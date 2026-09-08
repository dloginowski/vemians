/*
 * Attach the Custom Domains and create the Cloudflare Access application for
 * the staff Worker, then report the AUD tag so it can be written into
 * ops/wrangler.toml.
 *
 * Idempotent: an existing domain or application is adopted, not duplicated.
 * Every failure names the exact API token permission it needed, because the
 * usual cause is a token scoped for deploying rather than for configuring.
 */
const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const ZONE_NAME = process.env.ZONE_NAME || "vemians.com";
const TEAM = process.env.ACCESS_TEAM_NAME || "vemians";
const EMAIL_DOMAIN = process.env.STAFF_EMAIL_DOMAIN || "@vemians.com";

if (!TOKEN || !ACCOUNT) { console.error("::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set"); process.exit(1); }

async function cf(path, init = {}, needs = "") {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errs = (body.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || res.status;
    if (res.status === 403 || String(errs).includes("9109") || String(errs).includes("Unauthorized")) {
      console.error(`::error::Permission denied on ${path}. The API token needs: ${needs || "a wider scope"}`);
    }
    throw new Error(`${init.method || "GET"} ${path} -> ${errs}`);
  }
  return body.result;
}

const step = (s) => console.log(`\n=== ${s} ===`);

/* ---- zone -------------------------------------------------------------- */
step(`zone ${ZONE_NAME}`);
const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`, {}, "Zone: Zone: Read");
if (!zones.length) { console.error(`::error::zone ${ZONE_NAME} is not on this account`); process.exit(1); }
const zoneId = zones[0].id;
console.log(`  ${ZONE_NAME} -> ${zoneId} (${zones[0].status})`);
if (zones[0].status !== "active") console.log(`::warning::zone status is ${zones[0].status}, not active`);

/* ---- custom domains ---------------------------------------------------- */
step("custom domains");
const WANT = [
  { hostname: ZONE_NAME, service: "vemians-storefront" },
  { hostname: `www.${ZONE_NAME}`, service: "vemians-storefront" },
  { hostname: `ops.${ZONE_NAME}`, service: "vemians-ops" },
];
const existing = await cf(`/accounts/${ACCOUNT}/workers/domains`, {}, "Workers Scripts: Edit");
for (const w of WANT) {
  const hit = existing.find((d) => d.hostname === w.hostname);
  if (hit && hit.service === w.service) { console.log(`  ok      ${w.hostname} -> ${w.service}`); continue; }
  if (hit) { console.log(`::warning::${w.hostname} is attached to ${hit.service}, not ${w.service} — leaving it alone`); continue; }
  try {
    await cf(`/accounts/${ACCOUNT}/workers/domains`, {
      method: "PUT",
      body: JSON.stringify({ environment: "production", hostname: w.hostname, service: w.service, zone_id: zoneId }),
    }, "Workers Scripts: Edit");
    console.log(`  ATTACH  ${w.hostname} -> ${w.service}`);
  } catch (err) { console.log(`  FAILED  ${w.hostname}: ${err.message}`); }
}

/* ---- access application ------------------------------------------------ */
step("access application");
const opsHost = `ops.${ZONE_NAME}`;
let app;
try {
  const apps = await cf(`/accounts/${ACCOUNT}/access/apps`, {}, "Access: Apps and Policies: Edit");
  app = apps.find((a) => a.domain === opsHost);
} catch (err) {
  console.error(`::error::Could not list Access applications — ${err.message}`);
  console.error("::error::Add this permission to the API token: Account -> Access: Apps and Policies -> Edit");
  process.exit(2);
}

if (app) {
  console.log(`  existing application ${app.id}`);
} else {
  app = await cf(`/accounts/${ACCOUNT}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name: "Vemians ops",
      domain: opsHost,
      type: "self_hosted",
      session_duration: "24h",
      /* One-time PIN is Cloudflare's own identity provider: no external IdP,
         and swapping to Google Workspace later changes this field only. */
      allowed_idps: [],
      auto_redirect_to_identity: false,
    }),
  }, "Access: Apps and Policies: Edit");
  console.log(`  CREATED application ${app.id}`);
}

/* ---- policy ------------------------------------------------------------ */
step("policy");
const policies = await cf(`/accounts/${ACCOUNT}/access/apps/${app.id}/policies`, {}, "Access: Apps and Policies: Edit");
if (policies.some((p) => p.name === "Vemians staff")) {
  console.log("  existing policy 'Vemians staff'");
} else {
  await cf(`/accounts/${ACCOUNT}/access/apps/${app.id}/policies`, {
    method: "POST",
    body: JSON.stringify({
      name: "Vemians staff",
      decision: "allow",
      include: [{ email_domain: { domain: EMAIL_DOMAIN.replace(/^@/, "") } }],
      require: [], exclude: [],
    }),
  }, "Access: Apps and Policies: Edit");
  console.log(`  CREATED policy: allow emails ending in ${EMAIL_DOMAIN}`);
}

/* ---- report ------------------------------------------------------------ */
step("values for ops/wrangler.toml");
console.log(`  ACCESS_TEAM_DOMAIN = "${TEAM}.cloudflareaccess.com"`);
console.log(`  ACCESS_AUD         = "${app.aud}"`);
if (process.env.GITHUB_OUTPUT) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `aud=${app.aud}\nteam_domain=${TEAM}.cloudflareaccess.com\n`);
}
