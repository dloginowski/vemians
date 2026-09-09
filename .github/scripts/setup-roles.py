#!/usr/bin/env python3
"""Create the Access Groups the Worker's role mapping expects.

Idempotent by NAME: an existing group is left exactly as it is rather than
rewritten, because this script does not know who was added to it by hand since.

WHAT IT DELIBERATELY DOES NOT DO: point any policy at these groups. A group is
inert until a policy includes it, so nothing here can change who reaches
ops.vemians.com. Wiring the policies is a separate, ordered job — Access
evaluates policies by precedence and the existing catch-all matches everyone,
so a new owner policy placed after it would never match and the owner would
silently become staff.

`vemians-manager` is NOT created. Nobody is a manager. A group that exists to
look complete, holding nobody, is a lie the next person has to disprove.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
OWNER = os.environ["OWNER_EMAIL"].strip()
DOMAIN = os.environ["STAFF_DOMAIN"].strip().lstrip("@")

if not OWNER or "@" not in OWNER:
    raise SystemExit(f"::error::owner_email {OWNER!r} is not an address")


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{API}/{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r), None
    except urllib.error.HTTPError as e:
        try:
            errs = json.load(e).get("errors") or []
            msg = "; ".join(str(x.get("message", x)) for x in errs) or f"HTTP {e.code}"
        except Exception:
            msg = f"HTTP {e.code}"
        return None, msg


WANTED = [
    ("vemians-owner", [{"email": {"email": OWNER}}], f"just {OWNER}"),
    ("vemians-staff", [{"email_domain": {"domain": DOMAIN}}], f"everyone at {DOMAIN}"),
]

existing, err = call("GET", f"accounts/{ACCOUNT}/access/groups")
if err:
    raise SystemExit(f"::error::cannot read Access groups — {err}")
by_name = {g.get("name"): g for g in (existing.get("result") or [])}
print(f"account already has {len(by_name)} group(s): {sorted(by_name) or '(none)'}\n")

failed = False
for name, include, human in WANTED:
    if name in by_name:
        print(f"  {name}: already exists ({by_name[name]['id']}) — left untouched")
        continue
    body, err = call("POST", f"accounts/{ACCOUNT}/access/groups", {"name": name, "include": include})
    if err:
        failed = True
        print(f"::error::{name}: could not create — {err}")
        continue
    print(f"  {name}: created ({body['result']['id']}) — {human}")

print()
print("Nothing about access changed. These groups are referenced by no policy,")
print("so who can reach ops.vemians.com is exactly what it was a minute ago.")
print("Next, and separately: one policy per group, ordered owner-before-staff.")
sys.exit(1 if failed else 0)
