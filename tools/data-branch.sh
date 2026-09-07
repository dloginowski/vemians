#!/bin/sh
# data-branch.sh — one commit per agent session on the Git data branches.
#
# Contract and reasoning: docs/adr/005-data-branches.md
#
# Only non-personal domains may live on a Git branch: catalog, knowledge, reports.
# Anything with a person in it (customers, identity, commerce, finance, people,
# audit) lives in D1 and is refused here — RULES.md "Data & Privacy", and ADR-001
# measured that deleting from Git does not delete.
#
# Squashing and force-pushing are TIDINESS, not privacy. Overwritten commits stay
# retrievable by SHA on any remote that saw them, and forever inside a fork network.
#
#   data-branch.sh commit    <domain> <message>
#   data-branch.sh reroot    <domain> [--max-commits N] [--max-age-days D]
#   data-branch.sh checkout  <domain> <path> [--worktree] [--force]
#   data-branch.sh push      <domain>
#   data-branch.sh status    <domain>
#   data-branch.sh session-new
#
# Environment:
#   DATA_BRANCH_SESSION    session id; one commit per session per branch
#   DATA_BRANCH_SRC_ROOT   directory holding <domain>/ (default: repo root)
#   DATA_BRANCH_REMOTE     remote for push (default: origin)

set -eu

PROG=${0##*/}
ALLOWED='catalog knowledge reports'
PREFIX='data'
REMOTE=${DATA_BRANCH_REMOTE:-origin}
LOCK_HELD=''
TMP_INDEX=''

die() { printf '%s: error: %s\n' "$PROG" "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

cleanup() {
	if [ -n "$TMP_INDEX" ]; then rm -f "$TMP_INDEX" || :; TMP_INDEX=''; fi
	if [ -n "$LOCK_HELD" ]; then rmdir "$LOCK_HELD" 2>/dev/null || :; LOCK_HELD=''; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

usage() {
	cat <<'USAGE_EOF'
data-branch.sh — squash-per-session writes to the Git data branches

  commit    <domain> <message>    fold this session's edits into ONE commit on data/<domain>
  reroot    <domain> [--max-commits N] [--max-age-days D]
                                  truncate history to a fresh root, tree unchanged
  checkout  <domain> <path> [--worktree] [--force]
                                  materialise data/<domain> for a build
  push      <domain>              push with --force-with-lease (never bare --force)
  status    <domain>              branch tip, commit count, owning session
  session-new                     start a new session id (next commit is a new commit)

Domains allowed: catalog knowledge reports
USAGE_EOF
}

# --- guards ------------------------------------------------------------------

check_domain() {
	db_d=${1:-}
	if [ -z "$db_d" ]; then usage >&2; die "no domain given"; fi
	for db_a in $ALLOWED; do
		if [ "$db_d" = "$db_a" ]; then return 0; fi
	done
	{
		printf '%s: REFUSED: "%s" is not a Git data domain.\n' "$PROG" "$db_d"
		printf '  Allowed: %s\n' "$ALLOWED"
		printf '  Domains holding personal data (customers, identity, commerce,\n'
		printf '  finance, people, audit) live in D1 and must never reach a Git\n'
		printf '  branch: RULES.md "Data & Privacy", and ADR-001 measured that\n'
		printf '  deleting from Git does not delete.\n'
	} >&2
	exit 2
}

setup_repo() {
	ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
	cd "$ROOT"
	GITDIR=$(cd "$(git rev-parse --git-dir)" && pwd)
	STATE="$GITDIR/data-branch"
	mkdir -p "$STATE"
}

lock() {
	LK="$STATE/$1.lock"
	db_t=0
	while ! mkdir "$LK" 2>/dev/null; do
		db_t=$((db_t + 1))
		if [ "$db_t" -ge 20 ]; then
			die "another data-branch run holds the lock for '$1' ($LK).
  Two sessions writing one data branch clobber each other; serialise them.
  If no run is active, remove the lock directory by hand."
		fi
		sleep 1
	done
	LOCK_HELD="$LK"
}

session_id() {
	if [ -n "${DATA_BRANCH_SESSION:-}" ]; then
		printf '%s\n' "$DATA_BRANCH_SESSION"
		return 0
	fi
	if [ ! -f "$STATE/session" ]; then
		printf 'local-%s-%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$$" >"$STATE/session"
	fi
	cat "$STATE/session"
}

src_dir() {
	if [ -n "${DATA_BRANCH_SRC_ROOT:-}" ]; then
		printf '%s/%s\n' "${DATA_BRANCH_SRC_ROOT%/}" "$1"
	else
		printf '%s\n' "$1"
	fi
}

branch_of() { printf '%s/%s\n' "$PREFIX" "$1"; }

tip_of() { git rev-parse --verify --quiet "refs/heads/$1" || true; }

trailer_of() { git log -1 --format=%B "$2" | sed -n "s/^$1: //p" | tail -n 1; }

# --- commands ----------------------------------------------------------------

cmd_commit() {
	check_domain "${1:-}"
	domain=$1
	msg=${2:-}
	[ -n "$msg" ] || die "commit needs a message: $PROG commit $domain \"...\""
	[ "$#" -le 2 ] || die "unexpected argument '$3' — quote the message"

	setup_repo
	src=$(src_dir "$domain")
	[ -d "$src" ] || die "no source directory '$ROOT/$src' to commit"
	branch=$(branch_of "$domain")
	lock "$domain"

	# Build the tree from the working files in a scratch index, so the caller's
	# index and HEAD are never touched.
	TMP_INDEX="$STATE/index.$domain.$$"
	rm -f "$TMP_INDEX"
	GIT_INDEX_FILE="$TMP_INDEX" git add -A -- "$src"
	roottree=$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)
	rm -f "$TMP_INDEX"; TMP_INDEX=''
	tree=$(git rev-parse --verify --quiet "$roottree:$src") ||
		die "nothing to commit under '$src' (empty, or entirely gitignored)"

	sid=$(session_id)
	old=$(tip_of "$branch")
	writes=1
	mode='root'
	parent=''
	if [ -n "$old" ]; then
		if [ "$(git rev-parse "$old^{tree}")" = "$tree" ]; then
			say "$branch: no content change; nothing committed."
			return 0
		fi
		if [ "$(trailer_of Data-Session "$old")" = "$sid" ]; then
			mode='squash'
			parent=$(git rev-parse --verify --quiet "$old^" || true)
			prev=$(trailer_of Data-Writes "$old")
			case $prev in
			'' | *[!0-9]*) prev=0 ;;
			esac
			writes=$((prev + 1))
			[ -n "$parent" ] || mode='squash-root'
		else
			mode='new'
			parent=$old
		fi
	fi

	body=$(
		printf '%s\n\n' "$msg"
		printf 'Data-Domain: %s\n' "$domain"
		printf 'Data-Session: %s\n' "$sid"
		printf 'Data-Writes: %s\n' "$writes"
	)

	if [ -n "$parent" ]; then
		new=$(printf '%s\n' "$body" | git commit-tree "$tree" -p "$parent")
	else
		new=$(printf '%s\n' "$body" | git commit-tree "$tree")
	fi

	# Compare-and-swap: refuse to move the branch if it shifted under us.
	if [ -n "$old" ]; then
		git update-ref -m "data-branch commit ($mode)" "refs/heads/$branch" "$new" "$old" ||
			die "$branch moved while we were building the commit — nothing written. Re-run."
	else
		git update-ref -m 'data-branch commit (root)' "refs/heads/$branch" "$new" '' ||
			die "$branch appeared while we were building the commit — nothing written. Re-run."
	fi

	count=$(git rev-list --count "refs/heads/$branch")
	say "$branch: $mode — $(git rev-parse --short "$new") (session $sid, write #$writes)"
	say "$branch: $count commit(s) on the branch."
	[ "$mode" = 'squash' ] || [ "$mode" = 'squash-root' ] ||
		say "$branch: new session commit; run '$PROG push $domain' to publish."
}

cmd_reroot() {
	check_domain "${1:-}"
	domain=$1
	shift
	maxc=''
	maxd=''
	while [ "$#" -gt 0 ]; do
		case $1 in
		--max-commits)
			maxc=${2:-}
			[ -n "$maxc" ] || die "--max-commits needs a number"
			shift 2
			;;
		--max-age-days)
			maxd=${2:-}
			[ -n "$maxd" ] || die "--max-age-days needs a number"
			shift 2
			;;
		*) die "unknown option '$1'" ;;
		esac
	done

	setup_repo
	branch=$(branch_of "$domain")
	lock "$domain"
	old=$(tip_of "$branch")
	[ -n "$old" ] || die "$branch does not exist"

	before=$(git rev-list --count "refs/heads/$branch")
	root=$(git rev-list --max-parents=0 -n 1 "refs/heads/$branch")
	rootts=$(git log -1 --format=%ct "$root")
	age=$((($(date -u +%s) - rootts) / 86400))

	if [ -n "$maxc" ] || [ -n "$maxd" ]; then
		hit=0
		if [ -n "$maxc" ] && [ "$before" -gt "$maxc" ]; then hit=1; fi
		if [ -n "$maxd" ] && [ "$age" -gt "$maxd" ]; then hit=1; fi
		if [ "$hit" -eq 0 ]; then
			say "$branch: within retention ($before commits, ${age}d old); not rerooted."
			return 0
		fi
	fi

	tree=$(git rev-parse "refs/heads/$branch^{tree}")
	new=$(
		{
			printf 'reroot %s\n\n' "$branch"
			printf 'History truncated. The tree is byte-identical to %s.\n\n' "$(git rev-parse --short "$old")"
			printf 'Data-Domain: %s\n' "$domain"
			printf 'Data-Reroot-From: %s\n' "$old"
			printf 'Data-Reroot-Dropped: %s\n' "$before"
		} | git commit-tree "$tree"
	)

	# The whole point of a reroot is that the content survives it. Prove it.
	[ "$(git rev-parse "$new^{tree}")" = "$tree" ] ||
		die "reroot produced a different tree — refusing to move $branch"

	git update-ref -m 'data-branch reroot' "refs/heads/$branch" "$new" "$old" ||
		die "$branch moved while rerooting — nothing written. Re-run."

	after=$(git rev-list --count "refs/heads/$branch")
	say "$branch: rerooted — $before commit(s) -> $after, tree $(git rev-parse --short "$tree") unchanged."
	say "$branch: dropped history is still reachable by SHA (from $old) on every"
	say "  clone and remote that already had it, and permanently inside a fork"
	say "  network. This is tidiness, not deletion."
	say "$branch: run '$PROG push $domain' to publish (force-with-lease)."
}

cmd_checkout() {
	check_domain "${1:-}"
	domain=$1
	dest=${2:-}
	[ -n "$dest" ] || die "checkout needs a destination path"
	shift 2
	worktree=0
	force=0
	while [ "$#" -gt 0 ]; do
		case $1 in
		--worktree) worktree=1 ;;
		--force) force=1 ;;
		*) die "unknown option '$1'" ;;
		esac
		shift
	done

	setup_repo
	branch=$(branch_of "$domain")
	[ -n "$(tip_of "$branch")" ] || die "$branch does not exist — nothing to check out"

	case $dest in /*) abs=$dest ;; *) abs="$ROOT/$dest" ;; esac
	if [ -e "$abs" ] && [ -n "$(ls -A "$abs" 2>/dev/null || true)" ] && [ "$force" -eq 0 ]; then
		die "'$abs' exists and is not empty — refusing to overwrite (pass --force)"
	fi

	if [ "$worktree" -eq 1 ]; then
		[ "$force" -eq 0 ] || rm -rf "$abs"
		git worktree add --detach "$abs" "refs/heads/$branch" >/dev/null
	else
		mkdir -p "$abs"
		git archive --format=tar "refs/heads/$branch" | tar -x -C "$abs"
	fi

	n=$(find "$abs" -type f -not -path '*/.git/*' -not -name '.git' | wc -l | tr -d ' ')
	say "$branch: checked out to $abs ($n file(s), $(git rev-parse --short "refs/heads/$branch"))."
}

cmd_push() {
	check_domain "${1:-}"
	domain=$1
	setup_repo
	branch=$(branch_of "$domain")
	local_tip=$(tip_of "$branch")
	[ -n "$local_tip" ] || die "$branch does not exist locally"
	lock "$domain"

	# The lease is what THIS clone last fetched, never the remote's live value —
	# leasing against a just-read remote tip is --force wearing a disguise.
	seen=$(git rev-parse --verify --quiet "refs/remotes/$REMOTE/$branch" || true)
	now=$(git ls-remote --heads "$REMOTE" "$branch" 2>/dev/null | awk 'NR==1{print $1}') || now=''

	if [ -z "$now" ]; then
		git push "$REMOTE" "refs/heads/$branch:refs/heads/$branch"
		say "$branch: created on $REMOTE at $(git rev-parse --short "$local_tip")."
		return 0
	fi
	if [ "$now" = "$local_tip" ]; then
		say "$branch: $REMOTE already at $(git rev-parse --short "$local_tip"); nothing to push."
		return 0
	fi
	if [ -z "$seen" ]; then
		die "$REMOTE has $branch at $now but this clone has never fetched it.
  Refusing to overwrite history this session has not seen.
  Run: git fetch $REMOTE $branch   then reconcile."
	fi
	if [ "$seen" != "$now" ]; then
		die "$branch moved on $REMOTE since this session fetched it
  (fetched $seen, remote is now $now).
  Another session wrote this data branch. Serialise the writers, fetch and
  reconcile — do NOT retry with --force, that is how one session's work
  disappears."
	fi

	git push --force-with-lease="refs/heads/$branch:$seen" \
		"$REMOTE" "refs/heads/$branch:refs/heads/$branch" ||
		die "push rejected: the lease on $branch no longer holds. $REMOTE moved
  between the check and the push. Fetch, reconcile, re-run."
	say "$branch: pushed to $REMOTE at $(git rev-parse --short "$local_tip")."
}

cmd_status() {
	check_domain "${1:-}"
	domain=$1
	setup_repo
	branch=$(branch_of "$domain")
	tip=$(tip_of "$branch")
	printf 'branch:   %s\n' "$branch"
	if [ -z "$tip" ]; then
		printf 'state:    does not exist\n'
		printf 'session:  %s\n' "$(session_id)"
		return 0
	fi
	printf 'tip:      %s  %s\n' "$(git rev-parse --short "$tip")" "$(git log -1 --format=%s "$tip")"
	printf 'commits:  %s\n' "$(git rev-list --count "$tip")"
	printf 'tree:     %s\n' "$(git rev-parse --short "$tip^{tree}")"
	printf 'owned by: %s (writes: %s)\n' "$(trailer_of Data-Session "$tip")" "$(trailer_of Data-Writes "$tip")"
	printf 'session:  %s\n' "$(session_id)"
}

cmd_session_new() {
	setup_repo
	printf 'local-%s-%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$$" >"$STATE/session"
	say "new session: $(cat "$STATE/session")"
	say "(set DATA_BRANCH_SESSION to pin one explicitly)"
}

# --- dispatch ----------------------------------------------------------------

cmd=${1:-}
[ "$#" -gt 0 ] && shift || true
case $cmd in
commit) cmd_commit "$@" ;;
reroot) cmd_reroot "$@" ;;
checkout) cmd_checkout "$@" ;;
push) cmd_push "$@" ;;
status) cmd_status "$@" ;;
session-new) cmd_session_new "$@" ;;
-h | --help | help) usage ;;
'') usage >&2; exit 1 ;;
*) usage >&2; die "unknown command '$cmd'" ;;
esac
