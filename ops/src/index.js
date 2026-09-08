/*
 * Vemians ops — the employee area, and only the employee area.
 *
 *   ops.vemians.com/*  behind Cloudflare Access, fails closed.
 *
 * A SEPARATE WORKER from the storefront in ../store. Cloudflare Access applies
 * to a whole Worker, not to a route within one, so the two surfaces cannot
 * share a deployment: gating this one would gate the shop. Put the Access
 * application on THIS Worker and on no other.
 *
 *   wrangler deploy   ->  vemians-ops, SURFACE=ops, Access on
 *
 * SURFACE stays as the pin it always was. It is set to "ops" in wrangler.toml;
 * with it unset the Worker falls back to hostname routing, which is what
 * `wrangler dev` uses on localhost. Pinned the other way — SURFACE=public on
 * this Worker — nothing is served at all: a build that thinks it is the shop
 * must not hand out the employee area.
 *
 * The split is by HOSTNAME, not by path, and that is load-bearing. An Access
 * application covers a hostname. `/ops` is accepted here as a path alias for
 * convenience, and the storefront answers it with a 404 because the storefront
 * has none of this code in its bundle.
 *
 * PRD: Test-PRD-P0-22-workspace_sso, Test-PRD-P0-23-group_derived_roles,
 *      Test-PRD-P0-24-binding_scoped_tools.
 */

import { notFoundPage } from "../../shared/view/html.js";
import { readAccessIdentity } from "./access.js";
import { agentTurn, approve, roleFor, sessionBindings } from "./agent.js";
import { handleMcp, isMcpPath } from "./mcp.js";
import { customers, week } from "./seed.js";
import { opsPage, refusalPage } from "./views.js";

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

function servesOps(hostname, env) {
  /* An explicit SURFACE wins over the hostname, in both directions. */
  if (env.SURFACE === "ops") return true;
  if (env.SURFACE === "public") return false;

  const host = hostname.toLowerCase();
  if (host === (env.OPS_HOST || "").toLowerCase()) return true;
  /* `wrangler dev` and a *.workers.dev smoke test, before a Custom Domain
     exists. Access still has to be satisfied to see anything. */
  return DEV_HOSTS.has(host) || host.endsWith(".workers.dev");
}

/* Both agent endpoints answer JSON, so a refusal on them must be JSON too —
   the composer's fetch() has no use for a login page. */
const AGENT_PATHS = new Set(["/agent", "/agent/approve"]);

async function body(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json();
  return Object.fromEntries(await request.formData());
}

async function ops(request, env, path) {
  /* The MCP endpoint owns its own identity check: it refuses a service token
     the ops page would happily render for, and its refusal is JSON with a
     WWW-Authenticate header rather than an HTML page. See src/mcp.js. */
  if (isMcpPath(path)) return handleMcp(request, env, path);

  const identity = await readAccessIdentity(request, env);

  if (!identity.ok) {
    /* Fail closed. No assertion, no employee area — and that covers the agent
       endpoints, which are reached before any of their own code runs. */
    return AGENT_PATHS.has(path)
      ? json({ error: identity.reason }, identity.status)
      : html(refusalPage(identity.status, identity.reason), identity.status);
  }

  if (path === "/agent") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let q = "";
    try {
      q = String((await body(request)).q || "");
    } catch (err) {
      console.error(`ERROR ops/agent: unreadable body — ${err.message}`);
      return json({ error: "Unreadable request body." }, 400);
    }

    const turn = await agentTurn({ q, identity, env });
    return json({ verified: identity.verified, ...turn });
  }

  if (path === "/agent/approve") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let id = "";
    try {
      id = String((await body(request)).id || "");
    } catch (err) {
      console.error(`ERROR ops/agent/approve: unreadable body — ${err.message}`);
      return json({ error: "Unreadable request body." }, 400);
    }

    /* The id is the whole of what the client sends. The tool, its arguments and
       the approval token all come from the server side — see agent.js. */
    const out = await approve({ id, identity, env });
    return json({ verified: identity.verified, ...out }, out.status);
  }

  if (path === "" || path === "/") {
    return html(opsPage(identity, { customers, week, bindings: sessionBindings(roleFor(identity)), hasKey: Boolean(env.ANTHROPIC_API_KEY) }));
  }

  return html(notFoundPage(), 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

    if (!servesOps(url.hostname, env)) {
      console.error(`ERROR ops: refusing ${url.hostname} — SURFACE=${env.SURFACE ?? "unset"}, OPS_HOST=${env.OPS_HOST ?? "unset"}`);
      return html(notFoundPage(), 404);
    }

    /* Whole host is the employee area; /ops is accepted as an alias. */
    const path = url.pathname.startsWith("/ops") ? url.pathname.slice(4) : url.pathname;
    return ops(request, env, path);
  },
};
