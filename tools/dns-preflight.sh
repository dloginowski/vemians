#!/bin/sh
# dns-preflight.sh — capture DNS before a nameserver move, and diff it after.
#
# The nameserver switch is the only step in the Cloudflare migration that can
# break something you were not thinking about. Cloudflare imports what its scan
# finds; anything it misses goes dark the moment the nameservers change, and the
# usual casualty is mail, not the website.
#
#   ./dns-preflight.sh capture vemians.com    # BEFORE you change nameservers
#   ./dns-preflight.sh verify  vemians.com    # AFTER the zone reads Active
#
# `verify` re-queries and diffs against the capture. Empty diff means nothing
# was lost. Run capture while the OLD nameservers are still authoritative -
# once they are gone the old records are unrecoverable except from memory.

set -eu

CMD=${1:-}; DOMAIN=${2:-}
[ -n "$CMD" ] && [ -n "$DOMAIN" ] || { echo "usage: $0 {capture|verify} <domain>" >&2; exit 2; }
case "$CMD" in capture|verify) ;; *) echo "unknown command: $CMD" >&2; exit 2;; esac

command -v dig >/dev/null 2>&1 || {
  echo "error: dig not found. Install it (debian: dnsutils, macOS: bind)." >&2; exit 1; }

OUT="dns-$DOMAIN.txt"
TYPES="NS SOA A AAAA MX TXT CAA"
# Subdomains worth checking even when you think there are none.
SUBS="www mail smtp imap pop autodiscover autoconfig ftp cpanel webmail
      shop store blog app api staging dev ops m calendar drive"

emit() {
  echo "# captured $(date -u '+%Y-%m-%dT%H:%M:%SZ') for $DOMAIN"
  echo "# resolver: ${RESOLVER:-system}"
  for t in $TYPES; do
    dig ${RESOLVER:+@$RESOLVER} +short "$t" "$DOMAIN" 2>/dev/null \
      | sed "s|^|$DOMAIN\t$t\t|" | sort
  done
  for s in $SUBS; do
    for t in A AAAA CNAME MX TXT; do
      dig ${RESOLVER:+@$RESOLVER} +short "$t" "$s.$DOMAIN" 2>/dev/null \
        | sed "s|^|$s.$DOMAIN\t$t\t|" | sort
    done
  done
  # DMARC and common DKIM selectors live on their own names.
  for n in _dmarc google._domainkey default._domainkey selector1._domainkey \
           selector2._domainkey k1._domainkey _domainconnect; do
    dig ${RESOLVER:+@$RESOLVER} +short TXT "$n.$DOMAIN" 2>/dev/null \
      | sed "s|^|$n.$DOMAIN\tTXT\t|" | sort
  done
}

if [ "$CMD" = capture ]; then
  [ -e "$OUT" ] && { echo "error: $OUT exists. Move it aside rather than overwrite a pre-move capture." >&2; exit 1; }
  emit >"$OUT"
  n=$(grep -vc '^#' "$OUT" || true)
  # A capture that resolved nothing is indistinguishable from a successful one
  # on a quiet domain, and acting on it is worse than not capturing at all:
  # every record reads as "already absent" afterwards. Fail loudly instead.
  if [ "$n" -eq 0 ]; then
    rm -f "$OUT"
    echo "error: resolved 0 records for $DOMAIN." >&2
    echo "  Either the domain does not resolve, or DNS is failing from this machine." >&2
    echo "  Check with: dig +short NS $DOMAIN" >&2
    echo "  Refusing to write an empty capture - it would make every lost record look" >&2
    echo "  like it was never there." >&2
    exit 1
  fi
  echo "Captured $n record(s) to $OUT"
  echo
  echo "Records that MUST survive the move (check each appears in Cloudflare's DNS tab):"
  grep -E "	(MX|TXT|CAA)	" "$OUT" | sed 's/^/  /' || echo "  (none found — verify by hand, an empty result can mean the query failed)"
  echo
  echo "Commit this file or keep it somewhere outside the domain. Then change nameservers."
  exit 0
fi

[ -e "$OUT" ] || { echo "error: no capture at $OUT. You needed to run 'capture' BEFORE the move." >&2; exit 1; }
emit >"$OUT.now"
echo "Diff — lines starting '-' were lost in the move, '+' are new:"
echo
if diff -u "$OUT" "$OUT.now" | grep -vE '^(---|\+\+\+|@@|[-+]# )' | grep -qE '^[-+]'; then
  diff -u "$OUT" "$OUT.now" | grep -vE '^(---|\+\+\+|@@|[-+]# )' | grep -E '^[-+]' | sed 's/^/  /'
  echo
  echo "Anything on a '-' line and not deliberate is a record you have lost. Re-add it in"
  echo "Cloudflare DNS before going further. A missing MX means mail is being rejected NOW."
  exit 1
fi
echo "  (no differences — nothing was lost)"
