#!/usr/bin/env python3
"""Which hostnames are actually attached to which Worker, right now.

Written for the same reason access-report.py and worker-env.py exist: the
dashboard answers this correctly, but nothing here can look at a dashboard,
and "add a Custom Domain" from a script that does not first check what is
already attached is how a name ends up pointed at two Workers or attached
twice under a slightly different case.

Workers Custom Domains are an ACCOUNT-LEVEL list (one endpoint, every hostname
across every Worker), not a per-Worker one — so this is one call, not one per
Worker.

READ ONLY. Lists Custom Domains and the zone's DNS records; changes nothing.
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


def get(path):
    req = urllib.request.Request(f"{API}/{path}", headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            body = json.load(e)
        except Exception:
            print(f"  HTTP {e.code} reading {path}")
            return None, None
    if not body.get("success"):
        return None, body.get("errors")
    return body.get("result"), None


def section(title):
    print(f"\n───── {title} ─────")


section("the zone")
zones, err = get(f"zones?name={ZONE_NAME}")
if err or not zones:
    print(f"  '{ZONE_NAME}' not found on this account or token — {err}")
    sys.exit(0)
zone = zones[0]
zone_id = zone["id"]
print(f"  {zone['name']}  status={zone['status']}  id={zone_id}")

section("Workers Custom Domains on this account")
domains, err = get(f"accounts/{ACCOUNT}/workers/domains")
if err:
    print(f"  could not read — {err}")
else:
    ours = [d for d in domains if d.get("zone_name") == ZONE_NAME]
    if not ours:
        print(f"  none attached under {ZONE_NAME} yet")
    for d in ours:
        print(f"  {d.get('hostname')}  ->  {d.get('service')}  (environment={d.get('environment')})")
    others = [d for d in domains if d.get("zone_name") != ZONE_NAME]
    if others:
        print(f"  ({len(others)} more attached under other zones on this account)")

section(f"DNS records in {ZONE_NAME}")
records, err = get(f"zones/{zone_id}/dns_records?per_page=100")
if err:
    print(f"  could not read — {err}")
else:
    for r in records:
        proxied = "proxied" if r.get("proxied") else "DNS only"
        print(f"  {r['type']:6} {r['name']:30} -> {r.get('content','')[:50]:50}  {proxied}")
    if not records:
        print("  (empty)")
