#!/usr/bin/env python3
"""What can CLOUDFLARE_API_TOKEN actually do?

Written after the third time a step failed with "Authentication error
[code: 10000]" and the only way to find out which permission was missing was to
try the operation and read the wreckage. Guessing at a permissions screen from
an error message is slow and it has been wrong twice.

Every probe is a LIST — the cheapest read in each product. Read and Edit are
separate Cloudflare permissions, so a list that succeeds while a create fails is
itself the finding: the token was given Read where it needs Edit. That
distinction is printed rather than left to be inferred.

Nothing here creates, changes or deletes anything.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]

# (label, path, the Cloudflare permission that grants it, what breaks without it)
PROBES = [
    ("Workers scripts", f"accounts/{ACCOUNT}/workers/scripts",
     "Workers Scripts", "deploy-workers"),
    ("D1 databases", f"accounts/{ACCOUNT}/d1/database",
     "D1", "bootstrap-d1, mirror-status"),
    ("R2 buckets", f"accounts/{ACCOUNT}/r2/buckets",
     "Workers R2 Storage", "bootstrap-resources -> catalog.upload_image"),
    ("KV namespaces", f"accounts/{ACCOUNT}/storage/kv/namespaces",
     "Workers KV Storage", "bootstrap-resources -> durable T2 approvals"),
    ("Access apps", f"accounts/{ACCOUNT}/access/apps",
     "Access: Apps and Policies", "access-status"),
    # The roles live here. Creating one policy per role means naming the groups
    # in the include rules by ID, so this read is not optional — it is the
    # difference between doing the job and guessing at it.
    ("Access groups (the roles)", f"accounts/{ACCOUNT}/access/groups",
     "Access: Organizations, Identity Providers, and Groups",
     "reading the roles, to reference them in per-role policies"),
    ("Access identity providers", f"accounts/{ACCOUNT}/access/identity_providers",
     "Access: Organizations, Identity Providers, and Groups",
     "access-status — telling whether an IdP exists at all"),
    ("Access organization", f"accounts/{ACCOUNT}/access/organizations",
     "Access: Organizations, Identity Providers, and Groups",
     "reading the real team domain"),
]


def probe(path):
    req = urllib.request.Request(f"{API}/{path}", headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            body = json.load(r)
        result = body.get("result")
        n = len(result) if isinstance(result, list) else (1 if result else 0)
        return True, f"{n} item(s)"
    except urllib.error.HTTPError as e:
        try:
            errs = json.load(e).get("errors") or []
            msg = "; ".join(str(x.get("message", x)) for x in errs) or f"HTTP {e.code}"
        except Exception:
            msg = f"HTTP {e.code}"
        return False, msg
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


print(f"{'CAPABILITY':<28} {'':<4} DETAIL")
print("-" * 78)
missing = []
for label, path, permission, breaks in PROBES:
    ok, detail = probe(path)
    print(f"{label:<28} {'OK ' if ok else 'NO '} {detail}")
    if not ok:
        missing.append((label, permission, breaks))

print()
if not missing:
    print("Every capability this repository uses is readable with this token.")
    print()
    print("NOTE: these are READS. Creating an R2 bucket or a KV namespace needs")
    print("EDIT on those same permissions. A green line here with a failing")
    print("create means the token was given Read where it needs Edit.")
    sys.exit(0)

print("MISSING — add these at https://dash.cloudflare.com/profile/api-tokens")
seen = set()
for label, permission, breaks in missing:
    if permission in seen:
        continue
    seen.add(permission)
    print(f"  * Account -> {permission} -> Edit")
    print(f"      needed by: {breaks}")
print()
print("They are ACCOUNT-scoped permissions. A zone-scoped grant looks similar in")
print("the picker and does not apply to any of the above.")
sys.exit(1)
