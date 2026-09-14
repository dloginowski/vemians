/*
 * Read-only. Prints Square's active Team list — name, email, job title(s) —
 * so a human can see the real roster before mapping job titles to ops roles
 * (docs/adr/012-ops-is-a-delegate.md: "Square's staff list is the roster").
 * Nothing here writes to Square or to Cloudflare.
 *
 * Also answers that ADR's own open question: whether SQUARE_ACCESS_TOKEN
 * even has permission to read the Team API at all — unverified when it was
 * written, because Square was answering 401 to every call at the time.
 */
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const ENV = process.env.SQUARE_ENV || "production";
const BASE_BY_ENV = { sandbox: "https://connect.squareupsandbox.com", production: "https://connect.squareup.com" };
const BASE = BASE_BY_ENV[ENV];

/* Pinned, not "latest" — same reasoning shared/commerce/square/client.js
   gives its own SQUARE_VERSION: an unpinned version can change shape under
   us with no warning. */
const SQUARE_VERSION = "2026-08-19";

if (!TOKEN) {
  console.error("::error::SQUARE_ACCESS_TOKEN is not set");
  process.exit(1);
}
if (!BASE) {
  console.error(`::error::SQUARE_ENV must be "sandbox" or "production", got ${JSON.stringify(ENV)}`);
  process.exit(1);
}

async function sq(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json.errors || [])
      .map((e) => `${e.category ?? "?"}/${e.code ?? "?"}${e.detail ? `: ${e.detail}` : ""}`)
      .join("; ");
    const err = new Error(`Square ${path} -> HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

let out;
try {
  out = await sq("/v2/team-members/search", { limit: 200, query: { filter: { status: "ACTIVE" } } });
} catch (err) {
  console.error(`::error::${err.message}`);
  if (err.status === 401 || err.status === 403) {
    console.error(
      "::error::SQUARE_ACCESS_TOKEN either does not exist, is wrong, or lacks the Employees/Team " +
        "read permission — check Square Dashboard -> Settings -> Developer/API -> the token's own permissions.",
    );
  }
  process.exit(1);
}

const members = out.team_members || [];
console.log(`${members.length} active team member(s):\n`);
for (const m of members) {
  const name = [m.given_name, m.family_name].filter(Boolean).join(" ") || "(no name on file)";
  const titles = (m.wage_setting?.job_assignments ?? []).map((j) => j.job_title).filter(Boolean);
  console.log(`  ${name}`);
  console.log(`    email: ${m.email_address || "(none on file)"}`);
  console.log(`    owner: ${m.is_owner ? "yes" : "no"}`);
  console.log(`    job title(s): ${titles.length ? titles.join(", ") : "(none on file)"}`);
  console.log("");
}

if (!members.length) {
  console.log(
    "No active team members returned. Either the account genuinely has none, or the token's " +
      "permissions are narrower than they look.",
  );
}
