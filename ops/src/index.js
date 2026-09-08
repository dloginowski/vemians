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
import { CAPS } from "./tools/caps.js";
import { contentTypeFor, createMediaStore, verifyUploadTicket } from "./tools/media.js";
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
const AGENT_PATHS = new Set(["/agent", "/agent/approve", "/media/upload"]);

/*
 * The other half of catalog.upload_image.
 *
 * A tool argument cannot carry a phone photograph: the base64 would have to be
 * emitted token by token by the model, and a 12 MP JPEG is one to two million
 * output tokens of it (ops/src/tools/media.js says the arithmetic). So the tool
 * mints our R2 key, signs it, and returns a link. This is where the human opens
 * that link and the bytes go browser -> Worker -> R2, never through a model.
 *
 * TWO INDEPENDENT CHECKS, NEITHER SUFFICIENT ALONE
 *   1. Cloudflare Access has already terminated identity before this function
 *      runs (`ops()` fails closed above), so a person is on the other end.
 *   2. The ticket signature proves the key was minted by us, for THIS person,
 *      and has not expired. A leaked link is not a write capability for anyone
 *      else, because the actor is inside the signed message.
 */
async function mediaUpload(request, env, identity, actor) {
  if (request.method === "GET") {
    /* The picker. Deliberately plain: it exists so a human on a phone can pick
       a photo, not as a surface anything else talks to. */
    const url = new URL(request.url);
    const qs = url.searchParams.toString();
    return html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Upload a product photograph</title>` +
        `<body style="font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem">` +
        `<h1 style="font-size:1.25rem">Upload a product photograph</h1>` +
        `<p>Signed in as ${actor}. The original is stored in our own bucket; Square only ever gets a copy.</p>` +
        `<input id="f" type="file" accept="image/*">` +
        `<p id="s"></p>` +
        `<script>document.getElementById("f").addEventListener("change",async e=>{` +
        `const f=e.target.files[0];if(!f)return;const s=document.getElementById("s");s.textContent="Uploading…";` +
        `const r=await fetch(location.pathname+"?${qs}",{method:"PUT",headers:{"content-type":f.type||"application/octet-stream"},body:f});` +
        `const j=await r.json().catch(()=>({}));s.textContent=r.ok?("Stored "+j.bytes+" bytes. You can close this."):("Refused: "+(j.error||r.status));});` +
        `</script></body>`,
    );
  }
  if (request.method !== "PUT" && request.method !== "POST") {
    return json({ error: "PUT the file to this URL, or open it in a browser." }, 405);
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const ticket = await verifyUploadTicket({
    secret: env.MEDIA_SIGNING_KEY,
    key,
    actor,
    expiresAt: url.searchParams.get("exp"),
    signature: url.searchParams.get("sig") || "",
  });
  if (!ticket.ok) {
    console.error(`ERROR ops/media: refusing an upload by ${actor} — ${ticket.reason}`);
    return json({ error: ticket.reason }, 403);
  }

  let media;
  try {
    media = createMediaStore(env.MEDIA, env);
  } catch (err) {
    console.error(`ERROR ops/media: ${err.message}`);
    return json({ error: "media storage is not configured on this deployment" }, 503);
  }

  const contentType = contentTypeFor(key, request.headers.get("content-type"));
  if (!contentType) return json({ error: "unrecognised image type" }, 415);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > CAPS.ORIGINAL_IMAGE_MAX_BYTES) {
    return json({ error: `larger than the ${CAPS.ORIGINAL_IMAGE_MAX_BYTES}-byte limit for an original` }, 413);
  }

  try {
    const stored = await media.put(key, bytes, { contentType, actor });
    return json(stored);
  } catch (err) {
    console.error(`ERROR ops/media: storing ${key} failed — ${err.message}`);
    return json({ error: err.message }, 409);
  }
}

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

  if (path === "/media/upload") {
    /*
     * A machine may not upload a photograph: the audit trail and the ticket
     * both name a person, and a service token names a machine — the same
     * refusal src/mcp.js makes, for the same reason.
     */
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      console.error("ERROR ops/media: assertion has no email claim (service token?) — refusing the upload");
      return json({ error: "This route requires a per-user Access identity." }, 403);
    }
    if (!roleFor(identity, env)) {
      console.error(`ERROR ops/media: ${email} is in no known Access group — refusing the upload`);
      return json({ error: "Your Access identity is in no group this application maps to a role." }, 403);
    }
    return mediaUpload(request, env, identity, email);
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
