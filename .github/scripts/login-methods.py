#!/usr/bin/env python3
"""What does the Access login page actually offer a person?

The identity_providers API lists CONFIGURED providers. Cloudflare's built-in
one-time PIN is not one of those, so an empty list does not mean "nobody can
log in" — and that ambiguity has already cost a round trip.

This asks the question the way a person does: follow ops.vemians.com to
wherever Access sends it and read what the login page offers. The page is a JS
app, but it embeds its configuration as JSON, and the login-method names are in
there.

Read-only, unauthenticated, and it touches nothing but a public login page.
"""
import json
import re
import sys
import urllib.error
import urllib.request

TARGET = sys.argv[1] if len(sys.argv) > 1 else "https://ops.vemians.com/"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "vemians-access-check"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.geturl(), r.status, r.read().decode("utf-8", "replace")


try:
    final, status, body = fetch(TARGET)
except urllib.error.HTTPError as e:
    print(f"  {TARGET} -> HTTP {e.code}")
    raise SystemExit(0)
except Exception as e:
    print(f"  {TARGET} -> unreachable: {type(e).__name__}: {e}")
    raise SystemExit(0)

print(f"  followed to: {final}")
print(f"  status: {status}, {len(body)} bytes")

if "cloudflareaccess.com" not in final:
    print("  -> NOT an Access login page. The application may not be covering this hostname.")
    raise SystemExit(0)

# Cloudflare embeds the login config; the provider names are what we want.
names = set()
for m in re.finditer(r'"(?:name|type)"\s*:\s*"([a-z0-9_\- ]{3,40})"', body, re.I):
    v = m.group(1)
    if v.lower() in {
        "onetimepin", "one-time pin", "onetime_pin", "google", "google-apps",
        "azuread", "okta", "github", "saml", "oidc", "onelogin", "centrify", "pingone",
    }:
        names.add(v)

# The built-in is often spelled in the markup rather than in a config blob.
if re.search(r"one[\s\-]?time\s*pin|onetimepin", body, re.I):
    names.add("onetimepin")

if names:
    print(f"  LOGIN METHODS OFFERED: {', '.join(sorted(names))}")
    if "onetimepin" in {n.lower().replace(" ", "").replace("-", "") for n in names}:
        print("  -> One-time PIN is available. Enter a @vemians.com address and Access emails a code.")
else:
    print("  NO login method found on the page.")
    print("  -> Zero Trust -> Settings -> Authentication -> Login methods -> add One-time PIN.")
