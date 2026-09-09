#!/usr/bin/env python3
"""Point one Access policy at each role group, in the right order.

PRECEDENCE IS THE WHOLE RISK. Access evaluates policies lowest-first and the
first Allow that matches wins — and its id is what lands in the token as
`policy_id`. The existing catch-all matches every address at the domain, so an
owner policy placed after it would never match and the owner would silently
become staff, holding staff tools, with no error anywhere.

So: owner first, staff second, and THE EXISTING CATCH-ALL IS KEPT, demoted to
last. It is redundant once the group policies exist, and it is the reason a
mistake here cannot lock anyone out of their own shop. Deleting it would be
tidier and would remove the safety net at the same time.

Nothing is deleted. Re-running is safe: a policy that already exists by name is
updated in place rather than duplicated.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
APP = os.environ["APP_ID"]


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{API}/{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}",
                 **({"Content-Type": "application/json"} if body is not None else {})},
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


groups, err = call("GET", f"accounts/{ACCOUNT}/access/groups")
if err:
    raise SystemExit(f"::error::cannot read groups — {err}")
gid = {g["name"]: g["id"] for g in (groups.get("result") or [])}
for need in ("vemians-owner", "vemians-staff"):
    if need not in gid:
        raise SystemExit(f"::error::group {need} does not exist — run setup-roles first")

pols, err = call("GET", f"accounts/{ACCOUNT}/access/apps/{APP}/policies")
if err:
    raise SystemExit(f"::error::cannot read policies — {err}")
existing = {p.get("name"): p for p in (pols.get("result") or [])}
print("before:")
for p in sorted(pols.get("result") or [], key=lambda x: x.get("precedence", 999)):
    print(f"  {p.get('precedence')}. {p.get('name')!r}  id={p.get('id')}")

WANTED = [
    ("Vemians owner", 1, [{"group": {"id": gid["vemians-owner"]}}]),
    ("Vemians staff by group", 2, [{"group": {"id": gid["vemians-staff"]}}]),
]
NAMES = [w[0] for w in WANTED]

# ORDER OF OPERATIONS, and it is not cosmetic: Cloudflare requires precedences
# to be UNIQUE, so anything sitting on 1 or 2 has to move BEFORE the policies
# that want those slots are written. Creating first fails with
# "policy precedences must be unique", which is exactly what happened.
print("\nstep 1 — move everything else out of the way")
spare = 10
for pol in (pols.get("result") or []):
    if pol.get("name") in NAMES:
        continue
    body = {"name": pol["name"], "decision": pol["decision"],
            "include": pol["include"], "precedence": spare}
    _, err = call("PUT", f"accounts/{ACCOUNT}/access/apps/{APP}/policies/{pol['id']}", body)
    print(f"  {pol['name']!r}: -> precedence {spare}" if not err else f"::error::{pol['name']}: {err}")
    if err:
        raise SystemExit("::error::could not clear the precedence slots; nothing else attempted")
    spare += 1

print("\nstep 2 — the role policies")
ids = {}
failed = False
for name, precedence, include in WANTED:
    # CREATE WITHOUT A PRECEDENCE, THEN SET IT. Creating with precedence 1 was
    # rejected as "must be unique" even with slot 1 demonstrably free a moment
    # earlier — the uniqueness check evidently sees a view that has not caught
    # up with the move. Letting Cloudflare place it and then moving it is two
    # calls and no race.
    if name in existing:
        pid = existing[name]["id"]
        verb = "updated"
    else:
        out, err = call(
            "POST", f"accounts/{ACCOUNT}/access/apps/{APP}/policies",
            {"name": name, "decision": "allow", "include": include},
        )
        if err:
            failed = True
            print(f"::error::{name}: could not create — {err}")
            continue
        pid = out["result"]["id"]
        verb = "created"

    out, err = call(
        "PUT", f"accounts/{ACCOUNT}/access/apps/{APP}/policies/{pid}",
        {"name": name, "decision": "allow", "include": include, "precedence": precedence},
    )
    if err:
        failed = True
        print(f"::error::{name}: {verb}, but could not set precedence {precedence} — {err}")
        continue
    ids[name] = pid
    print(f"  {name}: {verb}, precedence {precedence}, id={pid}")

after, _ = call("GET", f"accounts/{ACCOUNT}/access/apps/{APP}/policies")
print("\nafter:")
for p in sorted(after.get("result") or [], key=lambda x: x.get("precedence", 999)):
    print(f"  {p.get('precedence')}. {p.get('name')!r}  id={p.get('id')}")

print("\nSet these in ops/wrangler.toml [vars]:")
for name, var in (("Vemians owner", "OWNER_POLICY_ID"), ("Vemians staff by group", "STAFF_POLICY_ID")):
    if name in ids:
        print(f'  {var} = "{ids[name]}"')
sys.exit(1 if failed else 0)
