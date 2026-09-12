#!/usr/bin/env python3
"""Attach the hostnames in WANTED to the Worker each one is supposed to serve,
and nothing else.

Idempotent by HOSTNAME, the same discipline setup-roles.py already uses for
Access Groups: reads the current attachment and converges it to what WANTED
says, never blindly recreating something already correct. Anything in WANTED
is, by definition, this script's to manage — if it is attached to the wrong
service (staging.vemians.com moved Worker names once already, while this
script was still being built), it is DETACHED and reattached correctly rather
than left wrong or refused.

vemians.com, www.vemians.com and ops.vemians.com are NOT in WANTED and never
will be — they are attached by hand (docs/deploy-cloudflare.md §3), and this
script only reports their state, in EXISTING_ONLY, for confirmation. A
hostname outside WANTED is never touched, no matter what it is attached to:
that is the actual safety property here, not "nothing is ever repointed".

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
# wanting one more environment-shaped subdomain later.
WANTED = [
    ("staging.vemians.com", "vemians-storefront-staging"),
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
            # DELETE answers 204 with an empty body — not "no error", but
            # genuinely nothing to parse. Only GET/PUT here ever return a
            # payload worth reading.
            raw = r.read()
            return (json.loads(raw) if raw else {"success": True, "result": None}), None
    except urllib.error.HTTPError as e:
        try:
            payload = json.load(e)
            errs = payload.get("errors") or []
            msg = "; ".join(f"{x.get('code','?')}: {x.get('message', x)}" for x in errs) or f"HTTP {e.code}"
        except Exception:
            msg = f"HTTP {e.code}"
        return None, msg


def attach(zone_id, host, service):
    return call(
        "PUT",
        f"accounts/{ACCOUNT}/workers/domains",
        {"zone_id": zone_id, "hostname": host, "service": service, "environment": "production"},
    )


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

    if current and current.get("service") == service:
        print(f"  {host}  already -> {service}. Nothing to do.")
        continue

    if current:
        # Ours to converge, not ours to leave wrong: detach the stale
        # attachment before reattaching to the right service.
        print(f"  {host}  is attached to '{current.get('service')}', not '{service}' — correcting it")
        _, err = call("DELETE", f"accounts/{ACCOUNT}/workers/domains/{current['id']}")
        if err:
            print(f"::error::could not detach {host} from '{current.get('service')}' — {err}")
            failed = True
            continue

    result, err = attach(zone_id, host, service)
    if err:
        print(f"::error::could not attach {host} -> {service} — {err}")
        failed = True
        continue
    print(f"  {host}  ->  {service}  (attached just now — certificate issuance can take a minute or two;")
    print(f"  the deploy workflow's own 'Does staging actually answer' step checks that separately)")

if failed:
    sys.exit(1)
