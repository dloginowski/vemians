/*
 * Cloudflare Access identity.
 *
 * THE GATE IS CLOUDFLARE ACCESS, NOT THIS FILE. Access terminates identity in
 * front of the Worker and only then forwards the request, carrying a signed
 * assertion in `Cf-Access-Jwt-Assertion`. Who is allowed in — "emails ending in
 * @vemians.com", a Workspace group, anything else — is an *Access policy*,
 * configured in the Cloudflare dashboard (docs/deploy-cloudflare.md). This
 * module deliberately contains no email-domain test: an application-side domain
 * check is a display convenience at best and a false sense of a boundary at
 * worst, because anything that can reach the origin unproxied bypasses it.
 *
 * What this module does do is fail closed. No assertion -> 401, always. That
 * covers the one failure mode we can actually defend against ourselves: a
 * request arriving at the Worker without having passed through Access.
 *
 * Test-PRD-P0-22-workspace_sso, Test-PRD-P0-23-group_derived_roles.
 */

const HEADER = "cf-access-jwt-assertion";
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = null; /* { url, at, keys } */

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSegment(seg) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));
}

async function jwks(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  jwksCache = { url, at: Date.now(), keys: body.keys || [] };
  return jwksCache.keys;
}

async function verifySignature(token, teamDomain) {
  const [h, p, s] = token.split(".");
  const header = decodeSegment(h);
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);

  const jwk = (await jwks(teamDomain)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`no JWKS key for kid ${header.kid}`);

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("signature does not verify");
  return decodeSegment(p);
}

/*
 * Returns one of:
 *   { ok: false, status, reason }
 *   { ok: true, verified: true|false, email, sub, claims, reason? }
 *
 * `verified: false` means the assertion was present and decoded but its
 * signature was NOT checked, because ACCESS_TEAM_DOMAIN / ACCESS_AUD are unset.
 * That is the prototype default so `wrangler dev` runs with no Cloudflare
 * account, and the ops page says so on screen. Set both vars and the same code
 * path becomes a real RS256 + audience + expiry check.
 */
export async function readAccessIdentity(request, env) {
  const token = request.headers.get(HEADER);

  /* Fail closed. This is the only boundary the application itself can hold. */
  if (!token) {
    return { ok: false, status: 401, reason: "No Cf-Access-Jwt-Assertion header. This surface is served only behind Cloudflare Access." };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 403, reason: "Malformed Access assertion." };
  }

  const configured = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

  let claims;
  if (configured) {
    try {
      claims = await verifySignature(token, env.ACCESS_TEAM_DOMAIN);
    } catch (err) {
      /* RULES.md: never swallow a service-boundary failure. */
      console.error(`ERROR access: assertion rejected — ${err.message}`);
      return { ok: false, status: 403, reason: "Access assertion failed verification." };
    }

    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) {
      console.error("ERROR access: assertion aud does not match ACCESS_AUD");
      return { ok: false, status: 403, reason: "Access assertion is for a different application." };
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp < now) {
      return { ok: false, status: 403, reason: "Access assertion has expired." };
    }
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) {
      return { ok: false, status: 403, reason: "Access assertion is not yet valid." };
    }
    if (claims.iss && claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) {
      console.error(`ERROR access: assertion iss ${claims.iss} is not our team domain`);
      return { ok: false, status: 403, reason: "Access assertion was issued by a different team." };
    }
  } else {
    try {
      claims = decodeSegment(parts[1]);
    } catch {
      return { ok: false, status: 403, reason: "Malformed Access assertion." };
    }
  }

  return {
    ok: true,
    verified: configured,
    email: claims.email || claims.common_name || "(no email claim)",
    sub: claims.sub || "(no sub claim)",
    claims,
  };
}


/*
 * Claims -> role. THE canonical mapping; agent.js and mcp.js both import it.
 *
 * There were briefly two implementations. They disagreed: one matched group
 * names by suffix and defaulted to "staff", the other required an exact name
 * and failed closed. The same person got different privileges depending on
 * whether they used the browser or their own AI client, which is the kind of
 * split that is invisible until it matters.
 *
 * Fails closed, per PRD Test-PRD-P0-23-group_derived_roles: authorisation
 * derives from group membership, so no group is no role. An @vemians.com
 * address gets someone through Access; it does not by itself grant a role.
 */
export const ROLE_ORDER = Object.freeze(["staff", "manager", "owner"]);

export function groupsFrom(claims = {}) {
  return []
    .concat(claims.groups || [], claims.roles || [], claims.custom?.groups || [])
    .map((g) => String(g).toLowerCase());
}

export function roleFor(identity, env = {}) {
  const claims = identity?.claims || identity || {};
  const groups = new Set(groupsFrom(claims));
  const named = (v, fallback) => String(v || fallback).toLowerCase();
  if (groups.has(named(env.OWNER_GROUP, "vemians-owner"))) return "owner";
  if (groups.has(named(env.MANAGER_GROUP, "vemians-manager"))) return "manager";
  if (groups.has(named(env.STAFF_GROUP, "vemians-staff"))) return "staff";
  return null;
}
