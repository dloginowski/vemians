#!/usr/bin/env python3
"""Write the real KV namespace id into a wrangler.toml.

Usage: resolve-kv-id.py <kv-list-json> <wrangler.toml> <namespace title>

`wrangler kv namespace list` prints a banner before its JSON on some versions,
so the array is found by trying each "[" rather than by trusting the first
byte — the same lesson .github/scripts/d1-table-count.py already paid for.

A namespace's binding name and its TITLE are different strings: wrangler names
the namespace `<title>` and the toml binds it as APPROVALS. Matching is on the
title, and an exact match is required — a substring match would happily pick a
`vemians-approvals-staging` that someone adds later.
"""
import json
import pathlib
import re
import sys

UUID_ISH = re.compile(r"^[0-9a-f]{32}$|^[0-9a-f-]{36}$")


def payload(text):
    for i, ch in enumerate(text):
        if ch != "[":
            continue
        try:
            return json.loads(text[i:])
        except json.JSONDecodeError:
            continue
    raise SystemExit(f"::error::no JSON array in wrangler output:\n{text[:2000]}")


def main(list_path, toml_path, title):
    spaces = payload(pathlib.Path(list_path).read_text())
    match = [n for n in spaces if n.get("title") == title]
    if not match:
        titles = sorted(n.get("title", "?") for n in spaces)
        raise SystemExit(f"::error::no KV namespace titled {title!r}; account has {titles}")
    real = match[0]["id"]

    p = pathlib.Path(toml_path)
    s = p.read_text()
    # Anchor on the APPROVALS binding so this can never rewrite another id.
    pat = re.compile(r'(\[\[kv_namespaces\]\]\s*\nbinding\s*=\s*"APPROVALS"\s*\nid\s*=\s*")([^"]+)(")')
    m = pat.search(s)
    if not m:
        raise SystemExit("::error::no [[kv_namespaces]] APPROVALS block in " + toml_path)
    if m.group(2) == real:
        print("KV id already correct — nothing to change.")
    else:
        print(f"  APPROVALS: {m.group(2)[:28]}… -> {real}")
        s = pat.sub(lambda _: m.group(1) + real + m.group(3), s, count=1)
        p.write_text(s)

    left = pat.search(p.read_text()).group(2)
    if not UUID_ISH.match(left):
        raise SystemExit(f"::error::APPROVALS id is still not a real id: {left!r}")
    print("APPROVALS id resolved.")


if __name__ == "__main__":
    main(*sys.argv[1:4])
