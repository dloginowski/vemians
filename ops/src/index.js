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
import { explainRole, readAccessIdentity } from "./access.js";
import { agentTurn, approve, roleFor, sessionBindings } from "./agent.js";
import { approvePending, canUseDomain, handleMcp, isMcpPath, peekPending } from "./mcp.js";
import { customers, week } from "./seed.js";
import { skillsFor } from "./skills.js";
import { CAPS } from "./tools/caps.js";
import { ROLES, roleAtLeast } from "./tools/roles.js";
import { contentTypeFor, mediaKey, mintUploadTicket, verifyUploadTicket } from "./tools/media.js";
import { mediaStoreFor } from "./tools/index.js";
import { listCategories } from "./tools/catalog-writer.js";
import { applyFormEdits } from "./approval-forms.js";
import { syncFromSquare } from "./sync.js";
import {
  approvalPage,
  approvalResultPage,
  batchReviewPage,
  batchUploadPage,
  opsPage,
  refusalPage,
  whoamiPage,
} from "./views.js";
import { draftCustomerBatch, draftProductBatch } from "./batch.js";

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

  /* The SAME choice the tools make, through the same function. The browser
     posting here and the agent that minted the ticket must land in the same
     store, and the only way to be sure of that is to ask once. */
  let media;
  try {
    media = mediaStoreFor(env);
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

/*
 * The roster shown on the front page.
 *
 * It is a record of INTENT, not of authorisation. What actually grants a role
 * is the Cloudflare Access policy that admitted the request, and this Worker
 * cannot read those: ADR-011 says no Worker holds a Cloudflare API token, which
 * is precisely what stops the employee area granting itself admin. So the page
 * labels this column "people store" and labels the reader's own row with where
 * their live assertion came from.
 *
 * Fails soft and says why. The `people` store is bound before its schema is
 * applied, so "no such table" is the expected state on a fresh environment and
 * is not an error worth a 500 on a page whose job is to orient someone.
 */
async function readRoster(env) {
  if (!env.PEOPLE) return { rows: [], note: "No people store is bound to this deployment, so only your own sign-in is shown." };
  try {
    const { results } = await env.PEOPLE.prepare(
      "SELECT email, name, role, is_active FROM employee ORDER BY is_active DESC, role, name",
    ).all();
    const rows = results ?? [];
    return {
      rows,
      note: rows.length ? "" : "The people store is empty. Add employees and they appear here.",
    };
  } catch (err) {
    console.warn(`WARNING ops/roster: people store unreadable — ${err.message}`);
    return { rows: [], note: "The people store has no employee table yet, so only your own sign-in is shown." };
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

  /*
   * /products/batch and /customers/batch — one CSV, many drafts, each still
   * approved one at a time on its own /approvals/ page. See batch.js for what
   * a row needs per kind and why photos are out of scope for either route.
   */
  if (path === "/products/batch" || path === "/customers/batch") {
    const kind = path === "/products/batch" ? "products" : "customers";
    const draftFn = kind === "products" ? draftProductBatch : draftCustomerBatch;
    const noun = kind === "products" ? "products" : "customers";

    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return html(refusalPage(403, "This page requires signing in as a person, not a service token."), 403);
    }
    const role = roleFor(identity, env);
    if (!role) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }
    /*
     * Both catalog.create_product and customer.create refuse below manager,
     * whether the call is asking to park an approval or to run one — a staff
     * upload would get every single row back as "requires the manager role",
     * one confusing message repeated N times rather than one clear one said
     * before any row is even read.
     */
    if (!roleAtLeast(role, "manager")) {
      return html(
        refusalPage(
          403,
          `Adding ${noun} needs the manager role. Ask a manager to upload this, or draft it with your assistant instead.`,
        ),
        403,
      );
    }

    if (request.method === "GET") {
      return html(batchUploadPage(kind));
    }
    if (request.method !== "POST") {
      return html(refusalPage(405, "Upload a file to this page, or open it in a browser."), 405);
    }

    let file;
    try {
      const form = await request.formData();
      file = form.get("file");
    } catch (err) {
      return html(refusalPage(400, `Unreadable upload — ${err.message}`), 400);
    }
    if (!(file instanceof File) || file.size === 0) {
      return html(refusalPage(400, "No file was attached."), 400);
    }
    if (file.size > CAPS.BATCH_MAX_BYTES) {
      return html(
        refusalPage(413, `That file is larger than the ${CAPS.BATCH_MAX_BYTES}-byte limit for one upload.`),
        413,
      );
    }

    const text = await file.text();
    const result = await draftFn(env, { text, actor: email, role });
    return html(batchReviewPage(result, kind));
  }

  /*
   * /media/new — a one-click way to add a photo, for a coworker who is not
   * talking to an assistant at all. It mints exactly ONE ticket for exactly
   * ONE photo and sends the browser straight to the picker below, so "add a
   * photo" is a single link on the front page rather than something that
   * only exists as a step inside catalog.upload_image.
   *
   * The extension in the minted key is cosmetic (a bucket listing is easier
   * to read with one): the real type is decided from what the browser
   * actually uploads, in mediaUpload() below, so guessing "jpeg" here before
   * a file is even chosen costs nothing if the photo turns out to be a PNG.
   */
  if (path === "/media/new") {
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }
    if (!roleFor(identity, env)) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }
    if (!env.MEDIA_SIGNING_KEY) {
      return html(refusalPage(503, "Photo uploads are not configured on this deployment yet."), 503);
    }
    const key = mediaKey("image/jpeg");
    const ticket = await mintUploadTicket({ secret: env.MEDIA_SIGNING_KEY, key, actor: email });
    const dest = new URL("/media/upload", request.url);
    dest.searchParams.set("key", ticket.key);
    dest.searchParams.set("exp", String(ticket.expiresAt));
    dest.searchParams.set("sig", ticket.signature);
    return new Response(null, { status: 302, headers: { Location: dest.pathname + dest.search } });
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

  /*
   * /whoami — the caller's OWN verified identity, and how their role was
   * derived. Added the night a real person first signed in and the question
   * "are my roles reaching the Worker" could not be answered from outside:
   * Cloudflare Access Groups and Google Workspace groups arrive by different
   * routes, and a role that exists in a dashboard is not the same as a claim
   * in a token.
   *
   * It returns claim KEYS but only the group-bearing VALUES, so a role landing
   * under an unexpected claim name is visible without dumping whatever else an
   * identity provider chose to attach. Nothing here is a secret to the person
   * asking: it is their own identity, and the assertion itself is never echoed.
   */
  /*
   * /approvals/<id> — a T2 write, shown to a human and run by them.
   *
   * Every T2 call over MCP parks its intent and hands the model this link.
   * There was no route here, so every one of those links 404d and nothing that
   * writes could ever complete: an agent could draft a product and never
   * create one.
   *
   * GET shows. POST runs. The split is P0-35: a model holds a LINK, never
   * authorisation, and the write executes under the approver's own verified
   * identity rather than the assistant's.
   */
  if (path.startsWith("/approvals/")) {
    const id = path.slice("/approvals/".length);
    const email = identity.claims?.email;
    const role = roleFor(identity, env);
    if (!role) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }

    if (request.method === "POST") {
      /*
       * The person reviewing may have edited a field on the prefilled form —
       * applyFormEdits() merges that over what was originally parked, and
       * refuses cleanly (no different from a bad CSV row) if an edit does
       * not parse. A tool with no friendly form just gets its args back
       * unchanged. Either way runTool's own check() gets the final say.
       */
      const pendingBefore = await peekPending(env, id);
      let overrideArgs;
      if (pendingBefore.pending) {
        let form;
        try {
          form = await request.formData();
        } catch (err) {
          return html(approvalResultPage(false, `Unreadable submission — ${err.message}`), 400);
        }
        const edited = applyFormEdits(pendingBefore.pending.tool, pendingBefore.pending.args, form);
        if (!edited.ok) {
          return html(approvalResultPage(false, edited.error), 400);
        }
        overrideArgs = edited.args;
      }

      const out = await approvePending(env, id, { email, role, verified: identity.verified }, overrideArgs);
      if (!out.ok) console.error(`ERROR ops/approvals: ${email} could not approve ${id} — ${out.error}`);
      return html(approvalResultPage(Boolean(out.ok), out.ok ? out.result ?? out : out.error), out.ok ? 200 : 403);
    }

    const { pending, durable } = await peekPending(env, id);
    if (!durable) {
      console.warn(
        "WARNING ops/approvals: approvals are held per-isolate on this deployment — bind APPROVALS (KV) to make an approval link outlive the request that minted it",
      );
    }
    /* Only fetched for a tool whose approval page actually shows a category
       picker — a DB read nothing else on this page needs. */
    const categories =
      pending?.tool === "catalog.create_product" && env.CATALOG_MIRROR
        ? await listCategories(env.CATALOG_MIRROR)
        : [];
    return html(approvalPage(id, pending, { durable, categories }), pending ? 200 : 404);
  }

  if (path === "/whoami") {
    const detail = explainRole(identity, env);
    const claims = identity?.claims ?? {};
    const body = {
      email: claims.email ?? null,
      verified: Boolean(identity.verified),
      role: detail.role,
      role_from: detail.via,
      matched_group: detail.matched,
      groups_seen: detail.groups,
      groups_expected: detail.expects,
      /*
       * THE POLICY ID, AND WHY IT IS PRINTED.
       *
       * `policy_id` is the only role-bearing claim Cloudflare sends, and until
       * now this endpoint reported which policy MATCHED and never which policy
       * the token actually carried. When nothing matched — the exact case
       * someone opens /whoami to debug — it printed null and said nothing else,
       * so "my role is none and I do not know why" had no answer from the
       * outside. It does now: the id in the token, and the three the Worker is
       * comparing it against. Policies are recreated during setup and their ids
       * change; a var left holding a stale one looks identical to a person
       * having no role at all.
       *
       * A policy id identifies a RULE, not a person, and grants nothing on its
       * own — this is the reader's own token, and the assertion itself is still
       * never echoed.
       */
      policy_seen: claims.policy_id ?? null,
      policies_expected: {
        owner: env.OWNER_POLICY_ID ?? null,
        manager: env.MANAGER_POLICY_ID ?? null,
        staff: env.STAFF_POLICY_ID ?? null,
      },
      claim_keys: Object.keys(claims).sort(),
      note:
        detail.via === "DEFAULT_ROLE"
          ? "No group matched, so DEFAULT_ROLE granted this. If you have created roles, they are not reaching this token — compare groups_seen with groups_expected, and check claim_keys for where they landed instead."
          : detail.via === "group"
            ? "A group claim granted this role. DEFAULT_ROLE can be removed from ops/wrangler.toml."
            : detail.via === "policy"
              ? "The Access policy that admitted you granted this role. This is the normal path: Cloudflare sends policy_id, never a group claim."
              : claims.policy_id
                ? "No role. The policy that admitted you is in policy_seen and matches none of policies_expected — compare them: if policy_seen is not among them, the ids in ops/wrangler.toml are stale and need replacing with the live ones."
                : "No role, and the token carries no policy_id at all. This identity reached the door under something this Worker cannot read.",
    };

    /*
     * A PERSON GETS A PAGE. Everything else gets the JSON.
     *
     * This endpoint was written for me, reading a terminal, and then handed to
     * the shopkeeper as the thing to open when their role reads none. `"role":
     * null` is a fact and not an explanation: nobody learns from it that a
     * browser holding a sign-in from before they were added is the usual cause,
     * or that signing out fixes it. The page says that. `?format=json` and any
     * client that does not ask for HTML still get exactly what they got before.
     */
    const wantsJson =
      new URL(request.url).searchParams.get("format") === "json" ||
      !(request.headers.get("accept") || "").includes("text/html");
    return wantsJson ? json(body) : html(whoamiPage(body));
  }

  if (path === "" || path === "/") {
    /*
     * `env` was missing from this call, and from the two in agent.js. roleFor
     * defaults it to {}, so OWNER_POLICY_ID and its siblings read as undefined
     * and the policy branch could never match — which is the ONLY branch that
     * fires here, because Access Groups are not claims. Every signed-in person
     * saw role `null` and an empty tool list on the page that is supposed to
     * tell them what they can do. The argument, not the rule, was wrong.
     * Test-PRD-P0-23-group_derived_roles.
     */
    const detail = explainRole(identity, env);
    const roster = await readRoster(env);
    return html(
      opsPage(identity, {
        customers,
        week,
        role: detail.role,
        roleVia: detail.via,
        bindings: sessionBindings(detail.role),
        perRole: ROLES.map((r) => sessionBindings(r)),
        skills: skillsFor(detail.role, canUseDomain),
        roster: roster.rows,
        rosterNote: roster.note,
        mcpUrl: `${new URL(request.url).origin}/mcp`,
        hasKey: Boolean(env.ANTHROPIC_API_KEY),
      }),
    );
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

  /*
   * The cron (Test-PRD-P0-48-scheduled_mirror_sync). Square's catalog and stock
   * into our mirror, on a schedule, through the adapter — see src/sync.js for
   * why the orchestration is there and the mapping is not.
   *
   * IT IS ON THE OPS WORKER AND NOT THE STOREFRONT, and that is the same split
   * everything else here follows: the sync holds the Square credential and
   * writes the stock ledger, and neither belongs on a Worker the public can
   * reach. The storefront only READS the mirror this fills.
   *
   * No Access check, because a cron has no Access assertion to check — the
   * trigger is Cloudflare's, the credential is a Worker secret, and no request
   * from the internet can reach this entry point.
   *
   * The promise is returned rather than fired and forgotten: a scheduled
   * handler that returns early has its isolate torn down mid-sweep, which shows
   * up as a mirror that is mysteriously half-synced.
   */
  async scheduled(event, env, ctx) {
    const run = syncFromSquare(env, { cron: event?.cron ?? null });
    ctx?.waitUntil?.(run);
    const out = await run;
    /* Already logged in detail, with the reason named, inside syncFromSquare.
       This line is the one a `wrangler tail` filtered to "scheduled" sees. */
    console.info(`INFO ops/scheduled: ${event?.cron ?? "manual"} -> ${out.ok ? "ok" : out.reason}`);
    return out;
  },
};
