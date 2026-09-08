#!/usr/bin/env python3
"""Read-only report on this account's Cloudflare Access configuration.

Answers the questions you cannot answer from the dashboard when you cannot
find the page: which identity provider is wired up, whether it is pinned to a
Workspace domain, which application covers ops.vemians.com, and exactly which
rule decides who gets in.

EMAILS ARE REDACTED to their domain. A staff address is a real person's
identifier and a workflow log is readable by anyone with access to the repo;
the domain is the part that answers "is this policy pointed at the Workspace
or at a personal account", and the local part answers nothing.

Read-only: GET only, no POST/PUT/DELETE anywhere in this file.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]

EMAIL = re.compile(r"\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")


def redact(obj):
    """Replace the local part of every email anywhere in the structure."""
    if isinstance(obj, dict):
        return {k: redact(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    if isinstance(obj, str):
        return EMAIL.sub(lambda m: f"{m.group(1)[0]}***@{m.group(2)}", obj)
    return obj


def get(path):
    req = urllib.request.Request(
        f"{API}/{path}", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        detail = json.load(e) if e.headers.get("content-type", "").startswith("application/json") else {}
        return None, detail.get("errors") or f"HTTP {e.code}"
    if not body.get("success"):
        return None, body.get("errors")
    return body.get("result"), None


def section(title):
    print(f"\n───── {title} ─────")


section("identity providers")
idps, err = get(f"accounts/{ACCOUNT}/access/identity_providers")
if err:
    print(f"could not read: {err}")
    print("(the API token likely lacks Access: Organizations, Identity Providers, and Groups — Read)")
else:
    for i in idps:
        cfg = i.get("config") or {}
        print(f"  {i.get('name')!r}  type={i.get('type')}")
        # apps_domain is Google Workspace's domain pin. Its ABSENCE is the
        # finding: without it Google accepts any account you are signed into.
        for key in ("apps_domain", "email_claim_name", "claims", "scopes", "prompt"):
            if key in cfg:
                print(f"      {key}: {redact(cfg[key])}")
        if i.get("type") in ("google-apps", "google") and "apps_domain" not in cfg:
            print("      apps_domain: NOT SET  <- any Google account may attempt login")

section("access applications")
apps, err = get(f"accounts/{ACCOUNT}/access/apps")
if err:
    print(f"could not read: {err}")
    sys.exit(0)

for a in apps:
    dom = a.get("domain") or ""
    print(f"  {a.get('name')!r}  domain={dom}  type={a.get('type')}  id={a.get('id')}")
    allowed = a.get("allowed_idps")
    print(f"      allowed_idps: {allowed if allowed else 'ALL (any configured provider)'}")

    pol, perr = get(f"accounts/{ACCOUNT}/access/apps/{a['id']}/policies")
    if perr:
        print(f"      policies: could not read — {perr}")
        continue
    for p in pol or []:
        print(f"      policy {p.get('name')!r}  decision={p.get('decision')}")
        for bucket in ("include", "exclude", "require"):
            rules = p.get(bucket) or []
            if rules:
                print(f"        {bucket}: {json.dumps(redact(rules))}")
