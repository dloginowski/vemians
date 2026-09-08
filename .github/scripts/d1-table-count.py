#!/usr/bin/env python3
"""Print the user-table count from a `wrangler d1 execute --json` result file.

wrangler does not guarantee the JSON is the whole of stdout: a banner, an
update notice, or a "▲ [WARNING] …" line can precede it, and that warning
contains a bracket of its own — so slicing from the first "[" is not enough.
Try each bracket in turn and take the first that parses.

Lives in a file rather than inline in the workflow because a Python block
nested in a YAML block scalar inside a shell heredoc has three sets of
quoting rules, and the last time this was inline it did not survive them.
"""
import json
import sys


def payload(text):
    for i, ch in enumerate(text):
        if ch != "[":
            continue
        try:
            return json.loads(text[i:])
        except json.JSONDecodeError:
            continue
    raise SystemExit(f"no JSON array in wrangler output:\n{text[:2000]}")


def main(path):
    rows = payload(open(path).read())
    # [{"results": [{"n": 5}], "success": true, "meta": {...}}]
    print(rows[0]["results"][0]["n"])


if __name__ == "__main__":
    main(sys.argv[1])
