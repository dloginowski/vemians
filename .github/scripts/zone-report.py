"""Report what Cloudflare thinks about a zone. Reads JSON from stdin."""
import json, os, sys

d = json.load(sys.stdin)
if not d.get("success") or not d.get("result"):
    print("::error::could not read the zone")
    print(json.dumps(d)[:400])
    sys.exit(1)

z = d["result"][0]
print("  status:   " + str(z.get("status")))
print("  paused:   " + str(z.get("paused")))
print("  ASSIGNED nameservers (these exact two must be at the registrar):")
assigned = sorted(z.get("name_servers") or [])
for n in assigned:
    print("    " + n)
print("  original nameservers Cloudflare saw at signup:")
for n in sorted(z.get("original_name_servers") or []):
    print("    " + n)

out = os.environ.get("GITHUB_OUTPUT")
if out:
    with open(out, "a") as fh:
        fh.write("assigned=" + ",".join(assigned) + "\n")
        fh.write("status=" + str(z.get("status")) + "\n")
