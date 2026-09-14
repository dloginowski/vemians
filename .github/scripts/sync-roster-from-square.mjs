/*
 * Builds a SQL script upserting Square's ACTIVE team list into `people`'s
 * own `employee` table (Test-PRD-P0-101-square_sourced_roster) — matched by
 * email, `id` set to Square's own team-member id, `is_active` set for
 * anyone Square still lists as ACTIVE. Writes the SQL to a file; the
 * sync-roster-from-square workflow runs it with `wrangler d1 execute
 * --file=`, the same way bootstrap-d1.yml loads a schema file. This script
 * never touches Cloudflare's API itself — only Square's, and only to read.
 *
 * ADR-012's own finding, unchanged by any of this: Square's API exposes
 * `is_owner` and job title, nothing about actual permissions. Job title ->
 * role is MANAGER_JOB_TITLES, a workflow input this script owns — the
 * "handful of rows" ADR-012 describes an admin panel eventually owning,
 * expressed as a comma-separated list until that panel exists.
 *
 * NOTHING IS EVER DELETED. An employee no longer ACTIVE in Square gets
 * `is_active = 0` here, never a removed row — `shift.employee_id`
 * references `employee(id)`, and a past shift's own attendance record must
 * survive whoever worked it leaving.
 *
 * Also keeps the Cloudflare Access login gate itself in step (this is the
 * other half of "Square is the roster" — the D1 table above decides what
 * someone can do once they're in, this decides who can get in at all). Once
 * `setup-access` has created the "Vemians ops" application and its "Vemians
 * staff" policy one time, this script takes over maintaining who's on that
 * policy's Include list — the same Square active-team read, one more
 * destination. Runs only if CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID are
 * set and the application already exists, so this script still works
 * standalone (roster-only) before that bootstrap has happened.
 */
import { writeFileSync } from "node:fs";

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const ENV = process.env.SQUARE_ENV || "production";
const BASE_BY_ENV = { sandbox: "https://connect.squareupsandbox.com", production: "https://connect.squareup.com" };
const BASE = BASE_BY_ENV[ENV];
const SQUARE_VERSION = "2026-08-19";
const OUT_PATH = process.argv[2] || "roster.sql";

/* One page only, the same trade shared/commerce/square/customers.js's own
   listContactCustomers makes: a boutique shop's headcount does not approach
   Square's own page size. A shop that outgrows this needs pagination added
   here, not a silently-truncated roster. */
const SEARCH_LIMIT = 200;

const MANAGER_JOB_TITLES = new Set(
  (process.env.MANAGER_JOB_TITLES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

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

/* Single quotes doubled — the standard SQL escape — since `wrangler d1
   execute` has no parameter binding of its own. Every value from Square (a
   name, an email) goes through this before it is ever interpolated into
   the generated SQL. */
const sqlString = (v) => `'${String(v ?? "").replace(/'/g, "''")}'`;

function roleFor(member) {
  if (member.is_owner) return "owner";
  /* Square job titles can carry incidental leading/trailing whitespace (seen
     live: "Director " with a trailing space) that an exact-match Set lookup
     never forgives — trimmed on both sides of the comparison so a title
     that reads identically to a human actually matches. */
  const titles = (member.wage_setting?.job_assignments ?? [])
    .map((j) => j.job_title?.trim())
    .filter(Boolean);
  if (titles.some((t) => MANAGER_JOB_TITLES.has(t))) return "manager";
  return "staff";
}

let out;
try {
  out = await sq("/v2/team-members/search", { limit: SEARCH_LIMIT, query: { filter: { status: "ACTIVE" } } });
} catch (err) {
  console.error(`::error::${err.message}`);
  if (err.status === 401 || err.status === 403) {
    console.error(
      "::error::SQUARE_ACCESS_TOKEN either does not exist, is wrong, or lacks the Employees/Team " +
        "read permission — check Square Dashboard -> Settings -> Developer/API.",
    );
  }
  process.exit(1);
}

const all = out.team_members || [];
const members = all.filter((m) => m.email_address);
if (all.length > members.length) {
  console.warn(
    `::warning::${all.length - members.length} active team member(s) have no email on file in Square ` +
      "and were skipped entirely — they gain no ops role until Square has an address for them.",
  );
}

const lines = [
  "-- Generated by sync-roster-from-square.mjs. Do not edit by hand; the next",
  "-- scheduled run overwrites whatever this leaves behind.",
];

for (const m of members) {
  const name = [m.given_name, m.family_name].filter(Boolean).join(" ") || m.email_address;
  const role = roleFor(m);
  lines.push(
    `INSERT INTO employee(id, email, name, role, is_active) VALUES ` +
      `(${sqlString(m.id)}, ${sqlString(m.email_address)}, ${sqlString(name)}, ${sqlString(role)}, 1) ` +
      `ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, is_active=1;`,
  );
}

/*
 * Deactivate anyone we previously marked active who Square no longer lists
 * — automatic revocation (ADR-012: "status: INACTIVE in Square revokes
 * ops"). Guarded on members.length > 0: an empty result from Square (an API
 * hiccup, an over-narrow filter) must never read as "deactivate the entire
 * company," which is exactly what an un-guarded version of this statement
 * would do.
 */
if (members.length > 0) {
  const activeEmails = members.map((m) => sqlString(m.email_address)).join(", ");
  lines.push(`UPDATE employee SET is_active = 0 WHERE is_active = 1 AND email NOT IN (${activeEmails});`);
} else {
  console.warn(
    "::warning::Square returned no active team members with an email on file — refusing to deactivate " +
      "anyone as a precaution. Investigate before assuming the roster is actually empty.",
  );
}

writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
console.log(`Wrote ${OUT_PATH}: ${members.length} active team member(s) from Square.`);
for (const m of members) {
  console.log(`  ${m.email_address} -> ${roleFor(m)}`);
}

/* ---- keep the Access login gate in step too ----------------------------- */
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const ZONE_NAME = process.env.ZONE_NAME || "vemians.com";

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errs = (body.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || res.status;
    throw new Error(`${init.method || "GET"} ${path} -> ${errs}`);
  }
  return body.result;
}

async function syncAccessPolicy() {
  const opsHost = `ops.${ZONE_NAME}`;
  const apps = await cf(`/accounts/${CF_ACCOUNT}/access/apps`);
  const app = apps.find((a) => a.domain === opsHost);
  if (!app) {
    console.log(`  (Access sync skipped: no application for ${opsHost} yet — run setup-access first)`);
    return;
  }
  const policies = await cf(`/accounts/${CF_ACCOUNT}/access/apps/${app.id}/policies`);
  const policy = policies.find((p) => p.name === "Vemians staff");
  if (!policy) {
    console.log('  (Access sync skipped: no "Vemians staff" policy yet — run setup-access first)');
    return;
  }
  const include = members.map((m) => ({ email: { email: m.email_address } }));
  await cf(`/accounts/${CF_ACCOUNT}/access/apps/${app.id}/policies/${policy.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: policy.name,
      decision: policy.decision,
      include,
      require: policy.require ?? [],
      exclude: policy.exclude ?? [],
    }),
  });
  console.log(`  Access policy "Vemians staff" -> ${members.length} address(es), matching Square`);
}

if (!CF_TOKEN || !CF_ACCOUNT) {
  console.log("  (Access sync skipped: CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set)");
} else if (members.length === 0) {
  console.warn(
    "::warning::Square returned no active team members with an email on file — refusing to touch the " +
      "Access policy as a precaution. Investigate before assuming the roster is actually empty.",
  );
} else {
  try {
    await syncAccessPolicy();
  } catch (err) {
    console.error(`::error::Access sync failed: ${err.message}`);
    process.exit(1);
  }
}
