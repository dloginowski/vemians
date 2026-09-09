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

ids = {}
failed = False
for name, precedence, include in WANTED:
    body = {"name": name, "decision": "allow", "include": include, "precedence": precedence}
    if name in existing:
        out, err = call("PUT", f"accounts/{ACCOUNT}/access/apps/{APP}/policies/{existing[name]['id']}", body)
        verb = "updated"
    else:
        out, err = call("POST", f"accounts/{ACCOUNT}/access/apps/{APP}/policies", body)
        verb = "created"
    if err:
        failed = True
        print(f"::error::{name}: {err}")
        continue
    ids[name] = out["result"]["id"]
    print(f"  {name}: {verb}, precedence {precedence}, id={ids[name]}")

# The catch-all stays, demoted. It is the reason a mistake here is recoverable.
for p in (pols.get("result") or []):
    if p.get("name") in dict(WANTED[:2]).keys() or p.get("name") in [w[0] for w in WANTED]:
        continue
    body = {"name": p["name"], "decision": p["decision"], "include": p["include"], "precedence": 10}
    out, err = call("PUT", f"accounts/{ACCOUNT}/access/apps/{APP}/policies/{p['id']}", body)
    print(f"  {p['name']}: kept as the fallback at precedence 10" if not err else f"::warning::{p['name']}: {err}")

after, _ = call("GET", f"accounts/{ACCOUNT}/access/apps/{APP}/policies")
print("\nafter:")
for p in sorted(after.get("result") or [], key=lambda x: x.get("precedence", 999)):
    print(f"  {p.get('precedence')}. {p.get('name')!r}  id={p.get('id')}")

print("\nSet these in ops/wrangler.toml [vars]:")
for name, var in (("Vemians owner", "OWNER_POLICY_ID"), ("Vemians staff by group", "STAFF_POLICY_ID")):
    if name in ids:
        print(f'  {var} = "{ids[name]}"')
sys.exit(1 if failed else 0)
