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
/* No shared staff domain — everyone has their own address, so the catch-all
   policy is a plain list of individual emails rather than one email_domain
   rule. Accepts either newlines or commas, since a workflow_dispatch text
   input has no native list type. */
const STAFF_EMAILS = [...new Set(
  (process.env.STAFF_EMAILS || "").split(/[,\n]/).map((e) => e.trim()).filter(Boolean),
)];

if (!TOKEN || !ACCOUNT) { console.error("::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set"); process.exit(1); }
if (!STAFF_EMAILS.length) { console.error("::error::staff_emails is empty"); process.exit(1); }
const badEmails = STAFF_EMAILS.filter((e) => !e.includes("@"));
if (badEmails.length) { console.error(`::error::staff_emails contains non-addresses: ${JSON.stringify(badEmails)}`); process.exit(1); }

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

/* ---- identity providers -------------------------------------------------- */
step("identity providers");
const idps = await cf(`/accounts/${ACCOUNT}/access/identity_providers`, {}, "Access: Identity Providers: Edit");
const oneTimePin = idps.find((p) => p.type === "onetimepin");
if (!oneTimePin) {
  console.error(
    "::error::No One-time PIN identity provider is enabled on this account. Enable it under " +
      "Zero Trust -> Settings -> Authentication, then re-run this workflow.",
  );
  process.exit(1);
}
console.log(`  One-time PIN -> ${oneTimePin.id}`);

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
      /* allowed_idps holds only One-time PIN's own id, so it is the only
         option the login card can ever offer — no "choose a login method"
         screen, just the email box. */
      allowed_idps: [oneTimePin.id],
      auto_redirect_to_identity: true,
    }),
  }, "Access: Apps and Policies: Edit");
  console.log(`  CREATED application ${app.id}`);
}

/* An app created before this script restricted allowed_idps (or edited by
   hand in the dashboard) may still have other identity providers enabled,
   which is what puts extra buttons on the login card. Lock it down here too,
   so re-running this workflow is enough to fix that — no manual dashboard
   step required. */
const alreadyRestricted =
  Array.isArray(app.allowed_idps) &&
  app.allowed_idps.length === 1 &&
  app.allowed_idps[0] === oneTimePin.id &&
  app.auto_redirect_to_identity === true;
if (!alreadyRestricted) {
  app = await cf(`/accounts/${ACCOUNT}/access/apps/${app.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: app.name,
      domain: app.domain,
      type: app.type,
      session_duration: app.session_duration,
      allowed_idps: [oneTimePin.id],
      auto_redirect_to_identity: true,
    }),
  }, "Access: Apps and Policies: Edit");
  console.log(`  UPDATED application ${app.id}: sign-in restricted to One-time PIN only`);
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
      include: STAFF_EMAILS.map((email) => ({ email: { email } })),
      require: [], exclude: [],
    }),
  }, "Access: Apps and Policies: Edit");
  console.log(`  CREATED policy: allow ${STAFF_EMAILS.length} named address(es)`);
}

/* ---- report ------------------------------------------------------------ */
step("values for ops/wrangler.toml");
console.log(`  ACCESS_TEAM_DOMAIN = "${TEAM}.cloudflareaccess.com"`);
console.log(`  ACCESS_AUD         = "${app.aud}"`);
if (process.env.GITHUB_OUTPUT) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `aud=${app.aud}\nteam_domain=${TEAM}.cloudflareaccess.com\n`);
}
