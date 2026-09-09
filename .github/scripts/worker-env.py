#!/usr/bin/env python3
"""Print a deployed Worker's plain-text vars, and say what SQUARE_ENV means.

Usage: worker-env.py <settings-json-file>

The single most confusing question this setup can produce is "why are my real
products not in the shop". When SQUARE_ENV is sandbox the answer is that the
mirror holds a DIFFERENT ACCOUNT'S catalog — and that should be readable from
the status report rather than deduced from wrangler.toml, which says what was
committed and not what is deployed.

In a file rather than inline in the workflow: Python nested in a YAML block
scalar inside a shell heredoc has three sets of quoting rules and column-zero
lines break the scalar. This repository has now hit that twice.
"""
import json
import sys


def main(path):
    d = json.load(open(path))
    if not d.get("success"):
        print(json.dumps(d.get("errors"), indent=2))
        return
    bindings = (d.get("result") or {}).get("bindings") or []
    env = {b["name"]: b.get("text") for b in bindings if b.get("type") == "plain_text"}

    val = env.get("SQUARE_ENV")
    shown = val if val else "(unset — client.js then defaults to sandbox)"
    print(f"  SQUARE_ENV = {shown}")

    if val != "production":
        print("  -> the mirror holds a SANDBOX catalog. Those are not the real shop's")
        print("     products, and anything created through ops stays in sandbox.")
        print("     Going live means BOTH: this set to production AND the secret")
        print("     replaced with a production token. One without the other is a 401.")

    for name in ("ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OPS_HOST", "SURFACE"):
        if name in env:
            v = env[name]
            print(f"  {name} = {v[:24] + '…' if v and len(v) > 24 else v}")


if __name__ == "__main__":
    main(sys.argv[1])
