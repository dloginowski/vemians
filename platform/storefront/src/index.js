/*
 * Vemians storefront prototype — two surfaces.
 *
 *   vemians.com/*      public catalog. No Cloudflare Access. Anyone can view.
 *   ops.vemians.com/*  employee area. Behind Cloudflare Access, fails closed.
 *
 * DEPLOYED AS TWO WORKERS. Cloudflare Access applies to a whole Worker, not to
 * a route within one, so a single Worker serving both surfaces cannot be gated
 * on one and open on the other — turning Access on would put a login page in
 * front of the shop. `SURFACE` pins each deployment to one surface and the
 * other becomes unreachable in that build:
 *
 *   wrangler deploy              -> vemians-storefront, SURFACE=public, no Access
 *   wrangler deploy --env ops    -> vemians-ops,        SURFACE=ops,   Access on
 *
 * Leave SURFACE unset and it falls back to hostname routing, which is what
 * `wrangler dev` uses to serve both from one process.
 *
 * The split is by HOSTNAME, not by path, and that is load-bearing. An Access
 * application covers a hostname; if `/ops` also answered on the public host it
 * would be an unauthenticated copy of the employee area sitting outside the
 * gate. So on the public host `/ops` is a 404, and the ops surface exists only
 * on the ops host — plus on localhost, for `wrangler dev`, which is stated on
 * screen and in the README rather than left as a surprise.
 *
 * PRD: Test-PRD-P0-22-workspace_sso, Test-PRD-P0-26-owned_storefront,
 *      Test-PRD-P0-27-adaptive_grid, Test-PRD-P0-28-image_contract.
 */

import { readAccessIdentity } from "./access.js";
import { handleMcp, isMcpPath } from "./mcp.js";
import { products, customers, week } from "./seed.js";
import { catalogPage, opsPage, refusalPage, notFoundPage } from "./views.js";

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

function surface(hostname, env) {
  /* An explicit SURFACE wins over the hostname. This is the guarantee that the
     public Worker cannot serve the employee area whatever Host it is sent. */
  if (env.SURFACE === "public") return "public";
  if (env.SURFACE === "ops") return "ops";

  const host = hostname.toLowerCase();
  if (host === (env.OPS_HOST || "").toLowerCase()) return "ops";
  if (host === (env.PUBLIC_HOST || "").toLowerCase() || host === `www.${(env.PUBLIC_HOST || "").toLowerCase()}`) return "public";
  if (DEV_HOSTS.has(host) || host.endsWith(".workers.dev")) return "dev";
  return "public"; /* unknown host: serve the safe surface, never the ops one */
}

async function ops(request, env, path) {
  /* The MCP endpoint owns its own identity check: it refuses a service token
     the ops page would happily render for, and its refusal is JSON with a
     WWW-Authenticate header rather than an HTML page. See src/mcp.js. */
  if (isMcpPath(path)) return handleMcp(request, env, path);

  const identity = await readAccessIdentity(request, env);

  if (!identity.ok) {
    /* Fail closed. No assertion, no employee area. */
    const wantsJson = path === "/agent";
    return wantsJson
      ? json({ error: identity.reason }, identity.status)
      : html(refusalPage(identity.status, identity.reason), identity.status);
  }

  if (path === "/agent") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let q = "";
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        q = String((await request.json()).q || "");
      } else {
        q = String((await request.formData()).get("q") || "");
      }
    } catch (err) {
      console.error(`ERROR ops/agent: unreadable body — ${err.message}`);
      return json({ error: "Unreadable request body." }, 400);
    }
    /* Stub. No model, no tools, no bindings. It echoes and says so. */
    return json({
      actor: identity.email,
      verified: identity.verified,
      reply: `Echo (no model wired): ${q}`,
    });
  }

  if (path === "" || path === "/") {
    return html(opsPage(identity, { customers, week }));
  }

  return html(notFoundPage(), 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kind = surface(url.hostname, env);

    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

    if (kind === "ops") {
      /* Whole host is the employee area; /ops is accepted as an alias. */
      const path = url.pathname.startsWith("/ops") ? url.pathname.slice(4) : url.pathname;
      return ops(request, env, path);
    }

    /* Dev convenience only, and only when this build is not pinned to public. */
    if (kind === "dev" && url.pathname.startsWith("/ops") && env.SURFACE !== "public") {
      return ops(request, env, url.pathname.slice(4));
    }

    if (url.pathname === "/") return html(catalogPage(products));

    return html(notFoundPage(), 404);
  },
};
