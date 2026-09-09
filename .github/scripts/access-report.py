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

    # is_ui_read_only LOCKS the whole Zero Trust dashboard. If it is on, every
    # "why can't I add this" has one answer and it is not the thing being
    # added. Worth printing before anyone hunts for a menu again.
    locked = (org or {}).get("is_ui_read_only")
    print(f"  is_ui_read_only: {locked}")
    if locked:
        print("  -> THE DASHBOARD IS LOCKED. Nothing in Zero Trust can be changed by anyone")
        print("     until this is turned off. It is not the setting you are trying to add.")
    for k in ("created_at", "updated_at", "session_duration", "ui_read_only_toggle_reason",
              "user_seat_expiration_inactive_time", "auto_redirect_to_identity"):
        if k in (org or {}):
            print(f"  {k}: {org[k]}")
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
        # The ID and the PRECEDENCE, not just the name. policy_id is the only
        # role-bearing claim the Worker receives, so a policy id here that is
        # absent from ops/wrangler.toml is the whole explanation for a signed-in
        # person whose role reads "none" — and precedence decides which of these
        # ids a given person's token ends up carrying, because Access stops at
        # the first Allow. Neither was printed, so neither could be checked.
        print(
            f"      policy {p.get('name')!r}  decision={p.get('decision')}"
            f"  precedence={p.get('precedence')}  id={p.get('id')}"
        )
        for bucket in ("include", "exclude", "require"):
            rules = p.get(bucket) or []
            if rules:
                print(f"        {bucket}: {json.dumps(redact(rules))}")


section("access groups, and who they actually hold")
# A policy that includes a GROUP admits nobody the group does not hold, and the
# group's membership is not visible from the policy. When the owner policy is
# group-based — ours is — an empty or wrong group is indistinguishable, from
# outside, from a person having no role: they fall through to the catch-all,
# whose id no var names, and the Worker grants nothing.
_groups, _gerr = get(f"accounts/{ACCOUNT}/access/groups")
if _gerr:
    print(f"  could not read groups — {_gerr}")
else:
    for _g in _groups or []:
        print(f"  {_g.get('name')!r}  id={_g.get('id')}")
        for _bucket in ("include", "exclude", "require"):
            _rules = _g.get(_bucket) or []
            if _rules:
                print(f"      {_bucket}: {json.dumps(redact(_rules))}")


section("do the Worker's policy vars match the live policies")
# The comparison nobody could make from a dashboard: the ids committed in
# ops/wrangler.toml against the ids the account is actually serving. A stale id
# here grants nobody a role and looks exactly like a person with no access.
_toml = pathlib.Path("ops/wrangler.toml").read_text(encoding="utf-8")
_wanted = {}
for _role in ("OWNER", "MANAGER", "STAFF"):
    _m = re.search(rf'^{_role}_POLICY_ID\s*=\s*"([^"]*)"', _toml, re.M)
    if _m and _m.group(1):
        _wanted[_role] = _m.group(1)

_live = set()
for a in apps or []:
    _pol, _e = get(f"accounts/{ACCOUNT}/access/apps/{a['id']}/policies")
    for _p in _pol or []:
        if _p.get("id"):
            _live.add(_p["id"])

if not _wanted:
    print("  ops/wrangler.toml names no policy ids at all — every role resolves to none.")
for _role, _id in _wanted.items():
    print(f"  {_role}_POLICY_ID = {_id}  ->  {'LIVE' if _id in _live else 'NOT A LIVE POLICY (stale)'}")
for _id in sorted(_live - set(_wanted.values())):
    print(f"  live policy not named by any var: {_id}")


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
