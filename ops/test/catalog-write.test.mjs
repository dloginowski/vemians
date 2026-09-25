/*
 * Agentic catalog authoring — PRD-backed regression checks.
 *
 *     Run: node --test test/            (from ops/)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD / TEST CONTRACT — read before editing this file
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/PRD.md` is the driving design document. Every check here exists to
 * enforce a NUMBERED PRD FEATURE as written there — not an implementation
 * detail, and not "a thing the code happens to do".
 *
 *   * Each check is named  test_PRD_P0_NN_short_id__specific_behaviour  and so
 *     carries the visible label  Test-PRD-P0-NN-short_id.
 *   * That label MUST exist in docs/PRD.md. The last check in this file
 *     (P0-30) parses THIS FILE's own check names and asserts it, so an invented
 *     or renamed label fails the run instead of drifting silently.
 *   * UNLABELED CHECKS ARE NOT ACCEPTABLE. A new guarantee needs a PRD feature
 *     first; if there is no feature for it, write the feature. The closed
 *     category set had none, so Test-PRD-P0-40-closed_category_set was written
 *     in the same change as the tools below.
 *   * When behaviour changes, the PRD feature and its labeled check move in the
 *     SAME change as the code. A tool edit with a stale PRD is a process
 *     failure, not a follow-up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MECHANICS, AND WHAT IS AND IS NOT PROVEN HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The REAL schemas are loaded into in-memory node:sqlite databases — D1 IS
 * SQLite, and the mirror's archive-only triggers and index views carry half the
 * guarantees. `shared/commerce/square/schema.sql` and `shared/db/audit.sql` are
 * loaded unmodified.
 *
 * NO SQUARE ACCOUNT, TOKEN OR NETWORK CALL IS INVOLVED, and none is claimed.
 * `fakeSquare` below is a stub catalog server: it accepts UpsertCatalogObject
 * and CreateCatalogImage, assigns ids the way Square does (`#temp` in,
 * `id_mappings` out), and serves the result back on SearchCatalogObjects. So
 * the REAL client, the REAL adapter, the REAL mirror and the REAL tools all run
 * — what is faked is the far side of the wire. What that proves is the ordering
 * (Square first, mirror second), the refusals, the id hygiene and the audit
 * rows. What it CANNOT prove is that Square's live API accepts these bodies;
 * only a sandbox token can, and there is none here.
 *
 * R2 is faked the same way — an in-memory Map behind the R2 binding's shape.
 * The one thing not faked is cryptography: upload-ticket signatures are real
 * HMAC-SHA256 through WebCrypto, because a recorded signature would only prove
 * that a constant equals itself.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

import { runTool, TOOLS, STORE_BINDINGS, RESOURCES, describeTools } from "../src/tools/index.js";
import { createApprovalStore } from "../src/tools/approval.js";
import { createRateLimiter } from "../src/tools/rate.js";
import { CAPS } from "../src/tools/caps.js";
import { createSquareCatalogWriter, effectiveCategoryItemOptionIds } from "../src/tools/catalog-writer.js";
import {
  createMediaStore,
  createSquareMediaStore,
  mediaKey,
  mintUploadTicket,
  verifyUploadTicket,
} from "../src/tools/media.js";
import { nearestCategory, suggestCategory, validateProposal } from "../src/tools/catalog-write.js";
import { normaliseCatalog } from "../../shared/commerce/square/catalog.js";

/* index.js (imported further down for the real-Worker checks) reaches
   agent.js, which reaches skills.js, which reads SKILL.md files — so the
   text-module loader is registered here, before any of those imports run. */
register("../../shared/test/text-modules.mjs", import.meta.url);
const { approvePending, parkForApproval } = await import("../src/approvals.js");
const { draftProductBatch } = await import("../src/batch.js");
const { dispatch, NO_TEXT_TABLE_NOTE } = await import("../src/agent.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.join(HERE, "..");
const REPO = path.join(OPS, "..");
const DB_DIR = path.join(REPO, "shared", "db");
const SQUARE_DIR = path.join(REPO, "shared", "commerce", "square");
const PRD = path.join(REPO, "docs", "PRD.md");
const TOOLS_DIR = path.join(OPS, "src", "tools");
const FIXTURES = path.join(HERE, "fixtures");

const SEED = JSON.parse(fs.readFileSync(path.join(FIXTURES, "square-catalog.json"), "utf8")).objects;

/* ── labels, for the P0-30 traceability check ───────────────────────────── */

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

/* Every check registers through here, so nothing unlabeled can run. */
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* ── a D1 binding, over the real schemas ────────────────────────────────── */

function d1FromSql(sql) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(sql);

  const wrap = (text) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async all() {
        return { success: true, results: db.prepare(text).all(...bound) };
      },
      async first(column) {
        const row = db.prepare(text).get(...bound);
        if (row === undefined) return null;
        return column === undefined ? row : row[column];
      },
      async run() {
        const r = db.prepare(text).run(...bound);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db };
}

const MIRROR_SQL = fs.readFileSync(path.join(SQUARE_DIR, "schema.sql"), "utf8");
const AUDIT_SQL = fs.readFileSync(path.join(DB_DIR, "audit.sql"), "utf8");

/* ── the stub Square ────────────────────────────────────────────────────── */

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/*
 * A catalog server that behaves the way Square documents: `#temp` ids in an
 * upsert come back through `id_mappings`, versions increment, and a
 * SearchCatalogObjects afterwards returns what the upsert created. Every call
 * is recorded IN ORDER, which is what makes "Square first, mirror second" an
 * assertion about a list rather than a hope.
 */
function fakeSquare(seed = SEED, { vendors = [], failSearch = false, failUpsert = null } = {}) {
  const objects = new Map(seed.map((o) => [o.id, structuredClone(o)]));
  const vendorObjects = new Map(vendors.map((v) => [v.id, structuredClone(v)]));
  const inventoryCounts = new Map();
  const calls = [];
  let seq = 0;
  const mint = (prefix) => `${prefix}_${(seq += 1)}`;

  const impl = async (url, init = {}) => {
    const p = new URL(url).pathname;
    const method = init.method ?? "GET";
    const record = { method, path: p };
    calls.push(record);

    if (p === "/v2/catalog/list") return jsonRes({ objects: [...objects.values()] });
    if (p === "/v2/catalog/search") {
      /* catalog.set_active's own immediate post-write resync (syncAfterWrite
         -> pullCatalog({full:false})) uses this same incremental search —
         failSearch models it answering unreachable, the way a real flaky
         resync would, without touching the SEED sync that already ran. */
      if (failSearch) throw new Error("simulated network failure");
      return jsonRes({ objects: [...objects.values()], related_objects: [] });
    }

    /* RetrieveCatalogObject — GET, one object by id, a path segment rather
       than a body. catalog.set_active's own safe archive/restore path
       (setProductPresence, shared/commerce/square/index.js) reads the whole
       object here before flipping only its presence fields, so an object
       that has never been upserted through THIS fake would 404, the same
       as a real handle Square has never seen. */
    if (p.startsWith("/v2/catalog/object/") && method === "GET") {
      const id = p.slice("/v2/catalog/object/".length);
      const obj = objects.get(id);
      if (!obj) return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }, 404);
      return jsonRes({ object: obj });
    }

    /* DeleteCatalogObject — the real production error this fake now models:
       "Object of type CATEGORY cannot be disabled." A CATEGORY has no
       presence lifecycle at all in Square, unlike ITEM — removeCategory's
       own real fix is a genuine DELETE, never a disable-via-POST. Kept as
       a soft is_deleted flag (never actually removed from `objects`), the
       same "still visible with include_deleted_objects, tells sync apart
       from never-synced" shape catalog.js's own comment describes. */
    if (p.startsWith("/v2/catalog/object/") && method === "DELETE") {
      const id = p.slice("/v2/catalog/object/".length);
      const obj = objects.get(id);
      if (!obj) return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }, 404);
      obj.is_deleted = true;
      return jsonRes({ deleted_object_ids: [id], deleted_at: new Date().toISOString() });
    }

    if (p === "/v2/catalog/object") {
      const body = JSON.parse(init.body);
      record.body = body;
      /* Models a REAL Square rejection — a 400 with its own detailed
         errors array — rather than the fake server's usual unconditional
         success, for the one test that proves that detail (category/code/
         field) actually reaches runTool's own returned error string
         instead of being dropped at "failed with 400". */
      if (failUpsert) return jsonRes({ errors: failUpsert }, 400);
      /* The real bug this whole handler is now guarding against: Square
         rejects a CATEGORY object upsert that tries to disable it via
         present_at_all_locations: false — "Object of type CATEGORY cannot
         be disabled." A regression back to removeCategory's old
         GET-then-POST-disable approach must fail exactly this way, not
         silently succeed against a fake that doesn't know the real rule. */
      if (body.object?.type === "CATEGORY" && body.object?.present_at_all_locations === false) {
        return jsonRes(
          {
            errors: [
              {
                category: "INVALID_REQUEST_ERROR",
                code: "INVALID_VALUE",
                detail: `Invalid object: Invalid Object with Id: ${body.object.id}. Object of type CATEGORY cannot be disabled.`,
              },
            ],
          },
          400,
        );
      }
      const obj = structuredClone(body.object);
      record.upsert = obj.type;
      const mappings = [];
      const assign = (o, prefix) => {
        if (String(o.id).startsWith("#")) {
          const real = mint(prefix);
          mappings.push({ client_object_id: o.id, object_id: real });
          o.id = real;
        }
        o.version = Number(o.version ?? 0) + 1;
      };
      assign(obj, obj.type === "CATEGORY" ? "CAT" : obj.type === "ITEM_OPTION" ? "OPT" : "ITEM");
      for (const v of obj.item_data?.variations ?? []) {
        assign(v, "VAR");
        v.item_variation_data.item_id = obj.id;
      }
      /* A brand-new ITEM_OPTION's own values arrive the same way a brand-new
         ITEM's own variations do — nested, with their own #temp ids that
         need resolving and their own parent FK (item_option_id) fixed up
         to the now-real parent id, whether the parent itself was also
         brand new this call or already existed. */
      for (const v of obj.item_option_data?.values ?? []) {
        assign(v, "OPTVAL");
        v.item_option_value_data.item_option_id = obj.id;
      }
      /* An upsert does not drop images Square already holds for the item. */
      const prev = objects.get(obj.id);
      if (obj.item_data && prev?.item_data?.image_ids) {
        obj.item_data.image_ids = [
          ...new Set([...(prev.item_data.image_ids ?? []), ...(obj.item_data.image_ids ?? [])]),
        ];
      }
      objects.set(obj.id, obj);
      return jsonRes({ catalog_object: obj, id_mappings: mappings });
    }

    if (p === "/v2/catalog/images") {
      const form = init.body;
      assert.ok(form instanceof FormData, "CreateCatalogImage must be multipart/form-data");
      const req = JSON.parse(await form.get("request").text());
      const file = form.get("image_file");
      const item = objects.get(req.object_id);
      if (!item) return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }, 404);
      const id = mint("IMG");
      objects.set(id, {
        id,
        type: "IMAGE",
        version: 1,
        present_at_all_locations: true,
        image_data: { url: `https://items-images.example/${id}.jpg`, caption: req.image.image_data.caption },
      });
      item.item_data.image_ids = [...(item.item_data.image_ids ?? []), id];
      record.imageBytes = (await file.arrayBuffer()).byteLength;
      record.imageType = file.type;
      record.objectId = req.object_id;
      return jsonRes({ image: objects.get(id) });
    }

    /* Square's Vendor entity — a wholly separate API from everything above,
       Test-PRD-P0-136-square_custom_attributes (revised for Retail Plus). */
    if (p === "/v2/vendors/search") return jsonRes({ vendors: [...vendorObjects.values()] });
    if (p === "/v2/vendors/create") {
      const body = JSON.parse(init.body);
      record.body = body;
      const id = mint("VENDOR");
      const vendor = { id, name: body.vendor?.name ?? "", status: "ACTIVE", version: 1 };
      vendorObjects.set(id, vendor);
      return jsonRes({ vendor });
    }

    /* Just enough of the inventory API for catalog.create_product's own
       initial-quantity push (VARIATION_WITH_OPTIONS' own `quantity`,
       catalog-write.js) to round-trip — the same two calls
       inventory.adjust's own run() makes (push, then pull to sync). */
    if (p === "/v2/inventory/changes/batch-create") {
      const body = JSON.parse(init.body);
      record.body = body;
      for (const c of body.changes ?? []) {
        if (c.type !== "PHYSICAL_COUNT") continue;
        inventoryCounts.set(c.physical_count.catalog_object_id, Number(c.physical_count.quantity));
      }
      return jsonRes({ counts: [] });
    }
    if (p === "/v2/inventory/changes/batch-retrieve") {
      const body = JSON.parse(init.body);
      record.body = body;
      const ids = body.catalog_object_ids ?? [];
      const changes = ids
        .filter((id) => inventoryCounts.has(id))
        .map((id, i) => ({
          type: "PHYSICAL_COUNT",
          physical_count: { id: `PC_${i}`, catalog_object_id: id, quantity: String(inventoryCounts.get(id)) },
        }));
      return jsonRes({ changes });
    }

    return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }, 404);
  };

  impl.calls = calls;
  impl.objects = objects;
  impl.vendors = vendorObjects;
  impl.writes = () => calls.filter((c) => c.path === "/v2/catalog/object" || c.path === "/v2/catalog/images");
  return impl;
}

/* ── the stub R2 ────────────────────────────────────────────────────────── */

function fakeR2() {
  const store = new Map();
  return {
    async put(key, body, opts = {}) {
      store.set(key, { body, httpMetadata: opts.httpMetadata ?? {}, customMetadata: opts.customMetadata ?? {} });
    },
    async head(key) {
      const o = store.get(key);
      return o ? { size: o.body.byteLength, httpMetadata: o.httpMetadata, uploaded: new Date() } : null;
    },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return {
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
        async arrayBuffer() {
          return o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength);
        },
      };
    },
    _store: store,
  };
}

const SQUARE_LOCATION = "LOC_SQUARE_MAIN";
const SIGNING_KEY = "fixture-media-signing-key-not-a-real-one";

function squareEnv() {
  return {
    SQUARE_ACCESS_TOKEN: "fixture-token",
    SQUARE_ENV: "sandbox",
    SQUARE_LOCATION_ID: SQUARE_LOCATION,
    MEDIA_SIGNING_KEY: SIGNING_KEY,
    OPS_HOST: "ops.vemians.com",
  };
}

/* One place to build a ctx, so no check can accidentally invent an actor. */
async function fixture({ actor = "mara@vemians.com", role = "manager", seedMirror = true, failSearch = false, failUpsert = null } = {}) {
  const square = fakeSquare(SEED, { failSearch, failUpsert });
  const mirrorDb = d1FromSql(MIRROR_SQL);
  const auditDb = d1FromSql(AUDIT_SQL);
  const bucket = fakeR2();
  const env = { CATALOG_MIRROR: mirrorDb, AUDIT: auditDb, ...squareEnv() };

  const writer = createSquareCatalogWriter(squareEnv(), {
    mirrorDb,
    commerceDb: null,
    /* No retry sleeping in a test run; the client's backoff is proven in the
       adapter's own suite. */
    clientOptions: { fetchImpl: square, sleep: async () => {}, maxAttempts: 1 },
    uploaderOptions: { fetchImpl: square, sleep: async () => {} },
  });
  const media = createMediaStore(bucket, squareEnv());

  /* The shop as it stands: mirrored FROM Square by a full sync, which is how a
     first sync actually happens. Nothing below writes a mirror row by hand. */
  if (seedMirror) await writer.adapter.pullCatalog({ full: true });
  const seededCalls = square.calls.length;

  return {
    square,
    mirrorDb,
    auditDb,
    bucket,
    media,
    writer,
    env,
    ctx: {
      actor,
      role,
      env,
      approvals: createApprovalStore(),
      rate: createRateLimiter(),
      square: writer,
      media,
    },
    /* Square calls made SINCE the seed sync — the ones a check is about. */
    calls: () => square.calls.slice(seededCalls),
    audit: (where = "") => auditDb._raw.prepare(`SELECT * FROM audit_log ${where} ORDER BY id`).all(),
    mirror: (sql, ...params) => mirrorDb._raw.prepare(sql).all(...params),
    categories: () =>
      mirrorDb._raw.prepare("SELECT id, name, parent_id, numeric_id FROM mirror_category_index ORDER BY name").all(),
  };
}

const staff = { actor: "ana@vemians.com", role: "staff" };

/* A tiny PNG-shaped byte string. Nothing here decodes it; it exists to have a
   length, a content type and a place in R2. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/* Put an original in R2 the way catalog.upload_image does, and return its key. */
async function uploadInline(f, { filename = "front.png", bytes = PNG_BYTES, ctx } = {}) {
  const res = await runTool(
    "catalog.upload_image",
    { filename, bytes_base64: b64(bytes) },
    ctx ?? f.ctx,
  );
  assert.equal(res.ok, true, res.error);
  return res.data.key;
}

const COAT = {
  title: "Belted gabardine trench coat",
  description: "Cotton gabardine, storm shield, horn buttons.",
  variations: [
    { title: "IT 38", sku: "VEM-0009-38", price_minor: 189000, currency: "USD" },
    { title: "IT 42", sku: "VEM-0009-42", price_minor: 189000, currency: "USD" },
  ],
};

/* Ask for a T2, then spend the token it issues. The token is issued by the
   registry, never composed here — that is the whole point of the gate. */
async function approvedCall(f, name, args, ctx) {
  const gate = await runTool(name, args, ctx ?? f.ctx);
  assert.equal(gate.needsApproval, true, "a T2 call must ask first");
  return runTool(name, args, { ...(ctx ?? f.ctx), approvalToken: gate.data.approval.token });
}

/* ─────────────────────────────────────────────────────────────────────────
 * P0-35 — the browser approval route must actually run the write
 *
 * This is the regression for a bug this exact suite would have caught had it
 * ever driven /approvals/ end to end: approvePending() minted a random,
 * never-issued token and handed it straight to consume(), which can only
 * ever answer "unknown_or_used_token". Every browser approval for an
 * MCP-parked T2 call silently re-issued an invisible internal token and
 * returned needsApproval again — nothing a person clicked "Approve and run"
 * on ever reached Square. Fixed by having approvePending() run the same
 * issue-then-consume dance a same-session caller does.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_35_approval_never_in_band__clicking_approve_actually_creates_the_product", async () => {
  const f = await fixture({ actor: "assistant-for-mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  const args = { ...COAT, category_id: outerwear.id };
  const gate = await runTool("catalog.create_product", args, f.ctx);
  assert.equal(gate.needsApproval, true);

  /* What actually happens on the MCP path: the requester's call never holds a
     token, only a link. */
  const { id } = await parkForApproval(f.env, {
    name: "catalog.create_product",
    args,
    actor: f.ctx.actor,
    role: f.ctx.role,
    tier: "T2",
    summary: gate.data.would,
  });

  const approver = { email: "owner@vemians.com", role: "owner", verified: true };
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await approvePending(f.env, id, approver);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.created, true, "the click must actually create the product, not ask again");
  assert.ok(f.calls().some((c) => c.path === "/v2/catalog/object"), "Square must have seen a real write");

  /* P0-35's own promise: recorded under the APPROVER, not the assistant that
     asked. */
  const rows = f.audit("WHERE tool = 'catalog.create_product' AND result = 'ok'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, approver.email, "the write must be recorded under whoever clicked approve");
  assert.equal(
    rows[0].on_behalf_of,
    "assistant-for-mara@vemians.com",
    "who originally asked is preserved, just not as the actor",
  );

  /* Single use: the link is gone whether or not the click worked. */
  const second = await approvePending(f.env, id, approver);
  assert.equal(second.ok, false);
  assert.match(second.error, /No such pending approval/);
});

check("test_PRD_P0_35_approval_never_in_band__a_role_that_cannot_use_the_tool_cannot_approve_it", async () => {
  const f = await fixture({ actor: "assistant-for-mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const args = { ...COAT, category_id: outerwear.id };

  const gate = await runTool("catalog.create_product", args, f.ctx);
  const { id } = await parkForApproval(f.env, {
    name: "catalog.create_product",
    args,
    actor: f.ctx.actor,
    role: f.ctx.role,
    tier: "T2",
    summary: gate.data.would,
  });

  const result = await approvePending(f.env, id, { email: "ana@vemians.com", role: "staff", verified: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot approve/);
  assert.deepEqual(f.calls(), [], "a refused approver must never reach Square");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-60 — a spreadsheet mints one approval per row, never a write
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_60_spreadsheet_products__a_clean_row_is_created_immediately", async () => {
  /* REVISED: "I expect you to create all of the options and variations as
     needed. This should not be a separate process or approval. You have
     all the information to create all of them, so just make them. I
     don't want to sit here and approve them" — the owner's own words.
     Uploading the spreadsheet IS the deliberate action now. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,description,category,price,sku,style id,cost\n" +
    `Wool Coat,Warm and heavy,${outerwear.name},450.00,VEM-100,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].title, "Wool Coat");
  assert.match(result.created[0].summary, /Wool Coat/);

  /* No approval link left to click -- the product already exists. */
  const product = f.mirror("SELECT title FROM mirror_product WHERE title = 'Wool Coat'");
  assert.equal(product.length, 1);
});

check("test_PRD_P0_60_spreadsheet_products__a_bad_row_is_reported_with_why_not_silently_dropped", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price\n" +
    ",Outerwear,45.00\n" +
    `Sun Hat,${outerwear.name}s,20.00\n` +
    "Silk Scarf,Outerwear,free\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 3);
  /* A blank title is no longer the reason this row is skipped — it now
     gets an auto-generated one and fails on the next real gap instead
     (no vendor and no unit cost anywhere in this sheet; style ID is no
     longer required at all, REVISED — see P0-31's own entry). Row 2's own
     near-identical spelling ("Outerwears") is refused by catalog.create_
     category's own near-duplicate check, immediately, now that creating a
     missing category no longer waits on a separate approval either. */
  assert.match(result.skipped[0].reason, /no vendor and no unit cost/i);
  assert.match(result.skipped[1].reason, /could not be created/);
  assert.match(result.skipped[2].reason, /"free" is not a plain number/);
  /* Rows are 1-based and counted past the header, so a person can find row 2
     in the spreadsheet they actually uploaded. */
  assert.deepEqual(result.skipped.map((s) => s.row), [2, 3, 4]);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-136 (REVISED) — "Categories/subcategories should be made if missing.
 * And ids assigned auto bumped" — the owner's own words. REVISED again: "we
 * can make categories with UI can't we? ... if UI works why can't agent?" —
 * a missing category is now created IMMEDIATELY, inline, in the very same
 * draftProductBatch call (the Admin panel's own check-then-re-run-with-the-
 * token pattern), so the row that needed it becomes a normal ready approval
 * in ONE upload — never a separate approval link and a re-upload.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_136_square_custom_attributes__a_missing_category_is_created_immediately_and_the_row_proceeds", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv = "title,category,price,cost\n" + "Sun Hat,Millinery,20.00,10.00\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1, "the row itself proceeds in the SAME upload, no re-upload needed");

  const created = f.categories().find((c) => c.name === "Millinery");
  assert.ok(created, "the missing category must actually have been created, not just proposed");
  assert.equal(created.numeric_id, "00", "the first-ever top-level category gets the first-ever code");
});

check("test_PRD_P0_136_square_custom_attributes__several_rows_naming_the_same_missing_category_create_it_only_once", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv =
    "title,category,price,cost\n" + "Sun Hat,Millinery,20.00,10.00\n" + "Beret,Millinery,25.00,12.00\n" + "Beanie,Millinery,15.00,8.00\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 3, "all three rows proceed against the one category created for them");
  assert.equal(f.categories().filter((c) => c.name === "Millinery").length, 1, "created only once, not three times");
});

check("test_PRD_P0_136_square_custom_attributes__two_distinct_missing_categories_get_two_different_auto_picked_numbers", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv = "title,category,price,cost\n" + "Sun Hat,Millinery,20.00,10.00\n" + "Tote,Handbags,40.00,20.00\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2);
  const millinery = f.categories().find((c) => c.name === "Millinery");
  const handbags = f.categories().find((c) => c.name === "Handbags");
  assert.ok(millinery && handbags);
  assert.notEqual(millinery.numeric_id, handbags.numeric_id, "two distinct new categories in one upload must never land on the same number");
});

check("test_PRD_P0_136_square_custom_attributes__a_category_that_fails_to_create_skips_the_row_with_the_real_reason", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  /* "Outerwear" already exists; a near-identical spelling is refused by
     catalog.create_category's own near-duplicate check — that refusal must
     surface as this row's own skip reason, not a generic failure. */
  const csv = `title,category,price,cost\nParka,${outerwear.name}s,60.00,30.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /could not be created/);
  assert.match(result.skipped[0].reason, /overlaps the existing/);
});

check("test_PRD_P0_145_auto_generated_title__a_blank_title_is_auto_generated_from_category_and_position", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,cost\n" +
    `,${outerwear.name},45.00,01-04-001,20.00\n` +
    `,${outerwear.name},55.00,01-04-002,25.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2);
  /* The seeded catalog already has one product in Outerwear (fixtures'
     own "Shearling-trimmed wool-blend coat"), so these two title-less
     rows pick up where it left off rather than starting back at 1. */
  assert.equal(result.created[0].title, "Outerwear 2");
  assert.equal(result.created[1].title, "Outerwear 3");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-31/P0-136 (REVISED) — "Generate a generic name from subcategory
 * name... when quantity not specified use 1... category and subcategory
 * is style id and vice versa... categories/subcategories should be made
 * if missing" — the owner's own words, on ingesting a spreadsheet with
 * data missing. The last of these (auto-CREATING a missing category) is
 * a separate, larger decision, still pending; these three are not.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_31_inventory_ledger__a_spreadsheet_row_with_no_quantity_column_defaults_to_1", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.match(result.created[0].summary, /Wool Coat: 1 in stock/, "no quantity column at all -- defaults to 1, never left blank");
});

check("test_PRD_P0_31_inventory_ledger__a_spreadsheet_quantity_column_is_honored_when_given", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost,quantity\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,12\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.match(result.created[0].summary, /Wool Coat: 12 in stock/);
});

check("test_PRD_P0_31_inventory_ledger__a_spreadsheet_quantity_that_does_not_parse_is_flagged", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost,quantity\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,a dozen\n`;

  const result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  assert.equal(result.created.length, 0);
  assert.match(result.skipped[0].reason, /quantity "a dozen" is not a plain whole number/);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_row_derives_its_category_from_a_given_style_id_alone", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });

  /* No category column at all -- only a style ID, resolving to Casual the
     same way an edit's own style_id already does. */
  const csv = "title,price,style id,cost\n" + "Bomber Jacket,300.00,01-04-001,150.00\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.match(result.created[0].summary, /in Casual/, "the category came from the style ID alone, no category column given");
});

check("test_PRD_P0_136_square_custom_attributes__a_style_number_column_is_never_read_as_the_products_title", async () => {
  /* A real sheet used "Style #" for this shop's own style_id, not a title --
     normalizeKey strips the "#", landing on the exact same bare "style" key
     TITLE_KEYS used to also claim, so the style number ("001-001") showed up
     as the product's own name and style_id went unrecognized. "You are
     mistaking style id with title" -- the owner's own words. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = `title,category,price,style #,cost\n,${outerwear.name},450.00,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.notEqual(result.created[0].title, "01-04-001", "the style number must never become the title");
  assert.equal(result.created[0].title, "Outerwear 2", "a blank title still falls through to the auto-generated name");

  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'Outerwear 2'")[0];
  assert.equal(row.style_id, "01-04-001", "the style number column must land as style_id, not be dropped");
});

check("test_PRD_P0_145_auto_generated_title__a_row_with_neither_category_nor_style_id_is_still_created_unassigned", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv = "title,price,cost\n" + ",300.00,150.00\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created[0].title, "Item 1", "no category and no derivable style ID -- a generic, still-numbered title");
  assert.match(result.created[0].summary, /with no category/);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_vendor_with_no_commission_is_parked_when_the_vendor_already_has_one_on_file", async () => {
  /* REVISED: "let's not force vendor's commission to be stated out loud...
     if we are entering items that has a vendor, that's when we want to
     make sure there is a commission included. Or at least we store it in
     essential locations per vendor so that their commission is recorded
     in a central location and automatically applied" — the owner's own
     words. A vendor merely EXISTING is no longer enough on its own; it
     needs a commission actually ON FILE (mirror_vendor.commission_pct)
     for a later row naming it with none of its own to go through clean. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_vendor (id, external_ref, name, commission_pct) VALUES ('vendor-seed', 'sqvendor-seed', 'Acme Mills', 15)")
    .run();
  const csv = "title,category,price,style id,vendor\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].title, "Wool Coat");
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_vendor_with_nothing_on_file_yet_is_flagged_even_though_it_already_exists", async () => {
  /* The other half of the same REVISED rule: existing in mirror_vendor at
     all (synced in directly from Square, never given a rate by this shop)
     is not enough — flagged here, before the row is ever parked, same
     treatment every other spreadsheet rule already gets. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_vendor (id, external_ref, name) VALUES ('vendor-seed', 'sqvendor-seed', 'Acme Mills')")
    .run();
  const csv = "title,category,price,style id,vendor\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills\n`;

  const result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /vendor 'Acme Mills' has no commission on file yet — give one now/);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_brand_new_vendor_with_no_commission_is_flagged", async () => {
  /* The owner's own words: "I need to specify a commission if I create a
     vendor." "Acme Mills" does not exist anywhere in this fresh fixture, so
     this row would CREATE it — flagged here, before the row is ever parked,
     same treatment the other spreadsheet rules already get. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,vendor\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills\n`;

  const result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /vendor 'Acme Mills' has no commission on file yet — give one now/);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_row_with_vendor_and_commission_is_parked_and_sets_both", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,vendor,commission\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills,20\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const product = f.mirror("SELECT id, commission_pct FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.equal(product.commission_pct, 20);
  const variant = f.mirror(
    `SELECT mv.name AS vendor FROM mirror_variant v JOIN mirror_vendor mv ON mv.id = v.vendor_id WHERE v.product_id = '${product.id}'`,
  )[0];
  assert.equal(variant.vendor, "Acme Mills");
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_vendor_rows_cost_column_becomes_the_real_unit_cost_not_custom_fields", async () => {
  /* WITH a vendor, "cost" is Square's own real unit_cost_minor now (Retail
     Plus/Premium) — not the custom_fields placeholder a vendor-less row
     still uses. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,vendor,commission,cost,vendor code\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills,20,210.00,ACME-4471\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const product = f.mirror("SELECT id, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.deepEqual(JSON.parse(product.custom_fields), {}, "cost/vendor code are real arguments now, not custom_fields text");
  const variant = f.mirror(
    `SELECT vendor_code, unit_cost_minor FROM mirror_variant WHERE product_id = '${product.id}'`,
  )[0];
  assert.equal(variant.vendor_code, "ACME-4471");
  assert.equal(variant.unit_cost_minor, 21000);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_commission_that_is_not_a_whole_number_is_flagged", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,vendor,commission\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills,twenty\n`;

  const result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  assert.equal(result.created.length, 0);
  assert.match(result.skipped[0].reason, /commission "twenty" is not a plain whole number/);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_row_with_no_style_id_is_no_longer_flagged", async () => {
  /* REVISED: "category and subcategory is style id and vice versa" — the
     owner's own words. A row naming a real category but no style ID at
     all is no longer a skip — it goes through with no style_id given
     (create_product's own resolveStyleId leaves it unassigned when the
     category itself has no numeric_id yet, exactly as it already
     tolerates on its own). */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,cost\n" + `Wool Coat,${outerwear.name},450.00,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_row_with_no_vendor_and_no_unit_cost_is_flagged", async () => {
  /* The owner's own words: "if we don't have a vendor name, then we must
     have a cost of goods... if we're adding a product that has a price, no
     vendor, and no cogs, that's a problem too." Square's own "unit cost" IS
     the cost-of-goods value here — there is no separate cogs attribute. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id\n" + `Wool Coat,${outerwear.name},450.00,01-04-001\n`;

  const result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  assert.equal(result.created.length, 0);
  assert.match(result.skipped[0].reason, /no vendor and no unit cost/);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_row_with_a_style_id_and_unit_cost_but_no_vendor_is_parked", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const row = f.mirror("SELECT id, style_id, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.equal(row.style_id, "01-04-001");
  assert.deepEqual(JSON.parse(row.custom_fields), { cost: "210.00" });
  const variant = f.mirror(`SELECT vendor_id FROM mirror_variant WHERE product_id = '${row.id}'`)[0];
  assert.equal(variant.vendor_id, null, "no vendor column was given — nothing to resolve");
});

check("test_PRD_P0_70_flexible_spreadsheet_columns__a_real_world_header_row_still_matches", async () => {
  /* A coworker's actual export, not our own sample file: "Item Name" instead
     of "title", "Product Type" instead of "category", "Retail Price"
     instead of "price", punctuation and casing nobody typed to a spec. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv =
    "Item Name,Product_Type,Retail Price,Style ID,Cost\n" +
    "Wool Coat,Outerwear,245.00,01-04-001,110.00\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].title, "Wool Coat");
});

check("test_PRD_P0_70_flexible_spreadsheet_columns__an_unrecognised_column_is_kept_as_a_custom_field_not_dropped", async () => {
  /* The owner's own words: "I want to preserve all fields when ingesting
     spreadsheets. Even if they are not surfaced in square or ui for now."
     Vendor is deliberately NOT used as the example column here any more —
     it is its own recognized field now (Test-PRD-P0-136-square_custom_
     attributes), with its own vendor-needs-a-commission rule, covered
     separately below. "Fabric Note" is a genuinely unknown column. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,Style ID,Unit Cost,Fabric Note\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,Boiled wool\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  /* csvRecords() already trims and lowercases every header before this file
     ever sees it — "Unit Cost" and "Fabric Note" arrive here as "unit cost"
     and "fabric note", still readable, just not the exact original
     capitalization. */
  const row = f.mirror("SELECT custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.deepEqual(JSON.parse(row.custom_fields), { "unit cost": "210.00", "fabric note": "Boiled wool" });
});

check("test_PRD_P0_70_flexible_spreadsheet_columns__a_cost_column_is_no_longer_misread_as_the_sale_price", async () => {
  /* The owner's own words: "Every product has a price and a unit cost" —
     two different numbers. "cost" used to be a PRICE synonym, so a sheet
     with its own "Cost" column (what we paid) was silently read as the
     price (what a customer pays) instead of the real "price" column right
     next to it. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const variant = f.mirror(
    "SELECT price_minor FROM mirror_variant WHERE product_id = (SELECT id FROM mirror_product WHERE title = 'Wool Coat')",
  )[0];
  assert.equal(variant.price_minor, 45000, "the real 'price' column must still win, not 'cost'");

  const row = f.mirror("SELECT custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.deepEqual(JSON.parse(row.custom_fields), { cost: "210.00" }, "the 'cost' column must be preserved, not discarded");
});

check("test_PRD_P0_70_flexible_spreadsheet_columns__the_preview_shows_extra_columns_the_same_way_it_shows_known_ones", async () => {
  const { previewBatch } = await import("../src/batch.js");
  const preview = previewBatch("title,category,price,Season\nWool Coat,Outerwear,450.00,Fall 2026\n", "products");
  assert.equal(preview.sampleRows[0].season, "Fall 2026");

  /* Only the one sampled row exists now (PREVIEW_SAMPLE_ROWS, batch.js) —
     a blank extra column on that row simply has no key at all, the same
     as any known column left blank being pruned by extraFields(), rather
     than surfacing as a column with a raw "undefined" value. */
  const blank = previewBatch("title,category,price,Season\nSilk Scarf,Accessories,90.00,\n", "products");
  assert.equal("season" in blank.sampleRows[0], false);
});

check("test_PRD_P0_60_spreadsheet_products__catalog_create_product_still_gates_on_role_even_from_a_spreadsheet", async () => {
  /* draftProductBatch adds no role check of its own — catalog.create_product's own
     minRole is the only gate, same as every other caller. This is what the
     /products/batch route itself refuses BEFORE reading the file, so a staff
     upload never gets this far; documented here so a change to that tool's
     minRole is felt in exactly one place, not silently in two. */
  const f = await fixture({ actor: "ana@vemians.com", role: "staff" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = `title,category,price,style id,cost\nWool Coat,${outerwear.name},450.00,01-04-001,210.00\n`;

  const result = await draftProductBatch(f.env, { text: csv, actor: "ana@vemians.com", role: "staff" });
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /requires the manager role/);
});

check("test_PRD_P0_60_spreadsheet_products__more_rows_than_the_cap_is_refused_before_any_row_runs", async () => {
  const f = await fixture();
  const tooMany = CAPS.BATCH_MAX_ROWS + 1;
  const csv = "title,category,price\n" + Array.from({ length: tooMany }, (_, i) => `Item ${i},Outerwear,10.00`).join("\n");

  const result = await draftProductBatch(f.env, { text: csv, actor: f.ctx.actor, role: f.ctx.role });
  assert.equal(result.tooMany, tooMany);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.skipped, []);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-63 — the /approvals/ page is a real form, driven the way a browser
 * actually drives it (worker.fetch, not runTool/approvePending called
 * directly) — the exact gap that let a ReferenceError on `email` ship
 * undetected in the POST handler: every earlier test of this path called
 * approvePending() straight from the test file, never through index.js's
 * own route, so nothing ever exercised the line that crashed.
 * ───────────────────────────────────────────────────────────────────────── */

/* GET only reads `role` from the claims — decoded-but-unverified is enough,
   the same shortcut every other worker.fetch test in this repo already
   takes on localhost. */
function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

const HTTP_ENV_EXTRA = { SURFACE: "ops", MANAGER_POLICY_ID: "policy-manager", STAFF_POLICY_ID: "policy-staff" };
const MANAGER_CLAIMS = { email: "mara@vemians.com", policy_id: "policy-manager" };

async function getApproval(env, id, claims = MANAGER_CLAIMS) {
  const worker = (await import("../src/index.js")).default;
  return worker.fetch(
    new Request(`http://localhost/approvals/${id}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }),
    { ...env, ...HTTP_ENV_EXTRA },
  );
}

/*
 * approvePending() REFUSES an unverified assertion outright ("An unverified
 * assertion may read. It may not authorise a write.") — so a POST test has
 * to produce the real thing: a genuinely RS256-signed assertion plus a JWKS
 * endpoint that serves the matching public key, exactly what access.js's
 * verifySignature() actually checks. A fresh team domain (and so a fresh
 * JWKS URL) per call sidesteps access.js's own hour-long JWKS cache, which
 * is keyed by URL and module-level — reusing one across tests would verify
 * the SECOND test's token against the FIRST test's key.
 */
async function verifiedPost(env, claims) {
  const teamDomain = `test-${crypto.randomUUID()}.cloudflareaccess.com`;
  const aud = "test-aud";
  const kid = "k1";

  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwksUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const jwksBody = { keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256" }] };

  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64url({ alg: "RS256", kid });
  const payload = b64url({ ...claims, aud });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const token = `${header}.${payload}.${Buffer.from(sig).toString("base64url")}`;

  /* Layered over whatever fetch is already installed (a test's own fake
     Square fetch), so a JWKS request is served here and everything else
     falls through unchanged. */
  const under = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === jwksUrl) return new Response(JSON.stringify(jwksBody), { status: 200 });
    return under(url, init);
  };

  return {
    token,
    env: { ...env, ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud },
    restore: () => {
      globalThis.fetch = under;
    },
  };
}

async function postApproval(env, id, formFields, claims = MANAGER_CLAIMS) {
  const worker = (await import("../src/index.js")).default;
  const { token, env: verifiedEnv, restore } = await verifiedPost(env, claims);
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(formFields)) form.set(k, v);
    return await worker.fetch(
      new Request(`http://localhost/approvals/${id}`, {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token },
        body: form,
      }),
      { ...verifiedEnv, ...HTTP_ENV_EXTRA },
    );
  } finally {
    restore();
  }
}

check("test_PRD_P0_63_editable_approval__submitting_unchanged_actually_creates_the_product", async () => {
  /* THE REGRESSION. A real POST through the real Worker route, with no
     edits — this is what "just click submit" has to do, and it is exactly
     what crashed with `email is not defined` before this was fixed. */
  const f = await fixture({ actor: "assistant@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const args = { ...COAT, category_id: outerwear.id };
  const gate = await runTool("catalog.create_product", args, f.ctx);
  const { id } = await parkForApproval(f.env, {
    name: "catalog.create_product",
    args,
    actor: f.ctx.actor,
    role: f.ctx.role,
    tier: "T2",
    summary: gate.data.would,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let res;
  try {
    /* The form's own prefilled values, submitted back unchanged — no edits,
       just "yes". */
    res = await postApproval(f.env, id, {
      title: COAT.title,
      description: COAT.description,
      category_id: outerwear.id,
      price: (COAT.variations[0].price_minor / 100).toFixed(2),
      sku: COAT.variations[0].sku,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(res.status, 200, await res.text());
  assert.ok(f.calls().some((c) => c.path === "/v2/catalog/object"), "the product must actually reach Square");
});

check("test_PRD_P0_63_editable_approval__the_get_page_shows_editable_fields_prefilled", async () => {
  const f = await fixture({ actor: "assistant@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const args = { ...COAT, category_id: outerwear.id };
  const gate = await runTool("catalog.create_product", args, f.ctx);
  const { id } = await parkForApproval(f.env, {
    name: "catalog.create_product",
    args,
    actor: f.ctx.actor,
    role: f.ctx.role,
    tier: "T2",
    summary: gate.data.would,
  });

  const res = await getApproval(f.env, id);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /name="title"[^>]*value="Belted gabardine trench coat"/);
  assert.match(html, /<option value="[^"]+" selected>Outerwear<\/option>/);
  assert.match(html, /name="price"[^>]*value="1890\.00"/);
});

check("test_PRD_P0_63_editable_approval__an_edited_price_is_what_actually_gets_created", async () => {
  const f = await fixture({ actor: "assistant@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const args = { ...COAT, category_id: outerwear.id };
  const gate = await runTool("catalog.create_product", args, f.ctx);
  const { id } = await parkForApproval(f.env, {
    name: "catalog.create_product",
    args,
    actor: f.ctx.actor,
    role: f.ctx.role,
    tier: "T2",
    summary: gate.data.would,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let res;
  try {
    res = await postApproval(f.env, id, {
      title: "Belted gabardine trench coat — sample",
      category_id: outerwear.id,
      price: "225.00",
      sku: COAT.variations[0].sku,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(res.status, 200, await res.text());
  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object");
  assert.ok(upsert, "the edited proposal must still reach Square");
  const variation = upsert.body.object.item_data.variations[0];
  assert.equal(variation.item_variation_data.price_money.amount, 22500, "the EDITED price, not the original 189000");
  assert.equal(upsert.body.object.item_data.name, "Belted gabardine trench coat — sample");
});

check("test_PRD_P0_63_editable_approval__an_edit_that_will_not_parse_is_refused_before_square_sees_it", async () => {
  const f = await fixture({ actor: "assistant@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const args = { ...COAT, category_id: outerwear.id };
  const gate = await runTool("catalog.create_product", args, f.ctx);
  const { id } = await parkForApproval(f.env, {
    name: "catalog.create_product",
    args,
    actor: f.ctx.actor,
    role: f.ctx.role,
    tier: "T2",
    summary: gate.data.would,
  });

  const res = await postApproval(f.env, id, {
    title: COAT.title,
    category_id: outerwear.id,
    price: "not a number",
    sku: COAT.variations[0].sku,
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not a plain number/);
  assert.deepEqual(f.calls(), [], "a refusal on the way in must never reach Square");

  /* And the link survives the refused attempt — peekPending, not consumed,
     so the person can fix it and try again. */
  const { peekPending } = await import("../src/approvals.js");
  const { pending } = await peekPending(f.env, id);
  assert.ok(pending, "an edit that fails to parse must not burn the approval link");
});

check("test_PRD_P0_63_editable_approval__a_tool_with_no_friendly_form_still_just_works", async () => {
  /* catalog.create_category has no editableFieldsFor() entry — the plain
     read-only view from before this change, and a submit with no relevant
     form fields must still run the parked args unchanged. */
  const f = await fixture({ actor: "assistant@vemians.com", role: "manager" });
  const args = { name: "Outerwear — Heavy", reason: "a genuinely new seasonal sub-line" };
  const gate = await runTool("catalog.create_category", args, f.ctx);
  if (!gate.needsApproval) return; /* near-duplicate refusal is a different, already-covered path */
  const { id } = await parkForApproval(f.env, {
    name: "catalog.create_category",
    args,
    actor: f.ctx.actor,
    role: f.ctx.role,
    tier: "T2",
    summary: gate.data.would,
  });

  const html = await (await getApproval(f.env, id)).text();
  assert.doesNotMatch(html, /class="field"/, "no friendly editor for an unlisted tool");

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let res;
  try {
    res = await postApproval(f.env, id, {});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 200, await res.text());
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-40 — the category comes from a closed set, with reasoning
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_40_closed_category_set__categories_lists_what_exists_and_says_the_set_is_closed", async () => {
  const f = await fixture();
  const res = await runTool("catalog.categories", {}, f.ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.data.categories.map((c) => c.name),
    ["Accessories", "Knitwear", "Outerwear"],
  );
  assert.equal(res.data.closed_set, true);
  assert.match(res.data.note, /catalog\.create_category/);

  /* Our uuids, never Square's. A model handed CAT_OUTERWEAR would be holding a
     vendor identifier above the adapter (Test-PRD-P0-16-commerce_port). */
  for (const c of res.data.categories) {
    assert.match(c.id, /^[0-9a-f-]{36}$/, "a category id handed out is OUR uuid");
    assert.deepEqual(Object.keys(c).sort(), ["id", "name", "numeric_id", "parent_id"]);
    /* Every fixture category is top-level, with no numeric_id assigned yet —
       Test-PRD-P0-138-nested_categories exercises the nested/numbered case. */
    assert.equal(c.parent_id, null);
    assert.equal(c.numeric_id, null);
  }
  /* And it is a read: not one Square call, not one mirror row changed. */
  assert.deepEqual(f.calls(), []);
});

check("test_PRD_P0_40_closed_category_set__a_draft_suggests_a_category_with_reasoning_and_assigns_none", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  /* The model picked from catalog.categories. The tool checks that pick against
     the set and hands back the argument for it — a gabardine trench coat is
     outerwear, and no lexicon in this repository knows that, so the semantics
     are the model's and the closed set is the tool's. */
  const res = await runTool(
    "catalog.draft_product",
    { ...COAT, category_id: outerwear.id, category_hint: "coats and jackets" },
    { ...f.ctx, ...staff },
  );
  assert.equal(res.ok, true);

  const c = res.data.category;
  assert.equal(c.suggestion.name, "Outerwear");
  assert.equal(c.chosen_id_exists, true);
  assert.equal(c.closed_set_size, 3);
  assert.match(c.reasoning, /Outerwear/);
  assert.match(c.reasoning, /categories that already exist/i, "the reasoning says the set is closed");
  assert.ok(Array.isArray(c.alternatives) && c.alternatives.length === 3);
  assert.match(c.note, /suggestion, not an assignment/i);
  assert.ok(res.data.price.comparable_stock.sample >= 2, "priced against what is already on the shelf");

  /* A pick outside the set is reported as blocking, not quietly accepted. */
  const off = await runTool(
    "catalog.draft_product",
    { ...COAT, category_id: "00000000-0000-4000-8000-000000000000" },
    { ...f.ctx, ...staff },
  );
  assert.equal(off.ok, true, "a draft reports; it does not refuse");
  assert.equal(off.data.ready, false);
  assert.equal(off.data.category.chosen_id_exists, false);
  assert.match(off.data.category.reasoning, /is not one of the 3 categories that exist/);

  /* With no pick at all, the wording alone is read — and says so. */
  const bare = await runTool(
    "catalog.draft_product",
    { title: "Ribbed cashmere jumper", description: "Two-ply knitwear.", variations: COAT.variations },
    { ...f.ctx, ...staff },
  );
  assert.equal(bare.data.category.suggestion.name, "Knitwear");
  assert.match(bare.data.category.reasoning, /No category_id was given/);

  /* A suggestion is not an assignment: nothing anywhere now holds a category
     for this product, because the product does not exist. */
  assert.equal(res.data.writes_nothing, true);
  assert.deepEqual(f.calls(), []);
  assert.equal(f.mirror("SELECT * FROM mirror_product WHERE title LIKE 'Belted%'").length, 0);
});

check("test_PRD_P0_40_closed_category_set__a_category_outside_the_set_is_refused_before_any_square_call", async () => {
  const f = await fixture();
  const res = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: "00000000-0000-4000-8000-000000000000" },
    f.ctx,
  );

  assert.equal(res.ok, false);
  assert.equal(res.needsApproval, undefined, "a refusal must not become an approval request");
  assert.match(res.error, /not one of the 3 categories that exist/);
  assert.match(res.error, /Outerwear/, "the refusal names the set to choose from");
  assert.match(res.error, /catalog\.create_category/, "and names the deliberate alternative");

  assert.deepEqual(f.calls(), [], "nothing reached Square");
  const rows = f.audit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "denied");
  assert.equal(JSON.parse(rows[0].detail).reason, "category_outside_closed_set");
});

check("test_PRD_P0_40_closed_category_set__a_near_duplicate_category_is_refused_by_name", async () => {
  const f = await fixture();
  /* "Coats & Jackets" beside "Outerwear" is allowed by lexical overlap alone —
     the fixture has no "Coats" — so this drives the real duplicate: a second
     name for a category that is already there. */
  const dup = await runTool(
    "catalog.create_category",
    { name: "Accessory", reason: "the belt does not fit anywhere" },
    f.ctx,
  );
  assert.equal(dup.ok, false);
  assert.match(dup.error, /overlaps the existing category "Accessories"/);
  assert.match(dup.error, /navigation meaningless/);
  assert.deepEqual(f.calls(), [], "a refused category makes no Square call");

  const exact = await runTool("catalog.create_category", { name: "knitwear", reason: "jumpers" }, f.ctx);
  assert.equal(exact.ok, false);
  assert.match(exact.error, /"Knitwear" already exists/);

  /* And the matcher itself, on the case the description warns about. */
  const set = [{ id: "1", name: "Coats & Jackets" }];
  assert.ok(nearestCategory("Coats", set).score >= CAPS.CATEGORY_DUPLICATE_SIMILARITY);
  assert.ok(nearestCategory("Fragrance", set).score < CAPS.CATEGORY_DUPLICATE_SIMILARITY);
});

check("test_PRD_P0_40_closed_category_set__creating_a_category_is_a_separate_gated_manager_action", async () => {
  const f = await fixture();
  const tool = TOOLS["catalog.create_category"];
  assert.equal(tool.tier, "T2", "creating a category is never a side effect of authoring");
  assert.equal(tool.minRole, "manager");
  assert.match(tool.describe, /RARELY THE RIGHT TOOL/);
  assert.ok(tool.schema.reason.required, "a new category needs a stated reason");

  /* Staff cannot reach it at all, and it is absent from their tool list. */
  const denied = await runTool(
    "catalog.create_category",
    { name: "Eyewear", reason: "we now sell sunglasses" },
    { ...f.ctx, ...staff },
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /requires the manager role/);
  assert.ok(!describeTools("staff").some((d) => d.name === "catalog.create_category"));

  /* A manager, approved, and only then does Square hear about it. */
  const made = await approvedCall(f, "catalog.create_category", {
    name: "Eyewear",
    reason: "we now sell sunglasses",
  });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.data.category.name, "Eyewear");
  assert.equal(made.data.existing_before, 3);
  assert.equal(f.categories().length, 4);
  assert.equal(f.calls().filter((c) => c.upsert === "CATEGORY").length, 1);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-138 — nested categories/subcategories, and OUR OWN numeric_id, later
 * embedded in a product's own style_id.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_138_nested_categories__create_category_with_parent_id_makes_a_real_square_subcategory", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const made = await approvedCall(f, "catalog.create_category", {
    name: "Coats",
    parent_id: outerwear.id,
    reason: "organizing Outerwear further",
  });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.data.category.name, "Coats");

  /* Square's own real hierarchy (category_data.parent_category, GA) — not
     something this codebase invents on top of a flat category. */
  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "CATEGORY");
  assert.equal(upsert.body.object.category_data.parent_category.id, "CAT_OUTERWEAR");

  const row = f.categories().find((c) => c.name === "Coats");
  assert.equal(row.parent_id, outerwear.id, "the mirror's own parent_id resolves after sync");
});

check("test_PRD_P0_138_nested_categories__parent_id_must_already_exist", async () => {
  const f = await fixture();
  const res = await runTool(
    "catalog.create_category",
    { name: "Coats", parent_id: "does-not-exist", reason: "test" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no category 'does-not-exist' to nest this under/);
  assert.deepEqual(f.calls(), []);
});

check("test_PRD_P0_138_nested_categories__a_name_may_repeat_under_a_different_parent_but_not_the_same_one", async () => {
  /* The owner's own words: "it is possible that we might have a category
     of pants and they might have a subcategory that matches another
     subcategory's name, but that's parented to a different category...
     what matters is that the ID stays unique." A flat, tree-wide duplicate
     check would wrongly refuse the second "Casual" below. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");

  const underOuterwear = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: outerwear.id,
    reason: "test",
  });
  assert.equal(underOuterwear.ok, true, underOuterwear.error);

  const underKnitwear = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: knitwear.id,
    reason: "test",
  });
  assert.equal(underKnitwear.ok, true, underKnitwear.error, "same name, different parent, must not collide");

  const dupSameParent = await runTool(
    "catalog.create_category",
    { name: "Casual", parent_id: outerwear.id, reason: "test" },
    f.ctx,
  );
  assert.equal(dupSameParent.ok, false);
  assert.match(dupSameParent.error, /already exists under "Outerwear"/);
});

check("test_PRD_P0_138_nested_categories__create_category_can_set_its_own_numeric_id_at_creation_time", async () => {
  /* The owner's own words: "the add row is supposed to have ID as well."
     Set once, at creation, instead of a separate catalog.set_category_
     number follow-up call. */
  const f = await fixture();
  const made = await approvedCall(f, "catalog.create_category", { name: "Eyewear", numeric_id: "42", reason: "test" });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.data.category.numeric_id, "42");
  const row = f.categories().find((c) => c.name === "Eyewear");
  assert.equal(row.numeric_id, "42", "the mirror actually persists it, not just the tool's own response");
});

check("test_PRD_P0_138_nested_categories__create_category_numeric_id_is_optional", async () => {
  const f = await fixture();
  const made = await approvedCall(f, "catalog.create_category", { name: "Eyewear", reason: "test" });
  assert.equal(made.ok, true, made.error);
  const row = f.categories().find((c) => c.name === "Eyewear");
  assert.equal(row.numeric_id, null, "leaving it blank must not assign anything");
});

check("test_PRD_P0_138_nested_categories__create_category_numeric_id_must_be_exactly_two_digits", async () => {
  const f = await fixture();
  const res = await runTool("catalog.create_category", { name: "Eyewear", numeric_id: "4", reason: "test" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /must be exactly two digits/);
  assert.equal(f.categories().find((c) => c.name === "Eyewear"), undefined, "refused, so nothing was created at all");
});

check("test_PRD_P0_138_nested_categories__create_category_numeric_id_respects_the_same_two_pools", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });

  const topLevelConflict = await runTool("catalog.create_category", { name: "Eyewear", numeric_id: "01", reason: "test" }, f.ctx);
  assert.equal(topLevelConflict.ok, false);
  assert.match(topLevelConflict.error, /already assigned to "Outerwear"/);
  assert.match(topLevelConflict.error, /every top-level category shares one pool/);

  /* The SAME number is fine for a SUBCATEGORY -- separate pool. */
  const subOk = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: outerwear.id,
    numeric_id: "01",
    reason: "test",
  });
  assert.equal(subOk.ok, true, subOk.error);
  assert.equal(subOk.data.category.numeric_id, "01");
});

check("test_PRD_P0_138_nested_categories__numeric_id_must_be_exactly_two_digits", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool(
    "catalog.set_category_number",
    { category_id: outerwear.id, numeric_id: "1a" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /must be exactly two digits/);
});

check("test_PRD_P0_138_nested_categories__two_top_level_categories_cannot_share_a_numeric_id", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  const first = await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  assert.equal(first.ok, true, first.error);

  const conflict = await runTool(
    "catalog.set_category_number",
    { category_id: knitwear.id, numeric_id: "01" },
    f.ctx,
  );
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /already assigned to "Outerwear"/);
  assert.match(conflict.error, /every top-level category shares one pool/);
});

check("test_PRD_P0_138_nested_categories__two_subcategories_under_different_parents_cannot_share_a_numeric_id", async () => {
  /* The owner's own words: "once an ID is used by any subcategory, it
     stops being available" — regardless of nesting depth or parent, ONE
     shared pool for every subcategory in the whole tree. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  const casualCoats = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: outerwear.id,
    reason: "test",
  });
  const casualKnits = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: knitwear.id,
    reason: "test",
  });

  const first = await approvedCall(f, "catalog.set_category_number", {
    category_id: casualCoats.data.category.id,
    numeric_id: "05",
  });
  assert.equal(first.ok, true, first.error);

  const conflict = await runTool(
    "catalog.set_category_number",
    { category_id: casualKnits.data.category.id, numeric_id: "05" },
    f.ctx,
  );
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /every subcategory in the whole tree/);
});

check("test_PRD_P0_138_nested_categories__a_top_level_category_and_a_subcategory_may_share_the_same_number", async () => {
  /* Two SEPARATE pools — the style_id's own first-segment/second-segment
     split already keeps a category's "01" and a subcategory's "01"
     structurally apart, so there is nothing for them to collide over. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: outerwear.id,
    reason: "test",
  });
  const topLevel = await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  assert.equal(topLevel.ok, true, topLevel.error);
  const sub = await approvedCall(f, "catalog.set_category_number", {
    category_id: casual.data.category.id,
    numeric_id: "01",
  });
  assert.equal(sub.ok, true, sub.error);
});

check("test_PRD_P0_138_nested_categories__clearing_a_numeric_id_frees_it_for_reuse", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const cleared = await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, clear: true });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(f.categories().find((c) => c.id === outerwear.id).numeric_id, null);

  const reused = await approvedCall(f, "catalog.set_category_number", { category_id: knitwear.id, numeric_id: "01" });
  assert.equal(reused.ok, true, reused.error, "a cleared number must become available again");
});

check("test_PRD_P0_138_nested_categories__assigning_a_numeric_id_retroactively_resorts_matching_products", async () => {
  /* The owner's own choice: retroactive, not "only going forward" — and a
     REAL Square write per product, since reporting_category is Square's
     own fact (ADR-009), not something poking the mirror directly would
     keep straight against the next full sync. The fixture's own coat
     starts in Outerwear (its own seeded reporting_category) — style_id
     targets Knitwear's future numeric_id instead, so the resort has an
     actual mismatch to fix, not a no-op match already in place. */
  const f = await fixture();
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "02-05-001" });

  const assigned = await approvedCall(f, "catalog.set_category_number", { category_id: knitwear.id, numeric_id: "02" });
  assert.equal(assigned.ok, true, assigned.error);
  assert.equal(assigned.data.products_resorted, 1);

  /* .pop(), not .find() — the LATEST ITEM upsert is the resort's own; an
     earlier one (the style_id call above, before "02" existed) legitimately
     still shows the OLD category. */
  const itemUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  assert.ok(itemUpsert, "the resort must actually write to Square, not just the mirror");
  assert.equal(itemUpsert.body.object.item_data.reporting_category.id, "CAT_KNITWEAR");

  const product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(product.category_id, knitwear.id);
});

check("test_PRD_P0_138_nested_categories__a_subcategory_match_wins_over_a_top_level_match", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: outerwear.id,
    reason: "test",
  });
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-05-001" });

  /* Only the top-level "01" matches so far — the product sorts there. */
  let product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(product.category_id, outerwear.id);

  /* Once "05" is given to the subcategory, the SAME style_id's own
     subcategory segment now matches something more specific, and wins. */
  const resort = await approvedCall(f, "catalog.set_category_number", {
    category_id: casual.data.category.id,
    numeric_id: "05",
  });
  assert.equal(resort.data.products_resorted, 1);
  product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(product.category_id, casual.data.category.id);
});

check("test_PRD_P0_138_nested_categories__setting_a_style_id_auto_derives_the_products_own_category", async () => {
  /* The owner's own words: "anytime we submit items with a style ID, those
     style IDs will actually be driving which categories and subcategories
     these items automatically get sorted to." No separate resort call
     needed here — set_square_attributes' own run() derives it inline. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: outerwear.id,
    reason: "test",
  });
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.data.category.id, numeric_id: "05" });

  const res = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-05-001" });
  assert.equal(res.ok, true, res.error);

  const casualExternalRef = f.mirror(`SELECT external_ref FROM mirror_category WHERE id = '${casual.data.category.id}'`)[0].external_ref;
  const itemUpsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  assert.equal(itemUpsert.body.object.item_data.reporting_category.id, casualExternalRef);
});

check("test_PRD_P0_138_nested_categories__creating_a_product_with_a_style_id_but_no_category_id_derives_one", async () => {
  /* The owner's own words, describing the ingestion process: "each item
     needs to have a style ID... all of the items need to be assigned to
     their respective categories." category_id is no longer required at
     all on catalog.create_product -- style_id's own digits, looked up
     the exact same way catalog.set_square_attributes already does for
     an edit, are enough. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });

  const res = await approvedCall(f, "catalog.create_product", { ...COAT, style_id: "01-99-001" });
  assert.equal(res.ok, true, res.error);
  const product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${res.data.product.handle}'`)[0];
  assert.equal(product.category_id, outerwear.id, "the top-level '01' segment matched with no subcategory numbered yet");
});

check("test_PRD_P0_138_nested_categories__creating_a_product_whose_style_id_matches_nothing_yet_leaves_it_unassigned_not_refused", async () => {
  /* "If categories do not exist, then they will not get assigned to a
     category, they'll stay unassigned" -- the owner's own words. No
     category exists with numeric_id '77' anywhere in this fixture. */
  const f = await fixture();
  const res = await approvedCall(f, "catalog.create_product", { ...COAT, style_id: "77-88-001" });
  assert.equal(res.ok, true, res.error);
  const product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${res.data.product.handle}'`)[0];
  assert.equal(product.category_id, null);
});

check("test_PRD_P0_138_nested_categories__creating_a_category_with_a_numeric_id_retroactively_assigns_products_left_unassigned", async () => {
  /* "If that category is then later created with the matching ID, then...
     these assets should be auto assigned to that category" -- the
     owner's own words. A product ingested before its own category ever
     existed must not be stuck unassigned forever: the moment a category
     is CREATED with a matching numeric_id (not just re-numbered later),
     the same retroactive resort catalog.set_category_number already
     triggers must run here too. */
  const f = await fixture();
  const orphan = await approvedCall(f, "catalog.create_product", { ...COAT, style_id: "42-01-001" });
  assert.equal(orphan.ok, true, orphan.error);
  let product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${orphan.data.product.handle}'`)[0];
  assert.equal(product.category_id, null, "nothing has numeric_id '42' yet");

  const created = await approvedCall(f, "catalog.create_category", {
    name: "Loungewear",
    numeric_id: "42",
    reason: "test",
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.data.products_resorted, 1, "the orphaned product must be picked up in the same call that creates its category");

  product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${orphan.data.product.handle}'`)[0];
  assert.equal(product.category_id, created.data.category.id);
});

check("test_PRD_P0_138_nested_categories__resync_from_square_is_manager_only", async () => {
  const f = await fixture();
  const denied = await runTool("catalog.resync_from_square", {}, { ...f.ctx, ...staff });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /manager/i);
});

check("test_PRD_P0_138_nested_categories__the_resync_route_actually_completes_the_approval_step_not_just_the_gate", async () => {
  /* A real bug, caught live from the owner's own copied error: POST
     /items/resync (index.js) used to make ONE runTool call and treat
     anything other than `ok: true` as a failure. resync_from_square is T2,
     and a T2 call with no approvalToken never returns `ok: true` OR an
     `.error` -- it returns `needsApproval: true` (tools/index.js's own
     gate) -- so this route fell straight through to its own generic
     "could not resync from Square" fallback on EVERY click, regardless of
     whether Square or the sync itself was healthy. Driven through the
     REAL HTTP route (worker.fetch), not runTool called directly the way
     the tool-level tests above already do -- that is exactly the layer
     the bug lived in and the tool-level tests could never have caught. */
  const f = await fixture();
  const worker = (await import("../src/index.js")).default;
  const under = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const res = await worker.fetch(
      new Request("http://localhost/items/resync", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER_CLAIMS) },
      }),
      { ...f.env, ...HTTP_ENV_EXTRA },
    );
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const data = JSON.parse(text);
    assert.equal(data.resynced, true);
    assert.equal(data.full, true);
  } finally {
    globalThis.fetch = under;
  }
});

check("test_PRD_P0_138_nested_categories__resync_from_square_backfills_a_parent_link_square_already_had", async () => {
  /* The owner's own question, after adding categories directly in Square's
     own dashboard: "why aren't you synchronizing them?" The scheduled
     sync only does a full ListCatalog sweep on its very first-ever run;
     every run after that is an incremental SearchCatalogObjects that only
     returns objects Square considers recently updated — so a category
     Square already held, untouched since the mirror's own cursor was
     recorded, never resurfaces on its own (in particular its own
     parent_category link, a field this mirror only started reading once
     nested categories shipped). This tool is the manual escape hatch: it
     calls the adapter's own pullCatalog({full:true}) directly, the same
     full sweep the cron only ever runs once, bypassing the cursor
     entirely. Modeled here by editing the fake Square catalog AFTER the
     fixture's own initial sync (which is itself a full sweep, so it
     already saw Knitwear as top-level) — the same shape as a category
     someone nests directly in Square after this mirror's first sync ever
     ran. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwearBefore = f.categories().find((c) => c.name === "Knitwear");
  assert.equal(knitwearBefore.parent_id, null, "Knitwear starts top-level, same as the fixture's own Square seed");

  f.square.objects.get("CAT_KNITWEAR").category_data.parent_category = { id: "CAT_OUTERWEAR" };

  const res = await approvedCall(f, "catalog.resync_from_square", {});
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.resynced, true);
  assert.equal(res.data.full, true);

  const knitwearAfter = f.categories().find((c) => c.name === "Knitwear");
  assert.equal(knitwearAfter.parent_id, outerwear.id, "the parent link Square already had is now reflected here");
});

check("test_PRD_P0_138_nested_categories__an_edit_that_does_not_touch_category_never_clears_it_in_square", async () => {
  /* Bug found and fixed while wiring this feature up: an UNDEFINED
     categoryId used to resolve to null, and itemData() (catalog-writer.js)
     omits categories/reporting_category entirely when catRef is falsy —
     which Square's own FULL-REPLACEMENT UpsertCatalogObject reads as an
     intentional clear (the same semantics the retractProduct fix, P0-137,
     verified against Square's own spec). Every update_product call that
     did not explicitly resend a categoryId — a vendor edit, a title edit,
     anything — was silently wiping the product's own category in Square. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.update_product", { handle: COAT_HANDLE, category_id: outerwear.id });

  const unrelated = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills", commission: 20 });
  assert.equal(unrelated.ok, true, unrelated.error);

  const upsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  assert.equal(
    upsert.body.object.item_data.reporting_category.id,
    "CAT_OUTERWEAR",
    "an edit that never mentioned category must still resend the CURRENT one, not omit it",
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-138 (revised) — "all of these categories and subcategories need to be
 * editable fields... I should be able to rename the categories." No local
 * source_version to resend the way update_product does (mirror_category has
 * none), so this GETs the object live from Square first and only then
 * writes it back, the same pattern setProductPresence already established.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_138_nested_categories__rename_category_is_a_real_square_write_not_a_mirror_only_field", async () => {
  const tool = TOOLS["catalog.rename_category"];
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");

  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const denied = await runTool(
    "catalog.rename_category",
    { category_id: outerwear.id, name: "Coats & Jackets" },
    { ...f.ctx, ...staff },
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /requires the manager role/);
  assert.ok(!describeTools("staff").some((d) => d.name === "catalog.rename_category"));

  const renamed = await approvedCall(f, "catalog.rename_category", { category_id: outerwear.id, name: "Coats & Jackets" });
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(renamed.data.category.name, "Coats & Jackets");

  const get = f.calls().find((c) => c.method === "GET" && c.path === "/v2/catalog/object/CAT_OUTERWEAR");
  assert.ok(get, "must read the object live from Square before writing it back");
  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "CATEGORY");
  assert.equal(upsert.body.object.category_data.name, "Coats & Jackets");
  assert.equal(upsert.body.object.id, "CAT_OUTERWEAR", "the SAME object, not a new one");

  const row = f.categories().find((c) => c.id === outerwear.id);
  assert.equal(row.name, "Coats & Jackets", "the mirror picks up the new name after sync");
});

check("test_PRD_P0_138_nested_categories__renaming_never_touches_numeric_id_or_parent", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const coats = await approvedCall(f, "catalog.create_category", { name: "Coats", parent_id: outerwear.id, reason: "test" });

  await approvedCall(f, "catalog.rename_category", { category_id: coats.data.category.id, name: "Coats & Jackets" });

  const row = f.categories().find((c) => c.id === coats.data.category.id);
  assert.equal(row.name, "Coats & Jackets");
  assert.equal(row.parent_id, outerwear.id, "renaming a subcategory must not detach it from its parent");
});

check("test_PRD_P0_138_nested_categories__renaming_into_a_sibling_exact_duplicate_is_refused", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");

  const res = await runTool("catalog.rename_category", { category_id: outerwear.id, name: "knitwear" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already exists at that level/);
  assert.deepEqual(f.calls(), []);
  assert.equal(knitwear.name, "Knitwear", "untouched");
});

check("test_PRD_P0_138_nested_categories__renaming_to_the_current_name_is_refused_as_a_no_op", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool("catalog.rename_category", { category_id: outerwear.id, name: "Outerwear" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already named that/);
});

check("test_PRD_P0_138_nested_categories__remove_category_is_a_real_square_delete_the_mirror_still_only_archives", async () => {
  /* A real production error, ground truth over the setProductPresence-style
     guess this used to make: "Square POST /v2/catalog/object failed with
     400 -- INVALID_REQUEST_ERROR/INVALID_VALUE... Object of type CATEGORY
     cannot be disabled." Unlike ITEM, a CATEGORY has no presence lifecycle
     in Square at all -- DeleteCatalogObject is the only removal path. */
  const tool = TOOLS["catalog.remove_category"];
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");

  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" });
  assert.equal(casual.ok, true, casual.error);

  const denied = await runTool("catalog.remove_category", { category_id: casual.data.category.id }, { ...f.ctx, ...staff });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /requires the manager role/);
  assert.ok(!describeTools("staff").some((d) => d.name === "catalog.remove_category"));

  const removed = await approvedCall(f, "catalog.remove_category", { category_id: casual.data.category.id });
  assert.equal(removed.ok, true, removed.error);

  /* A genuine Square DELETE, never the disable-via-POST this used to try. */
  const externalRef = f.mirror(`SELECT external_ref FROM mirror_category WHERE id = '${casual.data.category.id}'`)[0].external_ref;
  assert.ok(
    f.calls().some((c) => c.method === "DELETE" && c.path === `/v2/catalog/object/${externalRef}`),
    "removing a category must call Square's own DeleteCatalogObject, never an upsert",
  );
  assert.ok(!f.calls().some((c) => c.upsert === "CATEGORY" && c.body?.object?.id === externalRef), "no POST upsert for this object at all");

  /* ADR-008 still holds on OUR side: the mirror ROW is archived, never
     deleted -- the same is_deleted-first check isWithdrawn already makes
     for a withdrawn PRODUCT picks this up through the identical sync
     pipeline, no special-casing needed for a category. */
  assert.ok(!f.categories().some((c) => c.id === casual.data.category.id), "the working set no longer lists it");
  const row = f.mirror(`SELECT archived_at FROM mirror_category WHERE id = '${casual.data.category.id}'`)[0];
  assert.ok(row, "the row itself must still exist -- archived, not deleted");
  assert.ok(row.archived_at, "and must actually be marked archived");
});

check("test_PRD_P0_138_nested_categories__disabling_a_category_via_presence_is_refused_by_square_itself", async () => {
  /* Proves the fake actually models the real rule (rather than a removeCategory
     bug going undetected because nothing would catch it): the OLD approach --
     upserting a CATEGORY with present_at_all_locations: false -- must still
     fail exactly the way the real account did, so a future regression back
     to that shape is caught here, not discovered again in production. */
  const f = await fixture();
  await assert.rejects(
    () =>
      f.writer.adapter.client.post("/v2/catalog/object", {
        idempotency_key: "test-disable-category",
        object: { id: "CAT_OUTERWEAR", type: "CATEGORY", version: 1, present_at_all_locations: false, category_data: { name: "Outerwear" } },
      }),
    (err) => {
      assert.match(err.errors?.[0]?.detail ?? "", /cannot be disabled/);
      return true;
    },
  );
});

check("test_PRD_P0_138_nested_categories__a_category_with_subcategories_cannot_be_removed", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const coats = await approvedCall(f, "catalog.create_category", { name: "Coats", parent_id: outerwear.id, reason: "test" });
  assert.equal(coats.ok, true, coats.error);

  const res = await runTool("catalog.remove_category", { category_id: outerwear.id }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /still has 1 subcategory of its own \(Coats\) — remove those first/);
  assert.ok(f.categories().some((c) => c.name === "Outerwear"), "refused, so Outerwear must still be there");
});

check("test_PRD_P0_138_nested_categories__a_category_with_products_assigned_cannot_be_removed", async () => {
  /* "We probably should not enable the deletion of subcategories if they
     have items assigned to them" — the owner's own words, applied to any
     category (top-level or subcategory alike) still holding a real
     product, the same reasoning the "still has subcategories" refusal
     just above already follows for a category with children instead. */
  const f = await fixture();
  const category = await approvedCall(f, "catalog.create_category", { name: "Loungewear", reason: "test" });
  assert.equal(category.ok, true, category.error);
  const created = await approvedCall(f, "catalog.create_product", {
    title: "Robe",
    category_id: category.data.category.id,
    variations: [{ title: "One size", price_minor: 5000, currency: "USD" }],
  });
  assert.equal(created.ok, true, created.error);

  const res = await runTool("catalog.remove_category", { category_id: category.data.category.id }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /still has 1 product assigned to it — move them to a different category first/);
  assert.ok(f.categories().some((c) => c.name === "Loungewear"), "refused, so Loungewear must still be there");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-139 (continued) — two different edits must never collide on one
 * idempotency key, and a VERSION_MISMATCH must read as Square's own
 * concurrency control doing its job, not a bug
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_139_honest_write_failures__two_different_descriptions_never_share_an_idempotency_key", async () => {
  /* A real bug, caught live from the owner's own pasted error:
     "IDEMPOTENCY_KEY_REUSED... can only be retried with the same request
     data." The key used to hash only external_ref/source_version/style_id/
     vendor/commission -- NEVER title, description, category or variations.
     source_version stays the SAME across every attempt that has not yet
     been picked up by a sync, so two edits with different CONTENT, made
     before either landed in the mirror, hashed to the IDENTICAL key while
     sending DIFFERENT bodies -- exactly what Square's own idempotency
     contract refuses. Forcing source_version back down after the first
     call simulates exactly that: a second edit arriving before the first
     one's own resync ever ran. */
  const f = await fixture();
  const before = f.mirror(`SELECT source_version FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];

  const first = await approvedCall(f, "catalog.update_product", { handle: COAT_HANDLE, description: "First description." });
  assert.equal(first.ok, true, first.error);

  /* Roll source_version back to what it was BEFORE the first call, as if
     that call's own syncAfterWrite never ran -- the exact window the real
     bug lived in. */
  f.mirrorDb._raw
    .prepare(`UPDATE mirror_product SET source_version = ? WHERE handle = '${COAT_HANDLE}'`)
    .run(before.source_version);

  const second = await approvedCall(f, "catalog.update_product", { handle: COAT_HANDLE, description: "A completely different description." });
  assert.equal(second.ok, true, second.error);

  const keys = f.calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM")
    .map((c) => c.body.idempotency_key);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "two different descriptions must never hash to the same idempotency key");
});

check("test_PRD_P0_139_honest_write_failures__a_concurrent_square_edit_gets_a_plain_english_hint_not_just_the_raw_dump", async () => {
  /* The owner's own next real error, right after the idempotency fix:
     Square correctly refusing to overwrite a description someone (or
     something) changed directly in Square since the mirror's own
     source_version was last synced. VERSION_MISMATCH is Square's
     optimistic concurrency working exactly as designed -- the fix here is
     not to bypass it, it is to explain it, since "VERSION_MISMATCH...
     request_version=... latest_version=..." means nothing to a manager
     with no reason to know Square's own field names. */
  const f = await fixture({
    failUpsert: [
      {
        category: "INVALID_REQUEST_ERROR",
        code: "VERSION_MISMATCH",
        detail:
          "VERSION_MISMATCH: Object version does not match latest database version. Field `description` was modified concurrently.",
        field: "description",
      },
    ],
  });
  const res = await approvedCall(f, "catalog.update_product", { handle: COAT_HANDLE, description: "Gyyyyy" });
  assert.equal(res.ok, false);
  assert.match(
    res.error,
    /^This item was changed directly in Square since this page last loaded/,
    "a plain-English explanation must lead, not Square's own field names",
  );
  assert.match(res.error, /VERSION_MISMATCH/, "the raw technical detail must still follow, in case reloading does not resolve it");
  assert.match(res.error, /field: description/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-139 — a Square rejection's own reason must reach the caller, not just
 * "failed with 400"
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_139_honest_write_failures__a_squares_own_rejection_detail_reaches_runtools_error_string", async () => {
  /* The owner's own words, pasting the raw line verbatim after an edit
     silently went nowhere: "Square POST /v2/catalog/object failed with
     400." SquareError.errors carries Square's own category/code/detail/
     field on every rejection, already logged to console — the bug was
     that nothing past runTool's own catch ever looked at it, so this is
     the only place that reason could actually be lost, and the only
     place that proves it no longer is. */
  const f = await fixture({
    failUpsert: [
      {
        category: "INVALID_REQUEST_ERROR",
        code: "BAD_REQUEST",
        detail: "Item variation `price_money` must be a non-negative amount.",
        field: "object.item_data.variations[0].item_variation_data.price_money",
      },
    ],
  });
  const res = await approvedCall(f, "catalog.update_product", { handle: COAT_HANDLE, title: "Renamed Coat" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Square POST \/v2\/catalog\/object failed with 400/, "the generic sentence is still there");
  assert.match(res.error, /INVALID_REQUEST_ERROR\/BAD_REQUEST/, "Square's own category/code must reach the caller");
  assert.match(
    res.error,
    /field: object\.item_data\.variations\[0\]\.item_variation_data\.price_money/,
    "the specific field Square objected to must reach the caller",
  );
  assert.match(res.error, /non-negative amount/, "Square's own human-readable detail must reach the caller");

  const row = f.audit("WHERE result = 'error'").pop();
  assert.match(row.detail, /INVALID_REQUEST_ERROR\/BAD_REQUEST/, "the audit trail gets the same detail, not just the template");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-25 — writes need approval, and caps are refusals in code
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_25_write_approval_gate__a_draft_writes_nothing_to_square_or_to_any_store", async () => {
  const f = await fixture();
  const before = f.mirror("SELECT * FROM mirror_product");
  const res = await runTool("catalog.draft_product", COAT, { ...f.ctx, ...staff });

  assert.equal(res.ok, true);
  assert.equal(res.tier, "T1");
  assert.equal(res.data.ready, true);
  assert.deepEqual(res.data.blocking, []);
  assert.ok(res.data.diff.length >= 3, "a reviewable diff, not a paragraph");
  assert.deepEqual(
    res.data.diff.filter((d) => d.field === "title"),
    [{ op: "add", field: "title", from: null, to: COAT.title }],
  );

  assert.deepEqual(f.calls(), [], "a draft makes no Square call at all");
  assert.deepEqual(f.mirror("SELECT * FROM mirror_product"), before, "and changes no mirror row");
  assert.equal(f.bucket._store.size, 0);
});

check("test_PRD_P0_25_write_approval_gate__a_create_without_an_approval_token_writes_nothing", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  const gate = await runTool("catalog.create_product", { ...COAT, category_id: cat.id }, f.ctx);
  assert.equal(gate.ok, false);
  assert.equal(gate.needsApproval, true);
  assert.match(gate.data.approval.token, /^apr_/);
  assert.match(gate.data.would, /Belted gabardine trench coat.*Outerwear/);

  assert.deepEqual(f.calls(), [], "no Square call before a human approves");
  assert.equal(f.mirror("SELECT * FROM mirror_product WHERE title LIKE 'Belted%'").length, 0);

  const rows = f.audit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "pending_approval");
});

check("test_PRD_P0_25_write_approval_gate__the_token_is_bound_to_the_exact_call_it_was_issued_for", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const args = { ...COAT, category_id: cat.id };

  const gate = await runTool("catalog.create_product", args, f.ctx);
  const token = gate.data.approval.token;

  /* Same tool, same person, one digit of the price moved. */
  const moved = {
    ...args,
    variations: args.variations.map((v, i) => (i === 0 ? { ...v, price_minor: 289000 } : v)),
  };
  const spent = await runTool("catalog.create_product", moved, { ...f.ctx, approvalToken: token });
  assert.equal(spent.needsApproval, true, "an approval is for a change, not for a tool");
  assert.deepEqual(f.calls(), [], "and the price that was not approved never reached Square");
});

check("test_PRD_P0_25_write_approval_gate__a_zero_price_is_refused_before_square_is_called", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: cat.id, variations: [{ title: "One size", price_minor: 0, currency: "USD" }] },
    f.ctx,
  );

  assert.equal(res.ok, false);
  assert.equal(res.needsApproval, undefined, "a call that would be refused gets no token issued for it");
  assert.match(res.error, /refused before Square saw it/);
  assert.match(res.error, /Zero is not a discount/);
  assert.deepEqual(f.calls(), []);

  const rows = f.audit();
  assert.equal(rows[0].result, "denied");
  assert.equal(JSON.parse(rows[0].detail).reason, "invalid_product");
});

check("test_PRD_P0_25_write_approval_gate__an_absurd_price_is_refused_before_square_is_called", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool(
    "catalog.create_product",
    {
      ...COAT,
      category_id: cat.id,
      variations: [{ title: "One size", price_minor: CAPS.PRICE_MAX_MINOR + 1, currency: "USD" }],
    },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /exceeds the ceiling/);
  assert.match(res.error, /decimal-point slip/);
  assert.deepEqual(f.calls(), []);

  /* A float minor amount is a different bug and is caught by the schema, one
     gate earlier — money.js would have thrown at the boundary regardless. */
  const float = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: cat.id, variations: [{ title: "One size", price_minor: 49.99, currency: "USD" }] },
    f.ctx,
  );
  assert.equal(float.ok, false);
  assert.match(float.error, /must be an integer/);
  assert.deepEqual(f.calls(), []);
});

check("test_PRD_P0_25_write_approval_gate__a_product_with_no_variation_is_refused", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool("catalog.create_product", { ...COAT, category_id: cat.id, variations: [] }, f.ctx);

  assert.equal(res.ok, false);
  assert.match(res.error, /no variations/);
  assert.match(res.error, /One size/, "the refusal says what to do about it");
  assert.deepEqual(f.calls(), []);

  /* The same rule on the way out: an EDIT may not leave a product unsellable. */
  const emptied = await runTool(
    "catalog.update_product",
    { handle: "shearling-trimmed-wool-blend-coat", title: "Shearling coat" },
    f.ctx,
  );
  assert.equal(emptied.needsApproval, true, "an edit that keeps the variations is fine");
});

check("test_PRD_P0_25_write_approval_gate__an_empty_or_overlong_title_is_refused", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  const empty = await runTool("catalog.create_product", { ...COAT, title: "", category_id: cat.id }, f.ctx);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /'title' must not be empty/);

  const long = await runTool(
    "catalog.create_product",
    { ...COAT, title: "x".repeat(300), category_id: cat.id },
    f.ctx,
  );
  assert.equal(long.ok, false);
  assert.match(long.error, new RegExp(`longer than ${CAPS.CATALOG_TITLE_MAX}`));

  assert.deepEqual(f.calls(), [], "neither was forwarded to Square to bounce");
  assert.equal(f.audit().length, 2, "and both refusals are on the record");

  /* The same two, reported rather than refused, when they arrive at a DRAFT. */
  const problems = validateProposal({ title: "", variations: [] });
  assert.equal(problems.length, 2);
  assert.match(problems.join(" "), /title is empty/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-37 — Square is written; the mirror follows
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_37_mirror_is_ours__an_approved_create_writes_square_first_and_syncs_the_mirror_after", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const key = await uploadInline(f);

  assert.equal(f.mirror("SELECT * FROM mirror_product WHERE title LIKE 'Belted%'").length, 0);

  const res = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: cat.id, images: [key] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.created, true);
  assert.equal(res.data.authority, "square");

  /* THE ORDERING. Upsert, image, vendors (pullCatalog's own always-first
     step, Test-PRD-P0-136-square_custom_attributes revised), then the
     search that refreshes our copy. */
  const paths = f.calls().map((c) => c.path);
  assert.deepEqual(paths, ["/v2/catalog/object", "/v2/catalog/images", "/v2/vendors/search", "/v2/catalog/search"]);

  /* And the mirror now holds it, keyed by OUR uuid and OUR handle. */
  const product = f.mirror("SELECT * FROM mirror_product WHERE title = 'Belted gabardine trench coat'");
  assert.equal(product.length, 1);
  assert.equal(product[0].handle, "belted-gabardine-trench-coat");
  assert.match(product[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(res.data.product.handle, product[0].handle);

  const variants = f.mirror(`SELECT * FROM mirror_variant WHERE product_id = '${product[0].id}' ORDER BY ordinal`);
  assert.equal(variants.length, 2);
  assert.deepEqual(variants.map((v) => v.price_minor), [189000, 189000]);
  assert.deepEqual(variants.map((v) => v.sku), ["VEM-0009-38", "VEM-0009-42"]);

  /* The mirror recorded that a sync ran, which is the receipt the next
     incremental sweep reads its cursor from. */
  assert.equal(f.mirror("SELECT * FROM mirror_sync WHERE id = 'catalog'").length, 1);
});

check("test_PRD_P0_37_mirror_is_ours__no_authoring_tool_writes_a_square_fact_to_the_mirror_directly", async () => {
  /*
   * The structural half of "Square is the write target" — for a FACT SQUARE
   * ALSO HAS. Two writers into one copy of such a fact — the till's sync and
   * ours — diverge silently, so the ops tool layer contains no INSERT or
   * UPDATE against a mirror table for anything Square could also write. The
   * only writer of a Square-sourced column is shared/commerce/square/mirror.js,
   * reading back what Square now says.
   *
   * FIVE DELIBERATE EXCEPTIONS, allowlisted by name below rather than left
   * to widen this regex's blind spot: catalog.set_channel's own
   * `UPDATE mirror_product SET channel = ...` (Test-PRD-P0-71-product_channel),
   * catalog.set_custom_fields'/catalog.create_product's own
   * `UPDATE mirror_product SET custom_fields = ...`
   * (Test-PRD-P0-89-batch_preview_confirm's custom_fields entry),
   * catalog.set_category_number's own `UPDATE mirror_category SET
   * numeric_id = ...` (Test-PRD-P0-138-nested_categories), and
   * catalog.create_product's/catalog.set_square_attributes' own
   * `UPDATE mirror_vendor SET commission_pct = ...`
   * (Test-PRD-P0-138-nested_categories' own vendor-commission-centralization
   * entry). None of `channel`, `custom_fields`, `numeric_id` or a VENDOR's
   * own `commission_pct` is a fact Square has any notion of at all — Square
   * does not know our storefront exists, has no field for a fact we
   * invented, has no idea what "01" means to this shop's own style_id
   * nomenclature, and has no concept of a resale commission at all — so
   * none has a second writer to diverge from, and mirror.js's own sync
   * deliberately never names any of the four in its UPDATE or INSERT, for
   * exactly this reason (see the comments on all four columns in
   * shared/commerce/square/schema.sql). The FIFTH, catalog.create_custom_
   * field_name's own `INSERT INTO mirror_custom_field_name`, is not even
   * the same shape of exception — mirror_custom_field_name has no Square
   * correlate WHATSOEVER (unlike the other four, each an OURS-only column
   * bolted onto an otherwise Square-mirrored table), so mirror.js's own
   * sync has no row here to ever diverge from in the first place. The
   * assertion below still forbids that same file touching any OTHER
   * mirror column or table.
   *
   * A SIXTH exception, the same shape as the fifth: catalog.set_category_
   * item_options' own INSERT/UPDATE against mirror_category_item_option.
   * Also purely OURS (see that table's own comment in schema.sql) — but
   * unlike mirror_custom_field_name, a row here CAN be unassigned again,
   * which this codebase always spells as an UPDATE setting archived_at,
   * never a literal DELETE (Test-PRD-P0-25-write_approval_gate refuses
   * that statement outright, everywhere in this directory but erasure.js).
   *
   * A SEVENTH, the same catalog.set_category_item_options, back on
   * mirror_category itself this time: `UPDATE mirror_category SET
   * item_options_set_at = datetime('now')`, checked below alongside
   * numeric_id's own entry. Also OURS-only, same reasoning as numeric_id
   * — Square has no concept of "this subcategory stopped inheriting its
   * parent's option sets" at all.
   */
  const offenders = [];
  for (const file of fs.readdirSync(TOOLS_DIR).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(TOOLS_DIR, file), "utf8");
    for (const m of src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+mirror_\w+/gi)) {
      if (file === "catalog-write.js" && /^UPDATE\s+mirror_product$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^UPDATE\s+mirror_category$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^UPDATE\s+mirror_vendor$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^INSERT\s+INTO\s+mirror_custom_field_name$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^INSERT\s+INTO\s+mirror_category_item_option$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^UPDATE\s+mirror_category_item_option$/i.test(m[0])) continue;
      offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "an agent tool must not write a Square-sourced fact into the mirror");

  /* Every direct `UPDATE mirror_product` in this one allowlisted file really
     does touch only `channel` or `custom_fields` — nothing an incremental
     sync would ever also write. A per-statement check, not just the first
     match, so a THIRD such statement cannot sneak in unnoticed. */
  const writer = fs.readFileSync(path.join(TOOLS_DIR, "catalog-write.js"), "utf8");
  const stmts = [...writer.matchAll(/UPDATE mirror_product SET ([\s\S]*?) WHERE/g)];
  assert.ok(stmts.length >= 2, "catalog.set_channel's and catalog.set_custom_fields' own UPDATEs have moved or been removed");
  const ALLOWED_DIRECT_COLUMNS = ["channel = ?", "custom_fields = ?"];
  for (const [, captured] of stmts) {
    assert.ok(
      ALLOWED_DIRECT_COLUMNS.includes(captured.trim()),
      `an UPDATE mirror_product in catalog-write.js touches an unexpected column: ${captured}`,
    );
  }

  /* Same guard, for mirror_category's own OURS-only exceptions: numeric_id
     (written directly from TWO places, catalog.set_category_number and
     catalog.create_category's own "set it at creation time" convenience)
     and item_options_set_at (catalog.set_category_item_options' own
     inherit-vs-explicit marker, schema.sql's own comment on the column
     has the full reasoning) — set to datetime('now') on an explicit save,
     and back to NULL by that same tool's own `inherit: true` (the one way
     back to "still inheriting" once a category has ever been explicit) —
     checks every match, not just the first, the same way the mirror_product
     loop above does. */
  const categoryStmts = [...writer.matchAll(/UPDATE mirror_category SET ([\s\S]*?) WHERE/g)];
  assert.ok(
    categoryStmts.length >= 4,
    "catalog.set_category_number's, catalog.create_category's and catalog.set_category_item_options' own UPDATEs have moved or been removed",
  );
  const ALLOWED_CATEGORY_COLUMNS = ["numeric_id = ?", "item_options_set_at = datetime('now')", "item_options_set_at = NULL"];
  for (const [, captured] of categoryStmts) {
    assert.ok(
      ALLOWED_CATEGORY_COLUMNS.includes(captured.trim()),
      `an UPDATE mirror_category in catalog-write.js touches an unexpected column: ${captured}`,
    );
  }

  /* Same guard again, for mirror_vendor's own OURS-only exception:
     commission_pct, and only commission_pct — written directly from TWO
     places (catalog.create_product, catalog.set_square_attributes), the
     same "every match, not just the first" reasoning as both loops above. */
  const vendorStmts = [...writer.matchAll(/UPDATE mirror_vendor SET ([\s\S]*?) WHERE/g)];
  assert.ok(
    vendorStmts.length >= 2,
    "catalog.create_product's and catalog.set_square_attributes' own commission_pct UPDATEs have moved or been removed",
  );
  for (const [, captured] of vendorStmts) {
    assert.equal(captured.trim(), "commission_pct = ?", "an UPDATE mirror_vendor in catalog-write.js touches an unexpected column");
  }

  /* Same guard, for mirror_category_item_option's own two UPDATE shapes —
     reactivating a row (archived_at = NULL) and archiving one
     (archived_at = datetime('now')), and only those, never anything that
     reads as a disguised DELETE. */
  const categoryItemOptionStmts = [...writer.matchAll(/UPDATE mirror_category_item_option SET ([\s\S]*?) WHERE/g)];
  assert.ok(categoryItemOptionStmts.length >= 2, "catalog.set_category_item_options' own archived_at UPDATEs have moved or been removed");
  const ALLOWED_CATEGORY_ITEM_OPTION_COLUMNS = ["archived_at = NULL", "archived_at = datetime('now')"];
  for (const [, captured] of categoryItemOptionStmts) {
    assert.ok(
      ALLOWED_CATEGORY_ITEM_OPTION_COLUMNS.includes(captured.trim()),
      `an UPDATE mirror_category_item_option in catalog-write.js touches an unexpected column: ${captured}`,
    );
  }

  /* And the mirror schema itself refuses deletion, whatever anyone writes. */
  const f = await fixture();
  assert.throws(
    () => f.mirrorDb._raw.exec("DELETE FROM mirror_product"),
    /archive-only/,
  );
});

check("test_PRD_P0_136_square_custom_attributes__the_style_id_ledger_is_append_only_at_the_database", async () => {
  /* Belt and suspenders under the application-level conflict check above:
     the schema itself refuses an UPDATE or DELETE against
     mirror_style_id_ledger, whatever anyone writes, the same way
     mirror_product's own archive-only trigger does. */
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-04-001" });

  assert.throws(
    () => f.mirrorDb._raw.exec("UPDATE mirror_style_id_ledger SET product_id = 'someone-else'"),
    /append-only/,
  );
  assert.throws(
    () => f.mirrorDb._raw.exec("DELETE FROM mirror_style_id_ledger"),
    /append-only/,
  );
});

check("test_PRD_P0_37_mirror_is_ours__an_edit_goes_to_square_and_the_mirror_follows_it", async () => {
  const f = await fixture();
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  const before = f.mirror("SELECT * FROM mirror_product WHERE handle = 'shearling-trimmed-wool-blend-coat'")[0];
  assert.ok(before);

  const res = await approvedCall(f, "catalog.update_product", {
    handle: "shearling-trimmed-wool-blend-coat",
    title: "Shearling-trimmed wool coat",
    category_id: knitwear.id,
  });
  assert.equal(res.ok, true, res.error);

  const paths = f.calls().map((c) => c.path);
  assert.deepEqual(paths, ["/v2/catalog/object", "/v2/vendors/search", "/v2/catalog/search"]);

  const after = f.mirror("SELECT * FROM mirror_product WHERE handle = 'shearling-trimmed-wool-blend-coat'")[0];
  assert.equal(after.title, "Shearling-trimmed wool coat");
  assert.equal(after.id, before.id, "our uuid survives an edit");
  assert.equal(after.handle, before.handle, "and so does the public URL");
  assert.equal(after.category_id, knitwear.id);

  /* The variations were not named in the edit, so they are unchanged and still
     priced — an edit that silently dropped them is the failure this guards. */
  const variants = f.mirror(`SELECT * FROM mirror_variant WHERE product_id = '${after.id}' ORDER BY ordinal`);
  assert.equal(variants.length, 2);
  assert.deepEqual([...new Set(variants.map((v) => v.price_minor))], [560000]);

  /*
   * Now reprice ONE size, by our variant id. Square's upsert replaces
   * item_data.variations wholesale, so a patch that named only this one and was
   * forwarded as-is would delete the other size from the till. The merge is
   * what stops that, and this is the assertion that keeps it true.
   */
  const one = variants[0];
  const repriced = await approvedCall(f, "catalog.update_product", {
    handle: "shearling-trimmed-wool-blend-coat",
    variations: [{ variant_id: one.id, title: one.title, sku: one.sku, price_minor: 499000, currency: "USD" }],
  });
  assert.equal(repriced.ok, true, repriced.error);

  const now = f.mirror(`SELECT * FROM mirror_variant WHERE product_id = '${after.id}' ORDER BY ordinal`);
  assert.equal(now.length, 2, "the size that was not mentioned is still for sale");
  assert.equal(now[0].price_minor, 499000);
  assert.equal(now[1].price_minor, 560000);
  assert.deepEqual(now.map((v) => v.external_ref), variants.map((v) => v.external_ref), "the same variations, not new ones");

  /* And a reprice to zero is refused on the RESULT of the edit, the same way a
     creation would be. */
  const zeroed = await runTool(
    "catalog.update_product",
    {
      handle: "shearling-trimmed-wool-blend-coat",
      variations: [{ variant_id: one.id, title: one.title, price_minor: 0, currency: "USD" }],
    },
    f.ctx,
  );
  assert.equal(zeroed.ok, false);
  assert.match(zeroed.error, /Zero is not a discount/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-71 — channel: which audience sees a product. Ours, not Square's.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_71_product_channel__a_freshly_synced_product_defaults_to_direct_link", async () => {
  /* Every product already has a working page; the only real decision left
     is whether it is ALSO browsable in the grid, and nobody has said so
     yet for a product that just arrived from Square. */
  const f = await fixture();
  const row = f.mirror("SELECT channel FROM mirror_product WHERE handle = 'shearling-trimmed-wool-blend-coat'")[0];
  assert.equal(row.channel, "direct_link");
});

check("test_PRD_P0_71_product_channel__set_channel_writes_the_mirror_directly_and_calls_square_for_nothing", async () => {
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_channel", {
    handle: "shearling-trimmed-wool-blend-coat",
    channel: "website",
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.updated, true);
  assert.equal(res.data.channel, "website");
  assert.equal(res.data.previous_channel, "direct_link");
  assert.equal(res.data.authority, "ours");

  /* No Square call at all — this concept does not exist on Square's side. */
  assert.deepEqual(f.calls(), []);

  const row = f.mirror("SELECT channel FROM mirror_product WHERE handle = 'shearling-trimmed-wool-blend-coat'")[0];
  assert.equal(row.channel, "website");
});

check("test_PRD_P0_71_product_channel__website_and_direct_link_are_the_only_choices", async () => {
  const f = await fixture();
  const bad = await runTool(
    "catalog.set_channel",
    { handle: "shearling-trimmed-wool-blend-coat", channel: "everywhere" },
    f.ctx,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error, /must be one of website, direct_link/);

  /* website is a real change from the fixture's own default (direct_link);
     switching back is a real change too — both of the only two choices
     actually write. */
  const toWebsite = await approvedCall(f, "catalog.set_channel", {
    handle: "shearling-trimmed-wool-blend-coat",
    channel: "website",
  });
  assert.equal(toWebsite.ok, true, toWebsite.error);

  const backToDirectLink = await approvedCall(f, "catalog.set_channel", {
    handle: "shearling-trimmed-wool-blend-coat",
    channel: "direct_link",
  });
  assert.equal(backToDirectLink.ok, true, backToDirectLink.error);
  assert.equal(
    f.mirror("SELECT channel FROM mirror_product WHERE handle = 'shearling-trimmed-wool-blend-coat'")[0].channel,
    "direct_link",
  );
});

check("test_PRD_P0_71_product_channel__an_unknown_handle_is_refused", async () => {
  const f = await fixture();
  const res = await runTool("catalog.set_channel", { handle: "does-not-exist", channel: "website" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /no product with handle/);
});

check("test_PRD_P0_71_product_channel__setting_the_same_channel_again_is_refused_as_a_no_op", async () => {
  const f = await fixture();
  const res = await runTool(
    "catalog.set_channel",
    { handle: "shearling-trimmed-wool-blend-coat", channel: "direct_link" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /already direct_link/);
});

check("test_PRD_P0_71_product_channel__the_tool_holds_no_square_resource_at_all", () => {
  /* Structural, like every other "this tool cannot reach X" guarantee in this
     codebase: a missing declaration, not a promise the body keeps. */
  const tool = TOOLS["catalog.set_channel"];
  assert.ok(tool, "catalog.set_channel is not registered");
  assert.deepEqual(tool.resources ?? [], []);
  assert.deepEqual(tool.stores, ["catalog_mirror"]);
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-137 — Active: Square's own sale lifecycle, archived or not. The
 * opposite structural shape from set_channel above (which holds no Square
 * resource at all) — this one both holds `square` and actually calls it,
 * since archiving/restoring is a real write to the authority (ADR-009).
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_137_item_active_toggle__the_tool_holds_the_square_resource_unlike_channel", () => {
  const tool = TOOLS["catalog.set_active"];
  assert.ok(tool, "catalog.set_active is not registered");
  assert.deepEqual(tool.resources, ["square"]);
  assert.deepEqual(tool.stores, ["catalog_mirror"]);
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");
});

check("test_PRD_P0_137_item_active_toggle__archiving_calls_square_and_the_mirror_reflects_it", async () => {
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_active", { handle: COAT_HANDLE, active: false });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.active, false);
  assert.equal(res.data.handle, COAT_HANDLE);
  assert.equal(res.data.synced, true);

  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.method === "POST");
  assert.ok(upsert, "archiving must actually write to Square");
  assert.equal(upsert.body.object.present_at_all_locations, false);
  assert.deepEqual(upsert.body.object.present_at_location_ids, []);
  assert.ok(upsert.body.object.item_data, "item_data must round-trip, never a bare presence patch");

  const row = f.mirror(`SELECT status, archived_at FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(row.status, "archived");
  assert.ok(row.archived_at, "the immediate resync must have archived the mirror row too");
});

check("test_PRD_P0_137_item_active_toggle__restoring_an_archived_product_calls_square_and_the_mirror_reflects_it", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.set_active", { handle: COAT_HANDLE, active: false });
  const res = await approvedCall(f, "catalog.set_active", { handle: COAT_HANDLE, active: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.active, true);
  assert.equal(res.data.synced, true);

  const upserts = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.method === "POST");
  const restore = upserts[upserts.length - 1];
  assert.equal(restore.body.object.present_at_all_locations, true);
  assert.equal(restore.body.object.present_at_location_ids, undefined, "omitted, not an empty list, once present everywhere");

  const row = f.mirror(`SELECT status, archived_at FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(row.status, "active");
  assert.equal(row.archived_at, null);
});

check("test_PRD_P0_137_item_active_toggle__setting_the_same_state_again_is_refused_as_a_no_op", async () => {
  const f = await fixture();
  const res = await runTool("catalog.set_active", { handle: COAT_HANDLE, active: true }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already active/);
  assert.deepEqual(f.calls(), [], "a refused no-op must never reach Square");
});

check("test_PRD_P0_137_item_active_toggle__an_unknown_handle_is_refused", async () => {
  const f = await fixture();
  const res = await runTool("catalog.set_active", { handle: "does-not-exist", active: false }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /no product with handle/);
});

check("test_PRD_P0_137_item_active_toggle__a_failed_immediate_resync_does_not_refuse_the_archive", async () => {
  /* Reproduces the same shape of real production incident P0-31's own
     inventory.adjust hardening fixed: the write to Square (retractProduct)
     already succeeded — it is the authoritative one, ADR-009 — but the
     immediate follow-up resync (this call's own best-effort shortcut to
     reflect that back without waiting for the next cron) fails. That must
     never make the whole call look refused. */
  const f = await fixture({ failSearch: true });
  const res = await approvedCall(f, "catalog.set_active", { handle: COAT_HANDLE, active: false });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.active, false, "the optimistic value the write to Square already applied");
  assert.equal(res.data.synced, false, "honest about the immediate resync having failed");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-136 — style_id, vendor and commission, Square's own Custom Attributes.
 * The opposite structural shape from set_channel above: this tool DOES hold
 * `square` and DOES call it, because Square is authoritative for all three.
 * ───────────────────────────────────────────────────────────────────────── */

const COAT_HANDLE = "shearling-trimmed-wool-blend-coat";

check("test_PRD_P0_136_square_custom_attributes__the_tool_holds_the_square_resource_unlike_channel", () => {
  const tool = TOOLS["catalog.set_square_attributes"];
  assert.ok(tool, "catalog.set_square_attributes is not registered");
  assert.deepEqual(tool.resources, ["square"]);
  assert.deepEqual(tool.stores, ["catalog_mirror"]);
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");
});

check("test_PRD_P0_136_square_custom_attributes__setting_both_calls_square_then_syncs_the_mirror", async () => {
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    style_id: "01-04-001",
    vendor: "Acme Mills",
    commission: 20,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.style_id, "01-04-001");
  assert.equal(res.data.vendor, "Acme Mills");
  assert.equal(res.data.authority, "square");

  /* style_id and commission stay Custom Attributes; vendor does NOT — it is
     Square's own Vendor entity now, referenced by vendor_id in
     vendor_information on EVERY variation (Test-PRD-P0-136-square_custom_
     attributes, revised for Retail Plus), not a plain-text
     custom_attribute_values entry. */
  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  assert.ok(upsert, "must actually call UpsertCatalogObject");
  assert.deepEqual(upsert.body.object.item_data.custom_attribute_values, {
    style_id: { key: "style_id", type: "STRING", string_value: "01-04-001" },
    commission: { key: "commission", type: "STRING", string_value: "20" },
  });
  const variation = upsert.body.object.item_data.variations[0];
  assert.ok(variation.item_variation_data.vendor_information?.[0]?.vendor_id, "vendor_information must be set");

  const product = f.mirror(`SELECT id, style_id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(product.style_id, "01-04-001");
  const variant = f.mirror(
    `SELECT mv.name AS vendor FROM mirror_variant v JOIN mirror_vendor mv ON mv.id = v.vendor_id WHERE v.product_id = '${product.id}'`,
  )[0];
  assert.equal(variant.vendor, "Acme Mills");
});

check("test_PRD_P0_136_square_custom_attributes__style_id_must_match_the_shops_own_nomenclature", async () => {
  const f = await fixture();
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, style_id: "not-a-style-id" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /NN-NN-NNN/);
  assert.deepEqual(f.calls(), [], "a refused style_id must never reach Square");
});

check("test_PRD_P0_136_square_custom_attributes__a_duplicate_style_id_auto_bumps_to_the_next_free_index", async () => {
  /* REVISED: "No it must be auto generated... Auto bump" — the owner's own
     words. An explicit style_id that already belongs to another product no
     longer refuses outright — it bumps to the next unused index under the
     same NN-NN prefix instead. */
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-04-001" });

  const category = f.categories()[0];
  const created = await approvedCall(f, "catalog.create_product", {
    title: "Second Coat",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 45000, currency: "USD" }],
  });
  assert.equal(created.ok, true, created.error);
  const secondHandle = created.data.product.handle;

  const gate = await runTool("catalog.set_square_attributes", { handle: secondHandle, style_id: "01-04-001" }, f.ctx);
  assert.equal(gate.needsApproval, true, "a bump is still a real change and still needs approval");
  assert.match(gate.data.would, /01-04-001.*already assigned to.*used '01-04-002' instead/);

  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: secondHandle, style_id: "01-04-001" },
    { ...f.ctx, approvalToken: gate.data.approval.token },
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.style_id, "01-04-002", "bumped to the next free index, never refused");
});

check("test_PRD_P0_136_square_custom_attributes__a_style_id_stays_reserved_even_after_the_product_moves_off_it", async () => {
  /* The owner's own words: "we want that style number to be held, so that
     you don't overwrite that style number and reuse it for something
     else." mirror_product.style_id is only ever the CURRENT value — this
     proves the OLD one a product edited away from is still refused for a
     second product, via mirror_style_id_ledger (schema.sql). */
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-04-001" });
  /* The coat moves on to a different number entirely. */
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-04-002" });

  const category = f.categories()[0];
  const created = await approvedCall(f, "catalog.create_product", {
    title: "Second Coat",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 45000, currency: "USD" }],
  });
  assert.equal(created.ok, true, created.error);

  /* REVISED: "Auto bump" — the owner's own words. Reusing the coat's own
     OLD, still-reserved number no longer refuses outright either — it
     bumps past BOTH numbers the coat's own ledger history already holds
     (001 and 002), landing on 003, never on either reserved one. */
  const reuse = await approvedCall(f, "catalog.set_square_attributes", {
    handle: created.data.product.handle,
    style_id: "01-04-001",
  });
  assert.equal(reuse.ok, true, reuse.error);
  assert.equal(reuse.data.style_id, "01-04-003", "bumped past both reserved numbers, never assigned either");

  /* And the coat itself is free to move BACK to the number it once held —
     that is a conflict with no product at all, since it is the ledger row
     the coat itself already owns. */
  const backOnOldOne = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-04-001" });
  assert.equal(backOnOldOne.ok, true, backOnOldOne.error);

  const ledgerRows = f.mirror("SELECT style_id, product_id FROM mirror_style_id_ledger ORDER BY style_id");
  assert.deepEqual(
    ledgerRows.map((r) => r.style_id),
    ["01-04-001", "01-04-002", "01-04-003"],
    "every number ever actually assigned stays ledgered forever, never freed",
  );
});

check("test_PRD_P0_136_square_custom_attributes__giving_only_one_field_leaves_the_others_untouched", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    style_id: "01-04-001",
    vendor: "Acme Mills",
    commission: 20,
  });

  /* "New Vendor" already exists (on a different product) by the time COAT's
     own call below reuses it — the "creating a vendor needs a commission"
     rule only bites the moment a vendor is actually CREATED, so this
     single-field call needs no commission of its own. */
  const category = f.categories()[0];
  await approvedCall(f, "catalog.create_product", {
    title: "Another Product",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 1000, currency: "USD" }],
    vendor: "New Vendor",
    commission: 10,
  });

  const res = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "New Vendor" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.style_id, "01-04-001", "style_id must survive a call that only meant to change vendor");
  assert.equal(res.data.vendor, "New Vendor");
});

check("test_PRD_P0_136_square_custom_attributes__setting_the_same_values_again_is_refused_as_a_no_op", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills", commission: 20 });
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, vendor: "Acme Mills" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /already has those values/);
});

check("test_PRD_P0_136_square_custom_attributes__staff_cannot_call_it", async () => {
  const f = await fixture();
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, vendor: "Acme Mills" },
    { ...f.ctx, ...staff },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /manager/i);
});

check("test_PRD_P0_136_square_custom_attributes__commission_requires_a_vendor", async () => {
  /* The owner's own words: "that's only for vendors — anything that has a
     vendor, it has a commission." A product with no vendor at all cannot
     take a commission, resolved from whatever this same call ALSO sets. */
  const f = await fixture();
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, commission: 20 },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no vendor/);
  assert.deepEqual(f.calls(), [], "a refused commission must never reach Square");
});

check("test_PRD_P0_136_square_custom_attributes__commission_alongside_a_vendor_in_the_same_call_is_allowed", async () => {
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    vendor: "Acme Mills",
    commission: 20,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.vendor, "Acme Mills");
  assert.equal(res.data.commission, 20);

  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  assert.deepEqual(upsert.body.object.item_data.custom_attribute_values.commission, {
    key: "commission",
    type: "STRING",
    string_value: "20",
  });

  const row = f.mirror(`SELECT commission_pct FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(row.commission_pct, 20);
});

check("test_PRD_P0_136_square_custom_attributes__vendor_code_and_unit_cost_require_a_vendor_too", async () => {
  /* vendor_code and unit_cost_minor live on the SAME real Square Vendor
     association as vendor (Retail Plus/Premium, revised) — they make no
     sense without one, the same rule commission already gets. */
  const f = await fixture();
  const codeRes = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, vendor_code: "ACME-4471" },
    f.ctx,
  );
  assert.equal(codeRes.ok, false);
  assert.match(codeRes.error, /no vendor/);

  const costRes = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, unit_cost_minor: 4200 },
    f.ctx,
  );
  assert.equal(costRes.ok, false);
  assert.match(costRes.error, /no vendor/);
  assert.deepEqual(f.calls(), [], "neither refusal reaches Square");
});

check("test_PRD_P0_136_square_custom_attributes__vendor_code_and_unit_cost_alongside_a_vendor_are_set_on_the_variation", async () => {
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    vendor: "Acme Mills",
    vendor_code: "ACME-4471",
    unit_cost_minor: 4250,
    commission: 20,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.vendor_code, "ACME-4471");
  assert.equal(res.data.unit_cost_minor, 4250);

  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  const vendorInfo = upsert.body.object.item_data.variations[0].item_variation_data.vendor_information[0];
  assert.equal(vendorInfo.vendor_code, "ACME-4471");
  assert.deepEqual(vendorInfo.unit_cost_money, { amount: 4250, currency: "USD" });

  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  const variant = f.mirror(
    `SELECT vendor_code, unit_cost_minor, unit_cost_currency FROM mirror_variant WHERE product_id = '${product.id}'`,
  )[0];
  assert.equal(variant.vendor_code, "ACME-4471");
  assert.equal(variant.unit_cost_minor, 4250);
  assert.equal(variant.unit_cost_currency, "USD");
});

check("test_PRD_P0_136_square_custom_attributes__clear_vendor_removes_the_vendor_and_everything_that_depends_on_it", async () => {
  /* "I don't like adding none to vendors. Let's just make the vendor
     selected vendor toggle so that if I selected a vendor and then I
     selected the same vendor again, it just clears that selection." —
     clear_vendor: true is the tool-layer half of that: the generic
     schema validator refuses an empty "vendor" string outright, so
     clearing needs its own boolean flag, the same shape catalog.
     set_category_number's own clear: true already established. Clearing
     removes vendor_code/unit_cost/commission right along with it, since
     none of those apply without a vendor. */
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    vendor: "Acme Mills",
    vendor_code: "ACME-4471",
    unit_cost_minor: 4250,
    commission: 20,
  });

  const callsBeforeClear = f.calls().length;
  const res = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, clear_vendor: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.vendor, null);
  assert.equal(res.data.vendor_code, null);
  assert.equal(res.data.unit_cost_minor, null);
  assert.equal(res.data.commission, null);

  /* Square's own UpsertCatalogObject is full-replacement — clearing must
     never call vendorRef/CreateVendor for an empty name, and must send
     no vendor_information at all for the variation (undefined, the same
     "genuinely absent, not present-and-empty" shape a brand-new product
     with no vendor yet already gets). Only calls made BY THE CLEAR itself
     count here — the earlier call above legitimately created "Acme Mills"
     the first time it was ever named. */
  const callsDuringClear = f.calls().slice(callsBeforeClear);
  const upsert = callsDuringClear.find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  const variation = upsert.body.object.item_data.variations[0];
  assert.equal(variation.item_variation_data.vendor_information, undefined);
  assert.ok(
    !callsDuringClear.some((c) => c.path === "/v2/vendors/create"),
    "clearing must never create a Square Vendor for an empty name",
  );

  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  const variant = f.mirror(`SELECT vendor_id, vendor_code FROM mirror_variant WHERE product_id = '${product.id}'`)[0];
  assert.equal(variant.vendor_id, null);
  assert.equal(variant.vendor_code, null);
});

check("test_PRD_P0_136_square_custom_attributes__clear_vendor_and_vendor_together_is_refused", async () => {
  const f = await fixture();
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, vendor: "Acme Mills", clear_vendor: true },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /give either vendor or clear_vendor: true, not both/);
  assert.deepEqual(f.calls(), []);
});

check("test_PRD_P0_136_square_custom_attributes__clear_vendor_alongside_vendor_code_or_commission_is_refused_the_same_as_having_no_vendor", async () => {
  /* clear_vendor resolves the SAME resultingVendor (null/falsy) the
     "no vendor at all" case already refuses vendor_code/unit_cost/
     commission against -- clearing and setting one of those facts in the
     same call makes no more sense than setting them with no vendor ever
     assigned. */
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills", commission: 20 });
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, clear_vendor: true, commission: 20 },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no vendor/);
});

check("test_PRD_P0_136_square_custom_attributes__clear_vendor_on_a_product_with_no_vendor_is_refused_as_a_no_op", async () => {
  const f = await fixture();
  const res = await runTool("catalog.set_square_attributes", { handle: COAT_HANDLE, clear_vendor: true }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already has those values/);
  assert.deepEqual(f.calls(), [], "a no-op clear must never reach Square");
});

check("test_PRD_P0_136_square_custom_attributes__update_product_refuses_a_per_variation_unit_cost_with_no_vendor", async () => {
  /* Revised again — "all the variants can have a different unit cost too"
     — catalog.update_product's own variations array can now carry
     unit_cost_minor, and it is refused the same "facts about a VENDOR's
     product" way catalog.set_square_attributes' own unit_cost_minor
     already is, before Square ever sees it. */
  const f = await fixture();
  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  const variants = f.mirror(`SELECT id, title, price_minor, currency FROM mirror_variant WHERE product_id = '${product.id}' ORDER BY ordinal`);

  const res = await runTool(
    "catalog.update_product",
    {
      handle: COAT_HANDLE,
      variations: [{ variant_id: variants[0].id, title: variants[0].title, price_minor: variants[0].price_minor, currency: variants[0].currency, unit_cost_minor: 4200 }],
    },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /has no vendor, so unit_cost_minor does not apply/);
  assert.deepEqual(f.calls(), [], "the refusal never reaches Square");
});

check("test_PRD_P0_136_square_custom_attributes__each_variation_can_carry_its_own_unit_cost", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills", commission: 20 });

  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  const variants = f.mirror(`SELECT id, title, price_minor, currency FROM mirror_variant WHERE product_id = '${product.id}' ORDER BY ordinal`);
  assert.equal(variants.length, 2, "this fixture product needs two variations for a real per-variation test");

  /* Only the FIRST variation's own cost is being touched — the second is
     resent unchanged, the same "resend or it may vanish" rule its own
     title/price already follow. */
  const res = await approvedCall(f, "catalog.update_product", {
    handle: COAT_HANDLE,
    variations: [
      { variant_id: variants[0].id, title: variants[0].title, price_minor: variants[0].price_minor, currency: variants[0].currency, unit_cost_minor: 3100 },
      { variant_id: variants[1].id, title: variants[1].title, price_minor: variants[1].price_minor, currency: variants[1].currency },
    ],
  });
  assert.equal(res.ok, true, res.error);

  const rows = f.mirror(`SELECT id, unit_cost_minor FROM mirror_variant WHERE product_id = '${product.id}' ORDER BY ordinal`);
  assert.equal(rows.find((r) => r.id === variants[0].id).unit_cost_minor, 3100);
  assert.equal(rows.find((r) => r.id === variants[1].id).unit_cost_minor, 0, "the untouched variation was never given a cost of its own, so it stays at its own default");

  /* And editing that SAME first variation again, for something unrelated
     (its title), leaves its own cost exactly where it was — an edit that
     is not about cost must not silently reset it back to the product's
     old uniform default. */
  const retitled = await approvedCall(f, "catalog.update_product", {
    handle: COAT_HANDLE,
    variations: [{ variant_id: variants[0].id, title: "Relabeled size", price_minor: variants[0].price_minor, currency: variants[0].currency }],
  });
  assert.equal(retitled.ok, true, retitled.error);
  const after = f.mirror(`SELECT unit_cost_minor FROM mirror_variant WHERE id = '${variants[0].id}'`)[0];
  assert.equal(after.unit_cost_minor, 3100, "an edit that was not about cost must not reset it");
});

check("test_PRD_P0_136_square_custom_attributes__reusing_an_existing_vendor_name_does_not_create_a_second_vendor", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills", commission: 20 });
  assert.equal(f.square.vendors.size, 1, "Square gained exactly one Vendor");

  const category = f.categories()[0];
  const created = await approvedCall(f, "catalog.create_product", {
    title: "Second Coat",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 45000, currency: "USD" }],
    vendor: "Acme Mills",
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(f.square.vendors.size, 1, "the SAME vendor is reused by name, not recreated");

  const vendorCalls = f.calls().filter((c) => c.path === "/v2/vendors/create");
  assert.equal(vendorCalls.length, 1, "only the FIRST call ever created a vendor; the second reused it");
});

check("test_PRD_P0_136_square_custom_attributes__creating_a_new_vendor_via_set_square_attributes_requires_a_commission", async () => {
  /* The owner's own words: "I need to specify a commission if I create a
     vendor." "Acme Mills" does not exist anywhere in this fresh fixture, so
     this call would CREATE it — and, either way, it has nothing on file. */
  const f = await fixture();
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, vendor: "Acme Mills" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /has no commission on file yet — give one now/);
  assert.deepEqual(f.calls(), [], "a refused new-vendor-with-no-commission call must never reach Square");
});

check("test_PRD_P0_136_square_custom_attributes__creating_a_new_vendor_via_create_product_requires_a_commission", async () => {
  const f = await fixture();
  const category = f.categories()[0];
  const res = await runTool("catalog.create_product", {
    title: "Another Product",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 1000, currency: "USD" }],
    vendor: "Acme Mills",
  }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /has no commission on file yet — give one now/);
  assert.deepEqual(f.calls(), [], "a refused new-vendor-with-no-commission call must never reach Square");
});

check("test_PRD_P0_136_square_custom_attributes__a_vendor_with_no_commission_on_file_anywhere_still_needs_one_even_if_square_already_knows_it", async () => {
  /* REVISED: "let's not force vendor's commission to be stated out loud...
     but if we are entering items that has a vendor, that's when we want
     to make sure there is a commission included" -- the owner's own
     words. Existing is no longer enough on its own: a vendor Square
     already has on record (synced in directly, never given a rate by
     this shop) is exactly as unable to supply one automatically as a
     brand-new one. */
  const f = await fixture();
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_vendor (id, external_ref, name) VALUES ('vendor-seed', 'sqvendor-seed', 'Acme Mills')")
    .run();
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, vendor: "Acme Mills" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /has no commission on file yet — give one now/);
});

check("test_PRD_P0_136_square_custom_attributes__a_vendors_own_on_file_commission_is_applied_automatically_with_no_commission_restated", async () => {
  /* REVISED: "we store it in essential locations per vendor so that their
     commission is recorded in a central location and automatically
     applied" -- the owner's own words. Once ANY call gives Acme Mills a
     commission, every later product naming that same vendor with no
     commission of its own picks up that exact rate, unprompted. */
  const f = await fixture();
  const category = f.categories()[0];
  await approvedCall(f, "catalog.create_product", {
    title: "Another Product",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 1000, currency: "USD" }],
    vendor: "Acme Mills",
    commission: 15,
  });

  const res = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.vendor, "Acme Mills");
  assert.equal(res.data.commission, 15, "the vendor's own on-file rate, applied with nothing restated");

  const vendorRow = f.mirror("SELECT commission_pct FROM mirror_vendor WHERE name = 'Acme Mills'")[0];
  assert.equal(vendorRow.commission_pct, 15, "the central rate itself is unaffected by reading it for a second product");
});

check("test_PRD_P0_136_square_custom_attributes__catalog_vendors_lists_every_vendor_with_its_own_commission", async () => {
  /* "The same kind of drop down schema that we have for categories" -- the
     owner's own words. catalog.vendors is the read side, mirroring
     catalog.categories exactly. */
  const f = await fixture();
  const empty = await runTool("catalog.vendors", {}, f.ctx);
  assert.equal(empty.ok, true, empty.error);
  assert.deepEqual(empty.data.vendors, []);

  await approvedCall(f, "catalog.create_vendor", { name: "Acme Mills", commission: 20, reason: "test" });
  const res = await runTool("catalog.vendors", {}, f.ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.count, 1);
  assert.equal(res.data.vendors[0].name, "Acme Mills");
  assert.equal(res.data.vendors[0].commission_pct, 20);
});

check("test_PRD_P0_141_item_option_sets_mirrored__catalog_item_options_lists_every_option_set_with_its_own_values", async () => {
  const f = await fixture();
  const empty = await runTool("catalog.item_options", {}, f.ctx);
  assert.equal(empty.ok, true, empty.error);
  assert.deepEqual(empty.data.item_options, [], "the seed catalog defines no option set yet");

  /* An option set created directly in Square and not yet used by any item --
     the owner's own question ("do you have access to these option sets?")
     is exactly this case, and it must still show up here. */
  const normalised = normaliseCatalog([
    {
      type: "ITEM_OPTION",
      id: "OPT_SIZE",
      is_deleted: false,
      item_option_data: {
        name: "Size",
        values: [
          { type: "ITEM_OPTION_VAL", id: "OPTVAL_S", item_option_value_data: { name: "S" } },
          { type: "ITEM_OPTION_VAL", id: "OPTVAL_M", item_option_value_data: { name: "M" } },
        ],
      },
    },
  ]);
  await f.writer.adapter.mirror.syncCatalog(normalised, { full: false });

  const res = await runTool("catalog.item_options", {}, f.ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.count, 1);
  assert.equal(res.data.item_options[0].name, "Size");
  assert.deepEqual(
    res.data.item_options[0].values.map((v) => v.name),
    ["S", "M"],
    "in Square's own ordinal order, not alphabetical",
  );
});

check("test_PRD_P0_141_item_option_sets_mirrored__catalog_item_options_is_t0_and_read_only", () => {
  assert.equal(TOOLS["catalog.item_options"].tier, "T0");
  assert.equal(TOOLS["catalog.item_options"].undo, null);
  assert.deepEqual(TOOLS["catalog.item_options"].resources ?? [], []);
  assert.ok(describeTools("staff").map((d) => d.name).includes("catalog.item_options"));
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-142 — a category's own option sets: "I don't want to be adding the
 * same option sets to every single category" — a per-category association,
 * ours alone, since Square has no such mechanism.
 * ───────────────────────────────────────────────────────────────────────── */

function seedItemOption(f, { id = "opt1", externalRef = "SQ_OPT_SIZE", name = "Size" } = {}) {
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_item_option (id, external_ref, name) VALUES (?, ?, ?)")
    .run(id, externalRef, name);
  return { id, name };
}

check("test_PRD_P0_142_category_item_options__set_category_item_options_assigns_and_the_read_side_reflects_it", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f);

  const res = await approvedCall(f, "catalog.set_category_item_options", {
    category_id: outerwear.id,
    item_option_ids: [size.id],
    reason: "test",
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.item_option_ids, [size.id]);

  const row = f.mirror("SELECT archived_at FROM mirror_category_item_option WHERE category_id = ? AND item_option_id = ?", outerwear.id, size.id)[0];
  assert.equal(row.archived_at, null);
});

check("test_PRD_P0_142_category_item_options__a_resend_fully_replaces_the_set_never_merges", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f, { id: "opt1", externalRef: "SQ_OPT_SIZE", name: "Size" });
  const color = seedItemOption(f, { id: "opt2", externalRef: "SQ_OPT_COLOR", name: "Color" });

  await approvedCall(f, "catalog.set_category_item_options", {
    category_id: outerwear.id,
    item_option_ids: [size.id],
    reason: "test",
  });
  const replaced = await approvedCall(f, "catalog.set_category_item_options", {
    category_id: outerwear.id,
    item_option_ids: [color.id],
    reason: "test",
  });
  assert.equal(replaced.ok, true, replaced.error);
  assert.deepEqual(replaced.data.item_option_ids, [color.id]);

  const sizeRow = f.mirror("SELECT archived_at FROM mirror_category_item_option WHERE category_id = ? AND item_option_id = ?", outerwear.id, size.id)[0];
  assert.ok(sizeRow.archived_at, "Size is unassigned -- archived, never deleted");
  const colorRow = f.mirror("SELECT archived_at FROM mirror_category_item_option WHERE category_id = ? AND item_option_id = ?", outerwear.id, color.id)[0];
  assert.equal(colorRow.archived_at, null);
});

check("test_PRD_P0_142_category_item_options__reassigning_a_previously_unassigned_option_reactivates_the_same_row", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f);

  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [], reason: "test" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const rows = f.mirror("SELECT archived_at FROM mirror_category_item_option WHERE category_id = ? AND item_option_id = ?", outerwear.id, size.id);
  assert.equal(rows.length, 1, "the same row is reused, not re-inserted");
  assert.equal(rows[0].archived_at, null);
});

check("test_PRD_P0_142_category_item_options__an_empty_list_clears_every_assignment", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f);
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [], reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.item_option_ids, []);
  const row = f.mirror("SELECT archived_at FROM mirror_category_item_option WHERE category_id = ? AND item_option_id = ?", outerwear.id, size.id)[0];
  assert.ok(row.archived_at);
});

check("test_PRD_P0_142_category_item_options__refuses_an_unknown_category_or_item_option", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f);

  const badCategory = await runTool("catalog.set_category_item_options", { category_id: "no-such-category", item_option_ids: [], reason: "test" }, f.ctx);
  assert.equal(badCategory.ok, false);
  assert.match(badCategory.error, /no category/);

  const badOption = await runTool(
    "catalog.set_category_item_options",
    { category_id: outerwear.id, item_option_ids: ["no-such-option"], reason: "test" },
    f.ctx,
  );
  assert.equal(badOption.ok, false);
  assert.match(badOption.error, /no item option/);
  void size;
});

check("test_PRD_P0_142_category_item_options__refuses_a_no_op_resend_of_the_exact_same_set", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f);
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await runTool("catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already offers exactly this set/);
});

check("test_PRD_P0_142_category_item_options__staff_cannot_call_it_and_it_touches_no_square_resource", async () => {
  const f = await fixture();
  assert.deepEqual(TOOLS["catalog.set_category_item_options"].resources ?? [], []);
  assert.ok(!describeTools("staff").map((d) => d.name).includes("catalog.set_category_item_options"));
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f);
  const res = await runTool(
    "catalog.set_category_item_options",
    { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" },
    { ...f.ctx, role: "staff" },
  );
  assert.equal(res.ok, false);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-142 (REVISED) — inheritance: "when I set sets for a category, all
 * subcategories inherit the sets unless I specify different selections
 * for the subcategories" — the owner's own words.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_142_category_item_options__a_subcategory_with_no_explicit_set_inherits_its_parents", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  const size = seedItemOption(f);

  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });
  const effective = await effectiveCategoryItemOptionIds(f.mirrorDb);
  assert.deepEqual([...(effective.get(casual.id) ?? [])], [size.id], "Casual never set its own -- it inherits Outerwear's");
  assert.deepEqual([...(effective.get(outerwear.id) ?? [])], [size.id]);
});

check("test_PRD_P0_142_category_item_options__specifying_a_selection_for_the_subcategory_stops_it_inheriting", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  const size = seedItemOption(f, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const color = seedItemOption(f, { id: "opt2", externalRef: "sqopt2", name: "Color" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  /* "Unless I specify different selections" -- Casual names its own,
     independent of whatever Outerwear has on file. */
  await approvedCall(f, "catalog.set_category_item_options", { category_id: casual.id, item_option_ids: [color.id], reason: "test" });
  let effective = await effectiveCategoryItemOptionIds(f.mirrorDb);
  assert.deepEqual([...(effective.get(casual.id) ?? [])], [color.id]);

  /* A later edit to the PARENT must never reach back down into a
     subcategory that has already specified its own. */
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [color.id], reason: "test" });
  effective = await effectiveCategoryItemOptionIds(f.mirrorDb);
  assert.deepEqual([...(effective.get(casual.id) ?? [])], [color.id], "still Casual's own choice, untouched by the parent's later edit");
});

check("test_PRD_P0_142_category_item_options__an_explicit_empty_set_is_a_real_override_not_a_no_op", async () => {
  /* "Unless I specify different selections" covers naming NONE too -- a
     subcategory can explicitly opt out of everything its parent offers,
     and that must not be refused as "nothing to change" just because the
     resulting row set (zero rows) looks identical to "never touched." */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  const size = seedItemOption(f);
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.set_category_item_options", { category_id: casual.id, item_option_ids: [], reason: "test" });
  assert.equal(res.ok, true, res.error);
  const effective = await effectiveCategoryItemOptionIds(f.mirrorDb);
  assert.deepEqual([...(effective.get(casual.id) ?? [])], [], "Casual now explicitly offers none, not Outerwear's inherited set");

  /* And it is now explicit -- a second identical save really is a no-op. */
  const again = await runTool("catalog.set_category_item_options", { category_id: casual.id, item_option_ids: [], reason: "test" }, f.ctx);
  assert.equal(again.ok, false);
  assert.match(again.error, /already offers exactly this set/);
});

check("test_PRD_P0_142_category_item_options__a_top_level_category_with_nothing_set_has_no_parent_to_inherit_from", async () => {
  const f = await fixture();
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  seedItemOption(f);
  const effective = await effectiveCategoryItemOptionIds(f.mirrorDb);
  assert.deepEqual([...(effective.get(knitwear.id) ?? [])], []);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-142 (REVISED AGAIN) — "there needs to be a separate option called
 * Inherit for every category... set by default to inherit... once inherit
 * is checked I don't see any options — they're grayed out and disabled.
 * But if I disable inherit, I can now adjust" — the owner's own words.
 * `inherit: true` is the one way back to NULL item_options_set_at once a
 * category has ever been made explicit — before this, only another
 * explicit save (even to the same list, or to []) was possible.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_142_category_item_options__inherit_true_clears_an_explicit_override_and_the_effective_set_reverts_to_the_parents", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  const size = seedItemOption(f, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const color = seedItemOption(f, { id: "opt2", externalRef: "sqopt2", name: "Color" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: casual.id, item_option_ids: [color.id], reason: "test" });

  const res = await approvedCall(f, "catalog.set_category_item_options", { category_id: casual.id, inherit: true, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data, { category_id: casual.id, inherit: true, authority: "ours" });

  const effective = await effectiveCategoryItemOptionIds(f.mirrorDb);
  assert.deepEqual([...(effective.get(casual.id) ?? [])], [size.id], "Casual is back to following Outerwear's own set");

  const setAt = f.mirror("SELECT item_options_set_at FROM mirror_category WHERE id = ?", casual.id)[0];
  assert.equal(setAt.item_options_set_at, null, "item_options_set_at cleared -- Casual is inheriting again, not merely holding an empty explicit set");
  const rows = f.mirror("SELECT archived_at FROM mirror_category_item_option WHERE category_id = ? AND item_option_id = ?", casual.id, color.id);
  assert.ok(rows[0].archived_at, "Casual's own former explicit row is archived, not left active for a future re-explicit save to revive by accident");
});

check("test_PRD_P0_142_category_item_options__inherit_true_on_an_already_inheriting_category_is_refused_as_a_no_op", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  seedItemOption(f);

  const res = await runTool("catalog.set_category_item_options", { category_id: casual.id, inherit: true, reason: "test" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already inheriting/);
});

check("test_PRD_P0_142_category_item_options__inherit_true_and_item_option_ids_together_still_only_clears_the_override", async () => {
  /* inherit: true takes over the whole call -- item_option_ids, even if
     also sent (e.g. a stale form field), is never consulted. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const color = seedItemOption(f, { id: "opt2", externalRef: "sqopt2", name: "Color" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.set_category_item_options", {
    category_id: outerwear.id,
    inherit: true,
    item_option_ids: [color.id],
    reason: "test",
  });
  assert.equal(res.ok, true, res.error);
  const effective = await effectiveCategoryItemOptionIds(f.mirrorDb);
  assert.deepEqual([...(effective.get(outerwear.id) ?? [])], [], "no parent of its own to inherit from -- color was never actually applied");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-144 — mass-applying a category's own option sets onto every product
 * already filed in it: "when I apply the groups to a category... you're
 * going to apply these option sets to every product that is part of the
 * category... right now, you have to apply these options manually per
 * item" — the owner's own words. Item-level only (item_data.item_options);
 * no variation is ever created, changed, or removed by this tool.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_144_apply_category_item_options__pushes_the_categorys_own_effective_set_to_every_product_in_it", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f, { id: "opt1", externalRef: "SQ_OPT_SIZE", name: "Size" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.products_applied, 1, "the coat is the only product seeded under Outerwear");
  assert.deepEqual(res.data.errors, []);

  const itemUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  assert.ok(itemUpsert, "must actually write to Square, not just the mirror");
  assert.deepEqual(itemUpsert.body.object.item_data.item_options, [{ item_option_id: "SQ_OPT_SIZE" }]);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-144 (REVISED) — "I tried it. Didn't work" — the owner's own words,
 * live: Square's real answer, once visible (Test-PRD-P0-149-auto_apply_
 * failure_visibility's own incident), was "Expected ItemVariation to have
 * 1 Item Option Values, got 0." A variation that predates this Option
 * Sets feature entirely (the seeded coat's own VAR_COAT_S/VAR_COAT_M,
 * titled "IT 38"/"IT 42", never given any item_option_values) is exactly
 * that case. Auto-match by title — the owner's own choice, asked
 * directly — is what retagByTitle (catalog-writer.js) now does.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_144_apply_category_item_options__an_existing_untagged_variation_is_retagged_by_matching_its_own_title", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    /* The coat's own two REAL, pre-existing variations are titled exactly
       this — SEED (square-catalog.json), never touched by this test. */
    values: [{ externalRef: "SQ_OPTVAL_38", name: "IT 38" }, { externalRef: "SQ_OPTVAL_42", name: "IT 42" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.errors, []);
  assert.equal(res.data.products_applied, 1);

  const itemUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  const variations = itemUpsert.body.object.item_data.variations;
  assert.equal(variations.length, 2, "both existing variations are RETAGGED in place -- neither is duplicated as a new SKU");
  const v38 = findVariationByOptionPairs(variations, [{ item_option_id: "SQ_OPT_SIZE", item_option_value_id: "SQ_OPTVAL_38" }]);
  const v42 = findVariationByOptionPairs(variations, [{ item_option_id: "SQ_OPT_SIZE", item_option_value_id: "SQ_OPTVAL_42" }]);
  assert.ok(v38, "the variation titled IT 38 must now carry Size=IT 38");
  assert.ok(v42, "the variation titled IT 42 must now carry Size=IT 42");
  assert.equal(v38.id, "VAR_COAT_S", "the SAME real SKU, retagged in place -- never a new variation");
  assert.equal(v42.id, "VAR_COAT_M", "the SAME real SKU, retagged in place -- never a new variation");

  const options = f.mirror("SELECT options FROM mirror_variant WHERE external_ref = 'VAR_COAT_S'")[0];
  assert.deepEqual(JSON.parse(options.options), { Size: "IT 38" }, "the mirror itself reflects the retag after the resync");
});

check("test_PRD_P0_144_apply_category_item_options__a_title_that_matches_no_value_is_left_exactly_as_it_was", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    /* Neither value matches "IT 38"/"IT 42" -- nothing here for
       retagByTitle to find. */
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);

  const itemUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  const variations = itemUpsert.body.object.item_data.variations;
  assert.equal(variations.length, 4, "S and M are both genuinely NEW -- the two existing, untouched variations stay, unretagged");
  const untouched = variations.filter((v) => v.id === "VAR_COAT_S" || v.id === "VAR_COAT_M");
  assert.equal(untouched.length, 2);
  for (const v of untouched) {
    assert.deepEqual(v.item_variation_data.item_option_values ?? [], [], "a title with no match is left exactly as it was, never guessed at");
  }
});

check("test_PRD_P0_144_apply_category_item_options__product_title_matching_requires_a_whole_word_never_a_bare_substring", async () => {
  /* The real bug, caught live testing this exact fix before it ever
     shipped: a naive `.includes()` against the PRODUCT's own title
     matched the single letter "S" buried inside "dres`s`" in "Black
     Dress" itself, silently mis-tagging an existing variation as Size=S
     when its own title ("One size") never said any such thing. "Best
     Seller Vest" carries "s" and "t" scattered all over it but never as
     its own standalone word "S" -- nothing here for the fallback to
     find. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const created = await approvedCall(f, "catalog.create_product", {
    title: "Best Seller Vest",
    category_id: outerwear.id,
    variations: [{ title: "One size", price_minor: 5000, currency: "USD" }],
  });
  assert.equal(created.ok, true, created.error);

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Best Seller Vest")
    .pop();
  const oneSize = itemUpsert.body.object.item_data.variations.find((v) => v.item_variation_data.name === "One size");
  assert.ok(oneSize);
  assert.deepEqual(oneSize.item_variation_data.item_option_values ?? [], [], "S is not a whole word in Best Seller Vest -- must never be guessed at from a bare substring");
});

check("test_PRD_P0_144_apply_category_item_options__applies_an_inherited_set_not_only_an_explicit_one", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  const size = seedItemOption(f, { id: "opt1", externalRef: "SQ_OPT_SIZE", name: "Size" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });
  await approvedCall(f, "catalog.create_product", {
    title: "Casual Shirt",
    category_id: casual.id,
    variations: [{ title: "One size", price_minor: 5000, currency: "USD" }],
  });

  /* Casual never named its own option sets -- it inherits Outerwear's. */
  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: casual.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.products_applied, 1);
  assert.deepEqual(res.data.item_option_ids, [size.id]);
});

check("test_PRD_P0_144_apply_category_item_options__a_later_unrelated_edit_does_not_silently_clear_it", async () => {
  /* "UpsertCatalogObject replaces item_data wholesale... every caller here
     is responsible for passing through whatever value should survive" --
     itemData()'s own established rule, now covering item_options too. A
     plain title edit, not about option sets at all, must not wipe them. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f, { id: "opt1", externalRef: "SQ_OPT_SIZE", name: "Size" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });
  await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });

  await approvedCall(f, "catalog.update_product", { handle: COAT_HANDLE, title: "Renamed Coat" });
  const itemUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  assert.deepEqual(itemUpsert.body.object.item_data.item_options, [{ item_option_id: "SQ_OPT_SIZE" }], "must still be resent, not dropped");
});

check("test_PRD_P0_144_apply_category_item_options__a_category_with_no_products_of_its_own_is_a_quiet_no_op_not_a_refusal", async () => {
  /* "That should not be a stopping point for you... just ignore it and
     don't apply anything to it. I don't need to see an error about it
     and you don't need to stop" — the owner's own words, clicking
     through many categories in a row, some purely organizational
     (every real product living in a subcategory instead). REVISED from
     the original P0-144 behavior, which refused this outright. */
  const f = await fixture();
  const casual = (
    await approvedCall(f, "catalog.create_category", { name: "Casual", reason: "test" })
  ).data.category;
  const callsBefore = f.calls().length;
  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: casual.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.products_applied, 0);
  assert.deepEqual(res.data.errors, []);
  assert.equal(f.calls().length, callsBefore, "nothing to apply means no Square call at all, not an empty one");
});

check("test_PRD_P0_144_apply_category_item_options__staff_cannot_call_it", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  assert.deepEqual(TOOLS["catalog.apply_category_item_options_to_products"].resources, ["square"]);
  assert.ok(!describeTools("staff").map((d) => d.name).includes("catalog.apply_category_item_options_to_products"));
  const res = await runTool(
    "catalog.apply_category_item_options_to_products",
    { category_id: outerwear.id, reason: "test" },
    { ...f.ctx, role: "staff" },
  );
  assert.equal(res.ok, false);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-148 — "I expect the black dress to have these variations
 * auto-assigned because I assigned the sets to its parent category" — the
 * owner's own words, asked directly and confirmed: applying a category's
 * option sets now ALSO generates the real missing Size/Color variations,
 * not just the item-level flag (P0-144).
 * ───────────────────────────────────────────────────────────────────────── */

/* A real ITEM_OPTION object, with real values, seeded straight into the
   fake Square server — not just the mirror — so a full sync (below)
   resolves a variation's own item_option_values back to real name/value
   text exactly the way a live sync would (optionsFor(), shared/commerce/
   square/catalog.js). Hand-seeding only the mirror (seedItemOption,
   above) is enough for P0-142/144's own item-level-only assertions, but
   not for a test that needs an EXISTING variation's own combination to
   be recognized as already covered. */
function seedItemOptionInSquare(f, { externalRef, name, values }) {
  f.square.objects.set(externalRef, {
    id: externalRef,
    type: "ITEM_OPTION",
    version: 1,
    item_option_data: {
      name,
      values: values.map((v) => ({
        type: "ITEM_OPTION_VAL",
        id: v.externalRef,
        item_option_value_data: { item_option_id: externalRef, name: v.name },
      })),
    },
  });
}

/* Order-independent: optionCombinations' own key order is not a contract
   this suite pins down, so a generated variation is found by WHICH
   option/value pairs it carries, never by title text alone. */
function findVariationByOptionPairs(variations, pairs) {
  const want = new Set(pairs.map((p) => `${p.item_option_id}:${p.item_option_value_id}`));
  return variations.find((v) => {
    const has = new Set((v.item_variation_data.item_option_values ?? []).map((p) => `${p.item_option_id}:${p.item_option_value_id}`));
    return has.size === want.size && [...want].every((k) => has.has(k));
  });
}

check("test_PRD_P0_148_auto_generate_variations__applying_a_categorys_option_sets_creates_every_missing_combination", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_COLOR",
    name: "Color",
    values: [{ externalRef: "SQ_OPTVAL_BLACK", name: "Black" }, { externalRef: "SQ_OPTVAL_RED", name: "Red" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  const color = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_COLOR'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id, color.id], reason: "test" });

  const created = await approvedCall(f, "catalog.create_product", {
    title: "Black Dress",
    category_id: outerwear.id,
    variations: [{ title: "One size", price_minor: 8900, currency: "USD" }],
  });
  assert.equal(created.ok, true, created.error);

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.errors, []);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Black Dress")
    .pop();
  assert.ok(itemUpsert, "must reach Square with the black dress's own updated item");
  assert.deepEqual(
    itemUpsert.body.object.item_data.item_options.map((o) => o.item_option_id).sort(),
    ["SQ_OPT_COLOR", "SQ_OPT_SIZE"],
  );
  const variations = itemUpsert.body.object.item_data.variations;
  assert.equal(
    variations.length,
    5,
    `1 existing + 4 combinations (2 sizes x 2 colors), got: ${JSON.stringify(variations.map((v) => v.item_variation_data.name))}`,
  );

  const sBlack = findVariationByOptionPairs(variations, [
    { item_option_id: "SQ_OPT_SIZE", item_option_value_id: "SQ_OPTVAL_S" },
    { item_option_id: "SQ_OPT_COLOR", item_option_value_id: "SQ_OPTVAL_BLACK" },
  ]);
  assert.ok(sBlack, "S/Black must be generated");
  assert.equal(sBlack.item_variation_data.price_money.amount, 8900, "a new combination copies the product's own existing price");

  const mRed = findVariationByOptionPairs(variations, [
    { item_option_id: "SQ_OPT_SIZE", item_option_value_id: "SQ_OPTVAL_M" },
    { item_option_id: "SQ_OPT_COLOR", item_option_value_id: "SQ_OPTVAL_RED" },
  ]);
  assert.ok(mRed, "M/Red must be generated");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0_148 (REVISED) — "SKU should be auto generated when adding variants or
 * options -- Square does that" -- the owner's own words. Verified live it
 * does NOT, for a variation created through the Catalog API this file
 * calls: every one of the Black Dress's own auto-generated White/S-M-L-XL
 * combinations came back from Square with sku: null. "Automatically
 * generate SKUs" is a real Square setting, but Dashboard/POS-side only.
 * generateSku() (catalog-writer.js) fills the gap this file's own writes
 * leave behind instead.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_148_auto_generate_variations__a_brand_new_combination_gets_a_real_sku_when_none_is_given", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.errors, []);

  const itemUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  const variations = itemUpsert.body.object.item_data.variations;
  const brandNew = variations.filter((v) => v.id !== "VAR_COAT_S" && v.id !== "VAR_COAT_M");
  assert.equal(brandNew.length, 2, "the coat's own two pre-existing variations stay put; S and M here are genuinely new");
  for (const v of brandNew) {
    assert.match(v.item_variation_data.sku, /^\d{12}$/, "a brand-new combination must carry a real, numeric, barcode-shaped sku, never be left blank");
  }
  assert.notEqual(
    brandNew[0].item_variation_data.sku,
    brandNew[1].item_variation_data.sku,
    "two different new combinations on the same product must never collide on the same sku",
  );

  const productId = f.mirror("SELECT product_id FROM mirror_variant WHERE external_ref = 'VAR_COAT_S'")[0].product_id;
  const mirrored = f.mirror(
    "SELECT sku FROM mirror_variant WHERE product_id = ? AND sku IS NOT NULL AND title IN ('S', 'M')",
    productId,
  );
  assert.equal(mirrored.length, 2, "the mirror itself must reflect the real sku after the resync, not null");
});

check("test_PRD_P0_148_auto_generate_variations__an_existing_untouched_variation_never_gets_a_sku_fabricated_for_it", async () => {
  /* The retag fix (P0-144, above) deliberately leaves a title matching
     nothing exactly as it was -- "never touching price/sku/anything
     else." generateSku() must only ever reach a BRAND-NEW variation, never
     backfill one that predates this whole feature and still carries none. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const before = f.mirror("SELECT external_ref, sku FROM mirror_variant WHERE external_ref IN ('VAR_COAT_S', 'VAR_COAT_M')");
  assert.ok(before.every((v) => v.sku), "sanity: the coat's own real variations already carry real, pre-existing skus");
  const beforeById = new Map(before.map((v) => [v.external_ref, v.sku]));

  await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });

  const itemUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM").pop();
  const untouched = itemUpsert.body.object.item_data.variations.filter((v) => v.id === "VAR_COAT_S" || v.id === "VAR_COAT_M");
  assert.equal(untouched.length, 2);
  for (const v of untouched) {
    assert.equal(v.item_variation_data.sku, beforeById.get(v.id), "an EXISTING variation's own sku must ride through completely unchanged, never regenerated");
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-31 (REVISED) — "Generate a generic name from subcategory name... when
 * quantity not specified use 1" — the owner's own words, on spreadsheet
 * ingestion, finally building what create_product's own describe() text
 * had promised all along: `variations[].quantity`, set as part of THIS
 * SAME approved write, never a second inventory.adjust approval.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_31_inventory_ledger__create_product_sets_initial_stock_when_a_quantity_is_given", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  const created = await approvedCall(f, "catalog.create_product", {
    title: "Cotton Robe",
    category_id: outerwear.id,
    variations: [
      { title: "S", price_minor: 6000, currency: "USD", quantity: 5 },
      { title: "M", price_minor: 6000, currency: "USD" },
    ],
  });
  assert.equal(created.ok, true, created.error);

  const variants = f.mirror("SELECT title, external_ref FROM mirror_variant WHERE product_id = ?", created.data.product.id);
  const s = variants.find((v) => v.title === "S");
  const m = variants.find((v) => v.title === "M");

  const push = f.calls().find((c) => c.path === "/v2/inventory/changes/batch-create");
  assert.ok(push, "a variation given a quantity must push a real Square inventory count");
  const change = push.body.changes.find((c) => c.physical_count.catalog_object_id === s.external_ref);
  assert.equal(change.physical_count.quantity, "5", "the exact quantity given, as Square's own string-encoded count");
  assert.ok(
    !push.body.changes.some((c) => c.physical_count.catalog_object_id === m.external_ref),
    "a variation given NO quantity must never be pushed at all -- omitted means 'unknown', not zero",
  );
});

check("test_PRD_P0_31_inventory_ledger__no_quantity_given_at_all_pushes_no_inventory_call", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const before = f.calls().length;

  const created = await approvedCall(f, "catalog.create_product", {
    title: "Cotton Robe",
    category_id: outerwear.id,
    variations: [{ title: "One size", price_minor: 6000, currency: "USD" }],
  });
  assert.equal(created.ok, true, created.error);
  assert.ok(
    !f.calls().some((c) => c.path === "/v2/inventory/changes/batch-create"),
    "no variation named a quantity -- there is nothing to push",
  );
  assert.ok(f.calls().length > before, "sanity: the product itself still wrote to Square");
});

check("test_PRD_P0_31_inventory_ledger__a_negative_or_fractional_quantity_is_refused", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool(
    "catalog.create_product",
    { title: "Cotton Robe", category_id: outerwear.id, variations: [{ title: "One size", price_minor: 6000, currency: "USD", quantity: -1 }] },
    { actor: "mara@vemians.com", role: "manager", env: f.env },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /quantity '-1' must be a non-negative whole number/);
});

check("test_PRD_P0_148_auto_generate_variations__catalog_create_product_generates_a_sku_when_none_is_given_and_keeps_an_explicit_one_verbatim", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  const created = await approvedCall(f, "catalog.create_product", {
    title: "Cotton Robe",
    category_id: outerwear.id,
    variations: [
      { title: "S", price_minor: 6000, currency: "USD" },
      { title: "M", price_minor: 6000, currency: "USD", sku: "VEM-ROBE-M" },
    ],
  });
  assert.equal(created.ok, true, created.error);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Cotton Robe")
    .pop();
  const variations = itemUpsert.body.object.item_data.variations;
  const s = variations.find((v) => v.item_variation_data.name === "S");
  const m = variations.find((v) => v.item_variation_data.name === "M");
  assert.match(s.item_variation_data.sku, /^\d{12}$/, "a variation given no sku at all must still get a real one on creation");
  assert.equal(m.item_variation_data.sku, "VEM-ROBE-M", "an explicitly given sku must never be overwritten");
  assert.notEqual(s.item_variation_data.sku, m.item_variation_data.sku);
});

check("test_PRD_P0_148_auto_generate_variations__a_style_id_makes_the_sku_human_readable_instead_of_the_opaque_fallback", async () => {
  /* "Maybe generate it from the style id? Add option and size to the end?"
     -- the owner's own words, on hearing the first version was a plain
     opaque 12-digit code. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  const created = await approvedCall(f, "catalog.create_product", {
    title: "Cotton Robe",
    category_id: outerwear.id,
    style_id: "01-99-002",
    variations: [
      { title: "White, M", price_minor: 6000, currency: "USD", option_values: { Color: "White", Size: "M" } },
      { title: "One size", price_minor: 6000, currency: "USD" },
    ],
  });
  assert.equal(created.ok, true, created.error);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Cotton Robe")
    .pop();
  const variations = itemUpsert.body.object.item_data.variations;
  const tagged = variations.find((v) => v.item_variation_data.name === "White, M");
  const untagged = variations.find((v) => v.item_variation_data.name === "One size");
  assert.equal(tagged.item_variation_data.sku, "01-99-002-WHITE-M", "human-readable: style_id plus this variation's own option values");
  assert.equal(untagged.item_variation_data.sku, "01-99-002-ONE-SIZE", "no option_values at all -- falls back to the variation's own title instead");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0_144 (REVISED) -- "No, it must be auto generated when making the
 * options assignment!" -- the owner's own words, on hearing that
 * re-running Apply would never backfill a SKU for a combination it had
 * already retagged in an earlier run. Retagging an untagged variation IS
 * "making the options assignment" for it -- it must get a real SKU the
 * moment it happens, not stay stuck the way the Black Dress's own White
 * combinations were.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_144_apply_category_item_options__retagging_an_untagged_skuless_variation_also_gives_it_a_real_sku", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  await approvedCall(f, "catalog.create_product", {
    title: "Wrap Skirt",
    category_id: outerwear.id,
    style_id: "01-99-003",
    /* Predates Option Sets entirely -- a plain title, no option_values, no
       sku (the shop never got around to giving this specific one a real
       one). */
    variations: [{ title: "S", price_minor: 5000, currency: "USD" }],
  });

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.errors, []);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Wrap Skirt")
    .pop();
  const variations = itemUpsert.body.object.item_data.variations;
  assert.equal(variations.length, 1, "S already existed and is retagged in place -- never duplicated");
  const s = variations[0];
  assert.deepEqual(s.item_variation_data.item_option_values, [{ item_option_id: "SQ_OPT_SIZE", item_option_value_id: "SQ_OPTVAL_S" }]);
  assert.equal(s.item_variation_data.sku, "01-99-003-S", "retagging must also mint a real sku for a variation that never had one");

  const mirrored = f.mirror(
    "SELECT sku FROM mirror_variant v JOIN mirror_product p ON p.id = v.product_id WHERE p.handle = 'wrap-skirt'",
  )[0];
  assert.equal(mirrored.sku, "01-99-003-S", "the mirror itself reflects it after the resync");
});

check("test_PRD_P0_148_auto_generate_variations__an_existing_combination_is_never_duplicated_or_touched", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  await approvedCall(f, "catalog.create_product", {
    title: "Wool Skirt",
    category_id: outerwear.id,
    variations: [{ title: "S", price_minor: 6000, currency: "USD", option_values: { Size: "S" } }],
  });

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Wool Skirt")
    .pop();
  assert.ok(itemUpsert);
  const variations = itemUpsert.body.object.item_data.variations;
  assert.equal(variations.length, 2, "S already existed; only M should be newly added, never a second S");
  const m = findVariationByOptionPairs(variations, [{ item_option_id: "SQ_OPT_SIZE", item_option_value_id: "SQ_OPTVAL_M" }]);
  assert.ok(m, "the missing M must still be generated");
});

check("test_PRD_P0_148_auto_generate_variations__a_product_past_the_variation_cap_is_reported_not_silently_skipped_or_capped", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: Array.from({ length: 5 }, (_, i) => ({ externalRef: `SQ_OPTVAL_SIZE_${i}`, name: `Size${i}` })),
  });
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_COLOR",
    name: "Color",
    values: Array.from({ length: 6 }, (_, i) => ({ externalRef: `SQ_OPTVAL_COLOR_${i}`, name: `Color${i}` })),
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  const color = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_COLOR'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id, color.id], reason: "test" });

  await approvedCall(f, "catalog.create_product", {
    title: "Overloaded Dress",
    category_id: outerwear.id,
    variations: [{ title: "One size", price_minor: 5000, currency: "USD" }],
  });

  /* 5 sizes x 6 colors = 30 combinations, plus the existing "One size" —
     31, past CAPS.CATALOG_MAX_VARIATIONS (24). */
  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  const err = res.data.errors.find((e) => /past the cap of 24/.test(e.error));
  assert.ok(err, `expected a cap-exceeded error, got: ${JSON.stringify(res.data.errors)}`);

  /* Only the original creation write should exist for it — the
     cap-exceeded apply must not reach Square for this product at all,
     partial or otherwise. */
  const overloadedWrites = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data?.name === "Overloaded Dress");
  assert.equal(overloadedWrites.length, 1);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-139 (REVISED) — "Square POST /v2/catalog/object failed with 400" —
 * the owner's own words, live, after a real per-product apply failure
 * (Test-PRD-P0-149-auto_apply_failure_visibility's own incident) turned
 * out to have been logged with only that generic sentence, never Square's
 * own category/code/detail. P0-139 already fixed this for a DIRECT tool
 * call's own top-level error string; applyItemOptionsToProductsInCategory's
 * own per-product catch ("one product's failure does not fail the batch")
 * was a second, separate place the exact same detail was being dropped.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_139_honest_write_failures__a_per_product_apply_failure_also_carries_squares_own_rejection_detail", async () => {
  const f = await fixture({
    failUpsert: [
      {
        category: "INVALID_REQUEST_ERROR",
        code: "BAD_REQUEST",
        detail: "Item variation `item_option_values` referenced an unknown item option value.",
      },
    ],
  });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const size = seedItemOption(f, { id: "opt1", externalRef: "SQ_OPT_SIZE", name: "Size" });
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.products_applied, 0, "the coat's own Square write failed");
  assert.equal(res.data.errors.length, 1);
  assert.match(res.data.errors[0].error, /Square POST \/v2\/catalog\/object failed with 400/, "the generic sentence is still there");
  assert.match(res.data.errors[0].error, /INVALID_REQUEST_ERROR\/BAD_REQUEST/, "Square's own category/code must survive the per-product catch too");
  assert.match(res.data.errors[0].error, /unknown item option value/);
});

check("test_PRD_P0_148_auto_generate_variations__an_assigned_option_with_no_values_yet_is_named_before_approval_not_a_silent_no_op", async () => {
  /* "I only see sizes for the black dress. I don't see any colors" — the
     owner's own words, the first time this shipped. Dress Colors WAS
     checked, but had no VALUES on file in Square yet — and one assigned
     option with no values collapses the WHOLE cross product to nothing,
     not just its own dimension (optionCombinations' own comment,
     catalog-writer.js). Named here, before approval, so this is never a
     silent no-op discovered only after the fact. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Dress Sizes",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  /* Dress Colors exists and gets checked/assigned, but nobody has ever
     given it a real value in Square — the exact gap this test covers. */
  const color = seedItemOption(f, { id: "opt-color", externalRef: "SQ_OPT_COLOR", name: "Dress Colors" });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  await approvedCall(f, "catalog.set_category_item_options", {
    category_id: outerwear.id,
    item_option_ids: [size.id, color.id],
    reason: "test",
  });

  await approvedCall(f, "catalog.create_product", {
    title: "Black Dress",
    category_id: outerwear.id,
    variations: [{ title: "One size", price_minor: 8900, currency: "USD" }],
  });

  const gate = await runTool("catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" }, f.ctx);
  assert.equal(gate.needsApproval, true);
  assert.match(
    gate.data.would,
    /WARNING: Dress Colors has no values on file in Square yet, so NO variations will be generated/,
    `the approval summary must name the empty option before anyone says yes, got: ${gate.data.would}`,
  );

  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.options_with_no_values_yet, ["Dress Colors"], "the result itself must still say why, not just the approval screen");

  /* Confirms the actual behavior the owner hit: with Color empty, NOTHING
     new is generated at all — not even a Size-only combination — since
     the cross product collapses to nothing the moment one assigned
     dimension has no values. */
  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Black Dress")
    .pop();
  assert.equal(itemUpsert.body.object.item_data.variations.length, 1, "no new variations at all while Dress Colors has no values");
});

check("test_PRD_P0_148_auto_generate_variations__applying_a_parent_category_also_reaches_products_in_its_subcategories", async () => {
  /* "I expect all subcategories to get the same settings applied... they
     should propagate — why don't they?" — the owner's own words, after
     clicking Apply on a category whose real products all lived one
     level down, in a subcategory, and seeing nothing happen for them. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }, { externalRef: "SQ_OPTVAL_M", name: "M" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  /* Sets are configured on OUTERWEAR (the parent) only — Casual never
     gets its own explicit call, so it inherits. */
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });

  /* The real product lives in the SUBCATEGORY, not the parent. */
  await approvedCall(f, "catalog.create_product", {
    title: "Casual Shirt",
    category_id: casual.id,
    variations: [{ title: "One size", price_minor: 4500, currency: "USD" }],
  });

  /* Apply is clicked on the PARENT, Outerwear — not Casual. */
  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);
  /* 2, not 1: the fixture's own seeded coat (filed directly in Outerwear)
     plus the Casual Shirt (filed in the subcategory) — the point being
     the subcategory's own product is reached too, not just Outerwear's
     direct ones. */
  assert.equal(res.data.products_applied, 2, "the subcategory's own product must be reached too, not just Outerwear's direct ones");
  assert.deepEqual(res.data.errors, []);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Casual Shirt")
    .pop();
  assert.ok(itemUpsert, "the Casual Shirt, filed in the subcategory, must actually receive a Square write");
  assert.deepEqual(itemUpsert.body.object.item_data.item_options, [{ item_option_id: "SQ_OPT_SIZE" }]);
  assert.equal(itemUpsert.body.object.item_data.variations.length, 3, "One size plus the newly generated S and M — inherited from the parent");
});

check("test_PRD_P0_148_auto_generate_variations__a_subcategorys_own_explicit_sets_are_never_overridden_by_the_parents_bulk_apply", async () => {
  /* The other half of "they should propagate" — propagating to a
     subcategory with NOTHING of its own is correct; overwriting one
     that has ALREADY made its own explicit choice would not be. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_SIZE",
    name: "Size",
    values: [{ externalRef: "SQ_OPTVAL_S", name: "S" }],
  });
  seedItemOptionInSquare(f, {
    externalRef: "SQ_OPT_COLOR",
    name: "Color",
    values: [{ externalRef: "SQ_OPTVAL_RED", name: "Red" }],
  });
  await f.writer.adapter.pullCatalog({ full: true });
  const size = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_SIZE'")[0];
  const color = f.mirror("SELECT id FROM mirror_item_option WHERE external_ref = 'SQ_OPT_COLOR'")[0];
  await approvedCall(f, "catalog.set_category_item_options", { category_id: outerwear.id, item_option_ids: [size.id], reason: "test" });
  /* Casual makes its OWN explicit choice — Color, not Size. */
  await approvedCall(f, "catalog.set_category_item_options", { category_id: casual.id, item_option_ids: [color.id], reason: "test" });

  await approvedCall(f, "catalog.create_product", {
    title: "Casual Shirt",
    category_id: casual.id,
    variations: [{ title: "One size", price_minor: 4500, currency: "USD" }],
  });

  /* Apply is clicked on the PARENT, Outerwear. */
  const res = await approvedCall(f, "catalog.apply_category_item_options_to_products", { category_id: outerwear.id, reason: "test" });
  assert.equal(res.ok, true, res.error);

  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === "Casual Shirt")
    .pop();
  assert.ok(itemUpsert, "Casual Shirt must still be reached");
  assert.deepEqual(
    itemUpsert.body.object.item_data.item_options,
    [{ item_option_id: "SQ_OPT_COLOR" }],
    "Casual's own explicit Color must survive — never clobbered by Outerwear's own Size",
  );
});

check("test_PRD_P0_136_square_custom_attributes__create_vendor_makes_a_real_square_vendor_with_a_commission_on_file_immediately", async () => {
  const f = await fixture();
  const res = await approvedCall(f, "catalog.create_vendor", { name: "Acme Mills", commission: 20, reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.created, true);
  assert.equal(res.data.commission, 20);

  const vendorCalls = f.calls().filter((c) => c.path === "/v2/vendors/create");
  assert.equal(vendorCalls.length, 1, "a real Square Vendor must actually be created, not just a mirror row");

  const row = f.mirror("SELECT name, commission_pct FROM mirror_vendor WHERE name = 'Acme Mills'")[0];
  assert.equal(row.commission_pct, 20, "the commission is on file the moment the vendor exists -- a later product naming it needs nothing restated");

  /* Now provable end to end: a product naming this vendor with no
     commission of its own goes through clean. */
  const category = f.categories()[0];
  const product = await approvedCall(f, "catalog.create_product", {
    title: "A Product",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 1000, currency: "USD" }],
    vendor: "Acme Mills",
  });
  assert.equal(product.ok, true, product.error);
  assert.equal(product.data.product.commission_pct, 20);
});

check("test_PRD_P0_136_square_custom_attributes__create_vendor_refuses_a_name_that_already_exists", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.create_vendor", { name: "Acme Mills", commission: 20, reason: "test" });
  const res = await runTool("catalog.create_vendor", { name: "Acme Mills", commission: 15, reason: "test" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /"Acme Mills" already exists, with a commission of 20% already on file/);
});

check("test_PRD_P0_136_square_custom_attributes__set_vendor_commission_changes_the_central_rate_going_forward_only", async () => {
  /* REVISED: forward-only, deliberately -- "we store it in essential
     locations per vendor so that their commission is recorded in a
     central location and automatically applied" describes NEW items
     picking it up, not a retroactive rewrite of a vendor's own past
     products. */
  const f = await fixture();
  await approvedCall(f, "catalog.create_vendor", { name: "Acme Mills", commission: 20, reason: "test" });
  const category = f.categories()[0];
  const older = await approvedCall(f, "catalog.create_product", {
    title: "Older Product",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 1000, currency: "USD" }],
    vendor: "Acme Mills",
  });
  assert.equal(older.data.product.commission_pct, 20);

  const vendorId = f.mirror("SELECT id FROM mirror_vendor WHERE name = 'Acme Mills'")[0].id;
  const res = await approvedCall(f, "catalog.set_vendor_commission", { vendor_id: vendorId, commission: 25 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.commission, 25);
  assert.equal(res.data.previous_commission, 20);

  /* The older product's own already-set commission is untouched. */
  const olderRow = f.mirror(`SELECT commission_pct FROM mirror_product WHERE title = 'Older Product'`)[0];
  assert.equal(olderRow.commission_pct, 20, "an existing product's own commission is not retroactively rewritten");

  /* A NEW product naming the same vendor, with none of its own, picks up
     the NEW rate. */
  const newer = await approvedCall(f, "catalog.create_product", {
    title: "Newer Product",
    category_id: category.id,
    variations: [{ title: "One size", price_minor: 1000, currency: "USD" }],
    vendor: "Acme Mills",
  });
  assert.equal(newer.data.product.commission_pct, 25);
});

check("test_PRD_P0_136_square_custom_attributes__set_vendor_commission_is_ours_never_calls_square", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.create_vendor", { name: "Acme Mills", commission: 20, reason: "test" });
  const vendorId = f.mirror("SELECT id FROM mirror_vendor WHERE name = 'Acme Mills'")[0].id;
  const before = f.calls().length;
  await approvedCall(f, "catalog.set_vendor_commission", { vendor_id: vendorId, commission: 25 });
  assert.equal(f.calls().length, before, "a pure mirror write must never reach Square");
});

check("test_PRD_P0_71_items_tab__catalog_custom_field_names_lists_every_registered_name", async () => {
  const f = await fixture();
  const empty = await runTool("catalog.custom_field_names", {}, f.ctx);
  assert.equal(empty.ok, true, empty.error);
  assert.deepEqual(empty.data.names, []);

  await approvedCall(f, "catalog.create_custom_field_name", { name: "Fabric", reason: "test" });
  const res = await runTool("catalog.custom_field_names", {}, f.ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.count, 1);
  assert.deepEqual(res.data.names, ["Fabric"]);
});

check("test_PRD_P0_71_items_tab__create_custom_field_name_is_ours_never_calls_square", async () => {
  const f = await fixture();
  const before = f.calls().length;
  const res = await approvedCall(f, "catalog.create_custom_field_name", { name: "Fabric", reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.created, true);
  assert.equal(f.calls().length, before, "a pure mirror write must never reach Square");
  const row = f.mirror("SELECT name FROM mirror_custom_field_name WHERE name = 'Fabric'")[0];
  assert.equal(row.name, "Fabric");
});

check("test_PRD_P0_71_items_tab__create_custom_field_name_refuses_a_name_that_already_exists", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.create_custom_field_name", { name: "Fabric", reason: "test" });
  const res = await runTool("catalog.create_custom_field_name", { name: "fabric", reason: "test" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already a registered custom field/);
});

check("test_PRD_P0_136_square_custom_attributes__commission_must_be_a_whole_number_0_to_100", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills", commission: 20 });
  const res = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, commission: 101 },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /0-100/);
});

check("test_PRD_P0_136_square_custom_attributes__create_product_accepts_a_style_id_and_checks_the_same_format", async () => {
  /* style_id CAN be set at creation time too (Test-PRD-P0-136), the same as
     vendor/commission — this call already reaches Square for the item
     itself, so there is no reason to force a second edit afterward. */
  const f = await fixture();
  const category = f.categories()[0];
  const bad = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: category.id, style_id: "not-a-style-id" },
    f.ctx,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error, /NN-NN-NNN/);
  assert.deepEqual(f.calls(), [], "a refused style_id must never reach Square");

  const res = await approvedCall(f, "catalog.create_product", {
    ...COAT,
    category_id: category.id,
    style_id: "05-02-010",
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.product.style_id, "05-02-010");
});

check("test_PRD_P0_136_square_custom_attributes__create_product_auto_bumps_a_duplicate_style_id", async () => {
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, style_id: "01-04-001" });

  const category = f.categories()[0];
  const res = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: category.id, style_id: "01-04-001" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.product.style_id, "01-04-002", "bumped to the next free index, never refused");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-136 (REVISED) — "the style id should auto update from category and
 * subcategory id and an index that auto increments" — the owner's own
 * words. With no style_id given at all, catalog.create_product builds one
 * from the chosen category's own NN-NN pair plus the next unused index.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_136_square_custom_attributes__create_product_auto_generates_a_style_id_from_the_categorys_own_numbers", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "04" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "07" });

  const first = await approvedCall(f, "catalog.create_product", {
    title: "Bomber Jacket",
    category_id: casual.id,
    variations: [{ title: "One size", price_minor: 30000, currency: "USD" }],
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.data.product.style_id, "04-07-001", "auto-generated from the category's own NN-NN pair, no style_id given");

  const second = await approvedCall(f, "catalog.create_product", {
    title: "Denim Jacket",
    category_id: casual.id,
    variations: [{ title: "One size", price_minor: 32000, currency: "USD" }],
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.data.product.style_id, "04-07-002", "the next unused index under the same prefix");
});

check("test_PRD_P0_136_square_custom_attributes__no_style_id_is_generated_for_a_category_with_no_numeric_id_yet", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  const res = await approvedCall(f, "catalog.create_product", {
    title: "Bomber Jacket",
    category_id: casual.id,
    variations: [{ title: "One size", price_minor: 30000, currency: "USD" }],
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.product.style_id, null, "no numeric_id on file yet -- never invented, product created with none, same as before");
});

check("test_PRD_P0_136_square_custom_attributes__no_style_id_is_generated_for_a_bare_top_level_category", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "04" });
  const res = await approvedCall(f, "catalog.create_product", {
    title: "Bomber Jacket",
    category_id: outerwear.id,
    variations: [{ title: "One size", price_minor: 30000, currency: "USD" }],
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.product.style_id, null, "a bare top-level category has no subcategory half to build a style_id from");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-71 — custom_fields: the same "ours, not Square's" pattern as channel
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_71_product_channel__create_product_accepts_custom_fields_and_never_sends_them_to_square", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const res = await approvedCall(f, "catalog.create_product", {
    ...COAT,
    category_id: outerwear.id,
    custom_fields: { "Unit Cost": "95.00", Vendor: "Acme Mills" },
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.product.custom_fields, { "Unit Cost": "95.00", Vendor: "Acme Mills" });

  /* Square only ever saw the ITEM upsert, the image step and the sync
     search — nothing about custom_fields appears in any body sent. */
  for (const call of f.calls()) {
    assert.doesNotMatch(JSON.stringify(call.body ?? {}), /Unit Cost|Acme Mills/);
  }

  const row = f.mirror(`SELECT custom_fields FROM mirror_product WHERE handle = '${res.data.product.handle}'`)[0];
  assert.deepEqual(JSON.parse(row.custom_fields), { "Unit Cost": "95.00", Vendor: "Acme Mills" });
});

check("test_PRD_P0_71_product_channel__a_product_created_without_custom_fields_defaults_to_empty", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const res = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: outerwear.id });
  assert.equal(res.ok, true, res.error);
  const row = f.mirror(`SELECT custom_fields FROM mirror_product WHERE handle = '${res.data.product.handle}'`)[0];
  assert.equal(row.custom_fields, "{}");
});

check("test_PRD_P0_71_product_channel__set_custom_fields_adds_updates_and_removes_in_one_patch", async () => {
  const f = await fixture();
  const handle = "shearling-trimmed-wool-blend-coat";

  const first = await approvedCall(f, "catalog.set_custom_fields", {
    handle,
    fields: { "Unit Cost": "210.00", Vendor: "Acme Mills" },
  });
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.data.custom_fields, { "Unit Cost": "210.00", Vendor: "Acme Mills" });
  assert.deepEqual(first.data.previous_custom_fields, {});
  assert.equal(first.data.authority, "ours");

  /* A second patch: update one key, remove the other (empty string),
     leave nothing else mentioned untouched — there is nothing else yet,
     but the point is neither key from the first patch survives by
     accident if it were not for this merge. */
  const second = await approvedCall(f, "catalog.set_custom_fields", {
    handle,
    fields: { "Unit Cost": "225.00", Vendor: "" },
  });
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(second.data.custom_fields, { "Unit Cost": "225.00" });

  /* No Square call at all — this concept does not exist on Square's side,
     same guarantee as catalog.set_channel. */
  assert.deepEqual(f.calls(), []);

  const row = f.mirror(`SELECT custom_fields FROM mirror_product WHERE handle = '${handle}'`)[0];
  assert.deepEqual(JSON.parse(row.custom_fields), { "Unit Cost": "225.00" });
});

check("test_PRD_P0_71_product_channel__set_custom_fields_leaves_fields_not_mentioned_alone", async () => {
  const f = await fixture();
  const handle = "shearling-trimmed-wool-blend-coat";
  await approvedCall(f, "catalog.set_custom_fields", { handle, fields: { Vendor: "Acme Mills" } });
  const res = await approvedCall(f, "catalog.set_custom_fields", { handle, fields: { "Unit Cost": "150.00" } });
  assert.deepEqual(res.data.custom_fields, { Vendor: "Acme Mills", "Unit Cost": "150.00" });
});

check("test_PRD_P0_71_product_channel__setting_the_exact_same_fields_again_is_refused_as_a_no_op", async () => {
  const f = await fixture();
  const handle = "shearling-trimmed-wool-blend-coat";
  await approvedCall(f, "catalog.set_custom_fields", { handle, fields: { Vendor: "Acme Mills" } });
  const res = await runTool("catalog.set_custom_fields", { handle, fields: { Vendor: "Acme Mills" } }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already has exactly these fields/);
});

check("test_PRD_P0_71_product_channel__set_custom_fields_refuses_an_unknown_handle", async () => {
  const f = await fixture();
  const res = await runTool("catalog.set_custom_fields", { handle: "does-not-exist", fields: { Vendor: "x" } }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /no product with handle/);
});

check("test_PRD_P0_71_product_channel__set_custom_fields_requires_manager_and_the_tool_holds_no_square_resource", async () => {
  const f = await fixture();
  const denied = await runTool(
    "catalog.set_custom_fields",
    { handle: "shearling-trimmed-wool-blend-coat", fields: { Vendor: "x" } },
    { ...f.ctx, ...staff },
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /requires the manager role/);

  const tool = TOOLS["catalog.set_custom_fields"];
  assert.ok(tool, "catalog.set_custom_fields is not registered");
  assert.deepEqual(tool.resources ?? [], []);
  assert.deepEqual(tool.stores, ["catalog_mirror"]);
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");
});

check("test_PRD_P0_71_product_channel__the_record_type_refuses_a_non_string_value_and_too_many_fields", async () => {
  const f = await fixture();
  const handle = "shearling-trimmed-wool-blend-coat";

  const notAString = await runTool("catalog.set_custom_fields", { handle, fields: { Vendor: 12 } }, f.ctx);
  assert.equal(notAString.ok, false);
  assert.match(notAString.error, /must be a string/);

  const tooMany = Object.fromEntries(
    Array.from({ length: CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS + 1 }, (_, i) => [`field_${i}`, "x"]),
  );
  const overCap = await runTool("catalog.set_custom_fields", { handle, fields: tooMany }, f.ctx);
  assert.equal(overCap.ok, false);
  assert.match(overCap.error, /holds more than/);
});

check("test_PRD_P0_71_product_channel__catalog_product_reads_custom_fields_alongside_the_rest", async () => {
  const f = await fixture();
  const handle = "shearling-trimmed-wool-blend-coat";
  await approvedCall(f, "catalog.set_custom_fields", { handle, fields: { Vendor: "Acme Mills" } });

  const res = await runTool("catalog.product", { handle }, f.ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.product.handle, handle);
  assert.deepEqual(res.data.product.custom_fields, { Vendor: "Acme Mills" });
  assert.ok(Array.isArray(res.data.variations) && res.data.variations.length > 0);

  /* T0: staff can read it, no approval needed at all. */
  const asStaff = await runTool("catalog.product", { handle }, { ...f.ctx, ...staff });
  assert.equal(asStaff.ok, true, asStaff.error);
  assert.equal(asStaff.needsApproval, undefined);
});

check("test_PRD_P0_71_product_channel__catalog_product_refuses_an_unknown_handle", async () => {
  const f = await fixture();
  const res = await runTool("catalog.product", { handle: "does-not-exist" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /no product with handle/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-16 / P0-15 — the port boundary, and money
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_16_commerce_port__no_square_identifier_crosses_the_tool_boundary", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const key = await uploadInline(f);
  const res = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: cat.id, images: [key] });
  assert.equal(res.ok, true, res.error);

  /* Every id Square minted in this run, hunted for in what came back out and in
     what was written to the audit log. */
  const squareIds = [...f.square.objects.keys()];
  assert.ok(squareIds.length > 4);
  const returned = JSON.stringify(res.data);
  const audited = JSON.stringify(f.audit());
  for (const id of squareIds) {
    assert.ok(!returned.includes(id), `${id} leaked into a tool result`);
    assert.ok(!audited.includes(id), `${id} leaked into the audit log`);
  }
  /* Nor does the CDN host, which is the other shape a vendor reference takes. */
  assert.ok(!returned.includes("items-images.example"));

  /* What DOES come back is ours. */
  assert.match(res.data.product.id, /^[0-9a-f-]{36}$/);
  assert.match(res.data.product.handle, /^[a-z0-9-]+$/);

  /* And the Square ids live where the schema says they live, and nowhere else. */
  const image = f.mirror("SELECT * FROM mirror_image")[0];
  assert.ok(squareIds.includes(image.external_ref));
});

check("test_PRD_P0_15_money_minor_units__a_price_reaches_square_as_an_integer_minor_amount", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const res = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: cat.id });
  assert.equal(res.ok, true, res.error);

  const item = [...f.square.objects.values()].find((o) => o.item_data?.name === COAT.title);
  for (const v of item.item_data.variations) {
    const money = v.item_variation_data.price_money;
    assert.equal(money.currency, "USD", "an explicit currency, never implied");
    assert.ok(Number.isInteger(money.amount), "an integer minor amount, never a float");
    assert.equal(money.amount, 189000);
    assert.equal(v.item_variation_data.pricing_type, "FIXED_PRICING");
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-28 / P0-29 — R2 is authoritative; Square gets a copy
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_28_image_contract__the_original_lands_in_r2_and_square_gets_a_copy", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  const up = await runTool(
    "catalog.upload_image",
    { filename: "trench-front.png", bytes_base64: b64(PNG_BYTES), caption: "front" },
    { ...f.ctx, ...staff },
  );
  assert.equal(up.ok, true, up.error);
  assert.equal(up.data.stored, true);
  assert.equal(up.data.bytes, PNG_BYTES.byteLength);
  assert.match(up.data.key, /^catalog\/originals\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);

  /* The ORIGINAL is ours, byte for byte, before Square has heard of it. */
  const stored = f.bucket._store.get(up.data.key);
  assert.deepEqual([...stored.body], [...PNG_BYTES]);
  assert.equal(stored.httpMetadata.contentType, "image/png");
  assert.equal(stored.customMetadata.actor, "ana@vemians.com");
  assert.deepEqual(f.calls(), [], "storing an original is not a Square call");

  const res = await approvedCall(f, "catalog.create_product", {
    ...COAT,
    category_id: cat.id,
    images: [up.data.key],
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.images.attached, [up.data.key]);
  assert.deepEqual(res.data.images.skipped, []);
  assert.equal(res.data.images.originals_kept_in_r2, 1);

  /* Square got a COPY: the same bytes, the same type, on the item it belongs to. */
  const upload = f.calls().find((c) => c.path === "/v2/catalog/images");
  assert.equal(upload.imageBytes, PNG_BYTES.byteLength);
  assert.equal(upload.imageType, "image/png");

  /* And the mirror knows about Square's copy, while ours is untouched. */
  const image = f.mirror("SELECT * FROM mirror_image")[0];
  assert.match(image.source_url, /^https:\/\/items-images\.example\//);
  assert.equal(f.bucket._store.size, 1, "the original is still exactly where we put it");
});

check("test_PRD_P0_29_exit_test__an_original_square_will_not_take_is_still_stored_as_ours", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  /* HEIC is what a phone actually produces. Square's catalog images are
     JPEG/PNG/GIF, so the copy is skipped — and refusing to KEEP the photograph
     because a till cannot render it would be the provider dictating our
     archive, which is the whole thing the Exit Test exists to prevent. */
  const up = await runTool(
    "catalog.upload_image",
    { filename: "IMG_4417.heic", bytes_base64: b64(PNG_BYTES) },
    f.ctx,
  );
  assert.equal(up.ok, true, up.error);
  assert.equal(up.data.stored, true);
  assert.equal(up.data.square_will_accept, false);

  const res = await approvedCall(f, "catalog.create_product", {
    ...COAT,
    category_id: cat.id,
    images: [up.data.key],
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.images.attached, []);
  assert.equal(res.data.images.skipped.length, 1);
  assert.match(res.data.images.skipped[0].why, /the original is ours and kept/);
  assert.equal(res.data.images.originals_kept_in_r2, 1);

  /* The product exists and is priced; the photograph is ours; no image call. */
  assert.ok(res.data.product.handle);
  assert.equal(f.bucket._store.size, 1);
  assert.deepEqual(
    f.calls().map((c) => c.path),
    ["/v2/catalog/object", "/v2/vendors/search", "/v2/catalog/search"],
  );
});

check("test_PRD_P0_28_image_contract__base64_past_the_inline_cap_is_refused_and_sent_to_the_upload_link", async () => {
  const f = await fixture();

  /* The honest limit, asserted rather than described: a phone photo cannot be
     an argument, because the model would have to emit the base64. */
  const tooBig = new Uint8Array(CAPS.INLINE_IMAGE_MAX_BYTES + 1024);
  const refused = await runTool(
    "catalog.upload_image",
    { filename: "phone.jpg", bytes_base64: b64(tooBig) },
    f.ctx,
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /exceeds the .* cap for base64 in a tool argument/);
  assert.match(refused.error, /without bytes_base64/, "the refusal names the path that works");
  assert.equal(f.bucket._store.size, 0);

  /* A 12 MP JPEG is not near this cap, it is an order of magnitude past it —
     and past the schema's own ceiling, so it never reaches the tool body. */
  const twelveMP = new Uint8Array(4 * 1024 * 1024);
  const schemaRefused = await runTool(
    "catalog.upload_image",
    { filename: "phone.jpg", bytes_base64: b64(twelveMP) },
    f.ctx,
  );
  assert.equal(schemaRefused.ok, false);
  assert.match(schemaRefused.error, /'bytes_base64' is longer than/);

  /* The mode that works: a key now, a link for the human, no bytes anywhere
     near the model. */
  const link = await runTool("catalog.upload_image", { filename: "phone.jpg" }, f.ctx);
  assert.equal(link.ok, true, link.error);
  assert.equal(link.data.stored, false);
  assert.match(link.data.key, /^catalog\/originals\/.*\.jpg$/);
  assert.match(link.data.upload_url, /^https:\/\/ops\.vemians\.com\/media\/upload\?/);
  assert.ok(new URL(link.data.upload_url).searchParams.get("sig"));
  assert.ok(Date.parse(link.data.expires_at) > Date.now());
  assert.equal(link.data.square_will_accept, true);
});

check("test_PRD_P0_28_image_contract__an_upload_ticket_is_bound_to_its_key_person_and_expiry", async () => {
  const key = mediaKey("image/jpeg");
  const ticket = await mintUploadTicket({ secret: SIGNING_KEY, key, actor: "ana@vemians.com" });

  const good = await verifyUploadTicket({ secret: SIGNING_KEY, ...ticket });
  assert.equal(good.ok, true);

  /* Another person's browser cannot spend it, even holding every byte of it. */
  const theirs = await verifyUploadTicket({ secret: SIGNING_KEY, ...ticket, actor: "tomas@vemians.com" });
  assert.equal(theirs.ok, false);
  assert.match(theirs.reason, /signature does not match/);

  /* Nor can it be re-pointed at another key, or stretched. */
  const elsewhere = await verifyUploadTicket({ secret: SIGNING_KEY, ...ticket, key: mediaKey("image/jpeg") });
  assert.equal(elsewhere.ok, false);
  const stretched = await verifyUploadTicket({
    secret: SIGNING_KEY,
    ...ticket,
    expiresAt: ticket.expiresAt + 86_400_000,
  });
  assert.equal(stretched.ok, false);

  const expired = await verifyUploadTicket({
    secret: SIGNING_KEY,
    ...ticket,
    now: ticket.expiresAt + 1,
  });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /expired/);

  /* And with no secret configured, nothing is issued at all — an unsigned
     ticket would be a write capability handed to anyone who guessed a key. */
  await assert.rejects(
    () => mintUploadTicket({ secret: undefined, key, actor: "ana@vemians.com" }),
    /MEDIA_SIGNING_KEY is unset/,
  );
});

check("test_PRD_P0_28_image_contract__the_signed_upload_route_lands_an_original_a_write_can_attach", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  /* The path a 12 MP phone photo actually takes. The model gets the key now. */
  const link = await runTool("catalog.upload_image", { filename: "trench-front.jpg" }, f.ctx);
  assert.equal(link.ok, true, link.error);
  const url = new URL(link.data.upload_url);
  assert.equal(url.pathname, "/media/upload");
  assert.equal(url.searchParams.get("key"), link.data.key);

  /* The route's own check, run against the ticket the tool minted. */
  const accepted = await verifyUploadTicket({
    secret: SIGNING_KEY,
    key: url.searchParams.get("key"),
    actor: "mara@vemians.com",
    expiresAt: url.searchParams.get("exp"),
    signature: url.searchParams.get("sig"),
  });
  assert.equal(accepted.ok, true);

  /* The browser PUTs the file; it lands on exactly the key already returned,
     so the agent needs no second round trip to find out where it went. */
  await f.media.put(link.data.key, PNG_BYTES, { contentType: "image/jpeg", actor: "mara@vemians.com" });

  const res = await approvedCall(f, "catalog.create_product", {
    ...COAT,
    category_id: cat.id,
    images: [link.data.key],
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.images.attached, [link.data.key]);
  assert.equal(f.calls().find((c) => c.path === "/v2/catalog/images").imageType, "image/jpeg");

  /* And an original is never replaced in place. */
  await assert.rejects(
    () => f.media.put(link.data.key, PNG_BYTES, { contentType: "image/jpeg" }),
    /never overwritten/,
  );
});

check("test_PRD_P0_28_image_contract__an_image_key_we_did_not_mint_is_refused_before_the_write", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  const invented = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: cat.id, images: ["../../etc/passwd"] },
    f.ctx,
  );
  assert.equal(invented.ok, false);
  assert.match(invented.error, /not a media key this application minted/);

  /* Well-formed, correctly shaped, and holding nothing: the human has not
     finished uploading. Refused, not guessed at. */
  const empty = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: cat.id, images: [mediaKey("image/jpeg")] },
    f.ctx,
  );
  assert.equal(empty.ok, false);
  assert.match(empty.error, /has not finished uploading yet/);

  assert.deepEqual(f.calls(), [], "neither reached Square");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-21 — every one of these writes an audit row
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_21_append_only_audit__every_authoring_call_is_audited_including_its_refusals", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  await runTool("catalog.categories", {}, f.ctx);
  await runTool("catalog.draft_product", COAT, f.ctx);
  const key = await uploadInline(f);
  await runTool("catalog.create_product", { ...COAT, category_id: "not-a-category" }, f.ctx);
  await runTool("catalog.create_category", { name: "Knitwear", reason: "duplicate on purpose" }, f.ctx);
  await approvedCall(f, "catalog.create_product", { ...COAT, category_id: cat.id, images: [key] });

  const rows = f.audit();
  assert.deepEqual(
    rows.map((r) => [r.tool, r.result]),
    [
      ["catalog.categories", "ok"],
      ["catalog.draft_product", "ok"],
      ["catalog.upload_image", "ok"],
      ["catalog.create_product", "denied"],
      ["catalog.create_category", "denied"],
      ["catalog.create_product", "pending_approval"],
      ["catalog.create_product", "ok"],
    ],
  );
  for (const r of rows) {
    assert.equal(r.actor, "mara@vemians.com", "the actor is the Access identity on every row");
    assert.equal(r.domain, "catalog");
    assert.ok(r.created_at, "and every row is stamped");
  }

  /* The store is append-only by trigger, not by our good manners. */
  assert.throws(() => f.auditDb._raw.exec("UPDATE audit_log SET result='ok' WHERE id=1"), /append-only|immutable|cannot/i);
  assert.throws(() => f.auditDb._raw.exec("DELETE FROM audit_log"), /append-only|immutable|cannot/i);
});

check("test_PRD_P0_21_append_only_audit__an_unavailable_audit_store_stops_the_create_entirely", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");
  const gate = await runTool("catalog.create_product", { ...COAT, category_id: cat.id }, f.ctx);
  assert.equal(gate.needsApproval, true);

  /* Fail closed: with nowhere to record it, the write does not happen. */
  const res = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: cat.id },
    { ...f.ctx, env: { ...f.env, AUDIT: null }, approvalToken: gate.data.approval.token },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /audit unavailable/);
  assert.equal(res.auditId, null);
  assert.deepEqual(f.calls(), [], "an unlogged write is not a write we make");
  assert.equal(f.mirror("SELECT * FROM mirror_product WHERE title LIKE 'Belted%'").length, 0);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-24 — scope is a binding, for resources as well as stores
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_24_binding_scoped_tools__the_draft_tool_holds_no_square_write_path_at_all", async () => {
  /* Not "the draft tool does not call Square" — it has nothing to call it
     with. The registry hands `t.square` only to a tool that declared it. */
  assert.deepEqual(TOOLS["catalog.draft_product"].resources ?? [], []);
  assert.deepEqual(TOOLS["catalog.categories"].resources ?? [], []);
  assert.deepEqual(TOOLS["catalog.create_product"].resources, ["square", "media"]);
  assert.deepEqual(TOOLS["catalog.upload_image"].resources, ["media"]);

  /* Inject a writer that throws on ANY property access. The draft still runs,
     because the registry never put it within reach of the tool. */
  const f = await fixture();
  const booby = new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`the draft tool reached the Square writer (.${String(prop)})`);
      },
    },
  );
  const res = await runTool("catalog.draft_product", COAT, { ...f.ctx, square: booby });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(f.calls(), []);

  /* And the registry refuses the mistake at assembly rather than at a request:
     a T0 declaring the write path cannot be built (src/tools/index.js). */
  assert.deepEqual(RESOURCES, ["square", "square_client", "media"]);
  assert.equal(TOOLS["catalog.categories"].tier, "T0");
});

check("test_PRD_P0_24_binding_scoped_tools__authoring_tools_reach_no_customer_people_or_finance_store", async () => {
  for (const name of Object.keys(TOOLS).filter((n) => n.startsWith("catalog."))) {
    const stores = TOOLS[name].stores;
    for (const forbidden of ["customers", "people", "finance", "commerce"]) {
      assert.ok(!stores.includes(forbidden), `${name} declares '${forbidden}'`);
    }
  }
  /* And the vault has no binding in the registry at all, still. */
  assert.ok(!Object.keys(STORE_BINDINGS).includes("identity"));

  /*
   * Structurally: a customer store bound on the Worker is still unreachable
   * from a catalog tool, because `scopedStores` hands it no handle for one.
   * The binding below fails the check if anything so much as prepares against
   * it, and the tool runs to completion regardless.
   */
  const f = await fixture();
  const res = await runTool("catalog.categories", {}, {
    ...f.ctx,
    env: {
      ...f.env,
      CUSTOMERS: { prepare: () => assert.fail("a catalog tool reached the customers store") },
      FINANCE: { prepare: () => assert.fail("a catalog tool reached the finance store") },
    },
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.count, 3);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-84 — drafting a product asks only real questions, never a settled one
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_84_efficient_drafting__the_tool_descriptions_say_not_to_ask_about_currency", () => {
  /* This is a single-currency (USD) shop with no CAPS constant or schema
     default for it — the field is still required on every call, so the
     model has to pass something. Without this in the description it has no
     way to know the answer is always USD, and a human gets asked a question
     with only one real answer. On BOTH the draft and the real write, since
     a description read once at draft time and never again would leave the
     write asking anyway. */
  for (const name of ["catalog.draft_product", "catalog.create_product"]) {
    assert.match(TOOLS[name].describe, /USD/, `${name} must say what currency to default to`);
  }
});

check("test_PRD_P0_84_efficient_drafting__the_tool_descriptions_say_not_to_ask_about_variations_that_do_not_exist", () => {
  /* validateProposal() already explains this ("a single-size garment still
     needs one, conventionally titled 'One size'") — but only AFTER a
     refusal. Efficient means the model knows this on the FIRST call, from
     the description every request already carries, not from a failed
     round-trip. */
  for (const name of ["catalog.draft_product", "catalog.create_product"]) {
    assert.match(TOOLS[name].describe, /One size/, `${name} must say how to handle a product with no real options`);
  }
});

check("test_PRD_P0_84_efficient_drafting__the_tool_description_says_not_to_ask_about_quantity", () => {
  /* "I don't think that has to be a hard requirement. If you do not specify
     a quantity, let's make the assumption that we have one" — the owner's
     own words. Quantity was never a real schema field or a code-level
     gate anywhere in this codebase (VARIATION carries none; batch.js never
     touched it) — only this description's own insistence made an agent
     treat it as one, so this is the one place the fix belongs. */
  assert.match(TOOLS["catalog.create_product"].describe, /default(s)? to 1/i, "must say quantity defaults to 1 rather than being asked for");
});

check("test_PRD_P0_84_efficient_drafting__draft_product_says_to_write_the_description_itself", () => {
  /* description is a required argument to draft_product — the model has to
     supply SOMETHING regardless — but "required" must not read as "go ask
     the person to dictate one." Drafting one from the title/category/photo
     is exactly what a drafting tool is for. */
  assert.match(TOOLS["catalog.draft_product"].describe, /write the description yourself/i);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-34 / P0-35 — one registry, and an approval a model cannot mint
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_34_multi_client_tools__the_authoring_tools_are_one_registry_filtered_by_role", async () => {
  const forStaff = describeTools("staff").map((d) => d.name);
  const forManager = describeTools("manager").map((d) => d.name);

  /* Staff draft and upload; a manager creates. A tool a role may not use is
     ABSENT from that role's list rather than present and refused. */
  assert.ok(forStaff.includes("catalog.categories"));
  assert.ok(forStaff.includes("catalog.draft_product"));
  assert.ok(forStaff.includes("catalog.upload_image"));
  assert.ok(forStaff.includes("catalog.product"), "reading a real product is T0 — staff can look one up");
  assert.ok(!forStaff.includes("catalog.create_product"));
  assert.ok(!forStaff.includes("catalog.update_product"));
  assert.ok(!forStaff.includes("catalog.create_category"));
  assert.ok(!forStaff.includes("catalog.set_channel"));
  assert.ok(!forStaff.includes("catalog.set_custom_fields"));

  for (const name of [
    "catalog.create_product",
    "catalog.update_product",
    "catalog.create_category",
    "catalog.set_channel",
    "catalog.set_custom_fields",
  ]) {
    assert.ok(forManager.includes(name));
    assert.equal(TOOLS[name].tier, "T2", "every catalog write is T2 — these are commercial facts");
  }

  /* The description an external client is handed carries the tier and the undo,
     so the same rules reach Claude, ChatGPT and the browser chat as data. */
  const described = describeTools("manager").find((d) => d.name === "catalog.create_product");
  assert.equal(described.tier, "T2");
  assert.equal(described.min_role, "manager");
  assert.deepEqual(described.stores, ["catalog_mirror"]);
  assert.ok(described.undo.length > 5);
});

check("test_PRD_P0_35_approval_never_in_band__an_approval_token_is_never_accepted_from_arguments", async () => {
  const f = await fixture();
  const cat = f.categories().find((c) => c.name === "Outerwear");

  for (const field of ["approval_token", "approvalToken", "actor", "role"]) {
    const res = await runTool(
      "catalog.create_product",
      { ...COAT, category_id: cat.id, [field]: "apr_forged" },
      f.ctx,
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /cannot be passed as an argument/);
    const rows = f.audit();
    assert.equal(rows[rows.length - 1].result, "denied");
  }
  assert.deepEqual(f.calls(), [], "a forged approval reaches nothing");

  /* A token from a DIFFERENT person's session is not spendable either. */
  const gate = await runTool("catalog.create_product", { ...COAT, category_id: cat.id }, f.ctx);
  const theirs = await runTool(
    "catalog.create_product",
    { ...COAT, category_id: cat.id },
    { ...f.ctx, ...staff, role: "manager", approvalToken: gate.data.approval.token },
  );
  assert.equal(theirs.needsApproval, true, "an approval is for a person as well as a change");
  assert.deepEqual(f.calls(), []);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-30 — traceability
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", () => {
  assert.ok(fs.existsSync(PRD), `${PRD} not found: PRD-backed checks cannot be traced`);
  const prd = fs.readFileSync(PRD, "utf8");

  /* Read this file's own check names rather than trusting the running set. */
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const names = [...source.matchAll(/^check\("(test_PRD_[A-Za-z0-9_]+)"/gm)].map((m) => m[1]);
  assert.ok(names.length >= 20, `expected a real suite, found ${names.length} checks`);

  const labels = new Set();
  for (const name of names) {
    const m = NAME.exec(name);
    assert.ok(m, `${name} is not a PRD-labeled check`);
    labels.add(`Test-PRD-${m[1]}-${m[2]}-${m[3]}`);
  }
  const missing = [...labels].filter((label) => !prd.includes(label));
  assert.deepEqual(missing, [], "labels absent from docs/PRD.md");

  /* And every label that ran is one of them. */
  assert.deepEqual([...usedLabels].filter((l) => !labels.has(l)), []);

  /* The feature this change had to WRITE, because the behaviour had no home. */
  assert.ok(prd.includes("Test-PRD-P0-40-closed_category_set"));
});

/* Suggestion scoring, exercised directly so the reasoning string is not only
   asserted through a tool call. */
check("test_PRD_P0_40_closed_category_set__the_suggestion_is_scored_against_the_existing_names_only", () => {
  const categories = [
    { id: "a", name: "Outerwear" },
    { id: "b", name: "Knitwear" },
    { id: "c", name: "Accessories" },
  ];
  const hit = suggestCategory({
    hint: "knitwear",
    title: "Ribbed cashmere jumper",
    description: "Two-ply cashmere.",
    categories,
  });
  assert.equal(hit.suggestion.name, "Knitwear");
  assert.equal(hit.confidence, "high");

  /* The model's pick wins on semantics, and the tool says when its own reading
     of the wording disagrees rather than silently deferring. */
  const disagreement = suggestCategory({
    hint: "knitwear",
    title: "Ribbed cashmere jumper",
    description: "Two-ply cashmere.",
    categories,
    chosenId: "c",
  });
  assert.equal(disagreement.suggestion.name, "Accessories");
  assert.equal(disagreement.chosen_id_exists, true);
  assert.match(disagreement.reasoning, /"Knitwear" scored higher/);

  /* Nothing matches: the tool says so and points at a human, rather than
     inventing "Fragrance" on the spot. */
  const miss = suggestCategory({
    hint: "fragrance",
    title: "Vetiver eau de parfum",
    description: "50ml.",
    categories,
  });
  assert.equal(miss.suggestion, null);
  assert.equal(miss.confidence, "none");
  assert.match(miss.reasoning, /ask the human/);
  assert.match(miss.reasoning, /do not create a category/);
  assert.equal(miss.closed_set_size, 3);
});


/* ─────────────────────────────────────────────────────────────────────────
 * P0-55 — with no bucket, a photograph already in Square is LINKED, not
 *         uploaded a second time
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_55_square_held_media__an_image_already_in_square_is_linked_not_reuploaded", async () => {
  const f = await fixture();

  /* The deployment with no MEDIA bucket: the human's upload already went to
     Square, so the store hands back an image ref rather than bytes. */
  const uploads = [];
  const squareStore = createSquareMediaStore(
    {
      async upload(a) {
        uploads.push(a);
        return { imageRef: "SQIMG_EXISTING", url: "https://items.sq/x.jpg", name: a.name };
      },
      async findByName(name) {
        return { imageRef: "SQIMG_EXISTING", url: "https://items.sq/x.jpg", name };
      },
    },
    { MEDIA_SIGNING_KEY: "k", OPS_HOST: "ops.vemians.com" },
  );

  /* A real minted key: the store refuses anything it did not mint, which is
     the guard that rejected a hand-written path on the first run of this test. */
  const key = mediaKey("image/jpeg");
  const attachable = await squareStore.attachable(key);
  assert.equal(attachable.imageRef, "SQIMG_EXISTING", "the store hands over a ref, not bytes");

  const out = await f.writer.createProduct({
    title: "Linked Photograph Coat",
    description: "",
    categoryId: null,
    variations: [{ title: "One size", sku: "LPC-1", price_minor: 12000, currency: "USD" }],
    images: [{ ...attachable, caption: "Linked Photograph Coat" }],
  });

  /* 1. The item carries the image id, set at creation. */
  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.body?.object?.type === "ITEM");
  assert.ok(upsert, "the item was upserted");
  assert.deepEqual(
    upsert.body.object.item_data.image_ids,
    ["SQIMG_EXISTING"],
    "the photograph is linked on the item itself",
  );

  /* 2. And nothing was sent to the image endpoint — one photograph, one
        CatalogImage. Re-uploading is the bug this guards. */
  assert.equal(
    f.calls().filter((c) => c.path === "/v2/catalog/images").length,
    0,
    "an image already in Square must not be uploaded again",
  );
  assert.equal(uploads.length, 0, "and the media store must not be asked to upload either");

  assert.deepEqual(out.images.attached, [key], "reported as attached, because it is");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-88 — a dropped spreadsheet drafts through chat, not a raw-text guess
 * ───────────────────────────────────────────────────────────────────────── */

const ASSETS_SQL = fs.readFileSync(path.join(DB_DIR, "assets.sql"), "utf8");

async function assetsFixtureWithRow({ extracted_text = null, filename = "products.csv" } = {}) {
  const db = d1FromSql(ASSETS_SQL);
  await db
    .prepare(
      "INSERT INTO asset(id, store_key, filename, content_type, size_bytes, uploaded_by, extracted_text, text_truncated)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    )
    .bind("ast_1", "assets/ast_1", filename, "text/csv", 100, "mara@vemians.com", extracted_text)
    .run();
  return db;
}

check("test_PRD_P0_88_spreadsheet_via_chat__staff_cannot_call_the_batch_draft_meta_tools", async () => {
  const outcome = await dispatch(
    "catalog_draft_product_batch",
    { asset_id: "ast_1" },
    { actor: "ana@vemians.com", role: "staff", env: { ASSETS: await assetsFixtureWithRow() }, allowed: new Set(["catalog_draft_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /manager or owner/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__refuses_plainly_with_no_assets_store_bound", async () => {
  const outcome = await dispatch(
    "catalog_draft_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env: {}, allowed: new Set(["catalog_draft_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /no asset store/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__refuses_plainly_for_an_unknown_asset_id", async () => {
  const outcome = await dispatch(
    "catalog_draft_product_batch",
    { asset_id: "nope" },
    { actor: "mara@vemians.com", role: "manager", env: { ASSETS: await assetsFixtureWithRow() }, allowed: new Set(["catalog_draft_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /no asset/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__refuses_plainly_when_the_file_had_no_extractable_text", async () => {
  const outcome = await dispatch(
    "catalog_draft_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: null }) },
      allowed: new Set(["catalog_draft_product_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /no readable text/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__a_real_csv_drafts_through_the_same_path_products_batch_uses", async () => {
  /* THE POINT: the same draftProductBatch() that /products/batch calls
     directly, reached instead through the chat's own tool-call loop, with
     the CSV read back from the asset store rather than re-typed by the
     model — a wrong guess on this row from the model is not possible, only
     a wrong guess by the same deterministic parser /products/batch itself
     trusts. */
  const f = await fixture();
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n,Outerwear,10,,\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let outcome;
  try {
    outcome = await dispatch(
      "catalog_draft_product_batch",
      { asset_id: "ast_1" },
      { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_draft_product_batch"]) },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /1 products created, 1 skipped/);
  assert.match(outcome.block.content, /Wool Coat/);
  assert.match(outcome.block.content, /no vendor and no unit cost/i, "the skipped row's own reason must be relayed");
});

check("test_PRD_P0_136_square_custom_attributes__a_missing_category_via_chat_is_created_immediately_too", async () => {
  const f = await fixture();
  const csv = "title,category,price,cost\nSun Hat,Millinery,20.00,10.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let outcome;
  try {
    outcome = await dispatch(
      "catalog_draft_product_batch",
      { asset_id: "ast_1" },
      { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_draft_product_batch"]) },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /1 products created, 0 skipped/);
  assert.match(outcome.block.content, /Sun Hat/);
  assert.equal(outcome.table.rows[0][2], "created", "the row itself is created, in the same upload, once its missing category is created");
  assert.ok(f.categories().find((c) => c.name === "Millinery"), "the category must actually have been created");
});

check("test_PRD_P0_88_spreadsheet_via_chat__too_many_rows_reports_the_cap_not_a_partial_draft", async () => {
  const f = await fixture();
  const rows = Array.from({ length: CAPS.BATCH_MAX_ROWS + 1 }, (_, i) => `Item ${i},Outerwear,10.00`).join("\n");
  const csv = `title,category,price\n${rows}\n`;
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_draft_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_draft_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, new RegExp(`${CAPS.BATCH_MAX_ROWS}-row cap`));
});

check("test_PRD_P0_88_spreadsheet_via_chat__an_unknown_tool_name_still_refuses_before_reaching_any_of_this", async () => {
  /* Second enforcement of the same set (agent.js's own rule, P0-24) — a name
     these meta-tools don't recognise must never reach dispatchBatchDraft at
     all when it was never offered in the first place. */
  const outcome = await dispatch("catalog_draft_product_batch", {}, { actor: "mara@vemians.com", role: "manager", env: {}, allowed: new Set() });
  assert.match(outcome.block.content, /No such tool/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-89 — preview a spreadsheet's column mapping before drafting it
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_89_batch_preview_confirm__staff_cannot_call_the_preview_meta_tools_either", async () => {
  const outcome = await dispatch(
    "catalog_preview_product_batch",
    { asset_id: "ast_1" },
    { actor: "ana@vemians.com", role: "staff", env: { ASSETS: await assetsFixtureWithRow() }, allowed: new Set(["catalog_preview_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /manager or owner/i);
});

check("test_PRD_P0_89_batch_preview_confirm__previews_the_first_rows_and_headings_without_minting_anything", async () => {
  const f = await fixture();
  const csv = "title,category,price\nWool Coat,Outerwear,450.00\nAnother Coat,Outerwear,99.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_preview_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_preview_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /2 rows detected/);
  assert.match(outcome.block.content, /title, category, price/);
  assert.match(outcome.block.content, /Wool Coat/);
  assert.doesNotMatch(outcome.block.content, /https?:\/\/\S+\/approvals\//, "a preview must mint no approval link");
  assert.deepEqual(f.calls(), [], "a preview must not touch Square at all");

  /* The structured table is what the client renders — real headings as
     columns, one row per sample record, so it reads like a normal
     spreadsheet snippet rather than a field-by-field list. Just the one
     sample row now (PREVIEW_SAMPLE_ROWS, batch.js) — "just... one, two
     rows, one for the headings and one row of data" — even though the
     sheet itself has two. */
  assert.deepEqual(outcome.table.columns, ["title", "category", "subcategory", "price", "currency", "description", "sku", "style_id", "vendor", "vendor_code", "commission", "quantity", "size", "color"]);
  assert.equal(outcome.table.rows.length, 1, "only the first row is sampled");
  const titleCol = outcome.table.columns.indexOf("title");
  assert.equal(outcome.table.rows[0][titleCol], "Wool Coat");
});

check("test_PRD_P0_117_batch_preview_one_row_fits_without_scrolling__the_preview_table_is_marked_compact", async () => {
  /* Compact tables (this one) are what let views.js's tableCard() skip the
     fixed max-height clip entirely — "the height fits all the data" —
     unlike batchDraftTable()'s own potentially-long ready/skipped result,
     which stays plain (uncapped rows, still needs the scroll frame). */
  const csv = "title,category,price\nWool Coat,Outerwear,450.00\n";
  const outcome = await dispatch(
    "catalog_preview_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) },
      allowed: new Set(["catalog_preview_product_batch"]),
    },
  );
  assert.equal(outcome.table.compact, true);
});

check("test_PRD_P0_89_batch_preview_confirm__only_shows_the_top_row_not_the_whole_sheet", async () => {
  /* "I already need to really see just one — two rows, one for the
     headings and one row of data. I don't need to see three of them," the
     owner's own words, superseding P0-89's original "top 2 or 3 rows."
     A sheet with far more rows than that must still preview as a single
     sample row, with the true total named separately. */
  const rows = Array.from({ length: 20 }, (_, i) => `Item ${i},Outerwear,${10 + i}.00`).join("\n");
  const csv = `title,category,price\n${rows}\n`;
  const outcome = await dispatch(
    "catalog_preview_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) },
      allowed: new Set(["catalog_preview_product_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /20 rows detected/);
  assert.equal(outcome.table.rows.length, 1, "sampled, not the full 20 rows");
});

check("test_PRD_P0_89_batch_preview_confirm__customers_preview_maps_the_square_field_names", async () => {
  const csv = "given_name,family_name,email_address\nAva,Stone,ava@example.com\n";
  const outcome = await dispatch(
    "customer_preview_customer_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: csv, filename: "customers.csv" }) },
      allowed: new Set(["customer_preview_customer_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /1 row detected/);
  assert.deepEqual(outcome.table.columns, ["given_name", "family_name", "email_address", "phone_number"]);
  const emailCol = outcome.table.columns.indexOf("email_address");
  assert.equal(outcome.table.rows[0][emailCol], "ava@example.com");
});

check("test_PRD_P0_89_batch_preview_confirm__an_empty_spreadsheet_previews_as_nothing_to_show_not_a_crash", async () => {
  const outcome = await dispatch(
    "catalog_preview_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: "title,category,price\n" }) },
      allowed: new Set(["catalog_preview_product_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /no rows to preview/i);
  assert.equal(outcome.table, null);
});

check("test_PRD_P0_89_batch_preview_confirm__the_draft_tools_carry_a_structured_table_too", async () => {
  /* Not just the preview — the real draft result is ALSO structured, since a
     person cannot review forty skip reasons rendered as one text bubble. */
  const f = await fixture();
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n,Outerwear,10,,\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let outcome;
  try {
    outcome = await dispatch(
      "catalog_draft_product_batch",
      { asset_id: "ast_1" },
      { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_draft_product_batch"]) },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(outcome.table.columns.length, 4);
  assert.equal(outcome.table.rows.length, 2);
  const created = outcome.table.rows.find((r) => r[2] === "created");
  assert.equal(created[1], "Wool Coat");
  const skipped = outcome.table.rows.find((r) => r[2] === "skipped");
  assert.match(skipped[3], /no vendor and no unit cost/i);
});

check("test_PRD_P0_89_batch_preview_confirm__too_many_rows_carries_no_table_only_the_cap_message", async () => {
  const f = await fixture();
  const rows = Array.from({ length: CAPS.BATCH_MAX_ROWS + 1 }, (_, i) => `Item ${i},Outerwear,10.00`).join("\n");
  const csv = `title,category,price\n${rows}\n`;
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_draft_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_draft_product_batch"]) },
  );
  assert.equal(outcome.table, null);
});

check("test_PRD_P0_89_batch_preview_confirm__the_no_text_table_note_bans_every_shape_not_just_markdown", async () => {
  /* "Dont rely on text to try to explain table structure... This is
     useless" named "a markdown table" specifically, and the model found
     the loophole immediately — a bulleted arrow-style mapping instead
     ("- **Title** ← 'style #'..."), the identical restatement in a
     different shape. The note must ban the whole category, not one
     named format. */
  assert.match(NO_TEXT_TABLE_NOTE, /rendered for the person automatically/i, "must say a table is already shown");
  assert.match(NO_TEXT_TABLE_NOTE, /markdown table/i, "must still name a markdown table");
  assert.match(NO_TEXT_TABLE_NOTE, /bulleted or arrow-style field-by-field mapping/i, "must also ban the bulleted/arrow-mapping loophole the model actually used");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-146 — a missing Size/Color is minted, not refused: "if we are adding
 * a set of items and we specify its size or color, and this size or color
 * is not already defined in our option, add this size or color to the
 * option list and update it so that this item can still be added as a
 * SKU" — the owner's own words, for catalog.create_product's own
 * `variations[].option_values` directly and for the CSV batch path
 * (ops/src/batch.js) that builds it from a Size/Color column.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_146_dynamic_option_values__a_brand_new_option_set_is_minted_from_scratch", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  const res = await approvedCall(f, "catalog.create_product", {
    title: "Cotton Scarf",
    category_id: outerwear.id,
    variations: [{ title: "Cotton Scarf", price_minor: 4500, currency: "USD", option_values: { Material: "Cotton" } }],
  });
  assert.equal(res.ok, true, res.error);

  const optionObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Material");
  assert.ok(optionObj, "a new ITEM_OPTION must actually be created in Square");
  assert.equal(optionObj.item_option_data.values.length, 1);
  assert.equal(optionObj.item_option_data.values[0].item_option_value_data.name, "Cotton");

  const itemWrite = f.calls().find((c) => c.upsert === "ITEM" && c.body.object.item_data.name === "Cotton Scarf");
  assert.deepEqual(itemWrite.body.object.item_data.item_options, [{ item_option_id: optionObj.id }]);
  assert.deepEqual(itemWrite.body.object.item_data.variations[0].item_variation_data.item_option_values, [
    { item_option_id: optionObj.id, item_option_value_id: optionObj.item_option_data.values[0].id },
  ]);

  const optRow = f.mirror("SELECT id FROM mirror_item_option WHERE name = 'Material'")[0];
  assert.ok(optRow, "the new option must land in the mirror after sync");
  const valRow = f.mirror("SELECT name FROM mirror_item_option_value WHERE item_option_id = ? AND name = 'Cotton'", optRow.id)[0];
  assert.ok(valRow, "the new value must land in the mirror after sync");
});

check("test_PRD_P0_146_dynamic_option_values__a_new_value_is_appended_to_an_existing_option", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  f.square.objects.set("SQ_OPT_SIZE", {
    id: "SQ_OPT_SIZE",
    type: "ITEM_OPTION",
    version: 3,
    item_option_data: {
      name: "Size",
      values: [{ type: "ITEM_OPTION_VAL", id: "SQ_OPTVAL_S", item_option_value_data: { item_option_id: "SQ_OPT_SIZE", name: "S" } }],
    },
  });
  f.mirrorDb._raw.prepare("INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('opt-size','SQ_OPT_SIZE','Size')").run();
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal) VALUES ('optval-s','SQ_OPTVAL_S','opt-size','S',0)")
    .run();

  const res = await approvedCall(f, "catalog.create_product", {
    title: "Wool Sweater",
    category_id: outerwear.id,
    variations: [{ title: "Wool Sweater", price_minor: 8000, currency: "USD", option_values: { Size: "XL" } }],
  });
  assert.equal(res.ok, true, res.error);

  const optionWrite = f.calls().find((c) => c.upsert === "ITEM_OPTION" && c.body.object.id === "SQ_OPT_SIZE");
  assert.ok(optionWrite, "the EXISTING option object must be resent whole, with the new value appended");
  assert.deepEqual(
    optionWrite.body.object.item_option_data.values.map((v) => v.item_option_value_data.name),
    ["S", "XL"],
    "the option's own CURRENT values are resent whole, never replaced by just the new one",
  );

  const valRow = f.mirror("SELECT name FROM mirror_item_option_value WHERE item_option_id = 'opt-size' AND name = 'XL'")[0];
  assert.ok(valRow, "the new value must land in the mirror after sync");
  const sRow = f.mirror("SELECT archived_at FROM mirror_item_option_value WHERE item_option_id = 'opt-size' AND name = 'S'")[0];
  assert.equal(sRow.archived_at, null, "the EXISTING value must survive the append, never archived by it");
});

check("test_PRD_P0_146_dynamic_option_values__an_existing_value_is_reused_case_insensitively_with_no_extra_write", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  f.square.objects.set("SQ_OPT_SIZE", {
    id: "SQ_OPT_SIZE",
    type: "ITEM_OPTION",
    version: 3,
    item_option_data: {
      name: "Size",
      values: [{ type: "ITEM_OPTION_VAL", id: "SQ_OPTVAL_S", item_option_value_data: { item_option_id: "SQ_OPT_SIZE", name: "S" } }],
    },
  });
  f.mirrorDb._raw.prepare("INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('opt-size','SQ_OPT_SIZE','Size')").run();
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal) VALUES ('optval-s','SQ_OPTVAL_S','opt-size','S',0)")
    .run();

  /* Different case on both halves — "size"/"s" — than what is on file
     ("Size"/"S"), the same tolerance matchCategory already gives a
     spreadsheet that was not typed to a spec. */
  const res = await approvedCall(f, "catalog.create_product", {
    title: "Wool Sweater",
    category_id: outerwear.id,
    variations: [{ title: "Wool Sweater", price_minor: 8000, currency: "USD", option_values: { size: "s" } }],
  });
  assert.equal(res.ok, true, res.error);

  const optionWrites = f.calls().filter((c) => c.upsert === "ITEM_OPTION");
  assert.equal(optionWrites.length, 0, "an already-known value needs no Square write of its own");

  const itemWrite = f.calls().find((c) => c.upsert === "ITEM");
  assert.deepEqual(itemWrite.body.object.item_data.item_options, [{ item_option_id: "SQ_OPT_SIZE" }]);
  assert.deepEqual(itemWrite.body.object.item_data.variations[0].item_variation_data.item_option_values, [
    { item_option_id: "SQ_OPT_SIZE", item_option_value_id: "SQ_OPTVAL_S" },
  ]);
});

check("test_PRD_P0_146_dynamic_option_values__a_csv_size_or_color_column_reaches_create_product", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,cost,size,color\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,XL,Red\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const optionWrites = f.calls().filter((c) => c.upsert === "ITEM_OPTION");
  assert.equal(optionWrites.length, 2, "both Size and Color are brand new options this shop has never used");
  const itemWrite = f.calls().find((c) => c.upsert === "ITEM" && c.body.object.item_data.name === "Wool Coat");
  assert.equal(itemWrite.body.object.item_data.item_options.length, 2);
  assert.equal(itemWrite.body.object.item_data.variations[0].item_variation_data.item_option_values.length, 2);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-146 (REVISED) — "we're now going to be providing you with the full
 * style number... the category first, a subcategory ID, then the actual
 * index of the item, then a dash and an abbreviation for a color if there
 * is one, then a dash for any size. OS size means all sizes, it fits all"
 * — the owner's own words. The style id/style number column (STYLE_ID_KEYS)
 * may now carry this shop's own NN-NN-NNN style_id PLUS a trailing color
 * and/or size (parseStyleNumber, batch.js), instead of needing separate
 * Size/Color columns for every row.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_146_dynamic_option_values__a_full_style_number_supplies_color_and_size_too", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost\n" + `Wool Coat,${outerwear.name},450.00,01-04-001-BLK-M,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const colorObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Color");
  const sizeObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Size");
  assert.ok(colorObj && sizeObj, "the style number's own trailing segments must mint both a Color and a Size option");
  assert.equal(colorObj.item_option_data.values[0].item_option_value_data.name, "BLK");
  assert.equal(sizeObj.item_option_data.values[0].item_option_value_data.name, "M");

  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.equal(row.style_id, "01-04-001", "only the base three segments become style_id -- the color/size suffix is never sent along as part of it");
});

check("test_PRD_P0_146_dynamic_option_values__a_lone_trailing_segment_is_always_read_as_a_size_never_a_color", async () => {
  /* "OS size means all sizes, it fits all... so we need to have an OS
     size" -- the owner's own words. Color is the segment that goes
     missing entirely when an item has no color axis; size is always
     given, "OS" reserved for one with no real size axis either -- so a
     style number with only ONE segment after its base style_id is never
     mistaken for a color standing in alone. */
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost\n" + `Silk Scarf,${outerwear.name},90.00,01-04-001-OS,40.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const colorObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Color");
  const sizeObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Size");
  assert.equal(colorObj, undefined, "no Color option must be created -- there was no color segment, not a coincidentally short one");
  assert.ok(sizeObj, "the lone trailing segment must still become a Size option");
  assert.equal(sizeObj.item_option_data.values[0].item_option_value_data.name, "OS");

  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'Silk Scarf'")[0];
  assert.equal(row.style_id, "01-04-001");
});

check("test_PRD_P0_146_dynamic_option_values__an_explicit_size_or_color_column_wins_over_the_full_style_numbers_own", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,cost,size,color\n" + `Wool Coat,${outerwear.name},450.00,01-04-001-BLK-M,210.00,XL,Red\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const colorObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Color");
  const sizeObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Size");
  assert.equal(colorObj.item_option_data.values[0].item_option_value_data.name, "Red", 'the explicit Color column wins over the style number\'s own "BLK"');
  assert.equal(sizeObj.item_option_data.values[0].item_option_value_data.name, "XL", 'the explicit Size column wins over the style number\'s own "M"');
});

check("test_PRD_P0_146_dynamic_option_values__the_preview_splits_a_full_style_number_into_style_id_color_and_size", async () => {
  const { previewBatch } = await import("../src/batch.js");
  const preview = previewBatch("title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-001-BLK-M\n", "products");
  assert.equal(preview.sampleRows[0].style_id, "01-04-001");
  assert.equal(preview.sampleRows[0].color, "BLK");
  assert.equal(preview.sampleRows[0].size, "M");
});

check("test_PRD_P0_146_dynamic_option_values__a_bare_style_id_with_no_suffix_still_derives_no_color_or_size", async () => {
  /* Backward compatibility: every row before this feature existed gave a
     bare NN-NN-NNN with no trailing segment at all -- parseStyleNumber
     must leave it completely alone. */
  const { previewBatch } = await import("../src/batch.js");
  const preview = previewBatch("title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-001\n", "products");
  assert.equal(preview.sampleRows[0].style_id, "01-04-001");
  assert.equal(preview.sampleRows[0].color, null);
  assert.equal(preview.sampleRows[0].size, null);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-146 (REVISED AGAIN) — a real sheet: "Style #,Category,Subcategory,
 * Description,Color,Size,Qty,Cost (USD),Retail Price,..." whose own Style #
 * pads category/subcategory to THREE digits ("001-001-001"), not this
 * shop's own two -- Category/Subcategory NAME columns resolve the row
 * instead (a brand-new SUBCATEGORY_KEYS column, nesting under whichever
 * CATEGORY_KEYS column resolved to), and this shop's own style_id is left
 * to auto-generate from THOSE categories' own real numeric_id rather than
 * forcing the sheet's own mismatched numbering through as one.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_146_dynamic_option_values__separate_category_and_subcategory_columns_nest_a_new_subcategory", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv =
    "title,category,subcategory,price,style id,cost,color,size\n" +
    "Black Blazer,Jacket,Blazer,165.00,001-001-001-BLK-S,30.00,Black,S\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const categories = f.categories();
  const jacket = categories.find((c) => c.name === "Jacket");
  const blazer = categories.find((c) => c.name === "Blazer");
  assert.ok(jacket && !jacket.parent_id, "Jacket must be created as a new TOP-LEVEL category");
  assert.ok(blazer && blazer.parent_id === jacket.id, "Blazer must be created NESTED under Jacket");

  const row = f.mirror("SELECT category_id, style_id FROM mirror_product WHERE title = 'Black Blazer'")[0];
  assert.equal(row.category_id, blazer.id, "the product must land on the SUBcategory, the more specific level");
  assert.notEqual(row.style_id, "001-001-001", "the sheet's own mismatched 3-digit numbering must never become this shop's own style_id");
  assert.match(row.style_id, /^\d{2}-\d{2}-\d{3}$/, "style_id must still auto-generate in this shop's own real shape, from Jacket/Blazer's own real numeric_id");

  /* The explicit Color/Size columns ("Black"/"S") win over the style
     number's own embedded abbreviation ("BLK"/"S") -- the nicer, full
     word is what a real customer would actually see. */
  const colorObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Color");
  assert.equal(colorObj.item_option_data.values[0].item_option_value_data.name, "Black");
});

check("test_PRD_P0_146_dynamic_option_values__a_subcategory_given_with_no_category_is_refused", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv = "title,subcategory,price,cost\n" + "Black Blazer,Blazer,165.00,30.00\n";

  const result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /subcategory "Blazer" was given without a category to nest it under/);
});

check("test_PRD_P0_146_dynamic_option_values__the_same_subcategory_name_under_two_different_categories_creates_two_distinct_rows", async () => {
  /* P0-138's own rule: "a subcategory name can be used more than once [under
     a different parent]. The ID cannot." Two rows naming the SAME
     subcategory NAME under two DIFFERENT categories must create two
     genuinely separate rows, never collide on one shared cache entry. */
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv =
    "title,category,subcategory,price,cost\n" +
    "Black Blazer,Jacket,Casual,165.00,30.00\n" +
    "Wool Trousers,Pants,Casual,89.00,20.00\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2);

  const categories = f.categories();
  const jacket = categories.find((c) => c.name === "Jacket");
  const pants = categories.find((c) => c.name === "Pants");
  const casualRows = categories.filter((c) => c.name === "Casual");
  assert.equal(casualRows.length, 2, "two distinct Casual rows, one per parent");
  assert.ok(casualRows.some((c) => c.parent_id === jacket.id));
  assert.ok(casualRows.some((c) => c.parent_id === pants.id));
});

check("test_PRD_P0_146_dynamic_option_values__several_rows_naming_the_same_category_and_subcategory_only_create_them_once", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv =
    "title,category,subcategory,price,cost\n" +
    "Black Blazer,Jacket,Blazer,165.00,30.00\n" +
    "White Blazer,Jacket,Blazer,185.00,45.00\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2);

  const categories = f.categories();
  assert.equal(categories.filter((c) => c.name === "Jacket").length, 1);
  assert.equal(categories.filter((c) => c.name === "Blazer").length, 1);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-152 — a real sheet: "it's not one product, one line... I gave you
 * variations. So it's not one product... it's one variation per row."
 * "The numbers will provide you with everything you need to know... look
 * at the style number... whatever we have configured, you assign to that
 * category using its ID... if you find that we do not have an ID that
 * matches what we are supplying you, then you will use the columns for
 * the... name and create a new one" — the owner's own words. Rows sharing
 * one style number's own first three segments (category-subcategory-
 * index) become ONE catalog.create_product call with several variations,
 * one per row; category/subcategory resolve by NUMBER first, name only
 * when creating one from scratch or reconciling an unnumbered match.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_152_style_number_grouping__rows_sharing_a_style_base_become_one_product_with_multiple_variations", async () => {
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Qty,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,2,30,165\n" +
    "001-001-001-BLK-M,Jacket,Blazer,Black hand-painted blazer,Black,M,2,30,165\n" +
    "001-001-001-BLK-L,Jacket,Blazer,Black hand-painted blazer,Black,L,1,30,165\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1, "three rows sharing one style base -- ONE product");
  assert.equal(result.created[0].title, "Black hand-painted blazer", "no title column -- the Description stands in for it");

  const product = f.mirror("SELECT id, style_id FROM mirror_product WHERE title = 'Black hand-painted blazer'")[0];
  assert.ok(product, "the product must actually exist");
  assert.match(product.style_id, /^\d{2}-\d{2}-001$/, "this shop's own two-digit codes, the sheet's own three-digit index kept");
  const variants = f.mirror("SELECT price_minor FROM mirror_variant WHERE product_id = ?", product.id);
  assert.equal(variants.length, 3, "three sizes -- three variations on the SAME product, not three products");

  const jacket = f.categories().find((c) => c.name === "Jacket");
  const blazer = f.categories().find((c) => c.name === "Blazer");
  assert.ok(jacket && !jacket.parent_id && jacket.numeric_id === "01");
  assert.ok(blazer && blazer.parent_id === jacket.id, `Blazer must be created and nested under Jacket -- got: ${JSON.stringify(blazer)}`);
  assert.match(blazer.numeric_id, /^\d{2}$/, "auto-assigned, this shop's own two-digit convention");
});

check("test_PRD_P0_152_style_number_grouping__category_and_subcategory_resolve_by_number_ignoring_a_mismatched_name_column", async () => {
  /* "You don't have to think about the names... whatever we have
     configured, you assign to that category using its ID." An EXISTING
     category already numbered "01" is matched by that number alone, even
     though the sheet's own Category column spells something else. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });

  const csv = "Style #,Category,Description,Color,Size,Cost (USD),Retail Price\n" + "01-99-001-BLK-M,Not Outerwear At All,A coat,Black,M,30,165\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.equal(f.categories().filter((c) => c.name === "Outerwear").length, 1, "no duplicate category created just because the sheet's own name column disagreed");
  assert.equal(f.categories().some((c) => c.name === "Not Outerwear At All"), false, "the mismatched name column is never used when the number already resolves to something real");
});

check("test_PRD_P0_152_style_number_grouping__a_number_with_no_match_creates_a_new_category_named_from_the_column", async () => {
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv = "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" + "004-002-002-MLT-OS,Coat,Winter Coat,Winter coat with a polka dot print,Multi,OS,40,295\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const coat = f.categories().find((c) => c.name === "Coat");
  const winterCoat = f.categories().find((c) => c.name === "Winter Coat");
  assert.ok(coat && !coat.parent_id && coat.numeric_id === "04", '"004" normalizes to this shop\'s own two-digit "04" -- the TOP-LEVEL number IS taken from the style number');
  assert.ok(winterCoat && winterCoat.parent_id === coat.id, "Winter Coat must be created and nested under Coat");
  /* The SUBCATEGORY's own numeric_id is auto-assigned (this shop's own
     tree-wide pool), never the sheet's own "002" -- see draftGroupedProduct's
     own header comment on why subcategory resolution goes by name. */
  assert.match(winterCoat.numeric_id, /^\d{2}$/);
});

check("test_PRD_P0_152_style_number_grouping__an_existing_category_matched_by_name_gets_numbered_rather_than_duplicated", async () => {
  /* "Outerwear" already exists but was never numbered -- this is the ONE
     case a name column still gets consulted even under "you don't have to
     think about the names": to avoid minting a confusing near-duplicate
     beside a category that is really the same one. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  assert.equal(outerwear.numeric_id, null, "must start unnumbered for this test to mean anything");

  const csv = "Style #,Category,Description,Color,Size,Cost (USD),Retail Price\n" + "01-99-001-BLK-M,Outerwear,A coat,Black,M,30,165\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.equal(f.categories().filter((c) => c.name === "Outerwear").length, 1, "still just the one Outerwear -- now numbered, not duplicated");
  assert.equal(f.categories().find((c) => c.name === "Outerwear").numeric_id, "01");
});

check("test_PRD_P0_152_style_number_grouping__a_name_that_already_has_a_different_number_is_reported_not_silently_reassigned", async () => {
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "05" });

  const csv = "Style #,Category,Description,Color,Size,Cost (USD),Retail Price\n" + "01-99-001-BLK-M,Outerwear,A coat,Black,M,30,165\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /already exists numbered "05", not "01"/);
});

check("test_PRD_P0_152_style_number_grouping__a_style_number_that_does_not_match_the_pattern_is_ignored_outright", async () => {
  /* "Ignore any rows that do not match our style ID nomenclature... if
     they don't have that style ID pattern, then just ignore that" -- the
     owner's own words, describing exactly a real sheet's own trailing
     footnote (a whole sentence sitting in the Style # cell, no dashes at
     all). A genuinely BLANK style-id cell (a totals row, say) is a
     DIFFERENT case -- it still goes through the pre-existing standalone
     path and is reported the normal way once it fails on something else
     (a blank price, here) -- this test is only about a NON-blank cell
     that was clearly an attempt at something, but not this shop's own
     style number shape. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Qty,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,2,30,165\n" +
    "Red rows = color not yet specified (TBD) please confirm color for these items.,,,,,,,,\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 1, "the one real row still goes through");
  assert.equal(result.skipped.length, 0, "the footnote is dropped outright, never reported as a problem");
});

check("test_PRD_P0_152_style_number_grouping__a_totals_rows_blank_style_number_still_goes_through_the_ordinary_standalone_path", async () => {
  /* A trailing totals line (blank Style #, blank Category, a number in
     Qty) is a DIFFERENT case from a garbled cell -- nothing to "ignore
     outright" about a blank one, it simply has no style number to group
     by at all, so it takes the pre-existing standalone path same as any
     other style-id-less row, and is reported the ordinary way once
     something else about it fails (its own blank price, here). */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Qty,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,2,30,165\n" +
    ",,,TOTALS,,,3,,\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /price ".*" is not a plain number/);
});

check("test_PRD_P0_152_style_number_grouping__a_bad_price_on_any_one_row_skips_the_whole_group", async () => {
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,30,165\n" +
    "001-001-001-BLK-M,Jacket,Blazer,Black hand-painted blazer,Black,M,30,not-a-price\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0, "a product missing one of its own sizes is worse than not creating it yet");
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /price "not-a-price"/);
});

check("test_PRD_P0_152_style_number_grouping__the_actual_sample_sheet_drafts_sixteen_products_from_twenty_eight_rows", async () => {
  /* The owner's own real sample sheet, verbatim (minus its own byte-order
     mark and its trailing TOTALS/footnote rows, both already covered by
     their own dedicated tests above) -- 27 data rows, 16 distinct
     products once grouped by style base, spanning 3 top-level categories
     and 6 subcategories, none of which exist yet in a fresh shop. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv = [
    "Style #,Category,Subcategory,Description,Color,Size,Qty,Cost (USD),Retail Price,Margin,Margin %",
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,2,30,165,135,0.8181818182",
    "001-001-001-BLK-M,Jacket,Blazer,Black hand-painted blazer,Black,M,2,30,165,135,0.8181818182",
    "001-001-001-BLK-L,Jacket,Blazer,Black hand-painted blazer,Black,L,1,30,165,135,0.8181818182",
    "001-001-002-WHT-S,Jacket,Blazer,White blazer with pearls,White,S,1,45,185,140,0.7567567568",
    "001-001-003-TBD-S,Jacket,Blazer,Embellished blazer,TBD,S,1,35,125,90,0.72",
    "001-001-003-TBD-M,Jacket,Blazer,Embellished blazer,TBD,M,2,35,125,90,0.72",
    "001-001-003-TBD-L,Jacket,Blazer,Embellished blazer,TBD,L,1,35,125,90,0.72",
    "001-001-004-WHT-L,Jacket,Blazer,White blazer,White,L,1,19,75,56,0.7466666667",
    "001-002-001-DNM-OS,Jacket,Denim Jacket,Printed denim jacket,Denim,OS,4,25,225,200,0.8888888889",
    "001-003-001-BLK-S,Jacket,Vest,Black hand-painted vest,Black,S,3,25,135,110,0.8148148148",
    "001-003-001-BLK-M,Jacket,Vest,Black hand-painted vest,Black,M,2,25,135,110,0.8148148148",
    "001-003-001-BLK-L,Jacket,Vest,Black hand-painted vest,Black,L,1,25,135,110,0.8148148148",
    '001-003-002-WHT-S,Jacket,Vest,"Embellished vest, white",White,S,2,29,145,116,0.8',
    '001-003-002-WHT-M,Jacket,Vest,"Embellished vest, white",White,M,1,29,145,116,0.8',
    '001-003-002-WHT-L,Jacket,Vest,"Embellished vest, white",White,L,2,29,145,116,0.8',
    "001-003-003-CRM-M,Jacket,Vest,Cream embellished vest,Cream,M,1,25,115,90,0.7826086957",
    '001-003-004-B/W-L,Jacket,Vest,"Hand-painted vest, black & white",Black & White,L,1,25,140,115,0.8214285714',
    "001-003-005-WHT-M,Jacket,Vest,White vest,White,M,1,19,65,46,0.7076923077",
    "003-001-001-BLK-S,Pants,Dress Pants,Black dress pants,Black,S,1,14,49,35,0.7142857143",
    "003-001-001-BLK-M,Pants,Dress Pants,Black dress pants,Black,M,1,14,49,35,0.7142857143",
    "003-001-001-BLK-L,Pants,Dress Pants,Black dress pants,Black,L,2,14,49,35,0.7142857143",
    "003-001-002-WHT-S,Pants,Dress Pants,White dress pants,White,S,1,18,75,57,0.76",
    "003-001-002-WHT-M,Pants,Dress Pants,White dress pants,White,M,1,18,75,57,0.76",
    "004-001-001-TBD-OS,Coat,Trench Coat,Trench coat,TBD,OS,2,15,135,120,0.8888888889",
    '004-001-002-GRY-OS,Coat,Trench Coat,"Trench coat, gray",Gray,OS,2,40,225,185,0.8222222222',
    '004-002-001-GRY-OS,Coat,Winter Coat,"Winter coat, gray with print",Gray,OS,1,40,295,255,0.8644067797',
    '004-002-002-MLT-OS,Coat,Winter Coat,"Winter coat, polka dot",Multi (Polka Dot),OS,1,40,295,255,0.8644067797',
  ].join("\n");

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 16, "28 rows, 16 distinct products once grouped by style base");

  const jacket = f.categories().find((c) => c.name === "Jacket");
  const pants = f.categories().find((c) => c.name === "Pants");
  const coat = f.categories().find((c) => c.name === "Coat");
  assert.ok(jacket && jacket.numeric_id === "01" && !jacket.parent_id);
  assert.ok(pants && pants.numeric_id === "03" && !pants.parent_id);
  assert.ok(coat && coat.numeric_id === "04" && !coat.parent_id);

  const subNames = ["Blazer", "Denim Jacket", "Vest", "Dress Pants", "Trench Coat", "Winter Coat"];
  for (const name of subNames) {
    assert.equal(f.categories().filter((c) => c.name === name).length, 1, `${name} must be created exactly once across all its own rows`);
  }
  const blazer = f.categories().find((c) => c.name === "Blazer");
  const vest = f.categories().find((c) => c.name === "Vest");
  const denim = f.categories().find((c) => c.name === "Denim Jacket");
  assert.ok(blazer.parent_id === jacket.id && vest.parent_id === jacket.id && denim.parent_id === jacket.id);
  assert.notEqual(blazer.numeric_id, vest.numeric_id);
  assert.notEqual(blazer.numeric_id, denim.numeric_id);

  /* Every one of the 16 was created immediately, in the same call above --
     confirm the mirror actually ends up with 16 NEW products (on top of
     whatever the base fixture's own seed catalog already carried), each
     with a real, correctly-shaped style_id -- the one thing the
     pre-existing seed product does NOT have, so filtering on it isolates
     exactly the newly-created ones. */
  const products = f.mirror("SELECT title, style_id FROM mirror_product WHERE style_id IS NOT NULL");
  assert.equal(products.length, 16, `titles: ${JSON.stringify(products.map((p) => p.title))}`);
  for (const p of products) assert.match(p.style_id, /^\d{2}-\d{2}-\d{3}$/, `${p.title}'s own style_id must be this shop's real shape`);

  const coatRow = f.mirror("SELECT id FROM mirror_product WHERE title LIKE 'Black hand-painted blazer'")[0];
  const variants = f.mirror("SELECT price_minor FROM mirror_variant WHERE product_id = ?", coatRow.id);
  assert.equal(variants.length, 3, "the blazer's own three sizes landed as three variations on ONE product");
});

check("test_PRD_P0_152_style_number_grouping__a_description_column_standing_in_for_a_missing_title_is_never_also_sent_as_the_description", async () => {
  /* "You are getting the title of the items, the title, right? Not the
     descriptions. The descriptions will generate automatically later" --
     the owner's own words. Description text used as a title stand-in must
     not ALSO become the product's own description -- that would just be
     the same string twice. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,30,165\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created[0].title, "Black hand-painted blazer");

  const product = f.mirror("SELECT source_description FROM mirror_product WHERE title = 'Black hand-painted blazer'")[0];
  assert.ok(!product.source_description, "no description at all -- the title stand-in is never duplicated into it");
});

check("test_PRD_P0_152_style_number_grouping__a_real_title_column_still_keeps_its_own_separate_description", async () => {
  /* The REVISED rule above only changes the "no title column" case -- a
     sheet that gives BOTH a real title and its own description keeps
     sending both, exactly as it always has. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Title,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Bomber Blazer,Jacket,Blazer,A hand-painted piece,Black,S,30,165\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created[0].title, "Bomber Blazer");

  const product = f.mirror("SELECT source_description FROM mirror_product WHERE title = 'Bomber Blazer'")[0];
  assert.equal(product.source_description, "A hand-painted piece");
});

check("test_PRD_P0_152_style_number_grouping__with_no_sku_column_the_rows_own_full_style_number_becomes_its_sku", async () => {
  /* "For our full SKU number, we can go with the shorter names... the SKU
     is basically what we gave you in the first column. That's the SKU" --
     the owner's own words. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,30,165\n" +
    "001-001-001-BLK-M,Jacket,Blazer,Black hand-painted blazer,Black,M,30,165\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Black hand-painted blazer'")[0];
  const skus = f
    .mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)
    .map((v) => v.sku)
    .sort();
  assert.deepEqual(skus, ["001-001-001-BLK-M", "001-001-001-BLK-S"], "each variation's own SKU is that exact row's own full style number");
});

check("test_PRD_P0_152_style_number_grouping__an_explicit_sku_column_still_wins_over_the_style_number", async () => {
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,SKU,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,VEM-100,30,165\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Black hand-painted blazer'")[0];
  const variant = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0];
  assert.equal(variant.sku, "VEM-100");
});

check("test_PRD_P0_152_style_number_grouping__a_tbd_color_or_size_is_dropped_as_a_real_option_entirely", async () => {
  /* "Any time you see TBD, just use like a default or no option... it's
     just one of a kind, it's just one off. It doesn't need an option.
     That's the only one we have" -- the owner's own words. Three rows
     differing only by SIZE, all sharing color "TBD" -- Size alone is
     still a real, meaningful option; "Color: TBD" is not. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
    "001-001-003-TBD-S,Jacket,Blazer,Embellished blazer,TBD,S,35,125\n" +
    "001-001-003-TBD-M,Jacket,Blazer,Embellished blazer,TBD,M,35,125\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const colorObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Color");
  const sizeObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Size");
  assert.equal(colorObj, undefined, "TBD is never minted as a real Color option");
  assert.ok(sizeObj, "Size alone is still a real, meaningful option");
  assert.deepEqual(
    sizeObj.item_option_data.values.map((v) => v.item_option_value_data.name).sort(),
    ["M", "S"],
  );
});
