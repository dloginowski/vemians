#!/usr/bin/env python3
"""Activate the APPROVALS binding in a wrangler.toml.

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

    # The bindings ship COMMENTED. wrangler rejects a binding whose namespace id
    # is not real (code 10042) and fails the entire deploy, so a placeholder in
    # the repository is an outage rather than a marker — which is exactly what
    # it caused. They are written live only here, only after the resources have
    # been created, and only in this order.
    commented_kv = ('# [[kv_namespaces]]\n'
                    '# binding = "APPROVALS"\n'
                    '# id      = "<id>"')
    live_kv = ('[[kv_namespaces]]\n'
               'binding = "APPROVALS"\n'
               f'id      = "{real}"')
    if commented_kv in s:
        print(f"  APPROVALS: activating with id {real}")
        s = s.replace(commented_kv, live_kv, 1)
    else:
        pat = re.compile(r'(\[\[kv_namespaces\]\]\s*\nbinding\s*=\s*"APPROVALS"\s*\nid\s*=\s*")([^"]+)(")')
        m = pat.search(s)
        if not m:
            raise SystemExit("::error::no APPROVALS block, live or commented, in " + toml_path)
        if m.group(2) == real:
            print("  APPROVALS: already correct.")
        else:
            print(f"  APPROVALS: {m.group(2)[:28]}… -> {real}")
            s = pat.sub(lambda _: m.group(1) + real + m.group(3), s, count=1)

    # MEDIA is deliberately NOT activated. ADR-013 dropped the bucket, and a
    # binding to a bucket that does not exist fails the whole ops deploy — the
    # outage this script was rewritten to prevent.

    p.write_text(s)

    # Refuse to leave anything that is not a real id behind.
    for found in re.findall(r'^id\s*=\s*"([^"]+)"', s, re.M):
        if not UUID_ISH.match(found):
            raise SystemExit(f"::error::a kv id is still not real: {found!r}")
    print("APPROVALS is live.")


if __name__ == "__main__":
    main(*sys.argv[1:4])
