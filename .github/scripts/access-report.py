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
import pathlib
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


def committed_team_domain():
    """ACCESS_TEAM_DOMAIN as ops/wrangler.toml actually has it.

    Read rather than restated. A hardcoded copy here would agree with itself
    forever and stop being a check the moment the toml changed — which is the
    exact failure this whole report exists to catch.
    """
    toml = pathlib.Path(__file__).resolve().parents[2] / "ops" / "wrangler.toml"
    m = re.search(r'^ACCESS_TEAM_DOMAIN\s*=\s*"([^"]+)"', toml.read_text(), re.M)
    return m.group(1) if m else None


def section(title):
    print(f"\n───── {title} ─────")


section("the Zero Trust organization")
# THE team domain. Every JWT this Worker verifies is checked against
# https://<auth_domain>/cdn-cgi/access/certs — so if ops/wrangler.toml's
# ACCESS_TEAM_DOMAIN disagrees with this value, the Worker fetches the wrong
# signing keys and rejects every genuine login.
org, err = get(f"accounts/{ACCOUNT}/access/organizations")
if err:
    print(f"could not read: {err}")
else:
    auth = (org or {}).get("auth_domain")
    print(f"  name:        {(org or {}).get('name')!r}")
    print(f"  auth_domain: {auth}")
    configured = committed_team_domain()
    if auth and auth != configured:
        print(f"  MISMATCH: ops/wrangler.toml has ACCESS_TEAM_DOMAIN = {configured!r}")
        print(f"            the account's real auth_domain is {auth!r}")
        print("            -> the Worker fetches JWKS from the wrong team and rejects every real login")

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
    # Not fatal: the JWKS probe below needs no credential at all, and it is
    # the check that settles the team-domain mismatch.
    print(f"could not read: {err}")
    apps = []

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


section("which team domain actually serves signing keys")
# Settles the mismatch above by asking both hosts rather than trusting either
# record. A team that exists answers /cdn-cgi/access/certs with a JWKS.
# The committed value, plus every *.cloudflareaccess.com host the account
# itself mentions. Derived, so a renamed team or a corrected toml is still
# compared against what exists rather than against a list written today.
hosts = {committed_team_domain()}
for a in apps or []:
    for h in re.findall(r"([a-z0-9-]+\.cloudflareaccess\.com)", a.get("domain") or ""):
        hosts.add(h)
for host in sorted(h for h in hosts if h):
    url = f"https://{host}/cdn-cgi/access/certs"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            keys = json.load(r).get("keys") or []
            print(f"  {host}: HTTP {r.status}, {len(keys)} signing key(s)")
    except urllib.error.HTTPError as e:
        print(f"  {host}: HTTP {e.code}")
    except Exception as e:
        print(f"  {host}: unreachable — {type(e).__name__}")
