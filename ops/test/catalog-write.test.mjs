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
import { createSquareCatalogWriter } from "../src/tools/catalog-writer.js";
import {
  createMediaStore,
  createSquareMediaStore,
  mediaKey,
  mintUploadTicket,
  verifyUploadTicket,
} from "../src/tools/media.js";
import { nearestCategory, suggestCategory, validateProposal } from "../src/tools/catalog-write.js";

/* mcp.js is the one import here that reaches skills.js, which reads
   SKILL.md files — nothing else in this file needed the text-module loader
   before, so it is registered here rather than assumed, and the import is
   dynamic because a static one is resolved before this line ever runs. */
register("../../shared/test/text-modules.mjs", import.meta.url);
const { approvePending, parkForApproval } = await import("../src/mcp.js");

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
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

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
function fakeSquare(seed = SEED) {
  const objects = new Map(seed.map((o) => [o.id, structuredClone(o)]));
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
      return jsonRes({ objects: [...objects.values()], related_objects: [] });
    }

    if (p === "/v2/catalog/object") {
      const body = JSON.parse(init.body);
      record.body = body;
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
      assign(obj, obj.type === "CATEGORY" ? "CAT" : "ITEM");
      for (const v of obj.item_data?.variations ?? []) {
        assign(v, "VAR");
        v.item_variation_data.item_id = obj.id;
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

    return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }, 404);
  };

  impl.calls = calls;
  impl.objects = objects;
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
async function fixture({ actor = "mara@vemians.com", role = "manager", seedMirror = true } = {}) {
  const square = fakeSquare();
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
    mirror: (sql) => mirrorDb._raw.prepare(sql).all(),
    categories: () => mirrorDb._raw.prepare("SELECT id, name FROM mirror_category_index ORDER BY name").all(),
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
    assert.deepEqual(Object.keys(c).sort(), ["id", "name"]);
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

  /* THE ORDERING. Upsert, image, then the search that refreshes our copy. */
  const paths = f.calls().map((c) => c.path);
  assert.deepEqual(paths, ["/v2/catalog/object", "/v2/catalog/images", "/v2/catalog/search"]);

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

check("test_PRD_P0_37_mirror_is_ours__no_authoring_tool_writes_a_catalog_row_directly", async () => {
  /*
   * The structural half of "Square is the write target". Two writers into one
   * copy — the till's sync and ours — diverge silently, so the ops tool layer
   * contains no INSERT or UPDATE against a mirror table at all. The only writer
   * is shared/commerce/square/mirror.js, reading back what Square now says.
   */
  const offenders = [];
  for (const file of fs.readdirSync(TOOLS_DIR).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(TOOLS_DIR, file), "utf8");
    for (const m of src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+mirror_\w+/gi)) {
      offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "an agent tool must not write the mirror; it writes Square");

  /* And the mirror schema itself refuses deletion, whatever anyone writes. */
  const f = await fixture();
  assert.throws(
    () => f.mirrorDb._raw.exec("DELETE FROM mirror_product"),
    /archive-only/,
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
  assert.deepEqual(paths, ["/v2/catalog/object", "/v2/catalog/search"]);

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
    ["/v2/catalog/object", "/v2/catalog/search"],
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
  assert.deepEqual(RESOURCES, ["square", "media"]);
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
  assert.ok(!forStaff.includes("catalog.create_product"));
  assert.ok(!forStaff.includes("catalog.update_product"));
  assert.ok(!forStaff.includes("catalog.create_category"));

  for (const name of ["catalog.create_product", "catalog.update_product", "catalog.create_category"]) {
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
