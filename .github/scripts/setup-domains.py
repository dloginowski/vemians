#!/usr/bin/env python3
"""Attach staging.vemians.com to vemians-storefront, and nothing else.

Idempotent by HOSTNAME, the same discipline setup-roles.py already uses for
Access Groups: an existing attachment is read and left alone, never recreated,
because this script does not know what else has touched it since. It creates
exactly the one hostname it is told to want and refuses to touch any hostname
already attached to a DIFFERENT service — a script that "ensures domains" is
not allowed to silently repoint someone else's.

vemians.com, www.vemians.com and ops.vemians.com are NOT managed here. They
already exist (attached by hand, per docs/deploy-cloudflare.md §3) and this
script only reports their current state for confirmation; touching them is
out of scope for "add a staging subdomain".

A create that fails is not allowed to read as success (bootstrap-resources.py
already earned that rule twice) — a non-2xx from Cloudflare here fails the
step loudly rather than being swallowed.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
ZONE_NAME = os.environ.get("ZONE_NAME", "vemians.com")

# (hostname, the Worker it must serve). Adding a row here is the whole of
# wanting one more staging-shaped subdomain later.
WANTED = [
    ("staging.vemians.com", "vemians-storefront"),
]

# Reported, never created or altered by this script.
EXISTING_ONLY = ["vemians.com", "www.vemians.com", "ops.vemians.com"]


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
            payload = json.load(e)
            errs = payload.get("errors") or []
            msg = "; ".join(f"{x.get('code','?')}: {x.get('message', x)}" for x in errs) or f"HTTP {e.code}"
        except Exception:
            msg = f"HTTP {e.code}"
        return None, msg


zones, err = call("GET", f"zones?name={ZONE_NAME}")
if err or not zones.get("result"):
    print(f"::error::could not read zone '{ZONE_NAME}' — {err}")
    sys.exit(1)
zone_id = zones["result"][0]["id"]
print(f"zone {ZONE_NAME}: {zone_id}")

existing, err = call("GET", f"accounts/{ACCOUNT}/workers/domains")
if err:
    print(f"::error::could not list existing Workers Custom Domains — {err}")
    sys.exit(1)
by_hostname = {d["hostname"]: d for d in existing.get("result", [])}

print("\n───── already attached (unmanaged by this script) ─────")
for host in EXISTING_ONLY:
    d = by_hostname.get(host)
    print(f"  {host}  ->  {d['service'] if d else 'NOT ATTACHED'}")

print("\n───── what this script wants ─────")
failed = False
for host, service in WANTED:
    current = by_hostname.get(host)
    if current:
        if current.get("service") == service:
            print(f"  {host}  already -> {service}. Nothing to do.")
        else:
            # Never silently repoint a hostname someone else attached elsewhere.
            print(f"::error::{host} is already attached to '{current.get('service')}', not '{service}' — refusing to change it")
            failed = True
        continue

    result, err = call(
        "PUT",
        f"accounts/{ACCOUNT}/workers/domains",
        {"zone_id": zone_id, "hostname": host, "service": service, "environment": "production"},
    )
    if err:
        print(f"::error::could not attach {host} -> {service} — {err}")
        failed = True
        continue
    print(f"  {host}  ->  {service}  (attached just now)")

if failed:
    sys.exit(1)
