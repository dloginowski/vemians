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
 *      Test-PRD-P0-24-binding_scoped_tools, Test-PRD-P0-101-square_sourced_roster.
 */

import { notFoundPage } from "../../shared/view/html.js";
import { explainRole, readAccessIdentity } from "./access.js";
import { agentTurn, approve, roleFor, searchIntent } from "./agent.js";
import { approvePending, peekPending } from "./approvals.js";
import { CAPS } from "./tools/caps.js";
import { roleAtLeast } from "./tools/roles.js";
import { contentTypeFor, mediaKey, mintUploadTicket, verifyUploadTicket, STORABLE_IMAGE_TYPES } from "./tools/media.js";
import { mediaStoreFor, assetFileStoreFor, receiptFileStoreFor, runTool } from "./tools/index.js";
import { contentTypeForAsset, extractText } from "./tools/assets.js";
import { scanReceipt } from "./tools/receipt-ocr.js";
import { listAllProducts, listCategories } from "./tools/catalog-writer.js";
import { applyFormEdits } from "./approval-forms.js";
import { syncFromSquare } from "./sync.js";
import { backfillMedia } from "./media-backfill.js";
import { intakeContactTickets } from "./contact-intake.js";
import {
  approvalPage,
  approvalResultPage,
  assetListPage,
  assetUploadedPage,
  assetUploadPage,
  batchReviewPage,
  batchUploadPage,
  dashboardPage,
  expenseConfirmPage,
  expenseFiledPage,
  receiptUploadPage,
  itemsPage,
  opsPage,
  refusalPage,
  shellPage,
  ticketPage,
  ticketsPage,
  whoamiPage,
} from "./views.js";
import { draftCustomerBatch, draftProductBatch, parsePriceToMinor } from "./batch.js";

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/* Which /approvals/<id> writes were parked from an Items-tab tile, so the
   result page can send the approver back there instead of to the agent
   page every other approval link returns to. */
const ITEMS_TAB_TOOLS = new Set(["catalog.set_channel", "catalog.set_custom_fields", "catalog.set_square_attributes"]);

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

async function body(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json();
  return Object.fromEntries(await request.formData());
}

/* String.fromCharCode(...bytes) blows the call stack on anything but a small
   array; a phone photo is well past that. Chunked, so a multi-megabyte photo
   still encodes without one giant spread. */
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/*
 * "A row of icons under chat; let the agent figure out what to do with
 * them" — the owner's own words. This is where a file dropped into the chat
 * actually lands, BEFORE the agent ever sees it: a photo goes to the same
 * media store catalog.upload_image uses, everything else to the same asset
 * store /assets/new uses, both under the identity already verified for this
 * request. agent.js never receives raw bytes it would have to re-store —
 * only a reference to what is already there, plus (for a photo small enough)
 * a copy for the model to actually look at. See the comment on
 * buildUserContent in agent.js for why a photo makes that trip twice.
 */
async function ingestAgentAttachment(env, { file, email }) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const imageType = contentTypeFor(file.name, file.type);

  if (imageType && STORABLE_IMAGE_TYPES.includes(imageType)) {
    if (bytes.byteLength > CAPS.ORIGINAL_IMAGE_MAX_BYTES) {
      return { error: `That photo is larger than the ${CAPS.ORIGINAL_IMAGE_MAX_BYTES}-byte limit.`, status: 413 };
    }
    let media;
    try {
      media = mediaStoreFor(env);
    } catch (err) {
      console.error(`ERROR ops/agent: no media store available — ${err.message}`);
      return { error: "Photo storage is not configured on this deployment yet.", status: 503 };
    }
    const key = mediaKey(imageType);
    try {
      await media.put(key, bytes, { contentType: imageType, actor: email, caption: file.name });
    } catch (err) {
      console.error(`ERROR ops/agent: storing attached photo failed — ${err.message}`);
      return { error: err.message, status: 413 };
    }
    const image =
      bytes.byteLength <= CAPS.AGENT_VISION_MAX_BYTES ? { mediaType: imageType, base64: bytesToBase64(bytes) } : null;
    return { kind: "photo", key, filename: file.name, image };
  }

  const contentType = contentTypeForAsset(file.name, file.type);
  if (!contentType) {
    return {
      error: `"${file.name}" is not a file type this can read yet. Try an image, or .txt, .md, .csv, .json, .pdf, a spreadsheet, or a Word document.`,
      status: 415,
    };
  }
  if (bytes.byteLength > CAPS.ASSET_MAX_BYTES) {
    return { error: `That file is larger than the ${CAPS.ASSET_MAX_BYTES}-byte limit.`, status: 413 };
  }
  let files;
  try {
    files = assetFileStoreFor(env);
  } catch (err) {
    console.error(`ERROR ops/agent: no asset file store available — ${err.message}`);
    return { error: "File storage is not configured on this deployment yet.", status: 503 };
  }
  const id = crypto.randomUUID();
  const key = `assets/${id}`;
  try {
    await files.put(key, bytes);
  } catch (err) {
    return { error: err.message, status: 413 };
  }
  const extracted = extractText(contentType, bytes);
  try {
    await env.ASSETS.prepare(
      "INSERT INTO asset(id, store_key, filename, content_type, size_bytes, uploaded_by, extracted_text, text_truncated)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, key, file.name, contentType, bytes.byteLength, email, extracted?.text ?? null, extracted?.truncated ? 1 : 0)
      .run();
  } catch (err) {
    console.error(`ERROR ops/agent: stored ${key} but could not record it — ${err.message}`);
    return { error: "Stored the file but could not record it. Try again.", status: 500 };
  }
  return { kind: "file", id, filename: file.name, contentType, extractedText: extracted?.text ?? null };
}

async function ops(request, env, path) {
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
    const role = await roleFor(identity, env);
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
    if (!(await roleFor(identity, env))) {
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
     * both name a person, and a service token names a machine.
     */
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      console.error("ERROR ops/media: assertion has no email claim (service token?) — refusing the upload");
      return json({ error: "This route requires a per-user Access identity." }, 403);
    }
    if (!(await roleFor(identity, env))) {
      console.error(`ERROR ops/media: ${email} is in no known Access group — refusing the upload`);
      return json({ error: "Your Access identity is in no group this application maps to a role." }, 403);
    }
    return mediaUpload(request, env, identity, email);
  }

  /*
   * /items — the employee-only tile grid over every mirrored product, custom
   * fields included (P0-71). Any signed-in role may VIEW it (a T0 read, same
   * as catalog.product); editing a tile mints a T2 approval and hands the
   * browser to the SAME /approvals/<id> page every other catalog write
   * already uses, rather than writing anything itself — see the comment on
   * itemsPage() in views.js for why.
   */
  if (path === "/items") {
    const role = await roleFor(identity, env);
    if (!role) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }
    if (!env.CATALOG_MIRROR) {
      return html(refusalPage(503, "The catalog mirror is not configured on this deployment yet."), 503);
    }
    let products;
    try {
      products = await listAllProducts(env.CATALOG_MIRROR, { limit: CAPS.CATALOG_ITEMS_PAGE_MAX_ROWS });
    } catch (err) {
      /* The most likely real cause, named plainly rather than surfacing a
         raw Worker exception: a column was added to a mirror_* table by
         hand (ALTER TABLE, run once against production D1 — this schema
         has no migration runner), but that table's own *_index view is a
         VIEW, and SQLite compiles a view's own column list at CREATE VIEW
         time. Adding a column to the base table does not change an
         already-existing view — the view has to be dropped and recreated
         with the new column named, same as schema.sql's own definition.
         listAllProducts reads mirror_product directly (P0-137: archived
         rows must still surface here) plus FOUR separate *_index views
         (variant/vendor/category/image) — any one of them going stale the
         same way breaks this the same way, so the fix named here is
         general rather than naming one column on one table. */
      console.error(`ERROR ops/items: listAllProducts failed — ${err.message}`);
      return html(
        refusalPage(
          500,
          "The Items tab could not read the catalog mirror. If a column was just added to a mirror_* " +
            "table by hand, its own *_index view likely needs recreating too — ALTER TABLE does not " +
            "update an existing view's own column list. Drop the stale *_index view and recreate it " +
            "from shared/commerce/square/schema.sql, against vemians-catalog-mirror.",
        ),
        500,
      );
    }
    /* The FULL closed set (catalog.categories' own list), not just the ones
       already used by a product — the category picker on each tile needs
       to offer a category nobody has been put in yet, same as the agent's
       own catalog.create_product picker already can. */
    const allCategories = await listCategories(env.CATALOG_MIRROR);

    /* Stock, batched the same way vendor names and images already are —
       one read of the whole (small) inventory_level view rather than one
       query per variation. A deployment with no COMMERCE binding, or a
       read that fails for any other reason, still shows the Items tab —
       every variation just shows 0 in stock rather than the whole tab
       going down over a store this page has never needed before. */
    let stockBySku = new Map();
    if (env.COMMERCE) {
      try {
        const stock = await env.COMMERCE.prepare("SELECT sku, on_hand FROM inventory_level").bind().all();
        stockBySku = new Map((stock.results ?? []).map((r) => [r.sku, Number(r.on_hand)]));
      } catch (err) {
        console.error(`ERROR ops/items: could not read stock levels — ${err.message}`);
      }
    }
    products = products.map((p) => ({
      ...p,
      variations: p.variations.map((v) => ({ ...v, on_hand: v.sku ? (stockBySku.get(v.sku) ?? 0) : null })),
    }));

    return html(itemsPage({ role }, products, allCategories));
  }

  /*
   * The Items search bar's own mic (P0-103) — a single, non-agentic model
   * call turning a spoken description into a search string, never a tool
   * call and never a chat turn. `categories` comes from the client, not a
   * fresh query here: it is exactly the list rendered into the filter menu
   * the person is already looking at, so the model's own suggestions can
   * never drift from what the page shows as an actual category.
   */
  if (path === "/items/search-intent") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const role = await roleFor(identity, env);
    if (!role) {
      return json({ error: "Your Access identity is in no group this application maps to a role." }, 403);
    }
    let q = "";
    let categories = [];
    try {
      const parsed = await body(request);
      q = String(parsed.q || "");
      if (Array.isArray(parsed.categories)) categories = parsed.categories.map(String).slice(0, 200);
    } catch (err) {
      console.error(`ERROR items/search-intent: unreadable body — ${err.message}`);
      return json({ error: "Unreadable request body." }, 400);
    }
    const result = await searchIntent({ q, env, categories });
    return json(result);
  }

  /* "There are already defined category and subcategories on Square main
     page right now. Why aren't you synchronizing them?" — the scheduled
     sync (Test-PRD-P0-48-scheduled_mirror_sync) only does a full sweep on
     its very first-ever run; every run after that is an incremental search
     for objects Square considers recently updated, so a category that
     already existed in Square untouched since before this mirror's own
     cursor was recorded — in particular its own parent_category link,
     a field this mirror only started reading once nested categories
     shipped — never surfaces on its own. This is the manual escape hatch:
     a manager-only button forcing the same full sweep right now, not
     fifteen minutes and a lucky cron tick from now. Not scoped under
     /items/<handle>/... below (this is global, not per-product) despite
     sharing the /items/ prefix — checked first so it never falls into
     that block's own path.startsWith("/items/") match. */
  if (path === "/items/resync") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return json({ error: "This page requires signing in as a person, not a service token." }, 403);
    }
    const role = await roleFor(identity, env);
    if (!role) {
      return json({ error: "Your Access identity is in no group this application maps to a role." }, 403);
    }
    const result = await runTool("catalog.resync_from_square", {}, { actor: email, role, env });
    if (!result.ok) return json({ error: result.error || "could not resync from Square" }, 403);
    return json(result.data);
  }

  if (
    path.startsWith("/items/") &&
    (path.endsWith("/channel") ||
      path.endsWith("/active") ||
      path.endsWith("/custom-fields") ||
      path.endsWith("/square-attributes") ||
      path.endsWith("/category") ||
      path.endsWith("/categories/create") ||
      path.endsWith("/categories/number") ||
      path.endsWith("/variations") ||
      path.endsWith("/details") ||
      path.endsWith("/inventory"))
  ) {
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return html(refusalPage(403, "This page requires signing in as a person, not a service token."), 403);
    }
    const role = await roleFor(identity, env);
    if (!role) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }
    if (request.method !== "POST") {
      return html(refusalPage(405, "Edit an item from the Items tab, not this URL directly."), 405);
    }
    /* catalog.set_channel and catalog.set_custom_fields both refuse below
       manager anyway, but checked here first — same as /products/batch —
       so a staff member gets one clear reason instead of runTool's own
       generic denial. */
    if (!roleAtLeast(role, "manager")) {
      return html(refusalPage(403, "Editing an item needs the manager role. Ask a manager, or draft the change with your assistant instead."), 403);
    }

    const suffix = path.endsWith("/channel")
      ? "/channel"
      : path.endsWith("/active")
        ? "/active"
        : path.endsWith("/custom-fields")
          ? "/custom-fields"
          : path.endsWith("/square-attributes")
            ? "/square-attributes"
            : path.endsWith("/categories/create")
              ? "/categories/create"
              : path.endsWith("/categories/number")
                ? "/categories/number"
                : path.endsWith("/category")
                  ? "/category"
                  : path.endsWith("/details")
                    ? "/details"
                    : path.endsWith("/inventory")
                      ? "/inventory"
                      : "/variations";
    const handle = path.slice("/items/".length, path.length - suffix.length);

    let form;
    try {
      form = await request.formData();
    } catch (err) {
      return html(refusalPage(400, `Unreadable submission — ${err.message}`), 400);
    }

    let toolName, args, summaryNoun;
    if (suffix === "/channel") {
      /* A single "Visible on website" checkbox, not a 3-way select: every
         product already has a working direct-link page (P0-71), so the only
         real decision left is whether it is ALSO listed in the browsable
         grid. Checked -> website, unchecked -> direct_link. */
      toolName = "catalog.set_channel";
      args = { handle, channel: form.get("on_website") ? "website" : "direct_link" };
      summaryNoun = "channel";
    } else if (suffix === "/active") {
      /* The "Active" checkbox beside "Web" — Square's own sale lifecycle
         (archived/not), not catalog.set_channel's OURS-only website/
         direct_link choice. Unchecked -> archive; checked -> restore. */
      toolName = "catalog.set_active";
      args = { handle, active: Boolean(form.get("active")) };
      summaryNoun = "active status";
    } else if (suffix === "/custom-fields") {
      /* field_name_0/field_value_0, field_name_1/field_value_1, ... — the
         same numbered-row shape itemTile() renders in views.js. A row with
         no name is skipped; a row with a name but no value is passed
         through as "" so catalog.set_custom_fields' own merge treats it as
         a removal, exactly the same as editing it there directly. */
      const fields = {};
      for (let i = 0; form.has(`field_name_${i}`); i += 1) {
        const key = String(form.get(`field_name_${i}`) ?? "").trim();
        if (key) fields[key] = String(form.get(`field_value_${i}`) ?? "").trim();
      }
      toolName = "catalog.set_custom_fields";
      args = { handle, fields };
      summaryNoun = "custom fields";
    } else if (suffix === "/square-attributes") {
      /* style_id/vendor/vendor_code/unit_cost/commission — Square's own
         Custom Attributes and Vendor entity (P0-136), not ours. A blank
         input means "leave this one as it is," not "clear it": only a
         field the person actually typed something into is sent at all, so
         catalog.set_square_attributes' own undefined-means-unchanged
         handling applies the same way it would to a call that only ever
         meant to touch one of the five. commission is parsed as a plain
         integer here; unit_cost is a dollar string ("$45.00") parsed the
         same way a spreadsheet's own price column is (batch.js's
         parsePriceToMinor) — the agent-tool schema layer always takes a
         plain integer minor-units argument, dollar-string parsing happens
         only at this human-facing form boundary. A malformed or
         out-of-range value (commission, or a unit_cost that fails to
         parse) is left for the tool's own check() to refuse with a clear
         reason, rather than silently dropped.

         The ops UI's own style_id <form> (views.js) posts here alone now
         — unit_cost moved to the /variations route below once it stopped
         being one value for the whole product ("all the variants can have
         a different unit cost too"). This route and catalog.set_square_
         attributes itself are unchanged for API/agent callers that still
         want to set unit_cost uniformly in one call. */
      const styleId = String(form.get("style_id") ?? "").trim();
      const vendor = String(form.get("vendor") ?? "").trim();
      const vendorCode = String(form.get("vendor_code") ?? "").trim();
      const unitCostRaw = String(form.get("unit_cost") ?? "").trim();
      const unitCostMinor = unitCostRaw === "" ? undefined : parsePriceToMinor(unitCostRaw);
      const commissionRaw = String(form.get("commission") ?? "").trim();
      const commission = commissionRaw === "" ? undefined : Number(commissionRaw);
      toolName = "catalog.set_square_attributes";
      args = {
        handle,
        ...(styleId ? { style_id: styleId } : {}),
        ...(vendor ? { vendor } : {}),
        ...(vendorCode ? { vendor_code: vendorCode } : {}),
        /* parsePriceToMinor returning null (unparsable) still gets sent
           through as null rather than silently dropped, so the tool's own
           schema validation refuses it with a clear reason instead of the
           form quietly ignoring what was typed. */
        ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
        ...(commission !== undefined ? { commission } : {}),
      };
      summaryNoun = "style ID, vendor, vendor code, unit cost or commission";
    } else if (suffix === "/details") {
      /* "Where's the item label and where is the description fields?
         Shouldn't we be able to change that?" — title/description, sent
         exactly as typed: a blank title is not "leave it as it is" the way
         a blank style_id or vendor already means (both were only ever
         placeholders for something that might not exist yet); this field
         always carries the product's CURRENT title, so blank here means
         someone actually deleted it, and catalog.update_product's own
         check() refuses that with a clear reason ("title is empty") the
         same inline way every other refusal on this tile already does. A
         blank description is a real, intentional clear — the same
         "resend the whole thing" reasoning update_product's other fields
         already rely on, just this time the person editing it typed the
         blank themselves. */
      const title = String(form.get("title") ?? "").trim();
      const description = String(form.get("description") ?? "").trim();
      toolName = "catalog.update_product";
      args = { handle, title, description };
      summaryNoun = "title or description";
    } else if (suffix === "/inventory") {
      /* "Show current count, adjust with +/-" — the owner's own choice,
         over a plain "type a target count" box, once it was clear a stock
         count is never overwritten directly, only adjusted (P0-31's own
         "the count cannot be written directly"). ONE variation, ONE delta,
         per click — not part of the tile's big resend-everything Save flow
         (the page script below posts this immediately, on its own, the
         moment the +/- button is clicked), since a stock movement is an
         EVENT with its own moment in time, not a value to keep in sync. */
      const variantId = String(form.get("variant_id") ?? "").trim();
      const delta = Number(String(form.get("delta") ?? "").trim());
      if (!variantId || !Number.isInteger(delta) || delta === 0) {
        return json({ error: "give a variation and a non-zero whole-number change" }, 400);
      }
      toolName = "inventory.adjust";
      args = { variant_id: variantId, delta };
      summaryNoun = "stock";
    } else if (suffix === "/categories/create") {
      /* The new nested category/subcategory tree (P0-138), rendered above
         Variants — "an add category button... that will create a
         subcategory in the expanded view." A blank parent_id means a new
         TOP-LEVEL category; a real one nests under it, at whatever depth.
         Applies immediately, no /approvals/<id> hop, the same reasoning
         every other field on this tile already follows. */
      const name = String(form.get("name") ?? "").trim();
      const parentId = String(form.get("parent_id") ?? "").trim();
      if (!name) return json({ error: "give a category name" }, 400);
      toolName = "catalog.create_category";
      args = {
        name,
        reason: `created from the Items tab while categorizing '${handle}'`,
        ...(parentId ? { parent_id: parentId } : {}),
      };
      summaryNoun = "category";
    } else if (suffix === "/categories/number") {
      /* OURS, not Square's — a category/subcategory's own 2-digit style_id
         code. A blank input clears it (catalog.set_category_number's own
         clear: true — the generic schema validator refuses an empty
         STRING outright, so a real "" cannot mean clear on its own). */
      const categoryId = String(form.get("category_id") ?? "").trim();
      const numericId = String(form.get("numeric_id") ?? "").trim();
      if (!categoryId) return json({ error: "give a category" }, 400);
      toolName = "catalog.set_category_number";
      args = numericId ? { category_id: categoryId, numeric_id: numericId } : { category_id: categoryId, clear: true };
      summaryNoun = "category number";
    } else if (suffix === "/category") {
      /* A free-text name, resolved the same way vendor names already are
         (vendorRef, catalog-writer.js) — the owner's own words: "I should
         be able to... select an existing category subcategory, or just
         type in... it will create one if there isn't one." Unlike vendor,
         catalog.create_category keeps its own near-duplicate guard
         (nearestCategory) — resolving on demand from this form does not
         bypass it, since this still calls the SAME tool with the SAME
         check(), only with a reason supplied here instead of typed by
         hand. "Category/Subcategory" is not a real two-level hierarchy
         this schema has never had (see P0-136's own style_id comment) —
         it is a flat category whose own name happens to contain a "/",
         same as any other name. */
      const name = String(form.get("category") ?? "").trim();
      if (!name) {
        return json({ error: "give a category name, or choose one from the list" }, 400);
      }
      const listRes = await runTool("catalog.categories", {}, { actor: email, role, env });
      if (!listRes.ok) return json({ error: listRes.error || "could not read the category list" }, 400);
      const existing = listRes.data.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      let categoryId = existing?.id;
      if (!categoryId) {
        const reason = `created from the Items tab while categorizing '${handle}'`;
        const createGate = await runTool("catalog.create_category", { name, reason }, { actor: email, role, env });
        if (!createGate?.needsApproval) {
          return json({ error: createGate?.error || `could not create the category '${name}'` }, 400);
        }
        const created = await runTool(
          "catalog.create_category",
          { name, reason },
          { actor: email, role, env, approvalToken: createGate.data.approval.token },
        );
        if (created?.error || created?.denied) {
          return json({ error: created.error || created.denied || `could not create the category '${name}'` }, 400);
        }
        categoryId = created.category.id;
      }
      toolName = "catalog.update_product";
      args = { handle, category_id: categoryId };
      summaryNoun = "category";
    } else {
      /* Variation NAME, price, and now its own unit cost — never sku:
         "these are generated automatically by Square and we should not be
         editing them... we don't need to see them in our ops dashboard."
         Every existing variation is always resent (its own variant_id,
         its current-or-edited title/price/cost, its unchanged currency) —
         mergeVariations (catalog-writer.js) keeps anything not mentioned,
         so this is never destructive even though the whole set is sent
         every time, matching how the header's own bulk-price/bulk-cost
         controls (the client's own job, not this route) already touched
         every row before Save was ever clicked. */
      const variations = [];
      for (let i = 0; form.has(`variant_id_${i}`); i += 1) {
        /* unit_cost_N is blank whenever the row rendered without a cost
           column at all (no vendor yet — views.js's own `hasVendor` gate)
           or the person simply left it as it was; either way, undefined
           means "leave this one's own cost alone," the same convention
           title/price already use one line up. Revised — "all the
           variants can have a different unit cost too" — so this is no
           longer one value for the whole product. */
        const unitCostRaw = String(form.get(`unit_cost_${i}`) ?? "").trim();
        variations.push({
          variant_id: String(form.get(`variant_id_${i}`) ?? "").trim(),
          title: String(form.get(`title_${i}`) ?? "").trim(),
          price_minor: parsePriceToMinor(String(form.get(`price_${i}`) ?? "").trim()),
          currency: String(form.get(`currency_${i}`) ?? "USD").trim(),
          ...(unitCostRaw !== "" ? { unit_cost_minor: parsePriceToMinor(unitCostRaw) } : {}),
        });
      }
      if (!variations.length) {
        return json({ error: "no variations to save" }, 400);
      }
      toolName = "catalog.update_product";
      args = { handle, variations };
      summaryNoun = "variations";
    }

    /* Applies immediately — no second, separate "Yes, do this" confirmation
       page. The owner's own words: "I'm still seeing confirmation dialogs
       whenever I try to add a custom field... I shouldn't have to do this
       every time." A person filling in this very form and clicking Save
       already IS the decision an approval click would otherwise ask them
       to make again, seconds later, as the same verified manager identity
       — parking it and redirecting to /approvals/<id> was asking them to
       approve their own already-privileged request. This is deliberately
       narrower than "T2 writes never need approval": an AGENT proposing
       catalog.set_channel or catalog.set_custom_fields conversationally
       (agent.js's own separate stashPending/PENDING flow, untouched here)
       still parks and waits for a human, because nobody has directly
       clicked Save on a form there — there is a real decision to review.
       Here there already was one. The tool's own check()/audit trail is
       unchanged either way; only the redundant second click is gone.

       A REFUSAL is JSON, not a refusalPage — the owner's own words: "I
       don't want these errors to send me to a new page. They need to
       validate input like the style ID." A check() refusal (a malformed
       style_id, a vendor with no commission, unit_cost with no vendor —
       none of it knowable purely from a client-side <input pattern>, since
       several of these rules depend on the PRODUCT's current state or
       another vendor's own name already in the mirror) can only be found
       out from the server, but the tile it came from is still worth
       staying on — the enhance-forms script below fetches this route and
       shows the message inline, next to the field that was refused,
       instead of navigating there. Every pre-flight refusal above this
       point (role, method, unreadable body) stays a refusalPage: none of
       them are reachable through this form in normal use — canEdit already
       hides the form from anyone the role check would refuse — so they are
       defense against a request that didn't come from this UI at all,
       where a plain page is the right response, not JSON a browser
       address-bar hit would just show as raw text. */
    const gate = await runTool(toolName, args, { actor: email, role, env });
    if (!gate?.needsApproval) {
      return json({ error: gate?.error || `That ${summaryNoun} change could not be proposed.` }, 400);
    }
    const result = await runTool(toolName, args, { actor: email, role, env, approvalToken: gate.data.approval.token });
    if (result?.error || result?.denied) {
      return json({ error: result.error || result.denied || `That ${summaryNoun} change was refused.` }, 400);
    }
    /* The stock stepper updates its own field in place rather than
       reloading the whole page (a stepper implies rapid repeat clicks) —
       it needs the resulting count back to do that, so this is the one
       route on this tile that answers with JSON on success instead of the
       303 every resend-everything form still uses. */
    if (suffix === "/inventory") {
      return json({ on_hand: result.data.on_hand });
    }
    /* Both categories routes answer with JSON, not a redirect — the page
       script below fetches them directly (not through a <form>, the same
       reason the stock stepper does not use one either) and decides for
       itself what to update. */
    if (suffix === "/categories/create" || suffix === "/categories/number") {
      return json(result.data);
    }
    return new Response(null, { status: 303, headers: { Location: "/items" } });
  }

  /*
   * /dashboard — the ops home page (Test-PRD-P0-108-ops_dashboard). Tickets,
   * tasks (tickets assigned to the viewer), expenses and dropped files in
   * one feed, over three already-existing T0 tools — no new store. The
   * ticket create/comment/status routes stay below, under /tickets/*; this
   * is only the list page the shell's own Dashboard tab opens.
   */
  if (path === "/dashboard") {
    if (request.method !== "GET") {
      return html(refusalPage(405, "This page is reached from the Dashboard tab."), 405);
    }
    const role = await roleFor(identity, env);
    if (!role) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return html(refusalPage(403, "This page requires signing in as a person, not a service token."), 403);
    }
    if (!env.TICKETS) {
      return html(refusalPage(503, "The tickets store is not configured on this deployment yet."), 503);
    }
    const actorCtx = { actor: email, role, env };

    const ticketsRes = await runTool("ticket.list", {}, actorCtx);
    if (!ticketsRes.ok) console.error(`ERROR ops/dashboard: ticket.list failed — ${ticketsRes.error}`);
    const tickets = ticketsRes.ok ? ticketsRes.data.tickets : [];

    /* Expenses and uploads are lower priority, "just there so that... you
       can find it" — a missing FINANCE/ASSETS binding on some deployment
       degrades to an empty section rather than refusing the whole page,
       the same graceful-per-source handling runTool's own missing_binding
       refusal already makes possible. */
    const expensesRes = await runTool("expense.list", {}, actorCtx);
    if (!expensesRes.ok) console.error(`ERROR ops/dashboard: expense.list failed — ${expensesRes.error}`);
    const expenses = expensesRes.ok ? expensesRes.data.expenses : [];

    const assetsRes = await runTool("assets.list", {}, actorCtx);
    if (!assetsRes.ok) console.error(`ERROR ops/dashboard: assets.list failed — ${assetsRes.error}`);
    const uploads = assetsRes.ok ? assetsRes.data.assets : [];

    /* The owner's own words: "by default, it should be on tasks...
       however, if there are any tickets, say from a customer, that
       should take precedence over tasks... in general you should
       default to tasks or tickets, whichever is not empty" — an open
       customer ticket still wins outright when one exists; otherwise
       auto-select whichever of Tasks/Tickets actually has something to
       show, rather than landing on an empty view by default. Judged
       against what the client's own default status filter will actually
       show (open only — P0-112), not the raw row count, so this never
       picks a mode that then renders empty once that filter applies. */
    const visibleTickets = tickets.filter((t) => t.status !== "closed");
    const hasOpenCustomerTicket = visibleTickets.some((t) => t.category === "customer" && t.status === "open");
    const hasTasks = visibleTickets.some((t) => t.assigned_to === email);
    const hasTickets = visibleTickets.length > 0;
    const defaultKind = hasOpenCustomerTicket ? "ticket" : hasTasks ? "task" : hasTickets ? "ticket" : "task";

    return html(dashboardPage({ tickets, expenses, uploads, viewerEmail: email, defaultKind }));
  }

  /*
   * /tickets — internal messages, staff to staff (Test-PRD-P0-100-ticket_messaging).
   * ticket.* (tools/tickets.js) validates and returns a PROPOSAL; every route
   * below is the human action that actually applies it — the same
   * "runTool proposes, a browser submission commits it" split
   * /expenses/new -> /expenses/confirm already uses. No manager gate: a
   * ticket carries no money and no employee record (tickets.js's own
   * minRole is staff everywhere), so anyone signed in may read, open, or
   * move one.
   */
  if (path === "/tickets" || path.startsWith("/tickets/")) {
    const role = await roleFor(identity, env);
    if (!role) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return html(refusalPage(403, "This page requires signing in as a person, not a service token."), 403);
    }
    if (!env.TICKETS) {
      return html(refusalPage(503, "The tickets store is not configured on this deployment yet."), 503);
    }
    const actorCtx = { actor: email, role, env };

    if (path === "/tickets") {
      const res = await runTool("ticket.list", {}, actorCtx);
      if (!res.ok) return html(refusalPage(500, res.error || "Could not read tickets."), 500);
      return html(ticketsPage(res.data.tickets));
    }

    if (path === "/tickets/new") {
      if (request.method !== "POST") {
        return html(refusalPage(405, "Start a ticket from the Dashboard tab, not this URL directly."), 405);
      }
      let form;
      try {
        form = await request.formData();
      } catch (err) {
        return html(refusalPage(400, `Unreadable submission — ${err.message}`), 400);
      }
      const gate = await runTool("ticket.create", { title: String(form.get("title") ?? "").trim() }, actorCtx);
      if (!gate.ok) {
        return html(refusalPage(400, gate.error || "That ticket could not be proposed."), 400);
      }
      const v = gate.data.proposal.values;
      const id = crypto.randomUUID();
      /* Dashboard mode selector (Test-PRD-P0-110-dashboard_modes): "when we
         type in something in the bar and then hit submit, that's a new
         ticket... in a task, that's a new task... but they should not be
         the same thing." A task IS a ticket, assigned at creation to the
         person who filed it — the same "assigned to me" signal the
         Dashboard's own Tasks view already reads (P0-108), never a fourth
         store or a new category value. assigned_to comes from the
         AUTHENTICATED actor, never the client's own "mode" field value —
         the form can only ask for "assign this to me," never name anyone
         else. */
      const assignedTo = String(form.get("mode") ?? "") === "task" ? email : null;
      try {
        const next = await env.TICKETS.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM ticket").first();
        await env.TICKETS.prepare(
          "INSERT INTO ticket(id, number, title, body, category, priority, status, created_by, assigned_to) VALUES (?,?,?,?,?,?,?,?,?)",
        )
          .bind(id, next.number, v.title, v.body, v.category, v.priority, v.status, v.created_by, assignedTo)
          .run();
      } catch (err) {
        console.error(`ERROR ops/tickets: proposal validated but the row could not be written — ${err.message}`);
        return html(refusalPage(500, "Validated but could not be filed. Try again."), 500);
      }
      return new Response(null, { status: 303, headers: { Location: `/tickets/${id}` } });
    }

    const isComment = path.endsWith("/comment");
    const isStatus = path.endsWith("/status");
    const ticketId = path.slice(
      "/tickets/".length,
      isComment ? path.length - "/comment".length : isStatus ? path.length - "/status".length : path.length,
    );

    const showTicket = async (status, error) => {
      const detail = await runTool("ticket.get", { ticket_id: ticketId }, actorCtx);
      if (!detail.ok) return html(refusalPage(404, detail.error || "No such ticket."), 404);
      return html(ticketPage(detail.data.ticket, detail.data.comments, { error }), status);
    };

    if (isComment || isStatus) {
      if (request.method !== "POST") {
        return html(refusalPage(405, "Comment or update a ticket from its own page, not this URL directly."), 405);
      }
      let form;
      try {
        form = await request.formData();
      } catch (err) {
        return html(refusalPage(400, `Unreadable submission — ${err.message}`), 400);
      }

      if (isComment) {
        const gate = await runTool(
          "ticket.comment",
          { ticket_id: ticketId, body: String(form.get("body") ?? "").trim() },
          actorCtx,
        );
        if (!gate.ok) return showTicket(400, gate.error);
        const v = gate.data.proposal.values;
        try {
          await env.TICKETS.prepare("INSERT INTO ticket_comment(id, ticket_id, author, body) VALUES (?,?,?,?)")
            .bind(crypto.randomUUID(), v.ticket_id, v.author, v.body)
            .run();
        } catch (err) {
          console.error(`ERROR ops/tickets: comment validated but the row could not be written — ${err.message}`);
          return html(refusalPage(500, "Validated but could not be posted. Try again."), 500);
        }
        return new Response(null, { status: 303, headers: { Location: `/tickets/${ticketId}` } });
      }

      /* isStatus */
      const note = String(form.get("note") ?? "").trim();
      const gate = await runTool(
        "ticket.set_status",
        { ticket_id: ticketId, status: String(form.get("status") ?? ""), note: note || undefined },
        actorCtx,
      );
      if (!gate.ok) return showTicket(400, gate.error);
      const v = gate.data.proposal.values;
      try {
        const now = new Date().toISOString();
        const resolving = ["resolved", "closed"].includes(v.status);
        const sets = ["status = ?", "updated_at = ?"];
        const binds = [v.status, now];
        if (resolving) {
          sets.push("resolved_at = ?");
          binds.push(now);
        }
        binds.push(v.ticket_id);
        await env.TICKETS.prepare(`UPDATE ticket SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        if (v.note) {
          await env.TICKETS.prepare("INSERT INTO ticket_comment(id, ticket_id, author, body) VALUES (?,?,?,?)")
            .bind(crypto.randomUUID(), v.ticket_id, email, v.note)
            .run();
        }
      } catch (err) {
        console.error(`ERROR ops/tickets: status change validated but could not be written — ${err.message}`);
        return html(refusalPage(500, "Validated but could not be saved. Try again."), 500);
      }
      return new Response(null, { status: 303, headers: { Location: `/tickets/${ticketId}` } });
    }

    if (request.method !== "GET") {
      return html(refusalPage(405, "This page is reached from a ticket's own link on the Dashboard tab."), 405);
    }
    return showTicket(200);
  }

  /*
   * /assets — the employee asset drop site. Any signed-in role, no manager
   * gate: these are working documents, not a Square write (unlike
   * /products/batch and /customers/batch, which do gate on manager because
   * catalog.create_product and customer.create refuse below it anyway).
   *
   *   /assets/new    GET the upload form, POST a file      (a person, browser only)
   *   /assets/<id>   GET the original bytes back            (a person, or a link an agent hands out)
   *   /assets        GET a plain list, for a person browsing without an assistant
   */
  if (path === "/assets/new" || path === "/assets" || (path.startsWith("/assets/") && path !== "/assets/new")) {
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return html(refusalPage(403, "This page requires signing in as a person, not a service token."), 403);
    }
    if (!(await roleFor(identity, env))) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }

    if (path === "/assets") {
      if (!env.ASSETS) return html(refusalPage(503, "The asset drop site is not configured on this deployment yet."), 503);
      const { results } = await env.ASSETS.prepare(
        "SELECT id, filename, content_type, size_bytes, uploaded_by, uploaded_at FROM asset ORDER BY uploaded_at DESC LIMIT ?",
      )
        .bind(CAPS.ASSET_LIST_MAX_ROWS)
        .all();
      return html(assetListPage(results ?? []));
    }

    if (path === "/assets/new") {
      if (request.method === "GET") return html(assetUploadPage());
      if (request.method !== "POST") {
        return html(refusalPage(405, "Upload a file to this page, or open it in a browser."), 405);
      }
      if (!env.ASSETS) {
        return html(refusalPage(503, "The asset drop site is not configured on this deployment yet."), 503);
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
      if (file.size > CAPS.ASSET_MAX_BYTES) {
        return html(refusalPage(413, `That file is larger than the ${CAPS.ASSET_MAX_BYTES}-byte limit.`), 413);
      }
      const contentType = contentTypeForAsset(file.name, file.type);
      if (!contentType) {
        return html(
          refusalPage(
            415,
            `"${file.name}" is not a file type this drop site takes yet. Try .txt, .md, .csv, .json, .pdf, ` +
              "a spreadsheet, or a Word document.",
          ),
          415,
        );
      }

      let files;
      try {
        files = assetFileStoreFor(env);
      } catch (err) {
        console.error(`ERROR ops/assets: ${err.message}`);
        return html(refusalPage(503, "File storage is not configured on this deployment yet."), 503);
      }

      const id = crypto.randomUUID();
      const key = `assets/${id}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        await files.put(key, bytes);
      } catch (err) {
        return html(refusalPage(413, err.message), 413);
      }

      const extracted = extractText(contentType, bytes);
      try {
        await env.ASSETS.prepare(
          "INSERT INTO asset(id, store_key, filename, content_type, size_bytes, uploaded_by, extracted_text, text_truncated)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(id, key, file.name, contentType, bytes.byteLength, email, extracted?.text ?? null, extracted?.truncated ? 1 : 0)
          .run();
      } catch (err) {
        console.error(`ERROR ops/assets: stored ${key} but could not record it — ${err.message}`);
        return html(refusalPage(500, "Stored the file but could not record it. Try again."), 500);
      }

      return html(assetUploadedPage({ id, filename: file.name, hasText: Boolean(extracted) }));
    }

    /* /assets/<id> — the download route. */
    const id = path.slice("/assets/".length);
    if (!env.ASSETS) return html(refusalPage(503, "The asset drop site is not configured on this deployment yet."), 503);
    const row = await env.ASSETS.prepare("SELECT store_key, filename, content_type FROM asset WHERE id = ?").bind(id).first();
    if (!row) return html(refusalPage(404, "No such file."), 404);

    let files;
    try {
      files = assetFileStoreFor(env);
    } catch (err) {
      console.error(`ERROR ops/assets: ${err.message}`);
      return html(refusalPage(503, "File storage is not configured on this deployment yet."), 503);
    }
    const bytes = await files.bytes(row.store_key);
    if (!bytes) {
      console.error(`ERROR ops/assets: asset ${id} has a record but no bytes at ${row.store_key}`);
      return html(refusalPage(404, "The file's record exists but its bytes are missing."), 404);
    }
    return new Response(bytes, {
      headers: {
        "content-type": row.content_type,
        "content-disposition": `inline; filename="${row.filename.replace(/["\\]/g, "_")}"`,
      },
    });
  }

  /*
   * /expenses/new -> /expenses/confirm — scan a receipt, file an expense.
   *
   * Any signed-in role, same as /assets: filing your OWN expense is not the
   * gated action here, approving one is (expense.approve, manager+, already
   * T2). A photo is stored first, then Workers AI takes a best-effort read
   * of it (finance-skills rule 4: OCR prefills, it never files) — the person
   * always sees and can correct every field on the confirm page before
   * anything reaches the `finance` store, exactly the same "review, then
   * submit" shape as the approval-forms.js editable fields.
   */
  if (path === "/expenses/new" || path === "/expenses/confirm") {
    const email = identity.claims?.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return html(refusalPage(403, "This page requires signing in as a person, not a service token."), 403);
    }
    const role = await roleFor(identity, env);
    if (!role) {
      return html(refusalPage(403, "Your Access identity is in no group this application maps to a role."), 403);
    }

    if (path === "/expenses/new") {
      if (request.method === "GET") return html(receiptUploadPage());
      if (request.method !== "POST") {
        return html(refusalPage(405, "Upload a photo to this page, or open it in a browser."), 405);
      }
      if (!env.FINANCE) {
        return html(refusalPage(503, "The expense store is not configured on this deployment yet."), 503);
      }

      let file;
      try {
        const form = await request.formData();
        file = form.get("file");
      } catch (err) {
        return html(refusalPage(400, `Unreadable upload — ${err.message}`), 400);
      }
      if (!(file instanceof File) || file.size === 0) {
        return html(refusalPage(400, "No photo was attached."), 400);
      }
      if (file.size > CAPS.RECEIPT_MAX_BYTES) {
        return html(refusalPage(413, `That photo is larger than the ${CAPS.RECEIPT_MAX_BYTES}-byte limit.`), 413);
      }
      const contentType = contentTypeFor(file.name, file.type);
      if (!contentType) {
        return html(refusalPage(415, `"${file.name}" is not a photo type this scanner takes. Try a JPEG, PNG or HEIC.`), 415);
      }

      let receipts;
      try {
        receipts = receiptFileStoreFor(env);
      } catch (err) {
        console.error(`ERROR ops/expenses: ${err.message}`);
        return html(refusalPage(503, "Receipt storage is not configured on this deployment yet."), 503);
      }

      const key = `receipts/${crypto.randomUUID()}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        await receipts.put(key, bytes);
      } catch (err) {
        return html(refusalPage(413, err.message), 413);
      }

      const ocr = await scanReceipt(env, bytes);
      return html(expenseConfirmPage({ receiptKey: key, ...ocr }));
    }

    /* /expenses/confirm — a person accepting or correcting the OCR guess. */
    if (request.method !== "POST") {
      return html(refusalPage(405, "This page is reached from /expenses/new."), 405);
    }
    let form;
    try {
      form = await request.formData();
    } catch (err) {
      return html(refusalPage(400, `Unreadable submission — ${err.message}`), 400);
    }
    const receiptKey = String(form.get("receipt_key") || "");
    const description = String(form.get("description") || "").trim();
    const currency = String(form.get("currency") || "").trim().toUpperCase();
    const incurredOn = String(form.get("incurred_on") || "").trim();
    const amountMinor = parsePriceToMinor(form.get("amount"));
    if (amountMinor === null) {
      return html(
        expenseConfirmPage({
          receiptKey,
          description,
          currency,
          incurred_on: incurredOn,
          amount_minor: null,
          error: `"${form.get("amount")}" is not a plain amount like 42.50`,
        }),
        400,
      );
    }

    const res = await runTool(
      "expense.submit",
      { description, amount_minor: amountMinor, currency, incurred_on: incurredOn, receipt_key: receiptKey },
      { actor: email, role, env },
    );
    if (!res.ok) {
      return html(
        expenseConfirmPage({
          receiptKey,
          description,
          currency,
          incurred_on: incurredOn,
          amount_minor: amountMinor,
          error: res.error,
        }),
        400,
      );
    }

    const id = crypto.randomUUID();
    const v = res.data.proposal.values;
    try {
      await env.FINANCE.prepare(
        "INSERT INTO expense(id, budget_id, vendor_id, employee_id, employee_name, description," +
          " amount_minor, currency, incurred_on, status, receipt_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          id,
          v.budget_id,
          v.vendor_id,
          v.employee_id,
          v.employee_name,
          v.description,
          v.amount_minor,
          v.currency,
          v.incurred_on,
          v.status,
          v.receipt_key,
        )
        .run();
    } catch (err) {
      console.error(`ERROR ops/expenses: proposal validated but the row could not be written — ${err.message}`);
      return html(refusalPage(500, "Validated but could not be filed. Try again."), 500);
    }

    return html(expenseFiledPage({ id, description: v.description, amount_minor: v.amount_minor, currency: v.currency }));
  }

  if (path === "/agent") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let q = "";
    let rawFile = null;
    try {
      const parsed = await body(request);
      q = String(parsed.q || "");
      if (parsed.file instanceof File && parsed.file.size > 0) rawFile = parsed.file;
    } catch (err) {
      console.error(`ERROR ops/agent: unreadable body — ${err.message}`);
      return json({ error: "Unreadable request body." }, 400);
    }

    let attachment = null;
    if (rawFile) {
      const email = identity.claims?.email;
      if (typeof email !== "string" || !email.includes("@")) {
        return json({ error: "This route requires a per-user Access identity." }, 403);
      }
      const ingested = await ingestAgentAttachment(env, { file: rawFile, email });
      if (ingested.error) return json({ error: ingested.error }, ingested.status ?? 400);
      attachment = ingested;
    }

    const turn = await agentTurn({ q, identity, env, attachment });
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
    const role = await roleFor(identity, env);
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
      /* A write parked from the Items tab sends the person back there rather
         than to the generic "Back to ops" (agent) link every other approval
         uses — they came from a tile, not from chat. */
      const backToItems = ITEMS_TAB_TOOLS.has(pendingBefore.pending?.tool);
      return html(
        approvalResultPage(
          Boolean(out.ok),
          out.ok ? out.result ?? out : out.error,
          backToItems ? { backHref: "/items", backLabel: "Back to Items" } : undefined,
        ),
        out.ok ? 200 : 403,
      );
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
    const detail = await explainRole(identity, env);
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

  /*
   * / — the shell. The owner's own words: "I WANT tabs in the header...
   * the header is always present. Everything else is an iframe." One
   * persistent header (the tab bar) that never reloads, and one <iframe>
   * beneath it whose src swaps between the tabs' own ordinary pages —
   * /chat and /items are unchanged content, just no longer drawing their
   * OWN copy of the tab bar (shellPage() is the only place it is drawn
   * now). `?tab=items` picks which one loads first, so a link can still
   * point at a specific tab without a second, tab-shaped page for each.
   * Named /chat, not /agent: `/agent` (below) is already the chat form's
   * OWN POST endpoint, and giving this page the same path would make it
   * unreachable — shadowed by that earlier, POST-only handler.
   */
  if (path === "" || path === "/") {
    /* No role gate here on purpose — matching how this page has always
       behaved. A verified-but-unmapped identity still gets the shell, and
       /chat (loaded into it by default) is what already tells that person
       plainly that they have no role, the same as before this page split
       into a shell and a tab's own content. */
    const requestedTab = new URL(request.url).searchParams.get("tab");
    const tab = ["items", "dashboard", "website"].includes(requestedTab) ? requestedTab : "agent";
    return html(shellPage(tab));
  }

  if (path === "/chat") {
    /*
     * `env` was missing from this call, and from the two in agent.js. roleFor
     * defaults it to {}, so OWNER_POLICY_ID and its siblings read as undefined
     * and the policy branch could never match — which is the ONLY branch that
     * fires here, because Access Groups are not claims. Every signed-in person
     * saw role `null` and an empty tool list on the page that is supposed to
     * tell them what they can do. The argument, not the rule, was wrong.
     * Test-PRD-P0-23-group_derived_roles.
     */
    const detail = await explainRole(identity, env);
    return html(
      opsPage(identity, {
        role: detail.role,
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

    /*
     * The media backfill (Test-PRD-P0-73-real_photography) is a SEPARATE step
     * with its own failure mode, run after the sync rather than folded into
     * it: a photograph that fails to fetch must never mark the catalog sync
     * itself as failed, and a sync that fails must not stop the previous
     * run's photographs from still backfilling on schedule. try/catch here,
     * not inside backfillMedia, so a bug in this wiring cannot take the cron
     * down with it — the next run tries again regardless.
     */
    try {
      /* Checked directly rather than via mediaStoreFor(env): with no bucket
         bound, mediaStoreFor falls back to constructing a Square uploader,
         which throws with no SQUARE_ACCESS_TOKEN — a real, if unlikely,
         possibility on a Worker whose sync has never run. There is nothing
         for this step to do without a bucket regardless, so it never needs
         to reach that construction at all. */
      if (env.MEDIA) {
        const backfill = await backfillMedia(env, { media: mediaStoreFor(env) });
        if (backfill.attempted > 0) {
          console.info(
            `INFO ops/scheduled: media backfill -> ${backfill.backfilled}/${backfill.attempted} ok, ${backfill.failed} failed`,
          );
        }
      }
    } catch (err) {
      console.error(`ERROR ops/scheduled: media backfill step did not run — ${err.message}`);
    }

    /*
     * Contact-form intake (Test-PRD-P0-100-ticket_messaging) — the same
     * independent-step shape as the media backfill just above, for the same
     * reason: a failure here must never mark the catalog sync itself
     * failed, and a sync failure must not stop a contact-form submission
     * from still becoming a ticket on schedule.
     */
    try {
      if (env.TICKETS) {
        const intake = await intakeContactTickets(env);
        if (intake.ok && intake.created > 0) {
          console.info(`INFO ops/scheduled: contact intake -> ${intake.created} new ticket(s)`);
        }
      }
    } catch (err) {
      console.error(`ERROR ops/scheduled: contact intake step did not run — ${err.message}`);
    }

    return out;
  },
};
