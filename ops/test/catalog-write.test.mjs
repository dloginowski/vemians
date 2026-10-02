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
import { createRateLimiter, rateLimiter as sharedRateLimiter } from "../src/tools/rate.js";
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
import { normaliseCatalog } from "../../shared/commerce/square/catalog.js";

/* index.js (imported further down for the real-Worker checks) reaches
   agent.js, which reaches skills.js, which reads SKILL.md files — so the
   text-module loader is registered here, before any of those imports run. */
register("../../shared/test/text-modules.mjs", import.meta.url);
const { approvePending, parkForApproval } = await import("../src/approvals.js");
const { draftProductBatch } = await import("../src/batch.js");
const { dispatch, agentTurn, approve, NO_TEXT_TABLE_NOTE, readBatchProgress, startBatchRun, submitBatchPlanRow, openBatchPlanFor, cancelBatchPlan } = await import("../src/agent.js");
const http = await import("node:http");

/*
 * A fake Anthropic, the same technique test/agent-tool-wire-names.test.mjs
 * already proved out — the only way to reach the real, PRIVATE PENDING map
 * (stashPending/PENDING are not exported) is to drive a real agentTurn()
 * tool-use round-trip and read back the `pending.id` it hands the client.
 */
function fakeAnthropic(handleRequest) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { status, response } = handleRequest(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function withFakeAnthropic(handleRequest, fn) {
  const server = await fakeAnthropic(handleRequest);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/*
 * "I need to be able to click yes or no" — drives the exact path a click
 * on the chat card's own Approve button takes: a scripted model turn that
 * calls the batch-draft meta-tool once (mints a real PENDING record), then
 * approve() against that record's own id, never against re-typed args.
 * REVISED — customer_draft_customer_batch only, now: catalog_draft_product_
 * batch no longer stops for a separate approval at all (see
 * draftProductBatchViaChat, immediately below, for that one).
 *
 * `square`, when given, is spliced in as the fetch a real draft would use to
 * reach Square — routed alongside, not instead of, the real fetch the fake
 * Anthropic HTTP server itself needs, since both are live during this call.
 */
async function draftBatchViaChatButton(name, args, { actor = "mara@vemians.com", env, square = null }) {
  const realFetch = globalThis.fetch;
  if (square) {
    globalThis.fetch = (url, init) => {
      const href = typeof url === "string" ? url : url.url;
      return href.startsWith("http://127.0.0.1") ? realFetch(url, init) : square(url, init);
    };
  }
  try {
    let pendingId = null;
    await withFakeAnthropic(
      () => {
        if (!pendingId) {
          return {
            status: 200,
            response: {
              content: [{ type: "tool_use", id: "toolu_1", name, input: args }],
              stop_reason: "tool_use",
            },
          };
        }
        return { status: 200, response: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } };
      },
      async (base) => {
        const identity = { email: actor, groups: ["vemians-manager"] };
        const out = await agentTurn({
          q: "please ingest the file",
          identity,
          env: { ...env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
        });
        assert.ok(out.pending, "the model's first call must stop for a real approval, not run the draft itself");
        assert.equal(out.pending.tool, name);
        pendingId = out.pending.id;
      },
    );
    return await approve({ id: pendingId, identity: { email: actor, groups: ["vemians-manager"] }, env });
  } finally {
    globalThis.fetch = realFetch;
  }
}

/*
 * REVISED — "I shouldn't need to do that," the owner's own words, looking
 * at the approval card catalog_add_product_batch used to show even after
 * the person had already confirmed the preview mapping in chat. That outer
 * click is gone.
 *
 * REVISED AGAIN — "have the agent check everything and fill everything out
 * and then just do a straight submit... with the progress bar," the
 * owner's own words, and the fix for a real "too many subrequests" report:
 * dispatch() now plans the batch (a `checklist` outcome) rather than
 * creating everything itself, so this drives the REAL two-step path a
 * browser now takes — dispatch() for the plan, then one
 * submitBatchPlanRow call per row it offers back, exactly as the client's
 * own submit loop does (views.js) — and folds the per-row results back
 * into the same {ok, created, ready, skipped} shape the old, one-call
 * immediate-create path used to return directly, so callers below barely
 * had to change. A sheet with NOTHING left to submit (every row already a
 * clash or skip at plan time) still returns `kind: "result"` directly,
 * exactly as it always did — that path is unchanged.
 */
/* The HTTP half of one Submit click: POST /agent/batch-start for the rows
   checked, returning the run id every row submission must then carry. */
async function httpStartRun(worker, workerEnv, id, rows) {
  const res = await worker.fetch(
    new Request("http://localhost/agent/batch-start", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER_CLAIMS), "content-type": "application/json" },
      body: JSON.stringify({ id, rows }),
    }),
    workerEnv,
  );
  const text = await res.text();
  assert.equal(res.status, 200, `the run must start, got ${res.status}: ${text}`);
  const data = JSON.parse(text);
  assert.equal(data.ok, true, text);
  return data.runId;
}

/* One Submit click for ONE row of a planned upload: start a run selecting just
   that row, then submit it under that run -- exactly what the browser does,
   for a person who checked a single box. A refused start (the upload is
   finished, belongs to someone else) is returned as-is. */
async function submitRow({ id, row, title, identity, env }) {
  const started = await startBatchRun({ id, rows: [row], identity, env });
  if (!started.ok) return started;
  return submitBatchPlanRow({ id, row, title, runId: started.runId, identity, env });
}

async function draftProductBatchViaChat(name, args, { actor = "mara@vemians.com", role = "manager", env, square = null }) {
  const realFetch = globalThis.fetch;
  if (square) globalThis.fetch = square;
  try {
    const outcome = await dispatch(name, args, { actor, role, env, allowed: new Set([name]) });
    if (outcome.kind === "result") {
      return { ok: !outcome.block.is_error, reply: outcome.block.content, table: outcome.table, checklist: null };
    }
    assert.equal(outcome.kind, "checklist", "catalog_add_product_batch must plan a checklist, never stop for an old-style approval");
    const identity = { email: actor, groups: ["vemians-manager"] };
    const created = [];
    const parked = [];
    const skipped = [];
    /* ONE Submit click for every row the plan offered, as the browser's own
       loop does: one run, every row under it. */
    const started = await startBatchRun({ id: outcome.checklist.id, rows: outcome.checklist.rows.map((r) => r.row), identity, env });
    assert.equal(started.ok, true, `the run must start: ${JSON.stringify(started)}`);
    for (const row of outcome.checklist.rows) {
      const result = await submitBatchPlanRow({ id: outcome.checklist.id, row: row.row, runId: started.runId, identity, env });
      assert.equal(result.ok, true, `row ${row.row} failed to submit: ${JSON.stringify(result)}`);
      if (result.status === "created") created.push(result);
      else if (result.status === "parked") parked.push(result);
      else skipped.push(result);
    }
    /* outcome.table already carries whatever planProductBatch itself parked
       or skipped at PLAN time (a clash, or a row the gate check already
       knew would fail) — folded in here so a caller sees the same complete
       {created, ready, skipped} picture the old one-call path used to
       return directly, regardless of which of the two moments a given
       row's own outcome was actually decided at. */
    const plannedReady = (outcome.table?.rows ?? []).filter((r) => r[2] === "needs a person");
    const plannedSkipped = (outcome.table?.rows ?? []).filter((r) => r[2] === "skipped");
    return {
      ok: true,
      table: outcome.table,
      checklist: outcome.checklist,
      created,
      ready: [...parked, ...plannedReady.map((r) => ({ title: r[1], summary: r[3] }))],
      skipped: [...skipped, ...plannedSkipped.map((r) => ({ title: r[1], reason: r[3] }))],
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}

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
const COMMERCE_SQL = fs.readFileSync(path.join(DB_DIR, "commerce.sql"), "utf8");

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
      /* Square's own rule, which the fake used to accept silently: once an
         item declares item_options, EVERY variation must carry exactly one
         value per option, in the same order. A real production 400 read
         "Expected ItemVariation to have 2 Item Option Values, got 0". */
      if (body.object?.type === "ITEM") {
        const declared = body.object.item_data?.item_options ?? [];
        if (declared.length) {
          for (const v of body.object.item_data?.variations ?? []) {
            const got = v.item_variation_data?.item_option_values ?? [];
            const detail = got.length !== declared.length
              ? `Expected ItemVariation to have ${declared.length} Item Option Values, got ${got.length}`
              : declared.some((d, i) => got[i]?.item_option_id !== d.item_option_id)
                ? "Expected ItemVariation to have Item Option at index 0"
                : null;
            if (detail) {
              return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", detail }] }, 400);
            }
          }
        }
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
       inventory.adjust's own run() makes (push, then pull to sync).
       Each push mints its OWN globally unique physical-count id (`mint`,
       the same ever-incrementing counter this fake already uses for every
       other Square-minted id) rather than one synthesized from the
       retrieve call's own array position — a real PHYSICAL_COUNT id is
       unique per EVENT, never replayed, and syncInventoryChanges derives
       its own ledger row's id from exactly this field
       (NS_SQUARE_INVENTORY_CHANGE, mirror.js); a position-based id would
       collide across two separate push/pull round trips on the SAME
       catalog object (a create's own initial stock, then a LATER
       inventory.adjust on that same variant) and the second write would be
       silently dropped as a duplicate of the first. */
    if (p === "/v2/inventory/changes/batch-create") {
      const body = JSON.parse(init.body);
      record.body = body;
      for (const c of body.changes ?? []) {
        if (c.type !== "PHYSICAL_COUNT") continue;
        inventoryCounts.set(c.physical_count.catalog_object_id, { id: mint("PC"), quantity: Number(c.physical_count.quantity) });
      }
      return jsonRes({ counts: [] });
    }
    if (p === "/v2/inventory/changes/batch-retrieve") {
      const body = JSON.parse(init.body);
      record.body = body;
      const ids = body.catalog_object_ids ?? [];
      const changes = ids
        .filter((id) => inventoryCounts.has(id))
        .map((id) => {
          const entry = inventoryCounts.get(id);
          return { type: "PHYSICAL_COUNT", physical_count: { id: entry.id, catalog_object_id: id, quantity: String(entry.quantity) } };
        });
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
    /* OUR OWN internal location key (inventory_adjustment.location_id),
       never Square's own id above -- only load-bearing for a test that asks
       for the `withCommerce` fixture and actually writes to the ledger
       (commerce.test.mjs's own identical squareEnv() already needs this for
       the same reason). */
    LOCATION_ID: "main",
    MEDIA_SIGNING_KEY: SIGNING_KEY,
    OPS_HOST: "ops.vemians.com",
  };
}

/* One place to build a ctx, so no check can accidentally invent an actor. */
async function fixture({ actor = "mara@vemians.com", role = "manager", seedMirror = true, failSearch = false, failUpsert = null, extraSeed = [], withCommerce = false } = {}) {
  const square = fakeSquare([...SEED, ...extraSeed], { failSearch, failUpsert });
  const mirrorDb = d1FromSql(MIRROR_SQL);
  const auditDb = d1FromSql(AUDIT_SQL);
  const commerceDb = withCommerce ? d1FromSql(COMMERCE_SQL) : null;
  const bucket = fakeR2();
  const env = { CATALOG_MIRROR: mirrorDb, AUDIT: auditDb, ...(commerceDb ? { COMMERCE: commerceDb } : {}), ...squareEnv() };

  const writer = createSquareCatalogWriter(squareEnv(), {
    mirrorDb,
    commerceDb,
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
    commerceDb,
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
    onHand: (sku) => {
      const row = commerceDb?._raw.prepare("SELECT on_hand FROM inventory_level WHERE sku = ?").get(sku);
      return row?.on_hand ?? 0;
    },
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
    { title: "IT 38", price_minor: 189000, currency: "USD" },
    { title: "IT 42", price_minor: 189000, currency: "USD" },
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

check("test_PRD_P0_35_approval_never_in_band__the_preview_price_is_dollars_never_raw_minor_units", async () => {
  /* A real report: "I'm seeing wildly high prices for some of these items,
     like $14,000... all prices in queue right now... look like they have
     two extra zeros added to them." Traced to catalog.create_product's own
     check() printing price_minor (cents) straight into its preview summary
     with no division by 100 at all -- $1,890.00 (189000 minor units) read
     as "189000 USD" to anyone reviewing the batch checklist before Submit,
     exactly two zeros too many. The actual price sent to Square was never
     wrong (parsePriceToMinor/moneyToSquare both already treat price_minor
     correctly) -- only this one preview string was. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  const gate = await runTool("catalog.create_product", { ...COAT, category_id: outerwear.id }, f.ctx);
  assert.equal(gate.needsApproval, true);
  assert.match(gate.data.would, /1890\.00 USD/, `expected dollars, got: ${gate.data.would}`);
  assert.doesNotMatch(gate.data.would, /189000/, `raw minor units must never reach the preview: ${gate.data.would}`);
});

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
 * P0-166 — the chat Approve button must spend the SAME token the gate issued
 *
 * "I hit approve and got this: catalog.strip_legacy_cost_fields needs your
 * approval before it runs... did not accept the approval" — looping, for
 * EVERY T2 tool proposed in chat, because approve() (agent.js) invented a
 * fresh crypto.randomUUID() instead of sending back the real token
 * tools/approval.js's own gate had already issued on the model's proposing
 * call. Driven through agentTurn()/approve() exactly the way a real chat
 * click does — never runTool() or the PENDING map directly — because that
 * is precisely the layer the P0-35 bug above (the same shape, on the OTHER,
 * out-of-band approval path) already proved a belief-not-measurement mistake
 * can hide behind.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_166_chat_approve_spends_the_real_token__clicking_approve_actually_creates_the_product", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const args = { ...COAT, category_id: outerwear.id };
  const identity = { email: "mara@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const href = typeof url === "string" ? url : url.url;
    return href.startsWith("http://127.0.0.1") ? realFetch(url, init) : f.square(url, init);
  };

  let pendingId;
  try {
    await withFakeAnthropic(
      () => {
        if (!pendingId) {
          return {
            status: 200,
            response: {
              content: [{ type: "tool_use", id: "toolu_1", name: "catalog.create_product", input: args }],
              stop_reason: "tool_use",
            },
          };
        }
        return { status: 200, response: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } };
      },
      async (base) => {
        const out = await agentTurn({
          q: "please add this coat",
          identity,
          env: { ...f.env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
        });
        assert.ok(out.pending, "a T2 tool proposed in chat must stop for a real approval, not run it");
        assert.equal(out.pending.tool, "catalog.create_product");
        pendingId = out.pending.id;
      },
    );

    const approveEnv = { ...f.env, ANTHROPIC_API_KEY: "test-key" };
    const result = await approve({ id: pendingId, identity, env: approveEnv });

    /* THE BUG: this used to come back needsApproval again, forever — a
       random UUID that tools/approval.js's own store never issued could
       never be consumed, so runTool()'s gate just re-issued a new pending
       approval instead of running anything. Fixed: one real click actually
       runs the write. */
    assert.equal(result.ok, true, `approve() must actually run the write, got: ${JSON.stringify(result)}`);
    assert.notEqual(result.needsApproval, true, "a click that already carries the real token must not loop");
    assert.ok(f.calls().some((c) => c.path === "/v2/catalog/object"), "Square must have seen a real write");

    /* Single use, the same guarantee the OTHER approval path (P0-35) already
       has: a second approve() against the same, now-spent id must not
       silently re-run the write. */
    const second = await approve({ id: pendingId, identity, env: approveEnv });
    assert.notEqual(second.ok, true, "a spent approval id must not run the write twice");
  } finally {
    globalThis.fetch = realFetch;
  }
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
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
  /* REVISED: "the only time you want to do an approval link is if there's
     a clash and it has to be resolved by a person" — the owner's own
     words. A price this file has no safe number to guess is exactly such
     a clash: parked as an ordinary, editable approval (`ready`) with the
     real reason as its own summary, never silently dropped and never a
     bare skip either. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv =
    "title,category,price,style id\n" +
    "Silk Scarf,Outerwear,free,01-01-001\n" +
    "Wool Coat,Outerwear,also-not-a-number,01-01-002\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.ready.length, 2);
  assert.match(result.ready[0].summary, /"free" is not a plain number/);
  assert.match(result.ready[1].summary, /"also-not-a-number" is not a plain number/);
  assert.ok(result.ready[0].url && result.ready[1].url, "each clash is a real, openable approval link");
  /* Rows are 1-based and counted past the header, so a person can find row 2
     in the spreadsheet they actually uploaded. */
  assert.deepEqual(result.ready.map((s) => s.row), [2, 3]);
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
  /* REVISED — every real row now carries a style number (splitProductRecords'
     own header comment), so a brand-new top-level category's own number is
     always the style number's own explicit code now, never an auto-picked
     one — "auto-picking" only ever existed for the standalone (no style
     number) path this shop's own sheets never actually used. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv = "title,category,price,cost,style id\n" + "Sun Hat,Millinery,20.00,10.00,50-01-001\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1, "the row itself proceeds in the SAME upload, no re-upload needed");

  /* "Millinery" -- created under its own plural name, "Millineries":
     catalog.create_category folds every new name to plural before ever
     creating it ("I want to have all categories and subcategories to be
     plurals... never singular" -- the owner's own words). */
  const created = f.categories().find((c) => c.name === "Millineries");
  assert.ok(created, "the missing category must actually have been created, not just proposed");
  assert.equal(created.numeric_id, "50", "given the style number's own explicit code");
});

check("test_PRD_P0_136_square_custom_attributes__several_rows_naming_the_same_missing_category_create_it_only_once", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv =
    "title,category,price,cost,style id\n" +
    "Sun Hat,Millinery,20.00,10.00,50-01-001\n" +
    "Beret,Millinery,25.00,12.00,50-01-002\n" +
    "Beanie,Millinery,15.00,8.00,50-01-003\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 3, "all three rows proceed against the one category created for them");
  assert.equal(f.categories().filter((c) => c.name === "Millineries").length, 1, "created only once, not three times");
});

check("test_PRD_P0_136_square_custom_attributes__two_distinct_missing_categories_in_one_upload_never_collide", async () => {
  /* REVISED — the code itself is explicit (the style number's own first
     segment) now, not auto-picked, so this no longer proves "two distinct
     auto-picked numbers never collide" (nothing is picked any more); it
     proves the shared per-batch bookkeeping (reservedNumericIds/cache)
     lets two DIFFERENT brand-new categories, each with its own explicit
     code, both get created correctly in the same upload without
     interfering with each other. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv = "title,category,price,cost,style id\n" + "Sun Hat,Millinery,20.00,10.00,50-01-001\n" + "Tote,Handbags,40.00,20.00,51-01-001\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2);
  const millinery = f.categories().find((c) => c.name === "Millineries");
  const handbags = f.categories().find((c) => c.name === "Handbags");
  assert.equal(millinery?.numeric_id, "50");
  assert.equal(handbags?.numeric_id, "51");
});

check("test_PRD_P0_136_square_custom_attributes__a_misspelled_named_category_silently_conforms_to_the_real_one", async () => {
  /* REVISED AGAIN — "Outerwear" already exists, already numbered "01".
     "Outerwears" is a typo of it, not a real new category: "if they're
     improperly spelled, do correct the spelling and create the properly
     spelled category" -- but "create" here really means "use the one that
     already exists," since it is not actually missing, just misspelled.
     The sheet's own claimed code ("60") disagrees with Outerwear's real
     number ("01") -- REVISED YET AGAIN, this is no longer a clash either:
     "we already have categories... they do not provide the source of
     truth. We have the source of truth" -- the owner's own words. The
     product lands under Outerwear's own real category, never a new
     duplicate for the sheet's own wrong "60" -- but with no Subcategory
     name column, and no EXISTING subcategory tree-wide already numbered
     "05" to match, there is no real subcategory to file it under, so it
     stays directly in the (top-level) Outerwear, same as a bare category
     with no numeric_id of its own: no style_id at all, never one built
     from the sheet's own unmatched digit (Test-PRD-P0-177-fluid_style_id).
     SKU is unrelated to either: always a real, opaque, auto-generated
     code. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const csv = `title,category,price,cost,style id\nParka,${outerwear.name}s,60.00,30.00,60-05-001\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.ready.length, 0, `expected no clashes, got: ${JSON.stringify(result.ready)}`);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].title, "Parka");

  const row = f.mirror("SELECT category_id, style_id FROM mirror_product WHERE title = 'Parka'")[0];
  assert.equal(row.category_id, outerwear.id, "filed under the real, existing Outerwear, not a new duplicate");
  assert.equal(row.style_id, null, "Outerwear itself is top-level -- no matching subcategory exists, so there is nothing to build a style_id from");
  const sku = f.mirror(
    "SELECT sku FROM mirror_variant WHERE product_id = (SELECT id FROM mirror_product WHERE title = 'Parka')",
  )[0];
  assert.match(sku.sku, /^\d{12}$/, "SKU is always a real, opaque, auto-generated code -- never style_id text");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  /* "OS", not the product title -- no size column at all now defaults to
     the real Size value "OS" (Test-PRD-P0-147-variants_grid, revised),
     rather than leaving the variation with no option at all. */
  assert.match(result.created[0].summary, /OS: 1 in stock/, "no quantity column at all -- defaults to 1, never left blank");
});

check("test_PRD_P0_31_inventory_ledger__a_spreadsheet_quantity_column_is_honored_when_given", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost,quantity\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,12\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.match(result.created[0].summary, /OS: 12 in stock/);
});

check("test_PRD_P0_31_inventory_ledger__a_spreadsheet_quantity_that_does_not_parse_defaults_to_1_instead_of_blocking_the_row", async () => {
  /* REVISED: "the only hard rule here is that we must have a unique SKU
     number or ID for each item... if that's true, then add the product"
     -- an unparseable quantity is no different from a blank one now: it
     defaults to 1, noted rather than reported as a skip. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost,quantity\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,a dozen\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.match(result.created[0].summary, /OS: 1 in stock/);

  const row = f.mirror("SELECT custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.match(JSON.parse(row.custom_fields)["import notes"], /quantity "a dozen".*defaulted to 1/);
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
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
     mistaking style id with title" -- the owner's own words. REVISED
     (Test-PRD-P0-177-fluid_style_id): the style number column is read to
     figure out which category the row belongs to, and to number that
     category ("Outerwear" gets numeric_id "01" from it) -- but the row's
     own style_id is still whatever catalog.create_product's own
     resolveStyleId computes from the resulting category_id, never the
     column's own literal text; with no Subcategory column and no
     subcategory already numbered "04" to match, the product lands
     directly in the (now-numbered, but still top-level) Outerwear, with
     no style_id at all. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = `title,category,price,style #,cost\n,${outerwear.name},450.00,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.notEqual(result.created[0].title, "01-04-001", "the style number must never become the title");
  assert.equal(result.created[0].title, "Outerwear 2", "a blank title still falls through to the auto-generated name");

  const numbered = f.categories().find((c) => c.name === "Outerwear");
  assert.equal(numbered.numeric_id, "01", "the style number column's own leading segment must still number the category");

  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'Outerwear 2'")[0];
  assert.equal(row.style_id, null, "Outerwear is top-level with no matching subcategory -- nothing to build a style_id from");
});

check("test_PRD_P0_145_auto_generated_title__revised_a_row_with_no_style_id_at_all_is_dropped_not_created_unassigned", async () => {
  /* REVISED — this used to be the standalone path's own "no category and
     no style ID" case, auto-titled and created unassigned. The owner's own
     words, having actually seen a row with nothing qualifying it preview
     as a near-empty "product": "if you don't have the qualifying, like the
     style ID, just don't include that row at all... why would you show
     that to me?" There is no more standalone path — a row with no style
     number is not a different KIND of real product, it is the same "not a
     data row" case a garbage style number already was (splitProductRecords'
     own header comment). Never created, never parked, never even reported
     as skipped — it was never a data row to begin with. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv = "title,price,cost\n" + ",300.00,150.00\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0, "no style number at all -- not a real product row");
  assert.equal(result.ready.length, 0);
  assert.equal(result.skipped.length, 0, "dropped silently, not even reported as a skip");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
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

  const result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.ready.length, 1, "a vendor with no commission on file is a real clash, parked for a person, not silently skipped");
  assert.match(result.ready[0].summary, /vendor 'Acme Mills' has no commission on file yet — give one now/);
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_brand_new_vendor_with_no_commission_is_flagged", async () => {
  /* The owner's own words: "I need to specify a commission if I create a
     vendor." "Acme Mills" does not exist anywhere in this fresh fixture, so
     this row would CREATE it — flagged here, before the row is ever parked,
     same treatment the other spreadsheet rules already get. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,vendor\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills\n`;

  const result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.ready.length, 1, "a vendor with no commission on file is a real clash, parked for a person, not silently skipped");
  assert.match(result.ready[0].summary, /vendor 'Acme Mills' has no commission on file yet — give one now/);
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
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

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_commission_that_is_not_a_whole_number_is_dropped_not_blocked", async () => {
  /* REVISED: "the only hard rule here is that we must have a unique SKU
     number or ID for each item... if that's true, then add the product"
     -- a malformed commission no longer blocks the row on its own; it is
     simply left unset, noted. catalog.create_product's own REAL rule --
     a brand-new vendor genuinely has no commission to fall back to --
     still applies underneath it, unchanged, and is relayed verbatim like
     any other tool refusal. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,vendor,commission\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills,twenty\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.ready.length, 1, "the vendor's own real commission clash is parked for a person, not silently skipped");
  assert.match(result.ready[0].summary, /vendor 'Acme Mills' has no commission on file yet/);
});

check("test_PRD_P0_136_square_custom_attributes__a_malformed_commission_still_lets_the_row_through_when_the_vendor_already_has_one_on_file", async () => {
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_vendor (id, external_ref, name, commission_pct) VALUES ('vendor-seed', 'sqvendor-seed', 'Acme Mills', 15)")
    .run();
  const csv =
    "title,category,price,style id,vendor,commission\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills,twenty\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const row = f.mirror("SELECT commission_pct, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.equal(row.commission_pct, 15, "the vendor's own real rate on file, not the malformed row value");
  assert.match(JSON.parse(row.custom_fields)["import notes"], /commission "twenty".*left unset/);
});

check("test_PRD_P0_136_square_custom_attributes__revised_a_row_with_no_style_id_at_all_is_dropped_not_created", async () => {
  /* REVISED YET AGAIN — this test used to prove a row naming a real
     category but no style ID at all still went through (create_product's
     own resolveStyleId tolerates no style_id given). The owner's own
     words, having actually seen what that let through: "if you don't have
     the qualifying, like the style ID, just don't include that row at
     all... why would you show that to me?" There is no more path for a
     no-style-id row to go through at all, category given or not —
     splitProductRecords drops it outright, the same as a garbage style
     number always was. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,cost\n" + `Wool Coat,${outerwear.name},450.00,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0, "no style number at all -- dropped, not a real product row");
  assert.equal(result.ready.length, 0);
  assert.equal(result.skipped.length, 0, "dropped silently, not even reported as a skip");
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_row_with_no_vendor_and_no_unit_cost_is_no_longer_flagged", async () => {
  /* REVISED: "the only hard rule here is that we must have a unique SKU
     number or ID for each item... if that's true, then add the product"
     -- walking back the earlier "if we don't have a vendor name, then we
     must have a cost of goods" block. Neither is something catalog.
     create_product itself has ever actually required; a row with a real
     price and nothing about its cost simply goes through with neither. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id\n" + `Wool Coat,${outerwear.name},450.00,01-04-001\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const row = f.mirror("SELECT commission_pct, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.equal(row.commission_pct, null, "no vendor at all -- nothing to have a commission from");
  assert.equal(JSON.parse(row.custom_fields)["import notes"], undefined, "nothing was actually wrong here, just absent -- no note needed");
});

check("test_PRD_P0_136_square_custom_attributes__a_spreadsheet_row_with_a_style_id_and_unit_cost_but_no_vendor_gets_the_inhouse_vendor", async () => {
  /* REVISED YET AGAIN — "for all items that do not have a vendor, they're
     now considered In-house... cost must always be a built-in attribute we
     serve, not a custom attribute," the owner's own words, rejecting the
     item_unit_cost_minor Custom Attribute this test used to check for. A
     vendor-less row's own cost lands on the real, vendor-tied
     vendor_information.unit_cost_money instead — under the built-in
     "In-house" vendor, resolved automatically since the row names none. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const row = f.mirror("SELECT id, style_id, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  /* The style number's own leading "01" still numbers Outerwear -- but with
     no Subcategory column and no subcategory already numbered "04" to
     match, the product lands directly in the (top-level) Outerwear, with
     no style_id at all (Test-PRD-P0-177-fluid_style_id). Unrelated to the
     vendor/cost behaviour this test actually checks below. */
  assert.equal(row.style_id, null);
  assert.deepEqual(JSON.parse(row.custom_fields), {}, "cost must not land in custom_fields any more");
  const variant = f.mirror(
    "SELECT v.unit_cost_minor, mv.name AS vendor FROM mirror_variant v JOIN mirror_vendor mv ON mv.id = v.vendor_id WHERE v.product_id = ?",
    row.id,
  )[0];
  assert.equal(variant.vendor, "In-house", "no vendor column was given — the built-in vendor resolves automatically");
  assert.equal(variant.unit_cost_minor, 21000, "cost must land on the real vendor-tied Square mechanism instead");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
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
     separately below. "Fabric Note" is a genuinely unknown column.
     REVISED YET AGAIN — "Unit Cost" is no longer an example of a preserved
     custom field either: it now lands on the real vendor-tied Square
     mechanism, under the built-in "In-house" vendor since the row names
     none, the same as any OTHER row with a cost column and no vendor.
     "Fabric Note" alone is what actually has nowhere else to go. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,Style ID,Unit Cost,Fabric Note\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,Boiled wool\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  /* csvRecords() already trims and lowercases every header before this file
     ever sees it — "Fabric Note" arrives here as "fabric note", still
     readable, just not the exact original capitalization. */
  const row = f.mirror("SELECT id, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.deepEqual(JSON.parse(row.custom_fields), { "fabric note": "Boiled wool" });
  const variant = f.mirror("SELECT unit_cost_minor FROM mirror_variant WHERE product_id = ?", row.id)[0];
  assert.equal(variant.unit_cost_minor, 21000);
});

check("test_PRD_P0_70_flexible_spreadsheet_columns__a_margin_column_is_dropped_entirely_not_preserved", async () => {
  /* The one deliberate exception to "preserve all fields" — the owner's
     own words, looking at a real product's own stray "Margin" custom
     field: "we don't need to have a margin... we don't need that." A
     derived number (price minus cost, both already real fields in their
     own right) with nowhere useful to go is genuinely dropped, unlike a
     real cost column (the check right above this one), which still gets a
     real home — never redirected into custom_fields either. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,cost,Margin,Fabric Note\n" +
    `Wool Coat,${outerwear.name},450.00,01-04-001,210.00,53%,Boiled wool\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const row = f.mirror("SELECT id, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.deepEqual(JSON.parse(row.custom_fields), { "fabric note": "Boiled wool" }, "margin must not appear anywhere, not even as a custom field");
  const variant = f.mirror("SELECT unit_cost_minor FROM mirror_variant WHERE product_id = ?", row.id)[0];
  assert.equal(variant.unit_cost_minor, 21000, "the real cost column right next to it must still land on the real mechanism");
});

check("test_PRD_P0_70_flexible_spreadsheet_columns__a_cost_column_is_no_longer_misread_as_the_sale_price", async () => {
  /* The owner's own words: "Every product has a price and a unit cost" —
     two different numbers. "cost" used to be a PRICE synonym, so a sheet
     with its own "Cost" column (what we paid) was silently read as the
     price (what a customer pays) instead of the real "price" column right
     next to it. REVISED — "cost" is preserved as the real, vendor-
     independent unit cost attribute now, never a custom field. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,style id,cost\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,210.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const variant = f.mirror(
    "SELECT price_minor FROM mirror_variant WHERE product_id = (SELECT id FROM mirror_product WHERE title = 'Wool Coat')",
  )[0];
  assert.equal(variant.price_minor, 45000, "the real 'price' column must still win, not 'cost'");

  const row = f.mirror("SELECT id, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.deepEqual(JSON.parse(row.custom_fields), {}, "the 'cost' column must not be discarded into a custom field");
  const unitCost = f.mirror("SELECT unit_cost_minor FROM mirror_variant WHERE product_id = ?", row.id)[0];
  assert.equal(unitCost.unit_cost_minor, 21000, "the 'cost' column must be preserved on the real vendor-tied mechanism");
});

check("test_PRD_P0_70_flexible_spreadsheet_columns__the_preview_shows_extra_columns_the_same_way_it_shows_known_ones", async () => {
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "title,category,price,style id,Season\nWool Coat,Outerwear,450.00,01-04-001,Fall 2026\n", "products", "add");
  assert.equal(preview.sampleRows[0].season, "Fall 2026");

  /* A blank extra column on that row simply has no key at all, the same as
     any known column left blank being pruned by extraFields(), rather than
     surfacing as a column with a raw "undefined" value. */
  const blank = await previewBatch(f.env, "title,category,price,style id,Season\nSilk Scarf,Accessories,90.00,01-05-001,\n", "products", "add");
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

  const result = await draftProductBatch(f.env, { text: csv, actor: "ana@vemians.com", role: "staff" , mode: "add"});
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /requires the manager role/);
});

check("test_PRD_P0_60_spreadsheet_products__more_rows_than_the_cap_is_refused_before_any_row_runs", async () => {
  const f = await fixture();
  const tooMany = CAPS.BATCH_MAX_ROWS + 1;
  const csv = "title,category,price\n" + Array.from({ length: tooMany }, (_, i) => `Item ${i},Outerwear,10.00`).join("\n");

  const result = await draftProductBatch(f.env, { text: csv, actor: f.ctx.actor, role: f.ctx.role , mode: "add"});
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
     name for a category that is already there. "Fashion Accessory" (not the
     bare singular "Accessory") -- catalog.create_category folds every new
     name to plural first, and a bare "Accessory" would fold straight to the
     EXACT existing "Accessories", never reaching the near-duplicate check at
     all. */
  const dup = await runTool(
    "catalog.create_category",
    { name: "Fashion Accessory", reason: "the belt does not fit anywhere" },
    f.ctx,
  );
  assert.equal(dup.ok, false);
  assert.match(dup.error, /overlaps the existing category "Accessories"/);
  assert.match(dup.error, /navigation meaningless/);
  assert.deepEqual(f.calls(), [], "a refused category makes no Square call");

  /* "Knitwear" is a legacy, deliberately-uncountable name, grandfathered in
     unpluralized ("going forward" only, never renamed) -- a fresh
     "knitwear" now folds to "knitwears" first, so it no longer literal-
     matches "Knitwear" exactly, but still resolves as a near-duplicate
     (the same singular-fold scoring), refused the identical way. */
  const exact = await runTool("catalog.create_category", { name: "knitwear", reason: "jumpers" }, f.ctx);
  assert.equal(exact.ok, false);
  assert.match(exact.error, /overlaps the existing category "Knitwear"/);

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
    name: "Sunglasses",
    reason: "we now sell sunglasses",
  });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.data.category.name, "Sunglasses", "already plural -- round-trips to itself unchanged");
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
  const row = f.categories().find((c) => c.name === "Eyewears");
  assert.equal(row.numeric_id, "42", "the mirror actually persists it, not just the tool's own response");
});

check("test_PRD_P0_138_nested_categories__create_category_numeric_id_is_optional", async () => {
  const f = await fixture();
  const made = await approvedCall(f, "catalog.create_category", { name: "Eyewear", reason: "test" });
  assert.equal(made.ok, true, made.error);
  const row = f.categories().find((c) => c.name === "Eyewears");
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
  /* REVISED (Test-PRD-P0-177-fluid_style_id): the mechanism is no longer
     catalog.create_category's own retroactive product REASSIGNMENT (style_id
     never drives category any more) -- it is catalog.set_category_number's
     own resyncStyleIdPrefixes: renumbering a category corrects the style_id
     PREFIX of every product already sitting in it, a real Square write per
     product, keeping each one's own sequence number exactly as it was. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (
    await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })
  ).data.category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "05" });

  const created = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: casual.id });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.data.product.style_id, "01-05-001", "sanity: auto-assigned from Casual's own NN-NN pair");

  const resorted = await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "02" });
  assert.equal(resorted.ok, true, resorted.error);
  assert.equal(resorted.data.style_ids_updated, 1);
  assert.deepEqual(resorted.data.style_id_errors, []);

  /* A real Square write, not just a mirror update. */
  const itemUpsert = f
    .calls()
    .filter((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM" && c.body.object.item_data.name === COAT.title)
    .pop();
  assert.ok(itemUpsert, "the prefix resync must actually write to Square, not just the mirror");
  const styleIdAttr = itemUpsert.body.object.item_data.custom_attribute_values?.style_id;
  assert.equal(styleIdAttr?.string_value, "01-02-001", "the prefix moves to Casual's new '02', the sequence number '001' kept exactly as it was");

  const product = f.mirror(`SELECT style_id, category_id FROM mirror_product WHERE handle = '${created.data.product.handle}'`)[0];
  assert.equal(product.style_id, "01-02-001");
  assert.equal(product.category_id, casual.id, "the resync never moves a product to a different category");
});

check("test_PRD_P0_213_move_subcategory__moving_a_subcategory_reparents_it_in_square_and_corrects_its_products_style_id_prefix", async () => {
  /* "Build the move subcategory control" -- the owner's own words, after
     subcategories created under the wrong parent had no way to be moved. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data.category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "05" });
  const dresses = (await approvedCall(f, "catalog.create_category", { name: "Dresses", reason: "test" })).data.category;
  await approvedCall(f, "catalog.set_category_number", { category_id: dresses.id, numeric_id: "02" });

  const created = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: casual.id });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.data.product.style_id, "01-05-001", "sanity: top-level 01, subcategory 05");

  const moved = await approvedCall(f, "catalog.move_category", { category_id: casual.id, parent_id: dresses.id });
  assert.equal(moved.ok, true, moved.error);
  assert.equal(moved.data.style_ids_updated, 1);
  assert.deepEqual(moved.data.style_id_errors, []);

  /* A real Square write for the category itself. */
  const catUpsert = f.calls().filter((c) => c.path === "/v2/catalog/object" && c.upsert === "CATEGORY").pop();
  assert.ok(catUpsert, "the move must actually write the category to Square");
  const dressesRef = f.mirror("SELECT external_ref FROM mirror_category WHERE id = ?", dresses.id)[0].external_ref;
  assert.equal(catUpsert.body.object.category_data.parent_category.id, dressesRef);
  assert.equal(catUpsert.body.object.category_data.name, "Casuals", "the name is kept");

  const after = f.categories().find((c) => c.id === casual.id);
  assert.equal(after.parent_id, dresses.id, "the mirror shows the new parent");
  assert.equal(after.numeric_id, "05", "the subcategory keeps its own number");

  const product = f.mirror(`SELECT style_id, category_id FROM mirror_product WHERE handle = '${created.data.product.handle}'`)[0];
  assert.equal(product.category_id, casual.id, "the product stays in the subcategory");
  assert.equal(product.style_id, "02-05-001", "its prefix follows the new top-level category, its sequence number untouched");
});

check("test_PRD_P0_213_move_subcategory__the_refusals_a_top_level_category_the_same_parent_a_subcategory_destination_and_a_name_clash", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data.category;
  const inner = (await approvedCall(f, "catalog.create_category", { name: "Inner", parent_id: casual.id, reason: "test" })).data.category;
  const twin = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: knitwear.id, reason: "test" })).data.category;

  const denied = async (args) => {
    const r = await runTool("catalog.move_category", args, f.ctx);
    assert.equal(r.needsApproval, undefined, "refused before any approval is issued");
    return r.denied ?? r.error ?? "";
  };
  assert.match(await denied({ category_id: outerwear.id, parent_id: knitwear.id }), /top-level category/);
  assert.match(await denied({ category_id: casual.id, parent_id: outerwear.id }), /already under/);
  /* "We do not want to have nested subcategories... Do not parent under
     subcategories ever." -- the owner's own words. */
  assert.match(await denied({ category_id: casual.id, parent_id: inner.id }), /is itself a subcategory/);
  assert.match(await denied({ category_id: casual.id, parent_id: casual.id }), /is itself a subcategory/);
  assert.match(await denied({ category_id: inner.id, parent_id: twin.id }), /is itself a subcategory/);
  /* A same-named subcategory at the destination is a MERGE now, not an
     error; this one still has "Inner" under it, so it cannot be merged. */
  assert.match(await denied({ category_id: casual.id, parent_id: knitwear.id }), /cannot be merged into the existing/);
  assert.match(await denied({ category_id: casual.id, parent_id: "nope" }), /no category/);
});

async function mergeFixture(extraProducts = 0) {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  await approvedCall(f, "catalog.set_category_number", { category_id: knitwear.id, numeric_id: "02" });
  const mover = (await approvedCall(f, "catalog.create_category", { name: "Denim Jackets", parent_id: outerwear.id, reason: "test" })).data.category;
  await approvedCall(f, "catalog.set_category_number", { category_id: mover.id, numeric_id: "05" });
  const twin = (await approvedCall(f, "catalog.create_category", { name: "Denim Jackets", parent_id: knitwear.id, reason: "test" })).data.category;
  await approvedCall(f, "catalog.set_category_number", { category_id: twin.id, numeric_id: "06" });
  const make = async (title, categoryId) => {
    const r = await approvedCall(f, "catalog.create_product", { ...COAT, title, category_id: categoryId });
    assert.equal(r.ok, true, r.error);
    return r.data.product;
  };
  const existing = await make("Existing Denim", twin.id);
  const moving = [];
  for (let i = 0; i < 1 + extraProducts; i++) moving.push(await make(`Moving Denim ${i + 1}`, mover.id));
  return { f, outerwear, knitwear, mover, twin, existing, moving };
}

check("test_PRD_P0_213_move_subcategory__moving_onto_a_same_named_subcategory_merges_the_two_lists_instead_of_refusing", async () => {
  /* "If I move denim jackets under jackets and it already has denim jackets,
     I want to merge the two lists. I don't want you to give me an error." */
  const { f, knitwear, mover, twin, existing, moving } = await mergeFixture(2);
  assert.equal(moving[0].style_id, "01-05-001", "sanity: before the merge it numbers under Outerwear");
  assert.equal(existing.style_id, "02-06-001");

  const merged = await approvedCall(f, "catalog.move_category", { category_id: mover.id, parent_id: knitwear.id });
  assert.equal(merged.ok, true, merged.error);
  assert.equal(merged.data.merged, true);
  assert.equal(merged.data.merged_products, 3);
  assert.equal(merged.data.remaining, 0);

  const rows = f.mirror("SELECT title, category_id, style_id, import_style_number FROM mirror_product ORDER BY title");
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
  for (const title of ["Existing Denim", "Moving Denim 1", "Moving Denim 2", "Moving Denim 3"]) {
    assert.equal(byTitle[title].category_id, twin.id, `${title} is in the one remaining list`);
  }
  assert.equal(byTitle["Existing Denim"].style_id, "02-06-001", "what was already there keeps its style ID");
  const movedIds = ["Moving Denim 1", "Moving Denim 2", "Moving Denim 3"].map((t) => byTitle[t].style_id).sort();
  assert.deepEqual(movedIds, ["02-06-002", "02-06-003", "02-06-004"], "the merged-in products take the next free numbers, none repeated");

  /* The emptied one is removed from Square. */
  const mine = f.mirror("SELECT external_ref FROM mirror_category WHERE id = ?", mover.id)[0].external_ref;
  assert.ok(f.calls().some((c) => c.method === "DELETE" && c.path.endsWith(mine)), "the emptied subcategory is deleted in Square");
});

check("test_PRD_P0_213_move_subcategory__a_merge_works_in_batches_and_reports_how_many_are_left", async () => {
  /* One Worker request has a Square-call budget, so a merge moves 15 products
     and says how many remain; the page asks again until none do. */
  const { f, knitwear, mover, twin, moving } = await mergeFixture(15);
  assert.equal(moving.length, 16);
  const first = await approvedCall(f, "catalog.move_category", { category_id: mover.id, parent_id: knitwear.id });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.data.merged, false, "not finished: the old subcategory is kept until it is empty");
  assert.equal(first.data.remaining, 1);
  assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product WHERE category_id = ?", mover.id)[0].n, 1);

  const second = await approvedCall(f, "catalog.move_category", { category_id: mover.id, parent_id: knitwear.id });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.data.merged, true);
  assert.equal(second.data.remaining, 0);
  assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product WHERE category_id = ?", twin.id)[0].n, 17);
  const ids = f.mirror("SELECT style_id FROM mirror_product WHERE category_id = ?", twin.id).map((r) => r.style_id);
  assert.equal(new Set(ids).size, ids.length, "no two products ended up with the same style ID");
});

check("test_PRD_P0_138_nested_categories__a_subcategory_match_wins_over_a_top_level_match", async () => {
  /* REVISED (Test-PRD-P0-177-fluid_style_id): style_id never drives category
     assignment any more, so this is now about styleIdCodesFor's own
     preference during AUTO-ASSIGNMENT -- a product actually filed IN a
     numbered subcategory gets its style_id built from that subcategory's
     own NN-NN pair, never treated as if it were sitting in the top-level
     parent instead, even though the parent's own numeric_id is the same
     first segment either way. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const casual = await approvedCall(f, "catalog.create_category", {
    name: "Casual",
    parent_id: outerwear.id,
    reason: "test",
  });
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.data.category.id, numeric_id: "05" });

  const created = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: casual.data.category.id });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.data.product.style_id, "01-05-001", "built from the SUBCATEGORY's own pair, not just the top-level '01' alone");

  const product = f.mirror(`SELECT category_id FROM mirror_product WHERE handle = '${created.data.product.handle}'`)[0];
  assert.equal(product.category_id, casual.data.category.id, "filed in the subcategory actually given, never the top-level parent");
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
  assert.ok(f.categories().some((c) => c.name === "Loungewears"), "refused, so Loungewears must still be there");
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

  /* THE ORDERING. The built-in "In-house" vendor (createProduct's own
     vendorRefOrInHouse, resolved before the item write since a real
     vendor_id must already exist to embed in vendor_information) is
     created first — this coat names none of its own — then upsert, image,
     vendors again (pullCatalog's own always-first sync step,
     Test-PRD-P0-136-square_custom_attributes revised), then the search
     that refreshes our copy. */
  const paths = f.calls().map((c) => c.path);
  assert.deepEqual(paths, [
    "/v2/vendors/create",
    "/v2/catalog/object",
    "/v2/catalog/images",
    "/v2/vendors/search",
    "/v2/catalog/search",
  ]);

  /* And the mirror now holds it, keyed by OUR uuid and OUR handle. */
  const product = f.mirror("SELECT * FROM mirror_product WHERE title = 'Belted gabardine trench coat'");
  assert.equal(product.length, 1);
  assert.equal(product[0].handle, "belted-gabardine-trench-coat");
  assert.match(product[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(res.data.product.handle, product[0].handle);

  const variants = f.mirror(`SELECT * FROM mirror_variant WHERE product_id = '${product[0].id}' ORDER BY ordinal`);
  assert.equal(variants.length, 2);
  assert.deepEqual(variants.map((v) => v.price_minor), [189000, 189000]);
  for (const v of variants) assert.match(v.sku, /^\d{12}$/, "every variation gets a real, opaque, auto-generated sku");
  assert.notEqual(variants[0].sku, variants[1].sku);

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
   * SIX DELIBERATE EXCEPTIONS, allowlisted by name below rather than left
   * to widen this regex's blind spot: catalog.set_channel's own
   * `UPDATE mirror_product SET channel = ...` (Test-PRD-P0-71-product_channel),
   * catalog.set_custom_fields'/catalog.create_product's own
   * `UPDATE mirror_product SET custom_fields = ...`
   * (Test-PRD-P0-89-batch_preview_confirm's custom_fields entry),
   * catalog.create_product's own `UPDATE mirror_product SET
   * import_style_number = ...` (Test-PRD-P0-179-import_style_number_
   * matching), catalog.set_category_number's own `UPDATE mirror_category SET
   * numeric_id = ...` (Test-PRD-P0-138-nested_categories), and
   * catalog.create_product's/catalog.set_square_attributes' own
   * `UPDATE mirror_vendor SET commission_pct = ...`
   * (Test-PRD-P0-138-nested_categories' own vendor-commission-centralization
   * entry). None of `channel`, `custom_fields`, `import_style_number`,
   * `numeric_id` or a VENDOR's own `commission_pct` is a fact Square has
   * any notion of at all — Square does not know our storefront exists, has
   * no field for a fact we invented, has no idea what "01" means to this
   * shop's own style_id nomenclature, has no idea a CSV resubmit needs its
   * own stable key, and has no concept of a resale commission at all — so
   * none has a second writer to diverge from, and mirror.js's own sync
   * deliberately never names any of the five in its UPDATE or INSERT, for
   * exactly this reason (see the comments on all five columns in
   * shared/commerce/square/schema.sql). The SIXTH, catalog.create_custom_
   * field_name's own `INSERT INTO mirror_custom_field_name`, is not even
   * the same shape of exception — mirror_custom_field_name has no Square
   * correlate WHATSOEVER (unlike the other five, each an OURS-only column
   * bolted onto an otherwise Square-mirrored table), so mirror.js's own
   * sync has no row here to ever diverge from in the first place. The
   * assertion below still forbids that same file touching any OTHER
   * mirror column or table.
   *
   * A SEVENTH, a different shape from the rest: catalog-writer.js's own
   * insertVariantImage() `INSERT INTO mirror_image`, behind POST /items/
   * <handle>/photo (index.js) — not an agent tool at all, a direct, human-
   * only route, the same shape as the stock stepper's own /inventory.
   * mirror_image AS A TABLE does have Square-sourced rows (attachImages,
   * above, pushes to Square and lets syncAfterWrite's own incremental pull
   * fill the mirror, same as every other Square-sourced fact) — but THIS
   * insert's own row can never collide with one of those: its external_ref
   * is always synthesized ("ops-upload:<uuid>"), and mirror.js's own sync
   * only ever touches a row by Square's own external_ref (ON CONFLICT(
   * external_ref) DO UPDATE). Square's own catalog-image API has no
   * ITEM_VARIATION-level image at all in this codebase's adapter (images.js
   * only ever attaches to an ITEM) — a variant-tagged photo has nowhere on
   * Square's side to diverge FROM. schema.sql's own comment on
   * mirror_image.variant_id has the full reasoning.
   *
   * An EIGHTH, the same shape as the seventh: catalog-writer.js's own
   * archiveImage() `UPDATE mirror_image SET archived_at = ...`, behind POST
   * /items/<handle>/photo/<id>/delete (index.js) — also a direct, human-only
   * route, not an agent tool. archiveImage() itself refuses outright (never
   * writes at all) unless the row's own external_ref already carries the
   * seventh exception's own "ops-upload:" prefix, so this UPDATE can only
   * ever land on a row the SAME file's own insertVariantImage() created —
   * never a row mirror.js's sync would also touch.
   */
  const offenders = [];
  for (const file of fs.readdirSync(TOOLS_DIR).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(TOOLS_DIR, file), "utf8");
    for (const m of src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+mirror_\w+/gi)) {
      if (file === "catalog-write.js" && /^UPDATE\s+mirror_product$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^UPDATE\s+mirror_category$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^UPDATE\s+mirror_vendor$/i.test(m[0])) continue;
      if (file === "catalog-write.js" && /^INSERT\s+INTO\s+mirror_custom_field_name$/i.test(m[0])) continue;
      if (file === "catalog-writer.js" && /^INSERT\s+INTO\s+mirror_image$/i.test(m[0])) continue;
      if (file === "catalog-writer.js" && /^UPDATE\s+mirror_image$/i.test(m[0])) continue;
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
  assert.ok(
    stmts.length >= 3,
    "catalog.set_channel's, catalog.set_custom_fields'/catalog.create_product's custom_fields, and catalog.create_product's import_style_number UPDATEs have moved or been removed",
  );
  const ALLOWED_DIRECT_COLUMNS = ["channel = ?", "custom_fields = ?", "import_style_number = ?"];
  for (const [, captured] of stmts) {
    assert.ok(
      ALLOWED_DIRECT_COLUMNS.includes(captured.trim()),
      `an UPDATE mirror_product in catalog-write.js touches an unexpected column: ${captured}`,
    );
  }

  /* Same guard, for mirror_category's own OURS-only exception: numeric_id,
     written directly from TWO places (catalog.set_category_number and
     catalog.create_category's own "set it at creation time" convenience)
     — checks every match, not just the first, the same way the
     mirror_product loop above does. */
  const categoryStmts = [...writer.matchAll(/UPDATE mirror_category SET ([\s\S]*?) WHERE/g)];
  assert.ok(categoryStmts.length >= 2, "catalog.set_category_number's and catalog.create_category's own UPDATEs have moved or been removed");
  const ALLOWED_CATEGORY_COLUMNS = ["numeric_id = ?"];
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
     mirror_product's own archive-only trigger does. REVISED
     (Test-PRD-P0-177-fluid_style_id): style_id is never given by hand any
     more, so a ledger row is put there the only way one ever gets there
     now -- auto-assignment through catalog.create_product, given a real,
     numbered subcategory. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (
    await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })
  ).data.category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });
  const created = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: casual.id });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.data.product.style_id, "01-04-001", "sanity: a real row now sits in the ledger");

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
    variations: [{ variant_id: one.id, title: one.title, price_minor: 499000, currency: "USD" }],
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
  /* REVISED (Test-PRD-P0-177-fluid_style_id): catalog.set_square_attributes
     no longer accepts, validates or touches style_id at all -- it is purely
     vendor/vendor_code/unit_cost_minor/commission now. */
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    vendor: "Acme Mills",
    commission: 20,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.vendor, "Acme Mills");
  assert.equal(res.data.commission, 20);
  assert.equal(res.data.authority, "square");

  /* commission stays a Custom Attribute; vendor does NOT — it is Square's
     own Vendor entity now, referenced by vendor_id in vendor_information on
     EVERY variation (Test-PRD-P0-136-square_custom_attributes, revised for
     Retail Plus), not a plain-text custom_attribute_values entry. */
  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  assert.ok(upsert, "must actually call UpsertCatalogObject");
  assert.deepEqual(upsert.body.object.item_data.custom_attribute_values, {
    commission: { key: "commission", type: "STRING", string_value: "20" },
  });
  const variation = upsert.body.object.item_data.variations[0];
  assert.ok(variation.item_variation_data.vendor_information?.[0]?.vendor_id, "vendor_information must be set");

  const product = f.mirror(`SELECT id, commission_pct FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  assert.equal(product.commission_pct, 20);
  const variant = f.mirror(
    `SELECT mv.name AS vendor FROM mirror_variant v JOIN mirror_vendor mv ON mv.id = v.vendor_id WHERE v.product_id = '${product.id}'`,
  )[0];
  assert.equal(variant.vendor, "Acme Mills");
});

check("test_PRD_P0_136_square_custom_attributes__a_style_id_stays_reserved_even_after_the_product_moves_off_it", async () => {
  /* REVISED (Test-PRD-P0-177-fluid_style_id): style_id is never given by
     hand any more, so this now proves the underlying ledger guarantee
     through the real path a style_id is ever assigned by -- category-driven
     auto-assignment. The owner's own words still hold: "we want that style
     number to be held, so that you don't overwrite that style number and
     reuse it for something else." A product MOVED off a style_id (a real
     category change via catalog.update_product) must never let that number
     be reissued to a brand-new product filed in the very same category. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const knitwear = f.categories().find((c) => c.name === "Knitwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (
    await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })
  ).data.category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });

  const first = await approvedCall(f, "catalog.create_product", { ...COAT, category_id: casual.id });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.data.product.style_id, "01-04-001", "sanity: the first product to land in Casual gets 001");

  /* The first product moves OFF Casual entirely -- a real category change,
     the only thing that ever reassigns an existing product's style_id. */
  const moved = await approvedCall(f, "catalog.update_product", {
    handle: first.data.product.handle,
    category_id: knitwear.id,
  });
  assert.equal(moved.ok, true, moved.error);

  /* A brand-new second product, filed in the SAME category Casual (still
     numbered '01-04'), must never be reissued the vacated '01-04-001' --
     nextStyleIdFor's own ledger scan (mirror_style_id_ledger, not the
     product's own CURRENT style_id column) must skip it. */
  const second = await approvedCall(f, "catalog.create_product", {
    title: "Second Coat",
    category_id: casual.id,
    variations: [{ title: "One size", price_minor: 45000, currency: "USD" }],
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.data.product.style_id, "01-04-002", "the vacated 001 stays reserved forever -- the next product gets 002, never 001");

  const ledgerRows = f.mirror("SELECT style_id FROM mirror_style_id_ledger ORDER BY style_id");
  assert.deepEqual(
    ledgerRows.map((r) => r.style_id),
    ["01-04-001", "01-04-002"],
    "every number ever actually assigned stays ledgered forever, never freed",
  );
});

check("test_PRD_P0_136_square_custom_attributes__giving_only_one_field_leaves_the_others_untouched", async () => {
  const f = await fixture();
  /* REVISED (Test-PRD-P0-177-fluid_style_id): style_id is no longer one of
     this tool's own fields at all, so "the others" now means vendor_code/
     unit_cost_minor -- these must survive a later call that only means to
     swap the vendor itself, never silently carried over as if they still
     described the OLD vendor's own relationship, but never dropped either
     when the call does not mention them. */
  await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    vendor: "Acme Mills",
    vendor_code: "AC-1",
    unit_cost_minor: 5000,
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
  assert.equal(res.data.vendor, "New Vendor");
  assert.equal(res.data.commission, 10, "a vendor actually changing adopts THAT vendor's own on-file rate, never the old vendor's leftover value");
  assert.equal(res.data.vendor_code, "AC-1", "vendor_code must survive a call that only meant to change vendor -- not mentioned, not touched");
  assert.equal(res.data.unit_cost_minor, 5000, "same for unit_cost_minor -- resent whole, never silently dropped");
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

check("test_PRD_P0_136_square_custom_attributes__vendor_code_still_requires_a_vendor", async () => {
  /* vendor_code lives on the SAME real Square Vendor association as vendor
     (Retail Plus/Premium, revised) — it makes no sense without one, the
     same rule commission already gets. unit_cost_minor is DIFFERENT now —
     see the next check. */
  const f = await fixture();
  const codeRes = await runTool(
    "catalog.set_square_attributes",
    { handle: COAT_HANDLE, vendor_code: "ACME-4471" },
    f.ctx,
  );
  assert.equal(codeRes.ok, false);
  assert.match(codeRes.error, /no vendor/);
  assert.deepEqual(f.calls(), [], "the refusal never reaches Square");
});

check("test_PRD_P0_136_square_custom_attributes__unit_cost_no_longer_requires_a_named_vendor", async () => {
  /* REVISED YET AGAIN — "for all items that do not have a vendor, they're
     now considered In-house... cost must always be a built-in attribute,
     not a custom attribute," the owner's own words, rejecting the
     item_unit_cost_minor Custom Attribute this test used to check for.
     unit_cost_minor is still never refused for lack of a NAMED vendor —
     the product already carries the built-in "In-house" one from creation
     (createProduct's own default), so this lands on the real, vendor-tied
     vendor_information exactly like a real vendor's cost would. */
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, unit_cost_minor: 4200 });
  assert.equal(res.ok, true, res.error);

  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  assert.equal(upsert.body.object.item_data.custom_attribute_values?.unit_cost, undefined, "no such Custom Attribute exists any more");
  const vendorInfo = upsert.body.object.item_data.variations[0].item_variation_data.vendor_information[0];
  assert.deepEqual(vendorInfo.unit_cost_money, { amount: 4200, currency: "USD" });

  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  const variant = f.mirror(
    "SELECT v.unit_cost_minor, mv.name AS vendor FROM mirror_variant v JOIN mirror_vendor mv ON mv.id = v.vendor_id WHERE v.product_id = ?",
    product.id,
  )[0];
  assert.equal(variant.vendor, "In-house");
  assert.equal(variant.unit_cost_minor, 4200);
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

check("test_PRD_P0_136_square_custom_attributes__clear_vendor_reassigns_to_the_inhouse_vendor_not_to_none", async () => {
  /* "I don't like adding none to vendors. Let's just make the vendor
     selected vendor toggle so that if I selected a vendor and then I
     selected the same vendor again, it just clears that selection." —
     clear_vendor: true is the tool-layer half of that: the generic
     schema validator refuses an empty "vendor" string outright, so
     clearing needs its own boolean flag, the same shape catalog.
     set_category_number's own clear: true already established. Clearing
     removes vendor_code/unit_cost/commission right along with it — none of
     those apply to "In-house" either — but REVISED YET AGAIN, it lands the
     product back on the built-in "In-house" vendor, never on no vendor at
     all: that is not a state this shop's data can be in any more. */
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
  assert.equal(res.data.vendor, "In-house");
  assert.equal(res.data.vendor_code, null);
  /* 0, not null: mirror_variant.unit_cost_minor is NOT NULL DEFAULT 0 — a
     fresh vendor relationship (Acme Mills -> In-house) never carries the
     old vendor's own cost figure over, so this reads as a real, meaningful
     zero, never a fake "unknown" null. */
  assert.equal(res.data.unit_cost_minor, 0);
  assert.equal(res.data.commission, null);

  /* Square's own UpsertCatalogObject is full-replacement — clearing now
     DOES send real vendor_information for the variation (the "In-house"
     vendor's own vendor_id, no cost), never `undefined` any more, since
     "no vendor at all" is no longer a state to represent. Only calls made
     BY THE CLEAR itself count here — the earlier call above legitimately
     created "Acme Mills" the first time it was ever named, and this one
     legitimately creates "In-house" the first time IT is ever named. */
  const callsDuringClear = f.calls().slice(callsBeforeClear);
  const upsert = callsDuringClear.find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  const variation = upsert.body.object.item_data.variations[0];
  assert.ok(variation.item_variation_data.vendor_information[0].vendor_id, "the In-house vendor's own real Square id");
  assert.equal(variation.item_variation_data.vendor_information[0].unit_cost_money, undefined);
  assert.ok(
    callsDuringClear.some((c) => c.path === "/v2/vendors/create"),
    "the built-in vendor is a real Square Vendor, created on first use exactly like any other name",
  );

  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  const variant = f.mirror(
    "SELECT mv.name AS vendor, v.vendor_code FROM mirror_variant v JOIN mirror_vendor mv ON mv.id = v.vendor_id WHERE v.product_id = ?",
    product.id,
  )[0];
  assert.equal(variant.vendor, "In-house");
  assert.equal(variant.vendor_code, null);
});

check("test_PRD_P0_136_square_custom_attributes__revised_clear_vendor_with_a_fresh_cost_in_the_same_call_applies_that_cost_not_zero", async () => {
  /* REVISED — a real bug, caught live by draftProductUpdate's own fallback
     (batch.js, "make them all in-house and update their costs" -- the
     owner's own words): this SAME tool's own describe text already
     promises "clearing it also... resets unit_cost_minor to 0 UNLESS THIS
     SAME CALL ALSO GIVES A FRESH ONE" — but run() unconditionally forced
     unit_cost_minor to 0 whenever clear_vendor was given, silently
     discarding a unit_cost_minor given in that SAME call. check()'s own
     preview (`gate.data.would`) already computed the right answer — the
     bug was only in what actually got sent to Square — so a caller
     trusting the "would" preview would have seen the correct new cost,
     then watched it silently NOT land. */
  const f = await fixture();
  const res = await approvedCall(f, "catalog.set_square_attributes", {
    handle: COAT_HANDLE,
    clear_vendor: true,
    unit_cost_minor: 4200,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.vendor, "In-house");
  assert.equal(res.data.unit_cost_minor, 4200, "the fresh cost given alongside clear_vendor must win, never the 0 reset");

  const upsert = f.calls().find((c) => c.path === "/v2/catalog/object" && c.upsert === "ITEM");
  const vendorInfo = upsert.body.object.item_data.variations[0].item_variation_data.vendor_information[0];
  assert.deepEqual(vendorInfo.unit_cost_money, { amount: 4200, currency: "USD" }, "Square itself must actually receive the fresh cost");

  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${COAT_HANDLE}'`)[0];
  const variant = f.mirror("SELECT unit_cost_minor FROM mirror_variant WHERE product_id = ?", product.id)[0];
  assert.equal(variant.unit_cost_minor, 4200);
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

check("test_PRD_P0_136_square_custom_attributes__clear_vendor_on_a_legacy_vendorless_product_is_a_real_first_assignment_not_a_no_op", async () => {
  /* REVISED — a product with genuinely no vendor at all is no longer a
     state clear_vendor can find "already there": it is exactly the legacy
     state catalog.assign_inhouse_vendor exists to fix, and clear_vendor
     reaches the same real assignment one product at a time. Only a SECOND
     clear_vendor call, once the product is already on "In-house", is the
     actual no-op. */
  const f = await fixture();
  const first = await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, clear_vendor: true });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.data.vendor, "In-house");

  const callsBeforeSecond = f.calls().length;
  const res = await runTool("catalog.set_square_attributes", { handle: COAT_HANDLE, clear_vendor: true }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /already has those values/);
  assert.equal(f.calls().length, callsBeforeSecond, "the true no-op must never reach Square");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-154 — the "In-house" vendor: no product may have no vendor at all any
 * more, and catalog.assign_inhouse_vendor is the explicit, one-time pass
 * that reaches every product still missing one from before this rule
 * existed.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_154_inhouse_vendor__the_tool_is_registered_manager_only", () => {
  const tool = TOOLS["catalog.assign_inhouse_vendor"];
  assert.ok(tool, "catalog.assign_inhouse_vendor is not registered");
  assert.deepEqual(tool.resources, ["square"]);
  assert.deepEqual(tool.stores, ["catalog_mirror"]);
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");
});

check("test_PRD_P0_154_inhouse_vendor__reassigns_every_vendorless_product_and_is_idempotent", async () => {
  const f = await fixture();
  const before = f.mirror(
    "SELECT mv.name AS vendor FROM mirror_variant v LEFT JOIN mirror_vendor mv ON mv.id = v.vendor_id" +
      " WHERE v.product_id = (SELECT id FROM mirror_product WHERE handle = ?)",
    COAT_HANDLE,
  )[0];
  assert.equal(before.vendor, null, "this coat starts with no vendor at all, from before this rule existed");

  const first = await approvedCall(f, "catalog.assign_inhouse_vendor", { reason: "test" });
  assert.equal(first.ok, true, first.error);
  assert.ok(first.data.products_assigned >= 1, "at least this one vendor-less coat must be reassigned");
  assert.deepEqual(first.data.errors, []);

  const after = f.mirror(
    "SELECT mv.name AS vendor FROM mirror_variant v LEFT JOIN mirror_vendor mv ON mv.id = v.vendor_id" +
      " WHERE v.product_id = (SELECT id FROM mirror_product WHERE handle = ?)",
    COAT_HANDLE,
  )[0];
  assert.equal(after.vendor, "In-house");

  /* Idempotent: a second pass reassigns nothing further (every product
     already has a real vendor, or "In-house") — REVISED: it still touches
     Square once, confirming "In-house" itself is on file, but that call
     is itself idempotent (vendorRefOrInHouse resolves the existing vendor
     rather than creating a second one), so no product is reassigned
     again either way. */
  const second = await approvedCall(f, "catalog.assign_inhouse_vendor", { reason: "test" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.data.products_assigned, 0);
  assert.deepEqual(second.data.errors, []);
});

check("test_PRD_P0_154_inhouse_vendor__the_vendor_itself_is_guaranteed_even_with_nothing_to_reassign", async () => {
  /* A real transcript: "we should have In-house [in the vendor dropdown],
     right?" — asked after every product in a real shop already had a real
     named vendor, so nothing ever exercised the reassignment loop at all,
     and "In-house" had never been created or mirrored. This is the gap:
     a shop with zero vendor-less products must still end up with
     "In-house" on file after running this tool, not only a shop that
     happened to have one to reassign. */
  const f = await fixture();
  await approvedCall(f, "catalog.set_square_attributes", { handle: COAT_HANDLE, vendor: "Acme Mills", commission: 20 });
  const beforeVendors = f.mirror("SELECT name FROM mirror_vendor_index").map((r) => r.name);
  assert.ok(!beforeVendors.includes("In-house"), "In-house must not exist yet in this scenario");

  const res = await approvedCall(f, "catalog.assign_inhouse_vendor", { reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.products_assigned, 0, "Acme Mills is a real vendor -- nothing here needed reassigning");

  const afterVendors = f.mirror("SELECT name FROM mirror_vendor_index").map((r) => r.name);
  assert.ok(afterVendors.includes("In-house"), "In-house must exist and be mirrored even with nothing to reassign");
});

check("test_PRD_P0_154_inhouse_vendor__a_product_whose_square_ordinal_does_not_start_at_zero_is_still_reassigned", async () => {
  /* A real transcript: "I ran assigned vendors, and yes, I see the vendor
     created, but not all items have it automatically assigned. They have
     no vendor still assigned to them." Root cause, found by syncing a
     real, minimal fake Square item through the REAL adapter rather than
     hand-writing a mirror row: this tool's own query (and productByHandle/
     currentVendorInfo, catalog-writer.js) used to find "the product's own
     vendor-bearing variation" by filtering for the LITERAL value
     ordinal = 0 — but Square's own ordinal field is whatever Square
     itself assigned when the variation was created, not a value this
     codebase controls or one Square guarantees is zero-based. A product
     whose one real variation happens to carry ordinal 1 (seeded here
     exactly as Square's own API would return it, never hand-inserted into
     the mirror) matched NOTHING under the old query and was silently
     skipped by every single pass of this tool, no matter how many times
     it ran — the exact "not all items have it automatically assigned"
     reported live. */
  const nonZeroOrdinalItem = {
    type: "ITEM",
    id: "ITEM_OFFSET_ORDINAL",
    version: 1,
    present_at_all_locations: true,
    item_data: {
      name: "Item With a Nonzero Starting Ordinal",
      description: "",
      variations: [
        {
          type: "ITEM_VARIATION",
          id: "VAR_OFFSET_ORDINAL",
          version: 1,
          present_at_all_locations: true,
          item_variation_data: {
            item_id: "ITEM_OFFSET_ORDINAL",
            name: "One size",
            sku: "VEM-OFFSET-1",
            ordinal: 1,
            pricing_type: "FIXED_PRICING",
            price_money: { amount: 12000, currency: "USD" },
            track_inventory: true,
          },
        },
      ],
    },
  };
  const f = await fixture({ extraSeed: [nonZeroOrdinalItem] });
  const before = f.mirror(
    "SELECT ordinal, vendor_id FROM mirror_variant WHERE product_id = (SELECT id FROM mirror_product WHERE handle = 'item-with-a-nonzero-starting-ordinal')",
  )[0];
  assert.equal(before.ordinal, 1, "sanity check: Square's own ordinal for this product's only variation is not 0");
  assert.equal(before.vendor_id, null, "this product starts with no vendor at all, same as any other legacy row");

  const res = await approvedCall(f, "catalog.assign_inhouse_vendor", { reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.errors, []);

  const after = f.mirror(
    "SELECT mv.name AS vendor FROM mirror_variant v LEFT JOIN mirror_vendor mv ON mv.id = v.vendor_id" +
      " WHERE v.product_id = (SELECT id FROM mirror_product WHERE handle = 'item-with-a-nonzero-starting-ordinal')",
  )[0];
  assert.equal(after.vendor, "In-house", "a nonzero-ordinal product must be reassigned exactly like any other vendorless product");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-155 — cleaning up whatever a spreadsheet import left in custom_fields
 * before cost/margin had a real home (or, for margin, before it was
 * dropped outright). A real transcript: "I also want the custom field
 * gone from all the items that we've created, the cost, that cost and
 * the margin or whatever."
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_155_strip_legacy_cost_fields__the_tool_is_registered_manager_only_and_never_calls_square", () => {
  const tool = TOOLS["catalog.strip_legacy_cost_fields"];
  assert.ok(tool, "catalog.strip_legacy_cost_fields is not registered");
  assert.deepEqual(tool.resources ?? [], [], "custom_fields has no Square correlate -- this must never call Square");
  assert.deepEqual(tool.stores, ["catalog_mirror"]);
  assert.equal(tool.tier, "T2");
  assert.equal(tool.minRole, "manager");
});

check("test_PRD_P0_155_strip_legacy_cost_fields__removes_only_the_known_cost_and_margin_spellings", async () => {
  const f = await fixture();
  f.mirror(
    "UPDATE mirror_product SET custom_fields = ? WHERE handle = ?",
    JSON.stringify({ cost: "210.00", "cost usd": "210.00", margin: "53%", "fabric note": "Boiled wool" }),
    COAT_HANDLE,
  );

  const callsBefore = f.calls().length;
  const res = await approvedCall(f, "catalog.strip_legacy_cost_fields", { reason: "test" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.products_cleaned, 1);
  assert.equal(res.data.fields_removed, 3, "cost, cost usd, and margin -- three legacy keys on this one product");
  assert.equal(f.calls().length, callsBefore, "custom_fields has no Square correlate -- this must never reach Square");

  const row = f.mirror("SELECT custom_fields FROM mirror_product WHERE handle = ?", COAT_HANDLE)[0];
  assert.deepEqual(JSON.parse(row.custom_fields), { "fabric note": "Boiled wool" }, "only the legacy keys are gone -- everything else survives untouched");
});

check("test_PRD_P0_155_strip_legacy_cost_fields__a_product_with_none_of_the_legacy_keys_is_left_alone", async () => {
  const f = await fixture();
  f.mirror("UPDATE mirror_product SET custom_fields = ? WHERE handle = ?", JSON.stringify({ "fabric note": "Boiled wool" }), COAT_HANDLE);

  const res = await runTool("catalog.strip_legacy_cost_fields", { reason: "test" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /nothing to strip/);
  assert.deepEqual(f.calls(), []);
});

check("test_PRD_P0_155_strip_legacy_cost_fields__is_idempotent", async () => {
  const f = await fixture();
  f.mirror("UPDATE mirror_product SET custom_fields = ? WHERE handle = ?", JSON.stringify({ cost: "210.00" }), COAT_HANDLE);

  const first = await approvedCall(f, "catalog.strip_legacy_cost_fields", { reason: "test" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.data.products_cleaned, 1);

  const second = await runTool("catalog.strip_legacy_cost_fields", { reason: "test" }, f.ctx);
  assert.equal(second.ok, false);
  assert.match(second.error, /nothing to strip/);
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

check("test_PRD_P0_136_square_custom_attributes__update_product_can_add_a_brand_new_option_bearing_variation", async () => {
  /* "If there is additional options or additional sizes added to the same
     style ID, we're just adding more to the existing item... we're not
     rejecting them, we're adding to them" -- the owner's own words.
     option_values used to be refused outright on catalog.update_product's
     own schema, on the theory that growing an EXISTING product with a
     brand-new size/color was a bigger decision than this tool should make
     silently. mergeVariations (catalog-writer.js) already resolved an
     entry with no variant_id as "add new" and already handled its
     option_values correctly -- the ONLY thing missing was this tool's own
     closed schema accepting the field at all. */
  const f = await fixture();
  const category = f.categories()[0];
  const created = await approvedCall(f, "catalog.create_product", {
    title: "Wool Sweater",
    category_id: category.id,
    variations: [{ title: "Medium", price_minor: 8000, currency: "USD", option_values: { Size: "M" } }],
  });
  assert.equal(created.ok, true, created.error);

  const res = await approvedCall(f, "catalog.update_product", {
    handle: created.data.product.handle,
    variations: [{ title: "Large", price_minor: 8000, currency: "USD", option_values: { Size: "L" } }],
  });
  assert.equal(res.ok, true, res.error);

  const product = f.mirror(`SELECT id FROM mirror_product WHERE handle = '${created.data.product.handle}'`)[0];
  const variants = f.mirror(`SELECT title, options FROM mirror_variant_index WHERE product_id = '${product.id}' ORDER BY ordinal`);
  assert.equal(variants.length, 2, "the original Medium must survive, not be replaced by the new Large");
  assert.deepEqual(
    variants.map((v) => v.title).sort(),
    ["Large", "Medium"],
  );
  const large = variants.find((v) => v.title === "Large");
  assert.deepEqual(JSON.parse(large.options), { Size: "L" }, "the new variation's own Size must actually be assigned, not dropped");
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

check("test_PRD_P0_31_inventory_ledger__creating_a_brand_new_item_with_zero_units_is_refused", async () => {
  /* "Adding an item that has zero units, that's a failure point" -- the
     owner's own words, after a real batch-uploaded product landed with 0
     on hand. A brand-new item is never deliberately listed with nothing to
     sell -- refused here, the same preflight gate a bad price already
     uses, so a batch row like this becomes a clash for a person to review
     rather than a silently created product nobody can actually buy. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool(
    "catalog.create_product",
    { title: "Cotton Robe", category_id: outerwear.id, variations: [{ title: "One size", price_minor: 6000, currency: "USD", quantity: 0 }] },
    { actor: "mara@vemians.com", role: "manager", env: f.env },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /quantity is 0 -- a brand-new item is never created with nothing to sell/);
});

check("test_PRD_P0_31_inventory_ledger__omitting_quantity_entirely_still_defaults_to_one_not_refused", async () => {
  /* The zero-quantity refusal above must never be confused with "quantity
     not given at all" -- "quantity is not required at all... assume 1" is
     unchanged; only an EXPLICIT 0 is refused. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const res = await runTool(
    "catalog.create_product",
    { title: "Cotton Robe", category_id: outerwear.id, variations: [{ title: "One size", price_minor: 6000, currency: "USD" }] },
    { actor: "mara@vemians.com", role: "manager", env: f.env },
  );
  assert.equal(res.needsApproval, true, res.error);
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
  /* The built-in "In-house" vendor (createProduct's own default for a
     product naming none) is resolved before the item write itself — see
     Test-PRD-P0-37-mirror_is_ours' own identical ordering assertion. */
  assert.deepEqual(
    f.calls().map((c) => c.path),
    ["/v2/vendors/create", "/v2/catalog/object", "/v2/vendors/search", "/v2/catalog/search"],
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
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "ana@vemians.com", role: "staff", env: { ASSETS: await assetsFixtureWithRow() }, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /manager or owner/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__refuses_plainly_with_no_assets_store_bound", async () => {
  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env: {}, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /no asset store/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__refuses_plainly_for_an_unknown_asset_id", async () => {
  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "nope" },
    { actor: "mara@vemians.com", role: "manager", env: { ASSETS: await assetsFixtureWithRow() }, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /no asset/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__refuses_plainly_when_the_file_had_no_extractable_text", async () => {
  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: null }) },
      allowed: new Set(["catalog_add_product_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /no readable text/i);
});

check("test_PRD_P0_88_spreadsheet_via_chat__a_real_csv_drafts_through_the_same_path_products_batch_uses", async () => {
  /* THE POINT: the same draftProductBatch() that /products/batch calls
     directly, reached instead through the chat's own tool-call loop — the
     model's own call to catalog_add_product_batch runs it immediately, no
     approval button in between — with the CSV read back from the asset
     store rather than re-typed by the model — a wrong guess on this row
     from the model is not possible, only a wrong guess by the same
     deterministic parser /products/batch itself trusts. */
  const f = await fixture();
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\nSilk Scarf,Outerwear,free,01-04-002,\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await draftProductBatchViaChat(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { env, square: f.square },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.created.length, 1);
  assert.equal(outcome.ready.length, 1);
  assert.equal(outcome.skipped.length, 0);
  assert.match(outcome.created[0].title, /Wool Coat/);
  assert.match(outcome.ready[0].summary || outcome.ready[0].reason, /"free" is not a plain number/i, "the clashed row's own reason must be relayed");
});

check("test_PRD_P0_136_square_custom_attributes__a_missing_category_via_chat_is_created_immediately_too", async () => {
  const f = await fixture();
  const csv = "title,category,price,cost,style id\nSun Hat,Millinery,20.00,10.00,50-01-001\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await draftProductBatchViaChat(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { env, square: f.square },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.created.length, 1, "the row itself is created, in the same upload, once its missing category is created");
  assert.equal(outcome.ready.length, 0);
  assert.equal(outcome.skipped.length, 0);
  assert.match(outcome.created[0].title, /Sun Hat/);
  assert.ok(f.categories().find((c) => c.name === "Millineries"), "the category must actually have been created");
});

check("test_PRD_P0_88_spreadsheet_via_chat__too_many_rows_reports_the_cap_not_a_partial_draft", async () => {
  const f = await fixture();
  const rows = Array.from({ length: CAPS.BATCH_MAX_ROWS + 1 }, (_, i) => `Item ${i},Outerwear,10.00`).join("\n");
  const csv = `title,category,price\n${rows}\n`;
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, new RegExp(`${CAPS.BATCH_MAX_ROWS}-row cap`));
});

check("test_PRD_P0_88_spreadsheet_via_chat__an_unknown_tool_name_still_refuses_before_reaching_any_of_this", async () => {
  /* Second enforcement of the same set (agent.js's own rule, P0-24) — a name
     these meta-tools don't recognise must never reach dispatchBatchDraft at
     all when it was never offered in the first place. */
  const outcome = await dispatch("catalog_add_product_batch", {}, { actor: "mara@vemians.com", role: "manager", env: {}, allowed: new Set() });
  assert.match(outcome.block.content, /No such tool/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-89 — preview a spreadsheet's column mapping before drafting it
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_89_batch_preview_confirm__staff_cannot_call_the_preview_meta_tools_either", async () => {
  const outcome = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "ana@vemians.com", role: "staff", env: { ASSETS: await assetsFixtureWithRow() }, allowed: new Set(["catalog_preview_add_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /manager or owner/i);
});

check("test_PRD_P0_89_batch_preview_confirm__previews_the_first_rows_and_headings_without_minting_anything", async () => {
  const f = await fixture();
  const csv = "title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-001\nAnother Coat,Outerwear,99.00,01-04-002\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_preview_add_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /2 rows detected/);
  assert.match(outcome.block.content, /title, category, price, style id/);
  assert.match(outcome.block.content, /Wool Coat/);
  assert.doesNotMatch(outcome.block.content, /https?:\/\/\S+\/approvals\//, "a preview must mint no approval link");
  assert.deepEqual(f.calls(), [], "a preview must not touch Square at all");

  /* REVISED — "I always wanted to be able to click on the chat preview and
     expand and see the entire column... scroll up and down and just review
     the entire contents" — the owner's own words, correcting the earlier
     one-sample-row reading of "just... one, two rows." The structured table
     now carries every row the sheet was interpreted as (one per product,
     neither of these two rows shares a style number so neither groups with
     the other) — the small, collapsed default view is a CSS choice
     (`compact: true`, checked separately below), not a smaller dataset. */
  assert.deepEqual(outcome.table.columns, ["title", "category", "subcategory", "price", "currency", "description", "sku", "style_id", "variants", "vendor", "vendor_code", "commission", "quantity", "size", "color"]);
  assert.equal(outcome.table.rows.length, 2, "the whole sheet is interpreted, not just a sample of it");
  const titleCol = outcome.table.columns.indexOf("title");
  assert.equal(outcome.table.rows[0][titleCol], "Wool Coat");
  assert.equal(outcome.table.rows[1][titleCol], "Another Coat");

  /* "Instead of using not found, just use the dash... indicate that it's
     not there, it's not available" — the owner's own words, for a genuinely
     blank/unknown field with no real value behind it. `commission` has no
     such value here, so it still gets the plain dash this rule asks for. */
  const commissionCol = outcome.table.columns.indexOf("commission");
  assert.equal(outcome.table.rows[0][commissionCol], "—");
  assert.doesNotMatch(outcome.block.content + JSON.stringify(outcome.table), /not found/i, "the wordier, more alarming phrase must be gone entirely");

  /* REVISED — "shouldn't you be doing an in-house instead of a dash? Since
     if a vendor is not provided, then it must be in-house" — the owner's
     own words, a later, more informed instruction than the plain-dash rule
     above: a blank vendor cell is not "unknown" the way a blank commission
     is, it is a real, resolved fact the moment this row actually creates
     (vendorRefOrInHouse, catalog-writer.js) — so this preview says so
     instead of a dash that would understate the real outcome, the same
     reasoning that already gave sku/style_id their own "(auto-generated)"
     treatment above rather than a bare dash. */
  const vendorCol = outcome.table.columns.indexOf("vendor");
  assert.equal(outcome.table.rows[0][vendorCol], "In-house", "a blank vendor cell really does become In-house at creation, not an unresolved dash");
});

/*
 * P0-186 — a safety check for accidentally-duplicated batch rows
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_186_batch_duplicate_safety_check__two_identical_rows_in_one_upload_flag_the_second_as_a_possible_duplicate", async () => {
  /* "Maybe there are duplicate items... same quantity, same options, same
     variant names, same cost and price, that's a flag... offer to skip it
     ... sometimes maybe somebody might enter the same value twice" — the
     owner's own words. Two different style numbers, but otherwise
     byte-identical rows (title, category, cost, price, quantity, no
     options) — a classic copy-paste mistake, never two genuinely different
     products that happen to share a style-number convention. */
  const f = await fixture({ actor: "wren@vemians.com", role: "manager" });
  const csv =
    "title,category,price,style id,cost,quantity\n" +
    "Wool Coat,Outerwear,450.00,01-04-001,210.00,5\n" +
    "Wool Coat,Outerwear,450.00,01-04-002,210.00,5\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "wren@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.kind, "checklist");
  assert.equal(outcome.checklist.rows.length, 2);
  assert.ok(!outcome.checklist.rows[0].possibleDuplicate, "the first row is the original, never flagged against itself");
  assert.ok(outcome.checklist.rows[1].possibleDuplicate, "the second, identical row must be flagged");
  assert.match(outcome.checklist.rows[1].duplicateReason, /row 2 in this same upload/);
});

check("test_PRD_P0_186_batch_duplicate_safety_check__a_genuinely_different_price_or_quantity_is_never_flagged", async () => {
  const f = await fixture({ actor: "sage@vemians.com", role: "manager" });
  const csv =
    "title,category,price,style id,cost,quantity\n" +
    "Wool Coat,Outerwear,450.00,01-04-001,210.00,5\n" +
    "Wool Coat,Outerwear,399.00,01-04-002,210.00,5\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "sage@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.checklist.rows.length, 2);
  assert.ok(!outcome.checklist.rows[0].possibleDuplicate);
  assert.ok(!outcome.checklist.rows[1].possibleDuplicate, "a genuinely different price must never be flagged as a duplicate");
});

check("test_PRD_P0_186_batch_duplicate_safety_check__re_uploading_the_same_sheet_with_a_style_number_updates_instead_of_flagging", async () => {
  /* REVISED: "I think if we have the system to do style IDs as our main
     differentiator, it should be like one operation... we're just updating
     information if what we're submitting is different than what we have"
     -- the owner's own words, retiring the add/update mode split. A
     resubmit carrying the SAME style number this shop already assigned is
     now caught by the real, authoritative mechanism (import_style_number
     matching, always attempted regardless of which tool ran) before the
     fuzzy duplicate-content check ever gets a chance to merely flag it --
     a strictly better outcome than the old "flag it, still let someone
     accidentally create a duplicate by checking the box" behavior. The
     duplicate-content check below still matters for exactly the case it
     was built for: a resubmit with no reliable style number at all.
     REVISED AGAIN: a real price CHANGE on the resubmit (Test-PRD-P0-194-
     resubmit_no_op_suppression now suppresses a byte-identical one
     entirely, which would leave nothing here to assert against) -- the
     point this test actually proves (a style-number match resolves to a
     real update, never a duplicate create) still needs a checklist row to
     exist at all. */
  const f = await fixture({ actor: "ember@vemians.com", role: "manager" });
  const csv1 = "title,category,price,style id,cost,quantity\nWool Coat,Outerwear,450.00,01-04-001,210.00,5\n";

  const firstEnv = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv1 }) };
  const first = await draftProductBatchViaChat(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "ember@vemians.com", role: "manager", env: firstEnv, square: f.square },
  );
  assert.equal(first.created.length, 1, `expected the first upload to actually create the product: ${JSON.stringify(first)}`);

  const csv2 = "title,category,price,style id,cost,quantity\nWool Coat,Outerwear,475.00,01-04-001,210.00,5\n";
  const secondEnv = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv2 }) };
  const second = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "ember@vemians.com", role: "manager", env: secondEnv, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(second.kind, "checklist");
  assert.equal(second.checklist.rows.length, 1);
  assert.ok(!second.checklist.rows[0].possibleDuplicate, "a style-number match is resolved outright, never left as a mere flag");
  assert.match(second.checklist.rows[0].summary, /^edit /, "the matched row must be an update to the existing product, not a fresh create");
});

check("test_PRD_P0_186_batch_duplicate_safety_check__a_matched_update_is_never_flagged_but_a_genuine_miss_still_is", async () => {
  /* REVISED: this used to prove update mode never flags anything, because
     update mode used to refuse to create at all (a miss was always a
     clash, never a checklist row). That refusal is gone now -- "we're just
     updating information if what we're submitting is different than what
     we have," the owner's own words, retiring the mode split's own
     "update never creates" guarantee. The real invariant worth proving
     now: a row a real style-ID match resolves to an UPDATE is never a
     duplicate candidate (it is a confirmed identity, not a guess) -- but a
     row that genuinely creates something new is STILL eligible for the
     content-based duplicate check, scoped by what the row itself actually
     resolved to (toolName), never by which tool a person happened to call
     the whole batch with. */
  const f = await fixture({ actor: "lark@vemians.com", role: "manager" });

  /* Seeds a real product first, via ADD, the same way any product gets
     into this shop's catalog at all. */
  const seedCsv = "title,category,price,style id,cost,quantity\nWool Coat,Outerwear,450.00,01-04-001,210.00,5\n";
  const seedEnv = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: seedCsv }) };
  const seeded = await draftProductBatchViaChat(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "lark@vemians.com", role: "manager", env: seedEnv, square: f.square },
  );
  assert.equal(seeded.created.length, 1);

  /* A real style-ID match, resubmitted through "update" mode this time --
     never a duplicate flag, a confirmed update. A real price change (never
     the byte-identical seedCsv -- Test-PRD-P0-194-resubmit_no_op_
     suppression now suppresses that into nothing to assert against at
     all), since the point here is proving a MATCH resolves to a real
     checklist row, never a duplicate flag. */
  const matchedCsv = "title,category,price,style id,cost,quantity\nWool Coat,Outerwear,475.00,01-04-001,210.00,5\n";
  const matchedEnv = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: matchedCsv }) };
  const matched = await dispatch(
    "catalog_update_product_batch",
    { asset_id: "ast_1" },
    { actor: "lark@vemians.com", role: "manager", env: matchedEnv, allowed: new Set(["catalog_update_product_batch"]) },
  );
  assert.equal(matched.checklist.rows.length, 1);
  assert.ok(!matched.checklist.rows[0].possibleDuplicate, "a real style-ID match is a confirmed identity, never a mere flag");

  /* A genuine miss through ADD: a DIFFERENT, never-before-seen style
     number (so nothing matches by ID, and the name-based fallback is
     deliberately never attempted for "add" -- see draftGroupedProduct's
     own comment on why), but otherwise identical content -- a real create,
     still eligible for the same content-based duplicate check. */
  const missCsv = "title,category,price,style id,cost,quantity\nWool Coat,Outerwear,450.00,01-04-002,210.00,5\n";
  const missEnv = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: missCsv }) };
  const missed = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "lark@vemians.com", role: "manager", env: missEnv, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(missed.checklist.rows.length, 1, `expected this miss to fall through to a real create, got: ${JSON.stringify(missed)}`);
  assert.ok(missed.checklist.rows[0].possibleDuplicate, "a genuine new create that still matches the catalog by content must be flagged");
});

/* Wraps a d1FromSql-shaped store to count real queries by SQL SHAPE, not
   just a single grand total — category resolution and the per-row
   catalog.create_product gate check (runTool's own check()) legitimately
   run their own queries too, unrelated to flagLikelyDuplicates, so a bare
   total would be noisy. Keying by a recognizable fragment of the SQL text
   isolates exactly the three queries this feature's own helpers run
   (productsInCategory, productsByTitle, variantsWithOptionsOfMany). */
function countingMirror(mirrorDb) {
  const counts = {};
  return {
    prepare: (text) => {
      const inner = mirrorDb.prepare(text);
      return {
        bind: (...args) => {
          inner.bind(...args);
          const tally = () => {
            counts[text] = (counts[text] ?? 0) + 1;
          };
          return {
            all: async () => {
              tally();
              return inner.all();
            },
            first: async (c) => {
              tally();
              return inner.first(c);
            },
            run: async () => {
              tally();
              return inner.run();
            },
          };
        },
      };
    },
    countFor: (predicate) => Object.entries(counts).reduce((sum, [text, n]) => (predicate(text) ? sum + n : sum), 0),
    _raw: mirrorDb._raw,
  };
}

check("test_PRD_P0_186_batch_duplicate_safety_check__the_existing_catalog_check_is_bounded_by_distinct_categories_never_by_row_count", async () => {
  /* THE REAL BUG, caught live, the day this feature shipped: a real 100-row/
     78-product sheet came back "refused catalog_add_product_batch... The
     model service could not be reached" -- a query PER ROW (the original
     shape of this check) reproduces the exact class of failure
     planProductBatch's own header comment already warns about ("why does
     this need the 50 subrequest limit?"), just moved from category
     resolution into THIS check instead. 20 genuinely distinct products (no
     two share a title, price, or style number -- nothing here should ever
     flag as a duplicate) across only 2 real categories must cost roughly
     one query per CATEGORY, never one per PRODUCT. */
  const f = await fixture({ actor: "heron@vemians.com", role: "manager" });
  const lines = ["title,category,price,style id,cost,quantity"];
  for (let i = 1; i < 11; i++) {
    lines.push(`Coat Style ${i},Outerwear,${100 + i}.00,01-01-0${String(i).padStart(2, "0")},10.00,1`);
  }
  for (let i = 1; i < 11; i++) {
    lines.push(`Sweater Style ${i},Knitwear,${200 + i}.00,02-01-0${String(i).padStart(2, "0")},20.00,1`);
  }
  const csv = lines.join("\n") + "\n";

  const mirror = countingMirror(f.mirrorDb);
  const env = { ...f.env, CATALOG_MIRROR: mirror, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "heron@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.kind, "checklist");
  assert.equal(outcome.checklist.rows.length, 20, `expected all 20 genuinely distinct rows ready: ${JSON.stringify(outcome)}`);
  assert.doesNotMatch(JSON.stringify(outcome), /possibleDuplicate":true/, "none of these 20 genuinely distinct products should ever be flagged");

  /* Isolated by SQL shape, not a bare grand total -- category resolution
     and the per-row catalog.create_product gate check legitimately run
     their own queries too, unrelated to this feature. */
  const productsInCategoryCalls = mirror.countFor((t) => t.includes("WHERE p.category_id = ?") && !t.includes("AND LOWER"));
  const productsByTitleCalls = mirror.countFor((t) => t.includes("LOWER(TRIM(p.title)) = LOWER(TRIM(?))") && !t.includes("category_id"));
  const bulkVariantCalls = mirror.countFor((t) => t.includes("mirror_variant_index") && t.includes(" IN ("));
  assert.equal(productsInCategoryCalls, 2, "one query per distinct category (2), never one per row (20)");
  assert.equal(productsByTitleCalls, 0, "every row here has a real category, so the no-category path never runs at all");
  assert.ok(bulkVariantCalls <= 1, "every candidate's variants are fetched in at most one bulk query, never one per candidate");
});

check("test_PRD_P0_89_batch_preview_confirm__the_draft_tool_uses_the_actors_own_most_recently_previewed_asset", async () => {
  /* TWO real chat transcripts showed the model itself cannot be trusted to
     carry the asset id across the turn boundary between a preview and its
     own later confirmation reply -- once by losing it entirely ("refused
     assets.list", "refused catalog_add_product_batch", twice each, then
     "I can't find its asset id right now"), and once more after a first
     attempted fix (tagging the preview's own tool-result text with the id)
     that never actually reached the model's own VISIBLE reply -- that text
     is what the model reads on the same turn, never a chat bubble the
     person sees or `history` stores -- so the model still had nothing to
     read back and gave up again, asking the person to re-attach the file.
     The asset id now survives regardless of what the model itself does
     with it: LAST_PREVIEW (agent.js) records, server-side, which asset THIS
     actor most recently previewed, and the draft tools use THAT rather than
     trusting the model's own asset_id argument. Proven directly: preview
     the real file, then call the draft tool with a deliberately WRONG
     asset_id -- it must still draft the real, previewed file, not fail
     looking up one that was never real. */
  /* A dedicated actor this file uses nowhere else -- dispatch()'s own
     runTool calls share the module-level rate limiter across every test in
     this file (never reset between them), and a heavily-reused actor
     (mara/priya) is already close enough to its own 120-call/60s cap that
     this test's own extra calls would tip other, unrelated tests over it. */
  const f = await fixture({ actor: "yuki@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const ctx = { actor: "yuki@vemians.com", role: "manager", env };

  const preview = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    { ...ctx, allowed: new Set(["catalog_preview_add_product_batch"]) },
  );
  assert.equal(preview.block.is_error, false);

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let outcome;
  try {
    outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_does_not_exist" },
      { ...ctx, allowed: new Set(["catalog_add_product_batch"]) },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(outcome.kind, "checklist", "planned from the actually-previewed file, ignoring the wrong id the call itself carried");
  assert.equal(outcome.checklist.rows.length, 1);
  assert.match(outcome.checklist.rows[0].title, /Wool Coat/);
});

check("test_PRD_P0_183_durable_batch_bookkeeping__the_preview_tool_itself_uses_the_actors_own_most_recently_attached_asset", async () => {
  /* A real transcript, one step EARLIER than P0-89's own identical proof
     just above: attached, asked "is this new stock or an update?" (P0-182's
     own "ask outright if it is not already obvious" instruction), answered
     on the NEXT turn -- and by then the model had lost the asset id
     entirely: "refused assets.list", "refused catalog_preview_add_product_
     batch", "I don't have the actual asset id for that file yet." Every
     earlier fix for this exact class of bug only ever covered the DRAFT
     call surviving to ITS later turn -- this is the very FIRST batch tool
     call on a file, which used to have nothing at all to fall back on.
     agentTurn now records a spreadsheet attachment durably the moment it
     arrives (agent_last_preview, batch_kind 'attached') -- proven directly
     here, the same way P0-89's test proves the draft side: preview must
     resolve to the asset that was actually ATTACHED, even when the call
     itself carries a wrong or missing asset_id. */
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  await env.ASSETS.prepare("INSERT INTO agent_last_preview (actor, batch_kind, asset_id) VALUES (?, 'attached', ?)")
    .bind("yuki@vemians.com", "ast_1")
    .run();

  const outcome = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_does_not_exist" },
    { actor: "yuki@vemians.com", role: "manager", env, allowed: new Set(["catalog_preview_add_product_batch"]) },
  );
  assert.equal(outcome.block.is_error, false, `expected the preview to resolve to the attached asset, got: ${outcome.block.content}`);
  assert.equal(outcome.table.rows.length, 1);
});

check("test_PRD_P0_117_batch_preview_one_row_fits_without_scrolling__the_preview_table_is_marked_compact", async () => {
  /* Compact tables (this one) are what let views.js's tableCard() skip the
     fixed max-height clip entirely — "the height fits all the data" —
     unlike batchDraftTable()'s own potentially-long ready/skipped result,
     which stays plain (uncapped rows, still needs the scroll frame). */
  const f = await fixture();
  const csv = "title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-001\n";
  const outcome = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) },
      allowed: new Set(["catalog_preview_add_product_batch"]),
    },
  );
  assert.equal(outcome.table.compact, true);
});

check("test_PRD_P0_89_batch_preview_confirm__shows_every_interpreted_row_not_just_the_top_one", async () => {
  /* REVISED — "I already need to really see just one — two rows, one for
     the headings and one row of data. I don't need to see three of them,"
     superseded again by "my initial instructions was never followed... I
     always wanted to be able to click on the chat preview and expand and
     see the entire column... scroll up and down and just review the
     entire contents to verify that everything is included" — the owner's
     own words. A sheet with far more rows than fit collapsed must still
     carry every one of them in the structured table (collapsed by CSS,
     not by a smaller dataset) — only the plain-text summary stays short. */
  const f = await fixture();
  const rows = Array.from({ length: 20 }, (_, i) => `Item ${i},Outerwear,${10 + i}.00,01-04-${String(i + 1).padStart(3, "0")}`).join("\n");
  const csv = `title,category,price,style id\n${rows}\n`;
  const outcome = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) },
      allowed: new Set(["catalog_preview_add_product_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /20 rows detected/);
  assert.equal(outcome.table.rows.length, 20, "the complete, expandable table carries every interpreted row");
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

check("test_PRD_P0_89_batch_preview_confirm__customer_draft_still_stops_for_a_real_approval_button", async () => {
  /* UNLIKE catalog_add_product_batch (draftProductBatchViaChat, above):
     a bulk customer import is still its own T2 decision, gated behind a
     real Approve click -- the outer click here is not a redundant second
     yes on top of one already given in chat, it is the only place the
     batch as a whole is ever approved at all. And even once clicked, a
     clean row still never creates immediately, it still mints its own
     separate, individual approval link -- so this one row reads "0
     customers created, 1 need a person's decision" rather than "created". */
  const f = await fixture();
  const csv = "given_name,family_name,email_address\nAva,Stone,ava@example.com\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv, filename: "customers.csv" }) };

  const outcome = await draftBatchViaChatButton("customer_draft_customer_batch", { asset_id: "ast_1" }, { env, square: f.square });
  assert.equal(outcome.ok, true, outcome.reply);
  assert.match(outcome.reply, /0 customers created, 1 need a person's decision, 0 skipped/);
  assert.match(outcome.reply, /Ava/);
});

check("test_PRD_P0_89_batch_preview_confirm__an_empty_spreadsheet_previews_as_nothing_to_show_not_a_crash", async () => {
  const outcome = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: "title,category,price\n" }) },
      allowed: new Set(["catalog_preview_add_product_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /no rows to preview/i);
  assert.equal(outcome.table, null);
});

check("test_PRD_P0_89_batch_preview_confirm__rows_that_all_fail_to_group_preview_as_nothing_interpreted_not_a_crash", async () => {
  /* Grouping (splitProductRecords, batch.js) can drop a row outright -- a
     non-blank style-id cell that never parses as one at all -- "if they
     don't have that style ID pattern, then just ignore that." Every raw
     row detected but none of them a real product to interpret is genuinely
     different from an empty sheet (rowCount is still 1 here), and must
     still preview as a plain message rather than crash reading a table
     with nothing in it. */
  const outcome = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    {
      actor: "mara@vemians.com",
      role: "manager",
      env: { ASSETS: await assetsFixtureWithRow({ extracted_text: "title,category,price,style id\n,Outerwear,10.00,not-a-style-number\n" }) },
      allowed: new Set(["catalog_preview_add_product_batch"]),
    },
  );
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /1 row detected, but none of them could be read as a product/i);
  assert.equal(outcome.table, null);
});

check("test_PRD_P0_89_batch_preview_confirm__the_draft_tools_carry_a_structured_table_too", async () => {
  /* Not just the preview — the plan's own result is ALSO structured, since a
     person cannot review forty skip reasons rendered as one text bubble.
     REVISED — catalog_add_product_batch now PLANS rather than creating
     (dispatchProductBatchPlan, agent.js): a row still needing a person's
     decision at plan time (Silk Scarf's unparseable price, a clash
     batch.js itself already found) is in the checklist reply's own
     `table`, same shape as before; a row that is genuinely ready
     (Wool Coat) is in `checklist.rows` instead — nothing to put in a
     "created" table row until it is actually submitted. */
  const f = await fixture();
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\nSilk Scarf,Outerwear,free,01-04-002,\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await draftProductBatchViaChat(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { env, square: f.square },
  );
  assert.equal(outcome.checklist.rows.length, 1);
  assert.match(outcome.checklist.rows[0].title, /Wool Coat/);
  assert.equal(outcome.table.columns.length, 4);
  assert.equal(outcome.table.rows.length, 1);
  assert.equal(outcome.table.tall, true, "a batch result table must not be stuck at the plain, one-row-tall cap (\"I can't see shit, it's collapsed!!\")");
  const needsPerson = outcome.table.rows.find((r) => r[2] === "needs a person");
  assert.match(needsPerson[3], /"free" is not a plain number/i);
  /* And once actually submitted (the helper already ran every checklist row
     through submitBatchPlanRow), Wool Coat really was created. */
  assert.equal(outcome.created.length, 1);
  assert.match(outcome.created[0].title, /Wool Coat/);
});

check("test_PRD_P0_89_batch_preview_confirm__too_many_rows_carries_no_table_only_the_cap_message", async () => {
  const f = await fixture();
  const rows = Array.from({ length: CAPS.BATCH_MAX_ROWS + 1 }, (_, i) => `Item ${i},Outerwear,10.00`).join("\n");
  const csv = `title,category,price\n${rows}\n`;
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "mara@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
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

/* ─────────────────────────────────────────────────────────────────────────
 * P0-185 — a real production error, caught live: "Expected ItemVariation to
 * have Item Option at index 0 with ID '...', got '...'." `mirror_item_
 * option.name` carries no UNIQUE constraint (schema.sql's own comment) --
 * this shop's real Square account genuinely has more than one ITEM_OPTION
 * sharing the same name ("Color"), a plausible leftover from before
 * Test-PRD-P0-178 removed category-level Option Set assignment.
 * `ensureItemOptionValue`'s own plain `WHERE name = ?` picked an arbitrary
 * one of them for a variation being resent on update, which could -- and,
 * live, did -- disagree with the ONE this specific product's own
 * `item_options` already declares to Square (a real, synced fact,
 * `mirror_product_item_option`), producing exactly this Square refusal on
 * every future edit to that product, including the auto-in-house-vendor
 * assignment (draftProductUpdate, batch.js) a resubmit's own cost update
 * depends on.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_185_ambiguous_item_option_name__an_update_resolves_to_the_option_this_product_actually_has_not_an_unrelated_duplicate", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  /* TWO real Square ITEM_OPTION objects, both named "Color" -- the exact
     data-integrity condition schema.sql's own comment says this shop's
     account can be in. OPT_A is a wholly unrelated one that merely happens
     to exist and come first; the product below is wired to OPT_B, never
     OPT_A, matching what a real sync from Square actually recorded. */
  f.mirrorDb._raw.prepare("INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('opt-color-a','SQ_OPT_COLOR_A','Color')").run();
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal) VALUES ('optval-gray-a','SQ_OPTVAL_GRAY_A','opt-color-a','Gray',0)")
    .run();
  f.mirrorDb._raw.prepare("INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('opt-color-b','SQ_OPT_COLOR_B','Color')").run();
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal) VALUES ('optval-gray-b','SQ_OPTVAL_GRAY_B','opt-color-b','Gray',0)")
    .run();

  /* A pre-existing product -- built directly, the way a real sync from
     Square already populated it, rather than through catalog.create_product
     (which would only ever resolve ONE of the two ambiguous options,
     proving nothing about an update disagreeing with what is already on
     file). No vendor at all, the exact legacy shape draftProductUpdate's
     own inline auto-in-house-assignment exists for. */
  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_product (id, external_ref, handle, title, category_id, source_version) VALUES" +
        " ('prod-target','SQ_ITEM_TARGET','winter-coat-target','Winter Coat Target', ?, 5)",
    )
    .run(outerwear.id);
  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, ordinal, price_minor, currency, options, vendor_id, unit_cost_minor, unit_cost_currency)" +
        " VALUES ('var-target','SQ_VAR_TARGET','prod-target','SKU-TARGET','Winter Coat Target',0,10000,'USD','{\"Color\":\"Gray\"}',NULL,0,'USD')",
    )
    .run();
  /* The REAL fact, as if a sync from Square had already recorded it: this
     product's own item_options is OPT_B, never OPT_A. */
  f.mirrorDb._raw.prepare("INSERT INTO mirror_product_item_option (product_id, item_option_id) VALUES ('prod-target','opt-color-b')").run();

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    /* The exact call draftProductUpdate itself makes inline when a resubmit
       tries to set cost on a vendor-less legacy product. */
    const res = await approvedCall(f, "catalog.set_square_attributes", { handle: "winter-coat-target", clear_vendor: true });
    assert.equal(res.ok, true, res.error);
  } finally {
    globalThis.fetch = realFetch;
  }

  const itemWrite = f.calls().find((c) => c.upsert === "ITEM" && c.body.object.id === "SQ_ITEM_TARGET");
  assert.ok(itemWrite, "the product's own ITEM must actually be resent");
  assert.deepEqual(
    itemWrite.body.object.item_data.item_options,
    [{ item_option_id: "SQ_OPT_COLOR_B" }],
    "the item's own declared option must stay the one this product actually has",
  );
  assert.deepEqual(
    itemWrite.body.object.item_data.variations[0].item_variation_data.item_option_values,
    [{ item_option_id: "SQ_OPT_COLOR_B", item_option_value_id: "SQ_OPTVAL_GRAY_B" }],
    "the resent variation must reference the SAME option the item itself just declared, never the unrelated duplicate",
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-185 (REVISED) — the SAME "Expected ItemVariation to have Item Option
 * at index 0..." error, still live after the ambiguous-name fix above,
 * across products spanning entirely unrelated categories (coats, blazers,
 * vests, dress pants) and the SAME two option ids every time — evidence the
 * duplicate-name drift was never the only cause. `mirror_product_item_
 * option` (schema.sql) carries no ordinal column at all, so `currentItem
 * OptionExternalRefs`'s own plain JOIN, with no ORDER BY, returns this
 * product's item-level `item_options` in WHATEVER order SQLite's query
 * planner happens to produce -- entirely unrelated to the order a
 * variation's own `option_values` (JSON round-tripped from Square, one
 * shared shape, `mirror_variant.options`) happens to iterate in.
 * Square's own contract for ItemVariationData.item_option_values is
 * POSITIONAL: index k of a variation's own list must name the SAME
 * item_option as index k of the item's own `item_options` list, not merely
 * one that appears somewhere in it. Two shared Option Sets (Size and
 * Color, the common case across nearly this whole catalog) built by two
 * unrelated processes will only align by accident -- which is exactly why
 * the SAME two ids recur, byte-identical, on every affected product: this
 * shop's whole catalog shares the one Size option and the one Color
 * option, so every product hits the identical ordering mismatch.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_185_ambiguous_item_option_name__variation_option_values_stay_index_aligned_with_the_items_own_option_order", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  /* Size and Color, each unambiguous on its own (a single row per name --
     this is NOT the duplicate-name condition P0-185's first test covers).
     Inserted SIZE FIRST, so a plain, unordered JOIN returns
     [SQ_OPT_SIZE, SQ_OPT_COLOR] for this product's own item-level list. */
  f.mirrorDb._raw.prepare("INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('opt-size','SQ_OPT_SIZE','Size')").run();
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal) VALUES ('optval-m','SQ_OPTVAL_M','opt-size','M',0)")
    .run();
  f.mirrorDb._raw.prepare("INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('opt-color','SQ_OPT_COLOR','Color')").run();
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal) VALUES ('optval-gray','SQ_OPTVAL_GRAY','opt-color','Gray',0)")
    .run();

  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_product (id, external_ref, handle, title, category_id, source_version) VALUES" +
        " ('prod-target','SQ_ITEM_TARGET','blazer-target','Blazer Target', ?, 5)",
    )
    .run(outerwear.id);
  /* Square's own order for THIS variation's item_option_values, as a real
     sync would have recorded it -- Size first, Color second. mirror_
     product_item_option's own PRIMARY KEY is (product_id, item_option_id),
     so a plain, unordered JOIN against it comes back sorted by
     item_option_id, an opaque internal id with no relation to either
     option's own name or Square's real declared order -- here, "opt-color"
     sorts before "opt-size" lexicographically, the OPPOSITE of this
     variation's own order below. mirror_variant.options is a plain JSON
     object; key order round-trips through JSON.parse exactly as written,
     the same as Object.entries would read it back. */
  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, ordinal, price_minor, currency, options, vendor_id, unit_cost_minor, unit_cost_currency)" +
        " VALUES ('var-target','SQ_VAR_TARGET','prod-target','SKU-TARGET','Blazer Target',0,10000,'USD','{\"Size\":\"M\",\"Color\":\"Gray\"}',NULL,0,'USD')",
    )
    .run();
  f.mirrorDb._raw.prepare("INSERT INTO mirror_product_item_option (product_id, item_option_id) VALUES ('prod-target','opt-size')").run();
  f.mirrorDb._raw.prepare("INSERT INTO mirror_product_item_option (product_id, item_option_id) VALUES ('prod-target','opt-color')").run();

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const res = await approvedCall(f, "catalog.set_square_attributes", { handle: "blazer-target", clear_vendor: true });
    assert.equal(res.ok, true, res.error);
  } finally {
    globalThis.fetch = realFetch;
  }

  const itemWrite = f.calls().find((c) => c.upsert === "ITEM" && c.body.object.id === "SQ_ITEM_TARGET");
  assert.ok(itemWrite, "the product's own ITEM must actually be resent");
  const itemOptions = itemWrite.body.object.item_data.item_options.map((o) => o.item_option_id);
  const variationOptionValues = itemWrite.body.object.item_data.variations[0].item_variation_data.item_option_values;
  assert.equal(variationOptionValues.length, itemOptions.length, "every declared item option needs a value on the variation");
  itemOptions.forEach((optionId, i) => {
    assert.equal(
      variationOptionValues[i].item_option_id,
      optionId,
      `index ${i}: the variation's own item_option_values must name the SAME option the item declares at that same index`,
    );
  });
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
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
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
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
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

  /* The style number's own leading "01" still numbers Outerwear -- but with
     no Subcategory column and no subcategory already numbered "04" to
     match, the product lands directly in the (top-level) Outerwear, with
     no style_id at all (Test-PRD-P0-177-fluid_style_id) -- unrelated to
     the color/size extraction this test actually checks above. */
  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.equal(row.style_id, null);
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
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const colorObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Color");
  const sizeObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Size");
  assert.equal(colorObj, undefined, "no Color option must be created -- there was no color segment, not a coincidentally short one");
  assert.ok(sizeObj, "the lone trailing segment must still become a Size option");
  assert.equal(sizeObj.item_option_data.values[0].item_option_value_data.name, "OS");

  /* Same as the full-style-number test just above: no subcategory numbered
     "04" exists, so the product lands unassigned a style_id, in the
     (top-level) Outerwear (Test-PRD-P0-177-fluid_style_id). */
  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'Silk Scarf'")[0];
  assert.equal(row.style_id, null);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-146 (REVISED ONCE MORE) — "all items... should have an option and
 * associated sizes... let's just keep a blanket rule... if we don't
 * specify a size, it's going to be OS" — the owner's own words. "OS" was
 * already reserved (a person could TYPE it, above), but nothing ever
 * applied it as a real DEFAULT when a row named no size at all, by any
 * means (no style-number segment, no explicit Size column).
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_146_dynamic_option_values__no_size_given_at_all_still_defaults_to_a_real_os_option", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  /* A bare 3-segment style number -- no color, no size, not even a
     trailing "OS" typed by hand -- and no Size/Color columns either. */
  const csv = "title,category,price,style id,cost\n" + `Trench Coat,${outerwear.name},135.00,01-04-001,15.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);

  const sizeObj = [...f.square.objects.values()].find((o) => o.type === "ITEM_OPTION" && o.item_option_data?.name === "Size");
  assert.ok(sizeObj, "a row with no size given at all must still get a real Size option, never none at all");
  assert.equal(sizeObj.item_option_data.values[0].item_option_value_data.name, "OS");

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Trench Coat'")[0];
  const variant = f.mirror("SELECT options FROM mirror_variant WHERE product_id = ?", product.id)[0];
  assert.equal(JSON.parse(variant.options).Size, "OS");
});

check("test_PRD_P0_146_dynamic_option_values__a_sizeless_resubmit_still_matches_the_same_now_os_defaulted_variation", async () => {
  /* The exact failure this default could have introduced on its own:
     create with no size (defaults to OS, just above), then resubmit the
     IDENTICAL sheet -- a plain price update -- and confirm it still finds
     and updates the same variation rather than parking as a false
     "not an existing variation" clash now that a real Size value exists
     where none did before. */
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv1 = "title,category,price,style id,cost\n" + `Trench Coat,${outerwear.name},135.00,01-04-002,15.00\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "noor@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1, `expected the first submission to create, got: ${JSON.stringify(first)}`);

    const csv2 = "title,category,price,style id,cost\n" + `Trench Coat,${outerwear.name},150.00,01-04-002,15.00\n`;
    second = await draftProductBatch(f.env, { text: csv2, actor: "noor@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 0, `expected no clashes, got: ${JSON.stringify(second.ready)}`);
  assert.equal(second.created.length, 1);
  assert.equal(second.created[0].action, "updated");

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Trench Coat'")[0];
  const variant = f.mirror("SELECT price_minor, options FROM mirror_variant WHERE product_id = ?", product.id)[0];
  assert.equal(variant.price_minor, 15000, "the resubmit's own new price actually landed");
  assert.equal(JSON.parse(variant.options).Size, "OS", "still the same OS-defaulted variation, not a second one");
});

check("test_PRD_P0_146_dynamic_option_values__a_sizeless_resubmit_still_matches_a_legacy_variant_with_no_size_option_at_all", async () => {
  /* The other half of the same guarantee: a product that predates this
     default entirely -- built directly the way a real sync from Square
     already recorded it, with genuinely EMPTY options, never through
     catalog.create_product (which would always apply the new default) --
     must still resubmit correctly. The raw, undefaulted match is what
     this depends on; without it, every pre-existing sizeless product in
     this shop's real catalog would break the moment this default shipped. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_product (id, external_ref, handle, title, category_id, source_version, import_style_number) VALUES" +
        " ('prod-legacy','SQ_ITEM_LEGACY','trench-coat-legacy','Trench Coat Legacy', ?, 5, '01-04-003')",
    )
    .run(outerwear.id);
  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, ordinal, price_minor, currency, options, vendor_id, unit_cost_minor, unit_cost_currency)" +
        " VALUES ('var-legacy','SQ_VAR_LEGACY','prod-legacy','SKU-LEGACY','Trench Coat Legacy',0,13500,'USD','{}',NULL,1500,'USD')",
    )
    .run();

  const csv = "title,category,price,style id,cost\n" + `Trench Coat Legacy,${outerwear.name},150.00,01-04-003,15.00\n`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.ready.length, 0, `expected no clashes, got: ${JSON.stringify(result.ready)}`);
  assert.equal(result.created.length, 1);
  const variant = f.mirror("SELECT price_minor, options FROM mirror_variant WHERE product_id = 'prod-legacy'")[0];
  assert.equal(variant.price_minor, 15000);
  assert.equal(variant.options, "{}", "the legacy variant's own real, optionless shape must never be invented into a fake Size");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
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
  /* REVISED (Test-PRD-P0-177-fluid_style_id): the preview's own style_id
     column is always the literal "(auto-generated)" now, unconditionally --
     the sheet's own style number still drives the color/size split, just
     never shown back as if IT were the resulting style_id. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-001-BLK-M\n", "products", "add");
  assert.equal(preview.sampleRows[0].style_id, "01-04-001 (from the sheet; the shop ID follows its category)");
  assert.equal(preview.sampleRows[0].color, "BLK");
  assert.equal(preview.sampleRows[0].size, "M");
});

check("test_PRD_P0_206_sheet_style_id_shown__a_row_with_a_style_number_is_never_previewed_as_auto_generated", async () => {
  /* "It's being supplied. It's in the first column. Why is it being
     auto-generated?" A sheet that carries a style number shows it; only a row
     with none at all still reads "(auto-generated)". */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const withId = await previewBatch(f.env, "Style Number,title,category,price\n123-04-007-RED-M,Wool Coat,Outerwear,450.00\n", "products", "add");
  assert.match(withId.sampleRows[0].style_id, /^123-04-007 /);
  assert.doesNotMatch(withId.sampleRows[0].style_id, /auto-generated/);
  const without = await previewBatch(f.env, "title,category,subcategory,price\nWhite Blazer,Jacket,Blazer,175.00\n", "products", "add");
  assert.equal(without.sampleRows[0].style_id, "(auto-generated)");
});

check("test_PRD_P0_146_dynamic_option_values__a_bare_style_id_with_no_suffix_still_derives_no_color_or_size", async () => {
  /* Backward compatibility: every row before this feature existed gave a
     bare NN-NN-NNN with no trailing segment at all -- parseStyleNumber
     must leave it completely alone. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-001\n", "products", "add");
  assert.equal(preview.sampleRows[0].style_id, "01-04-001 (from the sheet; the shop ID follows its category)");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const categories = f.categories();
  const jacket = categories.find((c) => c.name === "Jackets");
  const blazer = categories.find((c) => c.name === "Blazers");
  assert.ok(jacket && !jacket.parent_id, "Jackets must be created as a new TOP-LEVEL category, folded to its plural");
  assert.ok(blazer && blazer.parent_id === jacket.id, "Blazers must be created NESTED under Jackets, folded to its plural too");

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

check("test_PRD_P0_146_dynamic_option_values__a_subcategory_given_with_no_category_lands_unassigned_instead_of_being_refused", async () => {
  /* REVISED: "the only hard rule here is that we must have a unique SKU
     number or ID for each item... if that's true, then add the product"
     -- a subcategory with nowhere to nest under no longer blocks the row
     either; it lands unassigned, the subcategory name preserved as a
     note rather than silently dropped. REVISED AGAIN: every real row now
     carries a style number (splitProductRecords' own header comment) --
     "99" here matches no existing top-level category, and no Category
     name column is given to create one from either, so the row still
     lands genuinely unassigned, through draftGroupedProduct's own
     equivalent note instead of the removed standalone loop's. */
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv = "title,subcategory,price,cost,style id\n" + "Black Blazer,Blazer,165.00,30.00,99-01-001\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const row = f.mirror("SELECT category_id, custom_fields FROM mirror_product WHERE title = 'Black Blazer'")[0];
  assert.equal(row.category_id, null);
  assert.match(JSON.parse(row.custom_fields)["import notes"], /subcategory "Blazer" was given without a resolvable category to nest it under/);
});

check("test_PRD_P0_146_dynamic_option_values__the_same_subcategory_name_under_two_different_categories_creates_two_distinct_rows", async () => {
  /* P0-138's own rule: "a subcategory name can be used more than once [under
     a different parent]. The ID cannot." Two rows naming the SAME
     subcategory NAME under two DIFFERENT categories must create two
     genuinely separate rows, never collide on one shared cache entry.
     Two distinct, brand-new top-level codes (60, 61) so each row's own
     style number resolves to its own real "Jacket"/"Pants" category. */
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv =
    "title,category,subcategory,price,cost,style id\n" +
    "Black Blazer,Jacket,Casual,165.00,30.00,60-01-001\n" +
    "Wool Trousers,Pants,Casual,89.00,20.00,61-01-001\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2);

  const categories = f.categories();
  const jacket = categories.find((c) => c.name === "Jackets");
  const pants = categories.find((c) => c.name === "Pants");
  const casualRows = categories.filter((c) => c.name === "Casuals");
  assert.equal(casualRows.length, 2, "two distinct Casuals rows, one per parent");
  assert.ok(casualRows.some((c) => c.parent_id === jacket.id));
  assert.ok(casualRows.some((c) => c.parent_id === pants.id));
});

check("test_PRD_P0_146_dynamic_option_values__several_rows_naming_the_same_category_and_subcategory_only_create_them_once", async () => {
  /* Both rows share the SAME brand-new top-level code (62 -- "Jacket"), but
     are two genuinely different products (distinct style-number indexes),
     not two variations of one. */
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv =
    "title,category,subcategory,price,cost,style id\n" +
    "Black Blazer,Jacket,Blazer,165.00,30.00,62-01-001\n" +
    "White Blazer,Jacket,Blazer,185.00,45.00,62-01-002\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2);

  const categories = f.categories();
  assert.equal(categories.filter((c) => c.name === "Jackets").length, 1);
  assert.equal(categories.filter((c) => c.name === "Blazers").length, 1);
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
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

  const jacket = f.categories().find((c) => c.name === "Jackets");
  const blazer = f.categories().find((c) => c.name === "Blazers");
  assert.ok(jacket && !jacket.parent_id && jacket.numeric_id === "01");
  assert.ok(blazer && blazer.parent_id === jacket.id, `Blazers must be created and nested under Jackets -- got: ${JSON.stringify(blazer)}`);
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.equal(f.categories().filter((c) => c.name === "Outerwear").length, 1, "no duplicate category created just because the sheet's own name column disagreed");
  assert.equal(f.categories().some((c) => c.name === "Not Outerwear At All"), false, "the mismatched name column is never used when the number already resolves to something real");
});

check("test_PRD_P0_211_number_is_the_truth__a_row_whose_number_and_name_disagree_is_held_and_nothing_is_created_for_it", async () => {
  /* "The name is not as important as the actual number... what I'm afraid of
     is having duplicate items being created under different categories." The
     sheet's "01" is Outerwear's number in this catalog but its Category
     column says Dresses: the row is held for a person (parked on the direct
     path, an unchecked row on the checklist), and no "Dresses" category and
     no "Evening Dresses" subcategory is made under the wrong parent. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const before = f.categories().length;
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, {
      text: "Style #,Category,Subcategory,Description,Price\n01-04-001,Dresses,Evening Dresses,Evening dress,100.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0, "nothing is created for a conflicted row");
  assert.equal(result.ready.length, 1, "it is held for a person");
  assert.match(result.ready[0].summary ?? result.ready[0].reason ?? JSON.stringify(result.ready[0]), /category number 01 is "Outerwear" in the catalog, but the sheet's category says "Dresses"/);
  assert.equal(f.categories().length, before, "no category or subcategory was made under the wrong parent");
  assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product WHERE title = 'Evening dress'")[0].n, 0);
});

check("test_PRD_P0_211_number_is_the_truth__the_conflict_shows_as_an_unchecked_checklist_row_with_the_reason", async () => {
  const csv = "Style Number,Title,Category,Subcategory,Price\n001-004-002,Evening dress,Dresses,Evening Dresses,100.00\n";
  const { f, plan } = await ledgerFixture(csv);
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const planned = await plan();
    assert.equal(planned.kind, "checklist", JSON.stringify(planned));
    const row = planned.checklist.rows[0];
    assert.equal(row.needsConfirmation, true, "held: unchecked by default");
    assert.match(row.confirmReason, /number 01 is "Outerwear" in the catalog, but the sheet's category says "Dresses"/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_211_number_is_the_truth__a_resubmit_moves_an_item_once_the_catalogs_numbering_agrees_with_the_sheet", async () => {
  /* An earlier run filed the item under Jackets. The partner fixes the
     numbering (Dresses is 01, Jackets moves to 03); the same sheet now
     resolves its number to Dresses, the name agrees, and the item is moved
     there, shown as a real change. */
  const csv = "Style Number,Title,Category,Subcategory,Price\n001-004-002,Evening dress,Dresses,Evening Dresses,100.00\n";
  const { f, env, identity, plan } = await ledgerFixture(csv);
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const seed = await draftProductBatch(f.env, {
      text: "Style Number,Title,Category,Subcategory,Price\n001-004-002,Evening dress,Jackets,Evening Dresses,100.00\n",
      actor: "zeynep@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(seed.created.length, 1, JSON.stringify(seed));
    const parentOf = () => {
      const cats = f.categories();
      const row = f.mirror("SELECT category_id FROM mirror_product WHERE title = 'Evening dress'")[0];
      const leaf = cats.find((c) => c.id === row.category_id);
      return cats.find((c) => c.id === leaf.parent_id)?.name;
    };
    assert.equal(parentOf(), "Jackets", "sanity: it starts under the wrong parent");

    /* The partner's numbering fix. */
    const jackets = f.categories().find((c) => !c.parent_id && c.name === "Jackets");
    await approvedCall(f, "catalog.set_category_number", { category_id: jackets.id, numeric_id: "03" });
    const dresses = (await approvedCall(f, "catalog.create_category", { name: "Dresses", reason: "test" })).data.category;
    await approvedCall(f, "catalog.set_category_number", { category_id: dresses.id, numeric_id: "01" });

    const planned = await plan();
    assert.equal(planned.kind, "checklist", JSON.stringify(planned));
    const row = planned.checklist.rows[0];
    assert.notEqual(row.needsConfirmation, true, "number and name agree now, so nothing holds it");
    assert.match(row.changes, /category Jackets › Evening Dresses -> Dresses › Evening Dresses/, "the move is shown as a real change");

    const run = await startBatchRun({ id: planned.checklist.id, rows: [row.row], identity, env });
    const done = await submitBatchPlanRow({ id: planned.checklist.id, row: row.row, runId: run.runId, identity, env });
    assert.equal(done.status, "updated", JSON.stringify(done));
    assert.equal(parentOf(), "Dresses", "filed where the sheet's number and name agree");
    assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product WHERE title = 'Evening dress'")[0].n, 1, "moved, not duplicated");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__two_different_leading_codes_never_produce_a_mismatch_note", async () => {
  /* The clean, correct-sheet case, confirmed unaffected: two genuinely
     different top-level codes each get their own real category, and their
     own, independent "Oversized" subcategory underneath -- no note, no
     collision, exactly as it already worked before this fix. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Price\n" +
    "90-01-001,Dress,Oversized,Oversized Dress,100.00\n" +
    "91-01-001,Pants,Oversized,Oversized Pants,100.00\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager", mode: "add" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 2, `expected both rows to create cleanly, got: ${JSON.stringify(result)}`);

  const categories = f.categories();
  assert.equal(categories.filter((c) => c.name === "Dresses").length, 1);
  assert.equal(categories.filter((c) => c.name === "Pants").length, 1);
  const oversizedUnderDress = categories.find((c) => c.name === "Oversizeds" && c.parent_id === categories.find((p) => p.name === "Dresses").id);
  const oversizedUnderPants = categories.find((c) => c.name === "Oversizeds" && c.parent_id === categories.find((p) => p.name === "Pants").id);
  assert.ok(oversizedUnderDress, "Dress gets its own real Oversized subcategory");
  assert.ok(oversizedUnderPants, "Pants gets its own, SEPARATE real Oversized subcategory -- the two must never collide");
  assert.notEqual(oversizedUnderDress.id, oversizedUnderPants.id);

  for (const title of ["Oversized Dress", "Oversized Pants"]) {
    const row = f.mirror("SELECT custom_fields FROM mirror_product WHERE title = ?", title)[0];
    assert.doesNotMatch(JSON.stringify(row.custom_fields ?? "{}"), /already belongs to/, `${title} must carry no mismatch note at all`);
  }
});

check("test_PRD_P0_152_style_number_grouping__a_number_with_no_match_creates_a_new_category_named_from_the_column", async () => {
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv = "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" + "004-002-002-MLT-OS,Coat,Winter Coat,Winter coat with a polka dot print,Multi,OS,40,295\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const coat = f.categories().find((c) => c.name === "Coats");
  const winterCoat = f.categories().find((c) => c.name === "Winter Coats");
  assert.ok(coat && !coat.parent_id && coat.numeric_id === "04", '"004" normalizes to this shop\'s own two-digit "04" -- the TOP-LEVEL number IS taken from the style number');
  assert.ok(winterCoat && winterCoat.parent_id === coat.id, "Winter Coats must be created and nested under Coats");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);
  assert.equal(f.categories().filter((c) => c.name === "Outerwear").length, 1, "still just the one Outerwear -- now numbered, not duplicated");
  assert.equal(f.categories().find((c) => c.name === "Outerwear").numeric_id, "01");
});

check("test_PRD_P0_152_style_number_grouping__a_name_that_already_has_a_different_number_silently_conforms_to_it", async () => {
  /* REVISED AGAIN — no longer a clash to park: "we already have categories
     and subcategories with their corresponding IDs defined in our
     database... they do not provide the source of truth. We have the
     source of truth, and we must map the incoming spreadsheets to match
     ours" -- the owner's own words. Outerwear is really numbered "05"; the
     sheet's own style number claims "01" instead -- the real "05" wins
     outright, the product filed under the real Outerwear, never a new
     duplicate for the sheet's own wrong "01". With no Subcategory column
     and no subcategory tree-wide already numbered "99" to match, there is
     no real subcategory to build a style_id from, so it stays directly in
     (top-level) Outerwear with none at all (Test-PRD-P0-177-
     fluid_style_id) -- SKU is unrelated either way: always a real, opaque,
     auto-generated code. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "05" });

  const csv = "Style #,Category,Description,Color,Size,Cost (USD),Retail Price\n" + "01-99-001-BLK-M,Outerwear,A coat,Black,M,30,165\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.ready.length, 0, `expected no clashes, got: ${JSON.stringify(result.ready)}`);
  assert.equal(result.created.length, 1);
  assert.equal(f.categories().filter((c) => c.name === "Outerwear").length, 1, "still just the one Outerwear, no duplicate created over the mismatch");

  const row = f.mirror("SELECT category_id, style_id FROM mirror_product WHERE title = 'A coat'")[0];
  assert.equal(row.category_id, outerwear.id);
  assert.equal(row.style_id, null, "Outerwear is top-level with no matching subcategory -- nothing to build a style_id from");
  const sku = f.mirror(
    "SELECT sku FROM mirror_variant WHERE product_id = (SELECT id FROM mirror_product WHERE title = 'A coat')",
  )[0];
  assert.match(sku.sku, /^\d{12}$/, "SKU is always a real, opaque, auto-generated code -- never style_id text");
});

check("test_PRD_P0_152_style_number_grouping__a_near_duplicate_subcategory_name_silently_conforms_to_the_real_one", async () => {
  /* "Blazer" already exists under "Jacket". REVISED AGAIN: a near-identical
     SECOND spelling for a different index is no longer a clash to park at
     all -- "if they're improperly spelled, do correct the spelling and
     create the properly spelled category" -- since one already exists
     under this exact name, "create" really means "use the one that's
     already there." "Casual Blazer"'s own token set is a superset of
     "Blazer"'s (nearestCategory's own subset shortcut), so it conforms to
     the real "Blazer" outright -- no second, confusingly similar
     subcategory is ever created beside it. */
  const f = await fixture({ actor: "sana@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,30,165\n" +
    "001-001-002-WHT-S,Jacket,Casual Blazer,White blazer,White,S,30,175\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "sana@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.ready.length, 0, `expected no clashes, got: ${JSON.stringify(result.ready)}`);
  assert.equal(result.created.length, 2);
  assert.equal(result.created[0].title, "Black hand-painted blazer");
  assert.equal(result.created[1].title, "White blazer");

  const jacket = f.categories().find((c) => c.name === "Jackets");
  const blazer = f.categories().find((c) => c.name === "Blazers" && c.parent_id === jacket.id);
  assert.equal(
    f.categories().filter((c) => c.parent_id === jacket.id).length,
    1,
    "still just the one Blazers subcategory -- no confusingly similar duplicate created beside it",
  );

  const products = f.mirror(
    "SELECT title, category_id FROM mirror_product WHERE title LIKE '%blazer%' COLLATE NOCASE ORDER BY title",
  );
  assert.deepEqual(
    products.map((p) => p.title),
    ["Black hand-painted blazer", "White blazer"],
  );
  assert.ok(
    products.every((p) => p.category_id === blazer.id),
    "both rows filed under the SAME real Blazer subcategory, the second one conformed rather than getting its own",
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-152 (REVISED) — a row with no style number, but naming an EXISTING,
 * already-numbered category and subcategory BY NAME, still becomes a real
 * product: catalog.create_product's own resolveStyleId mints a real
 * style_id from those categories' own real numeric codes, plus the next
 * free index. "We already have categories and subcategories with their
 * corresponding IDs defined in our database... as long as it finds the
 * matching category and subcategory, [it] should be able to generate an ID
 * automatically... the index is just something that it generates on the
 * fly using the next available slot" — the owner's own words.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_152_style_number_grouping__a_row_naming_an_existing_category_and_subcategory_gets_a_real_auto_generated_style_id", async () => {
  /* A dedicated actor ("keiko") this file uses nowhere else -- draftProductBatch's
     own runTool calls share the module-level rate limiter across every test in this
     file (never reset between them), and a heavily-reused actor (mara/priya) is
     already close enough to its own 120-call/60s cap that this test's own extra
     calls would tip other, unrelated tests over it. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let seed, result;
  try {
    /* Seed a real, numbered "Jacket"/"Blazer" pair the ordinary
       style-numbered way first — this new path never creates a category,
       only looks one up. A Subcategory NAME column resolves by name, not
       by the style number's own raw digit (draftGroupedProduct's own
       comment on that) — the first subcategory ever created in this fresh
       fixture gets numeric_id "00", the first free code in that pool. */
    seed = await draftProductBatch(f.env, {
      text: "Style #,Category,Subcategory,Description,Price\n70-01-001,Jacket,Blazer,Black Blazer,165.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(seed.created.length, 1, `seed row failed: ${JSON.stringify(seed)}`);

    result = await draftProductBatch(f.env, {
      text: "title,category,subcategory,price\nWhite Blazer,Jacket,Blazer,175.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.ready.length, 0);
  assert.equal(result.created.length, 1, "no style number given at all, but the category/subcategory matched by name");

  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'White Blazer'")[0];
  assert.equal(row.style_id, "70-00-002", "the real category/subcategory codes, plus the next free index after the seed row's own 001");
});

check("test_PRD_P0_152_style_number_grouping__matching_a_named_category_folds_plural_and_singular", async () => {
  /* "When matching categories and subcategories... either plural or
     singular should match" -- the owner's own words. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let seed, result;
  try {
    seed = await draftProductBatch(f.env, {
      text: "Style #,Category,Subcategory,Description,Price\n71-01-001,Jacket,Blazer,Black Blazer,165.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(seed.created.length, 1);

    result = await draftProductBatch(f.env, {
      text: "title,category,subcategory,price\nWhite Blazer,Jackets,Blazers,175.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 1, "the plural spellings still match the singular categories already on file");
  const row = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'White Blazer'")[0];
  assert.equal(row.style_id, "71-00-002");
});

check("test_PRD_P0_207_daily_limit_and_plurals__a_singular_subcategory_matches_its_existing_plural_when_the_plural_ends_in_ze_or_se", async () => {
  /* A real sheet: rows naming the subcategory "Oversize" all failed with
     'could not be created: "Oversizes" already exists under "Jackets". Use it.'
     Folding "Oversizes" back to a singular stripped "es" and gave "oversiz",
     which never equals "oversize". The "e" belongs to the singular here. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let first, second;
  try {
    first = await draftProductBatch(f.env, {
      text: "title,category,subcategory,price\nOversize Dress,Jackets,Oversize,90.00\nLeather Bag,Accessories,Purse,60.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(first.created.length, 2, JSON.stringify(first));
    const before = f.categories().length;
    second = await draftProductBatch(f.env, {
      text: "title,category,subcategory,price\nOversize Coat,Jackets,Oversize,120.00\nRed Bag,Accessories,Purses,45.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(second.ready.length, 0, `expected no clashes, got: ${JSON.stringify(second.ready)}`);
    assert.equal(second.created.length, 2, JSON.stringify(second));
    assert.equal(f.categories().length, before, "no second category was made beside the existing plural");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(f.categories().find((c) => c.name === "Oversizes"));
  assert.ok(f.categories().find((c) => c.name === "Purses"), "a name already plural round-trips unchanged");
});

check("test_PRD_P0_152_style_number_grouping__a_named_category_or_subcategory_matching_nothing_is_created_on_the_fly", async () => {
  /* REVISED AGAIN: "if [a category or subcategory does] not match anything
     we already have, provided that they are properly spelled, go ahead and
     do create them on the fly" -- the owner's own words. Neither name
     matches (or even near-matches) anything on file, so both get created
     fresh, each with a real, auto-picked number -- never a silent drop,
     never left unnumbered. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, {
      text: "title,category,subcategory,price\nMystery Item,Brand New Category,Brand New Sub,50.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.ready.length, 0, `expected no clashes, got: ${JSON.stringify(result.ready)}`);
  assert.equal(result.created.length, 1);

  const top = f.categories().find((c) => c.name === "Brand New Categories");
  assert.ok(top, "the top-level category was created, folded to its plural");
  assert.ok(top.numeric_id, "never left unnumbered -- 'that's a hard fail' otherwise");
  const sub = f.categories().find((c) => c.name === "Brand New Subs" && c.parent_id === top.id);
  assert.ok(sub, "the subcategory was created under it, folded to its plural too");
  assert.ok(sub.numeric_id, "the subcategory is never left unnumbered either");

  const row = f.mirror("SELECT category_id, style_id FROM mirror_product WHERE title = 'Mystery Item'")[0];
  assert.equal(row.category_id, sub.id);
  assert.equal(row.style_id, `${top.numeric_id}-${sub.numeric_id}-001`);
});

check("test_PRD_P0_152_style_number_grouping__a_top_level_pool_with_no_free_number_left_is_a_hard_fail", async () => {
  /* "It should all category have a must have a unique number... that's a
     hard fail" if it does not -- the owner's own words, given directly. All
     100 possible top-level codes (00-99) are already claimed here, so a
     genuinely new category name has no real number left to be given one --
     parked for a person, never silently filed unnumbered. */
  const f = await fixture({ actor: "omar@vemians.com", role: "manager" });
  for (let n = 0; n < 100; n++) {
    f.mirrorDb._raw
      .prepare("INSERT INTO mirror_category (id, external_ref, name, parent_id, numeric_id) VALUES (?, ?, ?, NULL, ?)")
      .run(`cat-filler-${n}`, `SQ_CAT_FILLER_${n}`, `Filler ${n}`, String(n).padStart(2, "0"));
  }
  const result = await draftProductBatch(f.env, {
    text: "title,category,subcategory,price\nMystery Item,Brand New Category,Brand New Sub,50.00\n",
    actor: "omar@vemians.com",
    role: "manager", mode: "add",
  });
  assert.equal(result.created.length, 0);
  assert.equal(result.ready.length, 1);
  assert.match(result.ready[0].summary, /no free top-level category number available/);
  assert.equal(f.categories().filter((c) => c.name === "Brand New Category").length, 0, "never silently created unnumbered");
});

check("test_PRD_P0_152_style_number_grouping__a_subcategory_pool_with_no_free_number_left_is_a_hard_fail", async () => {
  /* The identical hard-fail rule, one level down -- this shop's own
     subcategory numeric_id pool is tree-wide, shared by every subcategory
     regardless of parent (P0-138), so it can run out even while the
     top-level pool still has plenty of room. */
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  for (let n = 0; n < 100; n++) {
    f.mirrorDb._raw
      .prepare("INSERT INTO mirror_category (id, external_ref, name, parent_id, numeric_id) VALUES (?, ?, ?, ?, ?)")
      .run(`sub-filler-${n}`, `SQ_SUB_FILLER_${n}`, `Sub Filler ${n}`, outerwear.id, String(n).padStart(2, "0"));
  }
  const csv = "Style #,Category,Subcategory,Description,Price\n01-01-001,Outerwear,Brand New Subcategory,A coat,165.00\n";
  const result = await draftProductBatch(f.env, { text: csv, actor: "noor@vemians.com", role: "manager" , mode: "add"});
  assert.equal(result.created.length, 0);
  assert.equal(result.ready.length, 1);
  assert.match(result.ready[0].summary, /no free subcategory number available/);
  assert.equal(f.categories().filter((c) => c.name === "Brand New Subcategory").length, 0, "never silently created unnumbered");
});

check("test_PRD_P0_152_style_number_grouping__a_batch_import_is_not_starved_by_this_actors_own_unrelated_rate_usage", async () => {
  /* A real transcript: "some of the categories did get created and
     subcategories, but only like two items got added." Traced to every
     runTool call a batch makes sharing the SAME per-Access-identity budget
     (rate.js's own default limiter, CAPS.CALLS_PER_MINUTE) as that same
     person's own ordinary, unrelated chat activity -- category/subcategory
     resolution runs for every row FIRST, then every row's own
     catalog.create_product runs SECOND, so a budget already nearly spent on
     something else entirely starves the SECOND phase first. Proven
     directly: exhaust this actor's own SHARED rate budget completely first
     (the same singleton runTool defaults to when no explicit `rate` rides
     in its own context), then confirm the batch still creates the row --
     draftProductBatch now spends its own, dedicated budget instead
     (CAPS.BATCH_CALLS_PER_MINUTE's own header comment), never the shared
     one. A fresh, otherwise-unused actor here on purpose: this test
     deliberately exhausts a real actor's own SHARED budget, which would
     otherwise break any other test reusing that same actor afterward. */
  const actor = "zara@vemians.com";
  for (let i = 0; i < CAPS.CALLS_PER_MINUTE; i++) sharedRateLimiter.take(actor);

  const f = await fixture({ actor, role: "manager" });
  const csv = "Style #,Category,Subcategory,Description,Price\n60-01-001,Brand New Top,Brand New Sub,A coat,165.00\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor, role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.ready.length, 0, `expected no clashes, got: ${JSON.stringify(result.ready)}`);
  assert.equal(result.created.length, 1, "created despite this actor's shared rate budget already being fully spent");
});

check("test_PRD_P0_152_style_number_grouping__onprogress_fires_once_per_row_as_each_one_is_actually_created", async () => {
  /* "I don't like how the agent goes silent without any progress reports as
     it creates the new products" -- the owner's own words. draftProductBatch
     itself has no idea a person is watching a chat window; onProgress is the
     one seam agent.js's own dispatchBatchDraft (recordBatchProgress) uses to
     relay what is happening while this one call is still running. Two rows,
     two distinct new top-level categories, so each is its OWN pass through
     createRows' own per-row loop (batch.js) -- proving the callback fires
     per PRODUCT actually created, not once for the whole batch. */
  const f = await fixture({ actor: "mara@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Price\n" +
    "70-01-001,Brand New Hats,Brand New Sun Hats,A hat,45.00\n" +
    "71-01-001,Brand New Belts,Brand New Leather Belts,A belt,35.00\n";

  const seen = [];
  const onProgress = (p) => seen.push(p);

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager", onProgress , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 2, `expected both rows created, got: ${JSON.stringify(result)}`);
  assert.equal(seen.length, 2, `expected one progress update per row, got: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.map((p) => p.done), [1, 2]);
  assert.deepEqual(seen.map((p) => p.total), [2, 2]);
  assert.deepEqual(seen.map((p) => p.status), ["created", "created"]);
  assert.equal(seen[0].row, 2);
  assert.equal(seen[1].row, 3);
});

check("test_PRD_P0_152_style_number_grouping__batch_progress_is_cleared_once_the_real_customer_dispatch_finishes", async () => {
  /* REVISED — catalog_add_product_batch no longer uses BATCH_PROGRESS at
     all (dispatchProductBatchPlan/planProductBatch replace the one-call
     create-everything path onProgress/recordBatchProgress were built for —
     see planProductBatch's own header comment, batch.js); this mechanism
     is customer_draft_customer_batch's alone now. dispatchBatchDraft
     (agent.js) is what actually wires onProgress into recordBatchProgress
     — this drives the real approve() path a chat turn's own Approve click
     takes (draftBatchViaChatButton), rather than calling draftCustomerBatch
     directly, so a mistake in that wiring (the wrong actor key, a callback
     never passed through, a missing `finally`) would show up here.
     Asserting AFTER the click has already resolved: a real client would
     never poll the instant its own main request lands, so all this can
     prove is that nothing is left behind for a later, unrelated poll to
     read stale — the "6 of 16" that would otherwise never go away once
     this actor's next ordinary chat turn (or someone else's batch) polls
     it. */
  const f = await fixture();
  const csv = "given_name,family_name,email_address\nAva,Stone,ava@example.com\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv, filename: "customers.csv" }) };

  assert.equal(readBatchProgress("mara@vemians.com"), null, "nothing should be in flight before this test's own call");
  const outcome = await draftBatchViaChatButton("customer_draft_customer_batch", { asset_id: "ast_1" }, { env, square: f.square });
  assert.equal(outcome.ok, true, outcome.reply);
  assert.match(outcome.reply, /0 customers created, 1 need a person's decision, 0 skipped/);
  assert.equal(readBatchProgress("mara@vemians.com"), null, "the finished batch must not leave a stale progress record behind");
});

check("test_PRD_P0_152_style_number_grouping__a_plan_rows_own_submission_is_single_use", async () => {
  /* The analogous "nothing stale left behind" guarantee for the NEW
     checklist/plan mechanism (planProductBatch/submitBatchPlanRow) that
     replaced the one-call create-everything path above — a plan's own row
     is spliced out of BATCH_PLANS the moment it is picked up (agent.js's
     own submitBatchPlanRow), the same "single use" property PENDING's own
     approve() already has for a T2 approval. Proven directly: submit a
     one-row plan's only row, then submit that exact same {id, row} again
     — it must be refused as unknown, never create the same product twice
     or hand back a stale success. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let outcome;
  try {
    outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist");
    assert.equal(outcome.checklist.rows.length, 1);
    const row = outcome.checklist.rows[0].row;

    const first = await submitRow({ id: outcome.checklist.id, row, identity, env });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.status, "created");

    const second = await submitRow({ id: outcome.checklist.id, row, identity, env });
    assert.equal(second.ok, false);
    assert.equal(second.httpStatus, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__an_open_plan_survives_and_is_found_again_after_a_reload", async () => {
  /* "An ingestion in progress should be persistent if I reload a page...
     any existing jobs should persist even on reload" -- the owner's own
     words. agent_batch_plan was already durable (a prior real incident's
     own fix); openBatchPlanFor is the piece that was missing -- the page
     reload itself, simulated here by simply calling it again with nothing
     else changed, must find the SAME unfinished plan, shaped exactly like
     a freshly-planned checklist. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv =
    "title,category,price,style id,cost\n" + "Wool Coat,Outerwear,450.00,01-04-001,210.00\n" + "Silk Scarf,Outerwear,99.00,01-04-002,20.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.kind, "checklist");
  assert.equal(outcome.checklist.rows.length, 2);

  const resumed = await openBatchPlanFor(env, "zeynep@vemians.com");
  assert.ok(resumed, "the plan must still be found after a simulated reload");
  assert.equal(resumed.id, outcome.checklist.id);
  assert.equal(resumed.rows.length, 2);
  assert.deepEqual(
    resumed.rows.map((r) => r.title).sort(),
    ["Silk Scarf", "Wool Coat"],
  );

  /* A DIFFERENT actor's own reload must never see someone else's plan. */
  const other = await openBatchPlanFor(env, "someone-else@vemians.com");
  assert.equal(other, null);
});

check("test_PRD_P0_152_style_number_grouping__a_partially_submitted_plan_resumes_with_only_the_remaining_rows", async () => {
  /* "You should be able to resume a job without having to rerun the whole
     process and possibly have duplicates" -- the owner's own words. One row
     of a two-row plan submitted, then "reloaded" -- the resumed checklist
     must show ONLY the one row still left, never the one already created
     (which would risk a real duplicate if submitted again). */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv =
    "title,category,price,style id,cost\n" + "Wool Coat,Outerwear,450.00,01-04-001,210.00\n" + "Silk Scarf,Outerwear,99.00,01-04-002,20.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    const woolRow = outcome.checklist.rows.find((r) => r.title === "Wool Coat").row;
    const submitted = await submitRow({ id: outcome.checklist.id, row: woolRow, identity, env });
    assert.equal(submitted.status, "created", JSON.stringify(submitted));

    const resumed = await openBatchPlanFor(env, "zeynep@vemians.com");
    assert.ok(resumed, "the plan is still open -- one row remains");
    assert.equal(resumed.rows.length, 1);
    assert.equal(resumed.rows[0].title, "Silk Scarf");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_187_batch_plan_survives_reload__a_resumed_plan_reports_how_far_it_already_got", async () => {
  /* "You should just resume and show me where it's at... this is not an
     agentic workflow at this point, it's just a procedural ingest" -- the
     owner's own words, after confirming the plan itself already survives a
     reload. What was still missing from openBatchPlanFor's own return value
     was exactly this: done/total, so the resumed page can pick the
     submission loop back up and show real progress instead of asking the
     person to confirm a batch they already confirmed once in a tab that no
     longer exists. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv =
    "title,category,price,style id,cost\n" +
    "Wool Coat,Outerwear,450.00,01-04-001,210.00\n" +
    "Silk Scarf,Outerwear,99.00,01-04-002,20.00\n" +
    "Denim Jacket,Outerwear,120.00,01-04-003,55.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.checklist.rows.length, 3);

    const freshlyPlanned = await openBatchPlanFor(env, "zeynep@vemians.com");
    assert.equal(freshlyPlanned.done, 0, "nothing submitted yet -- Submit was never clicked");
    assert.equal(freshlyPlanned.total, 3);

    const woolRow = outcome.checklist.rows.find((r) => r.title === "Wool Coat").row;
    await submitRow({ id: outcome.checklist.id, row: woolRow, identity, env });

    const resumed = await openBatchPlanFor(env, "zeynep@vemians.com");
    assert.equal(resumed.done, 1, "one row already went through before the reload");
    assert.equal(resumed.total, 3, "total stays the original plan size, not just what's left");
    assert.equal(resumed.rows.length, 2, "only the two not-yet-submitted rows come back");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__a_fully_submitted_plan_is_no_longer_open", async () => {
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    const row = outcome.checklist.rows[0].row;
    const submitted = await submitRow({ id: outcome.checklist.id, row, identity, env });
    assert.equal(submitted.status, "created", JSON.stringify(submitted));

    assert.equal(await openBatchPlanFor(env, "zeynep@vemians.com"), null, "nothing left to resume once every row is spent");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_196_unconfirmed_rows_never_resurface__a_plan_left_with_only_needs_confirmation_rows_is_not_resumable", async () => {
  /* Live bug: "it seems to be in an upload cycle, it's stuck, it keeps on
     re-submitting things" -- the owner's own words. A needsConfirmation row
     (P0-195) is NEVER checked by default, so it can never remove itself
     from the plan's own `rows` the way every other row does on submit --
     openBatchPlanFor's own `done < total` query stayed true forever, and
     the checklist resurfaced, freshly rendered, on every single page load
     from then on, exactly the behavior P0-152's own "survives a reload"
     feature was built to provide for a GENUINELY interrupted batch, never
     for one a person already finished reviewing and chose to leave alone. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager", withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-070,3\n";
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "zeynep@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    /* A real price change (so a normal, checked-by-default row exists
       alongside the needsConfirmation one) plus a nonzero-current quantity
       disagreement (9 on the sheet, 3 on hand). */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-070,9\n";
    const assets = await assetsFixtureWithRow({ extracted_text: csv2 });
    const outcome = await dispatch(
      "catalog_update_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env: { ...f.env, ASSETS: assets }, allowed: new Set(["catalog_update_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist", `expected a checklist, got: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.checklist.rows.length, 2, `expected the price row and the stock row, got: ${JSON.stringify(outcome.checklist.rows)}`);
    const priceRow = outcome.checklist.rows.find((r) => !r.needsConfirmation);
    const stockRow = outcome.checklist.rows.find((r) => r.needsConfirmation);
    assert.ok(priceRow && stockRow, `expected one of each, got: ${JSON.stringify(outcome.checklist.rows)}`);

    const env = { ...f.env, ASSETS: assets };
    /* The checklist's own real behavior: only the checked (non-flagged) row
       is ever submitted automatically -- the needsConfirmation row is left
       exactly as a person leaving it unchecked on purpose would. */
    const submitted = await submitRow({ id: outcome.checklist.id, row: priceRow.row, identity, env });
    assert.equal(submitted.status, "updated", JSON.stringify(submitted));

    /* THE POINT: once a person has reviewed the checklist once (done > 0)
       and left every remaining row exactly where a deliberate non-checkbox
       choice would leave it, reloading the page must never resurface the
       SAME checklist again -- that is a fresh, separate "I want this
       applied" decision (a brand-new resubmit), never an interrupted job
       still genuinely in flight. */
    assert.equal(
      await openBatchPlanFor(env, "zeynep@vemians.com"),
      null,
      "a plan left with only needs-confirmation rows must never keep resurfacing on reload",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* A D1 binding whose "claim this row" UPDATE (ingest_row.claimed_at) throws
   for its first N calls, everything else passing straight through -- the
   shape of a one-request storage blip landing on a single row of a long run. */
function flakyPlanWrites(db, failures) {
  let remaining = failures;
  const attempts = { updates: 0 };
  return {
    attempts,
    prepare(sql) {
      if (/UPDATE ingest_row SET claimed_at/.test(sql)) {
        attempts.updates += 1;
        if (remaining > 0) {
          remaining -= 1;
          const fail = async () => {
            throw new Error("D1_ERROR: transient write failure");
          };
          return { bind: () => ({ run: fail, all: fail, first: fail }) };
        }
      }
      return db.prepare(sql);
    },
  };
}

check("test_PRD_P0_198_mark_spent_retries__a_one_off_storage_blip_on_a_rows_spent_write_no_longer_costs_the_row", async () => {
  /* "Row 40 could not be marked as submitted. Nothing was run" -- a real
     report, on SEVERAL rows of one 68-row run from a single tab. The write
     that records a row as spent used to be attempted exactly once. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const db = await assetsFixtureWithRow({ extracted_text: csv });
  const flaky = flakyPlanWrites(db, 2);
  const env = { ...f.env, ASSETS: flaky };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist", JSON.stringify(outcome));
    flaky.attempts.updates = 0;
    const row = outcome.checklist.rows[0].row;

    const result = await submitRow({ id: outcome.checklist.id, row, identity, env });
    assert.equal(result.ok, true, `two blips then success must go through, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, "created");
    assert.equal(flaky.attempts.updates, 3, "two failed attempts, then the one that landed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_198_mark_spent_retries__a_write_that_never_lands_still_fails_closed_with_nothing_run_and_the_row_kept", async () => {
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const db = await assetsFixtureWithRow({ extracted_text: csv });
  const flaky = flakyPlanWrites(db, 1000);
  const env = { ...f.env, ASSETS: flaky };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    flaky.attempts.updates = 0;
    const row = outcome.checklist.rows[0].row;

    const result = await submitRow({ id: outcome.checklist.id, row, identity, env });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 502);
    assert.match(result.reply, /could not be marked as submitted\. Nothing was run/);
    assert.equal(flaky.attempts.updates, 3, "gives up after the bounded number of attempts, never loops");
    assert.equal(f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'").length, 0, "nothing was created");

    const resumed = await openBatchPlanFor(db_passthrough(db), "zeynep@vemians.com");
    assert.ok(resumed && resumed.rows.length === 1, "the row is still in the stored plan, retryable on a reload");
  } finally {
    globalThis.fetch = realFetch;
  }
});

function db_passthrough(db) {
  return { ASSETS: db };
}

/* ─────────────────────────────────────────────────────────────────────────
 * P0-200 / P0-201 — a checklist row says what the sheet called it, where it
 * lands and exactly what would change; and a row is re-checked against the
 * catalog at the moment it is submitted. "I want to see style IDs that are
 * being provided by the table... and I want to see our result category and
 * subcategory that's actually being applied to... a way for me to confirm
 * where the things are being updated" / "If there's nothing changed, why is
 * this job even triggering? The only thing that I should see are real
 * changes" -- the owner's own words.
 * ───────────────────────────────────────────────────────────────────────── */

async function createdCoatThenPlannedPriceChange(styleId, { newPrice = "120.00" } = {}) {
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager", withCommerce: true });
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };
  const csv1 = `title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,${styleId},3\n`;
  const csv2 = `title,category,price,style id,quantity\nWool Coat,Outerwear,${newPrice},${styleId},3\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "zeynep@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1, JSON.stringify(first));
    const assets = await assetsFixtureWithRow({ extracted_text: csv2 });
    const env = { ...f.env, ASSETS: assets };
    const outcome = await dispatch(
      "catalog_update_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_update_product_batch"]) },
    );
    return { f, env, identity, outcome, realFetch };
  } finally {
    globalThis.fetch = realFetch;
  }
}

check("test_PRD_P0_200_checklist_shows_placement_and_changes__a_row_says_its_sheet_style_id_where_it_lands_and_what_changes", async () => {
  const { f, outcome } = await createdCoatThenPlannedPriceChange("01-04-090");
  assert.equal(outcome.kind, "checklist", JSON.stringify(outcome));
  assert.equal(outcome.checklist.rows.length, 1, JSON.stringify(outcome.checklist.rows));
  const row = outcome.checklist.rows[0];

  assert.equal(row.sheetStyleId, "01-04-090", "the style ID the SHEET gave, verbatim");
  const product = f.mirror(
    "SELECT c.name AS leaf, pc.name AS parent FROM mirror_product p JOIN mirror_category_index c ON c.id = p.category_id LEFT JOIN mirror_category_index pc ON pc.id = c.parent_id WHERE p.title = 'Wool Coat'",
  )[0];
  const expectedCategory = product.parent ?? product.leaf;
  const expectedSub = product.parent ? product.leaf : "";
  assert.ok(expectedCategory, "sanity: the product really sits in a category");
  assert.equal(row.category, expectedCategory, "the category the row actually lands in");
  assert.equal(row.subcategory, expectedSub, "and its subcategory");
  assert.match(row.changes, /price 100\.00 -> 120\.00/, `the exact change, old to new, got: ${row.changes}`);
});

check("test_PRD_P0_200_checklist_shows_placement_and_changes__the_submitted_result_reports_where_the_row_actually_landed", async () => {
  const { f, env, identity, outcome, realFetch } = await createdCoatThenPlannedPriceChange("01-04-091");
  const row = outcome.checklist.rows[0];
  globalThis.fetch = f.square;
  try {
    const result = await submitRow({ id: outcome.checklist.id, row: row.row, identity, env });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "updated", JSON.stringify(result));
    assert.equal(result.sheetStyleId, "01-04-091");
    assert.equal(result.category, row.category, "read back from the catalog after the write");
    assert.equal(result.subcategory, row.subcategory);
    const live = f.mirror("SELECT style_id FROM mirror_product WHERE title = 'Wool Coat'")[0].style_id ?? "";
    assert.equal(result.styleId, live, "the style ID the product carries on file right now (a product filed directly under a top-level category has none yet)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_200_checklist_shows_placement_and_changes__the_cost_only_fallback_row_is_also_suppressed_when_the_cost_already_matches", async () => {
  /* The vendor/cost fallback (every size on the sheet clashed, so only the
     product-level cost is applied) used to be offered even when every
     variation already carried exactly that cost on a product that already
     has a vendor -- a no-op like any other. It now falls through to the
     ordinary clash, which still tells a person about the unadded sizes. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager", withCommerce: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const csv1 = "title,category,price,style id,cost,quantity\nWool Coat,Outerwear,450.00,01-04-093,210.00,3\n";
    const first = await draftProductBatch(f.env, { text: csv1, actor: "zeynep@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1, JSON.stringify(first));

    /* A new size with no usable price clashes; the cost on the sheet is the
       one the product already has. */
    const csv2 = "title,category,price,style id,cost,size,quantity\nWool Coat,Outerwear,n/a,01-04-093,210.00,XL,3\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "zeynep@vemians.com", role: "manager", mode: "update" });
    assert.equal(second.created.length, 0, `a cost the product already carries must not be rewritten, got: ${JSON.stringify(second)}`);
    assert.equal(second.ready.length, 1, `the unadded size still surfaces as a clash, got: ${JSON.stringify(second)}`);
    assert.match(second.ready[0].summary, /needs a real price/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_201_submit_time_recheck__a_row_the_catalog_already_matches_is_not_written_again", async () => {
  /* A plan can be older than the catalog it was made against. Plan a price
     change, then let the catalog reach that price some other way before the
     row is submitted: submitting must report "unchanged" and make no write. */
  const { f, env, identity, outcome, realFetch } = await createdCoatThenPlannedPriceChange("01-04-092");
  const row = outcome.checklist.rows[0];
  globalThis.fetch = f.square;
  try {
    const applied = await draftProductBatch(f.env, {
      text: "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-092,3\n",
      actor: "zeynep@vemians.com",
      role: "manager",
      mode: "update",
    });
    assert.equal(applied.created.length, 1, `sanity: the price really changed out of band, got: ${JSON.stringify(applied)}`);

    const writesBefore = f.calls().filter((c) => c.path === "/v2/catalog/object").length;
    const result = await submitRow({ id: outcome.checklist.id, row: row.row, identity, env });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "unchanged", `expected no write, got: ${JSON.stringify(result)}`);
    assert.match(result.reason, /nothing to change/);
    assert.equal(f.calls().filter((c) => c.path === "/v2/catalog/object").length, writesBefore, "no catalog write may be made for a row that already matches");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-202 — the upload ledger. "We need to have an upload database, like an
 * ingest table that matches, that is based on file name that's being
 * uploaded. And it needs to have its own submitted check field. And so every
 * time you hit submit, it goes through this once... as it finishes the job,
 * it checks off every one of these fields, and then you know the job is
 * done. But it will never run more than once per submit click." -- the
 * owner's own words, after the same sheet kept being planned and run over
 * and over.
 * ───────────────────────────────────────────────────────────────────────── */

const LEDGER_CSV =
  "title,category,price,style id,cost\n" +
  "Wool Coat,Outerwear,450.00,01-04-001,210.00\n" +
  "Silk Scarf,Outerwear,80.00,01-04-002,20.00\n";

async function ledgerFixture(csv = LEDGER_CSV) {
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const assets = await assetsFixtureWithRow({ extracted_text: csv });
  const env = { ...f.env, ASSETS: assets };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };
  const plan = () =>
    dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
  return { f, assets, env, identity, plan };
}

check("test_PRD_P0_202_upload_ledger__planning_the_same_file_again_hands_back_the_open_upload_instead_of_planning_it_twice", async () => {
  const { f, assets, plan } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await plan();
    assert.equal(first.kind, "checklist", JSON.stringify(first));
    const productsAfterFirst = f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n;

    const second = await plan();
    assert.equal(second.kind, "checklist", JSON.stringify(second));
    assert.equal(second.checklist.id, first.checklist.id, "the SAME upload, not a second plan of the same file");
    assert.equal(second.checklist.rows.length, 2);
    assert.match(second.text, /already open/i, "and it says so rather than pretending to have planned it");

    const jobs = assets._raw.prepare("SELECT COUNT(*) AS n FROM ingest_job").get().n;
    assert.equal(jobs, 1, "one job for one file, however many times it is asked for");
    assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n, productsAfterFirst, "planning twice created nothing");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__sending_the_same_file_name_again_supersedes_the_older_open_upload", async () => {
  const { f, assets, env, identity, plan } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const older = await plan();
    /* A corrected file with the SAME name: a second stored asset. */
    assets._raw
      .prepare(
        "INSERT INTO asset(id, store_key, filename, content_type, size_bytes, uploaded_by, extracted_text, text_truncated) VALUES ('ast_2', 'assets/ast_2', 'products.csv', 'text/csv', 100, 'mara@vemians.com', ?, 0)",
      )
      .run("title,category,price,style id,cost\nDenim Jacket,Outerwear,120.00,01-04-003,55.00\n");
    const newer = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_2" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(newer.kind, "checklist", JSON.stringify(newer));
    assert.notEqual(newer.checklist.id, older.checklist.id);

    const status = (id) => assets._raw.prepare("SELECT status FROM ingest_job WHERE id = ?").get(id).status;
    assert.equal(status(older.checklist.id), "superseded", "only one live job per file name");
    assert.equal(status(newer.checklist.id), "ready");
    const open = await openBatchPlanFor(env, "zeynep@vemians.com");
    assert.equal(open.id, newer.checklist.id, "a reload shows only the current file's upload");
    const refused = await submitRow({ id: older.checklist.id, row: older.checklist.rows[0].row, identity, env });
    assert.equal(refused.ok, false, "the superseded upload can no longer be run");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__a_second_submit_click_cannot_start_while_a_run_is_going_and_an_old_run_cannot_claim_rows", async () => {
  const { f, assets, env, identity, plan } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await plan();
    const id = outcome.checklist.id;
    const [rowA, rowB] = outcome.checklist.rows;
    const products = () => f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n;
    const baseline = products();

    const runA = await startBatchRun({ id, rows: [rowA.row, rowB.row], identity, env });
    assert.equal(runA.ok, true, JSON.stringify(runA));
    assert.equal(runA.queued, 2);

    const doubleTap = await startBatchRun({ id, rows: [rowA.row, rowB.row], identity, env });
    assert.equal(doubleTap.ok, false, "a second click while the first run is going starts nothing");
    assert.equal(doubleTap.httpStatus, 409);

    /* The first run's own tab goes quiet (a phone asleep); nothing has moved
       for longer than the stale window, so a person can take the job over. */
    assets._raw.exec("UPDATE ingest_job SET updated_at = datetime('now', '-10 minutes')");
    const runB = await startBatchRun({ id, rows: [rowA.row], identity, env });
    assert.equal(runB.ok, true, `a quiet run can be taken over, got: ${JSON.stringify(runB)}`);
    assert.notEqual(runB.runId, runA.runId);

    const stale = await submitBatchPlanRow({ id, row: rowA.row, runId: runA.runId, identity, env });
    assert.equal(stale.ok, false, "the replaced run cannot run rows any more");
    assert.equal(stale.httpStatus, 409);
    assert.equal(products(), baseline, "nothing was created by the stale run");

    const unselected = await submitBatchPlanRow({ id, row: rowB.row, runId: runB.runId, identity, env });
    assert.equal(unselected.ok, false, "a row this click did not select is not part of the run");
    assert.equal(unselected.httpStatus, 404);

    const live = await submitBatchPlanRow({ id, row: rowA.row, runId: runB.runId, identity, env });
    assert.equal(live.ok, true, JSON.stringify(live));
    assert.equal(live.status, "created");

    const afterOver = await submitBatchPlanRow({ id, row: rowB.row, runId: runB.runId, identity, env });
    assert.equal(afterOver.ok, false, "once the run's own rows are done the run is over");
    assert.equal(afterOver.httpStatus, 409);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__rows_are_checked_off_with_their_outcome_and_the_job_is_done_only_when_none_is_left", async () => {
  const { f, assets, env, identity, plan } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await plan();
    const id = outcome.checklist.id;
    const [rowA, rowB] = outcome.checklist.rows;
    const baseline = f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n;
    const job = () => assets._raw.prepare("SELECT status, runs, run_id FROM ingest_job WHERE id = ?").get(id);
    const rowsNow = () => assets._raw.prepare("SELECT row_key, submitted, outcome, claimed_at, result_category FROM ingest_row WHERE job_id = ? ORDER BY rowid").all(id);

    assert.deepEqual(rowsNow().map((r) => r.submitted), [0, 0], "nothing is checked before any click");
    assert.equal(job().status, "ready");

    /* Click 1 checks only the first box. */
    const run1 = await startBatchRun({ id, rows: [rowA.row], identity, env });
    assert.equal(job().status, "running");
    const done1 = await submitBatchPlanRow({ id, row: rowA.row, runId: run1.runId, identity, env });
    assert.equal(done1.status, "created", JSON.stringify(done1));
    assert.equal(job().status, "ready", "the run is over and one row is still waiting for another click, so the job is not done");
    assert.equal(job().run_id, null, "no run is current between clicks");
    const afterOne = rowsNow();
    assert.deepEqual(afterOne.map((r) => r.submitted), [1, 0]);
    assert.equal(afterOne[0].outcome, "created");
    assert.ok(afterOne[0].claimed_at);
    assert.ok(afterOne[0].result_category, "where it landed is recorded with the check");

    /* Click 2 takes the rest; only now is the job done. */
    const run2 = await startBatchRun({ id, rows: [rowA.row, rowB.row], identity, env });
    assert.equal(run2.queued, 1, "a row already checked off is never selected again");
    const done2 = await submitBatchPlanRow({ id, row: rowB.row, runId: run2.runId, identity, env });
    assert.equal(done2.status, "created", JSON.stringify(done2));
    assert.equal(job().status, "done");
    assert.equal(job().runs, 2);
    assert.deepEqual(rowsNow().map((r) => r.submitted), [1, 1]);
    assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n, baseline + 2, "each row was created exactly once");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__a_row_submitted_with_no_run_is_refused_and_nothing_runs", async () => {
  const { f, env, identity, plan } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await plan();
    const baseline = f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n;
    for (const runId of [undefined, "", "not-a-real-run"]) {
      const result = await submitBatchPlanRow({ id: outcome.checklist.id, row: outcome.checklist.rows[0].row, runId, identity, env });
      assert.equal(result.ok, false, `runId ${JSON.stringify(runId)} must not run anything`);
      assert.ok([404, 409].includes(result.httpStatus), JSON.stringify(result));
    }
    assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n, baseline, "no Submit click, no product");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__the_tables_create_themselves_and_match_the_schema_file", async () => {
  /* The assets database has no automated migration, so ingest.js creates its
     own tables the first time it finds them missing -- and the definition it
     uses must be the one shared/db/assets.sql holds. */
  const { INGEST_SCHEMA } = await import("../src/ingest.js");
  const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`);

  const fromFile = new DatabaseSync(":memory:");
  fromFile.exec(ASSETS_SQL);
  const lazy = new DatabaseSync(":memory:");
  for (const statement of INGEST_SCHEMA) lazy.exec(statement);
  for (const table of ["ingest_job", "ingest_row"]) {
    assert.deepEqual(columns(lazy, table), columns(fromFile, table), `${table}: ingest.js and assets.sql must define the same columns`);
  }
  const indexes = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ingest_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(indexes(lazy), indexes(fromFile));

  /* And a database that predates the tables works on first use. */
  const { f, assets, env, identity, plan } = await ledgerFixture();
  assets._raw.exec("DROP TABLE ingest_row; DROP TABLE ingest_job;");
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    assert.equal(await openBatchPlanFor(env, "zeynep@vemians.com"), null, "nothing to show, and no error, before the tables exist");
    const outcome = await plan();
    assert.equal(outcome.kind, "checklist", `first use must create the tables, got: ${JSON.stringify(outcome)}`);
    const done = await submitRow({ id: outcome.checklist.id, row: outcome.checklist.rows[0].row, identity, env });
    assert.equal(done.status, "created", JSON.stringify(done));
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__if_the_one_statement_row_insert_is_refused_the_rows_are_still_saved_one_by_one", async () => {
  const { f, assets, identity } = await ledgerFixture();
  const refuseBulk = {
    prepare(sql) {
      if (/json_each/.test(sql) && /INSERT INTO ingest_row/.test(sql)) {
        const fail = async () => {
          throw new Error("D1_ERROR: no such function: json_each");
        };
        return { bind: () => ({ run: fail, all: fail, first: fail }) };
      }
      return assets.prepare(sql);
    },
  };
  const env = { ...f.env, ASSETS: refuseBulk };
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist", JSON.stringify(outcome));
    assert.equal(outcome.checklist.rows.length, 2, "both rows saved through the per-row fallback");
    assert.equal(assets._raw.prepare("SELECT COUNT(*) AS n FROM ingest_row").get().n, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__if_the_one_statement_row_selection_is_refused_the_click_still_selects_its_rows", async () => {
  const { f, assets, identity } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const env = { ...f.env, ASSETS: assets };
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    const refuseJson = {
      prepare(sql) {
        if (/UPDATE ingest_row SET queued_run = \?/.test(sql) && /json_each/.test(sql)) {
          const fail = async () => {
            throw new Error("D1_ERROR: no such function: json_each");
          };
          return { bind: () => ({ run: fail, all: fail, first: fail }) };
        }
        return assets.prepare(sql);
      },
    };
    const started = await startBatchRun({ id: outcome.checklist.id, rows: outcome.checklist.rows.map((r) => r.row), identity, env: { ...f.env, ASSETS: refuseJson } });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.queued, 2, "both rows selected through the chunked fallback");
    const done = await submitBatchPlanRow({ id: outcome.checklist.id, row: outcome.checklist.rows[0].row, runId: started.runId, identity, env });
    assert.equal(done.status, "created", JSON.stringify(done));
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__a_claim_whose_reply_is_lost_is_handed_back_to_the_retry_and_the_row_still_runs_once", async () => {
  /* The claim's UPDATE commits but the answer never arrives. Without a token
     the retry found the row "already claimed", nothing ran, nothing was
     checked, and the person saw a skip for work that simply never happened. */
  const { f, assets, identity } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const env = { ...f.env, ASSETS: assets };
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    let lost = 1;
    let claims = 0;
    const lossy = {
      prepare(sql) {
        const real = assets.prepare(sql);
        if (!/UPDATE ingest_row SET claimed_at/.test(sql)) return real;
        claims += 1;
        return {
          bind: (...args) => {
            const bound = real.bind(...args);
            return {
              all: async () => {
                const res = await bound.all();
                if (lost > 0) {
                  lost -= 1;
                  throw new Error("D1_ERROR: network connection lost");
                }
                return res;
              },
            };
          },
        };
      },
    };
    const baseline = f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n;
    const started = await startBatchRun({ id: outcome.checklist.id, rows: [outcome.checklist.rows[0].row], identity, env });
    const result = await submitBatchPlanRow({ id: outcome.checklist.id, row: outcome.checklist.rows[0].row, runId: started.runId, identity, env: { ...f.env, ASSETS: lossy } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "created", "the retry got the row back and it ran");
    assert.equal(claims, 2, "the claim was attempted twice");
    assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n, baseline + 1, "and ran exactly once");
    const row = assets._raw.prepare("SELECT submitted, outcome FROM ingest_row WHERE job_id = ? AND row_key = ?").get(outcome.checklist.id, outcome.checklist.rows[0].row);
    assert.deepEqual({ ...row }, { submitted: 1, outcome: "created" });

    /* A DIFFERENT request never inherits a claim, so a row still cannot run twice. */
    const again = await submitBatchPlanRow({ id: outcome.checklist.id, row: outcome.checklist.rows[0].row, runId: started.runId, identity, env });
    assert.equal(again.ok, false);
    assert.equal(f.mirror("SELECT COUNT(*) AS n FROM mirror_product")[0].n, baseline + 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__ending_a_run_frees_the_upload_even_when_a_row_could_not_be_checked_off", async () => {
  const { f, assets, env, identity, plan } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await plan();
    const id = outcome.checklist.id;
    const [rowA, rowB] = outcome.checklist.rows;
    const run = await startBatchRun({ id, rows: [rowA.row, rowB.row], identity, env });
    /* One row's claim never landed, so its run can never settle by itself. */
    const done = await submitBatchPlanRow({ id, row: rowA.row, runId: run.runId, identity, env });
    assert.equal(done.status, "created", JSON.stringify(done));
    const status = () => assets._raw.prepare("SELECT status, run_id FROM ingest_job WHERE id = ?").get(id);
    assert.equal(status().status, "running", "rowB was never submitted, so the run is still open");
    const blocked = await startBatchRun({ id, rows: [rowB.row], identity, env });
    assert.equal(blocked.httpStatus, 409, "and a retry right away is refused");

    const { finishBatchRun } = await import("../src/agent.js");
    const ended = await finishBatchRun({ id, runId: run.runId, identity, env });
    assert.equal(ended.ok, true, JSON.stringify(ended));
    assert.equal(status().status, "ready", "one row is still waiting, so the upload is ready for another click");
    assert.equal(status().run_id, null);

    const retry = await startBatchRun({ id, rows: [rowB.row], identity, env });
    assert.equal(retry.ok, true, `the person can retry at once, got: ${JSON.stringify(retry)}`);
    assert.equal(retry.queued, 1);

    /* Closing twice, or with a run that is not the current one, changes nothing. */
    const stale = await finishBatchRun({ id, runId: run.runId, identity, env });
    assert.equal(stale.ok, true);
    assert.equal(status().status, "running", "a stale close cannot end the new run");
    const other = await finishBatchRun({ id, runId: retry.runId, identity: { email: "someone-else@vemians.com", groups: ["vemians-manager"] }, env });
    assert.equal(other.ok, false);
    assert.equal(other.httpStatus, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__a_start_that_fails_after_taking_the_job_gives_it_back", async () => {
  const { f, assets, identity } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const env = { ...f.env, ASSETS: assets };
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    const breaking = {
      prepare(sql) {
        if (/UPDATE ingest_row SET queued_run = NULL/.test(sql)) {
          const fail = async () => {
            throw new Error("D1_ERROR: transient");
          };
          return { bind: () => ({ run: fail, all: fail, first: fail }) };
        }
        return assets.prepare(sql);
      },
    };
    const failed = await startBatchRun({ id: outcome.checklist.id, rows: outcome.checklist.rows.map((r) => r.row), identity, env: { ...f.env, ASSETS: breaking } });
    assert.equal(failed.ok, false);
    assert.equal(failed.httpStatus, 502);
    const job = assets._raw.prepare("SELECT status, run_id FROM ingest_job WHERE id = ?").get(outcome.checklist.id);
    assert.equal(job.status, "ready", "not left held by a run that never got its rows");
    assert.equal(job.run_id, null);
    const retry = await startBatchRun({ id: outcome.checklist.id, rows: outcome.checklist.rows.map((r) => r.row), identity, env });
    assert.equal(retry.ok, true, "so the person can simply press Submit again");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__a_settled_upload_is_not_handed_back_as_if_it_were_open_when_the_same_file_is_planned_again", async () => {
  /* Something was done from the job and only rows nobody checks by default
     are left: the page no longer shows it (Test-PRD-P0-196), so planning the
     same file again must not hand back that stale plan either. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager", withCommerce: true });
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, {
      text: "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-095,3\n",
      actor: "zeynep@vemians.com",
      role: "manager",
      mode: "add",
    });
    assert.equal(first.created.length, 1);
    const assets = await assetsFixtureWithRow({ extracted_text: "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-095,9\n" });
    const env = { ...f.env, ASSETS: assets };
    const ctx = { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_update_product_batch"]) };
    const planned = await dispatch("catalog_update_product_batch", { asset_id: "ast_1" }, ctx);
    const priceRow = planned.checklist.rows.find((r) => !r.needsConfirmation);
    assert.ok(priceRow && planned.checklist.rows.some((r) => r.needsConfirmation), JSON.stringify(planned.checklist.rows));
    const done = await submitRow({ id: planned.checklist.id, row: priceRow.row, identity, env });
    assert.equal(done.status, "updated", JSON.stringify(done));
    assert.equal(await openBatchPlanFor(env, "zeynep@vemians.com"), null, "the page does not show it");

    const again = await dispatch("catalog_update_product_batch", { asset_id: "ast_1" }, ctx);
    assert.equal(again.kind, "checklist", JSON.stringify(again));
    assert.notEqual(again.checklist.id, planned.checklist.id, "planned afresh, not handed back the stale job");
    assert.doesNotMatch(again.text, /already open/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__the_checklist_handed_back_at_planning_is_exactly_what_a_reload_shows", async () => {
  const { f, assets, plan } = await ledgerFixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await plan();
    const { checklistFor } = await import("../src/ingest.js");
    assert.deepEqual(outcome.checklist, await checklistFor(assets, outcome.checklist.id), "built in memory, identical to what the ledger reads back");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_202_upload_ledger__a_big_sheet_is_saved_in_chunks_not_one_oversized_value_or_one_query_per_row", async () => {
  const { createJob, checklistFor } = await import("../src/ingest.js");
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const assets = await assetsFixtureWithRow({ extracted_text: "x" });
  const inserts = [];
  const counting = {
    prepare(sql) {
      if (/INSERT INTO ingest_row/.test(sql)) inserts.push(sql);
      return assets.prepare(sql);
    },
  };
  const rows = Array.from({ length: 250 }, (_, i) => ({ rowNumber: i + 2, title: `Item ${i}`, args: { title: `Item ${i}` }, toolName: "catalog.create_product", summary: "create" }));
  const id = await createJob(counting, { actor: "zeynep@vemians.com", role: "manager", assetId: "ast_1", filename: "big.csv", mode: "add", rows });
  assert.equal(inserts.length, 3, "250 rows -> three statements of up to 100, not 250 and not 1");
  assert.equal((await checklistFor(assets, id)).rows.length, 250);
  void f;
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-204 — style numbers are detected, not just read from three header names.
 * "There is a style number column, the first column. It has the full like
 * style ID along with the variations and colors and sizes... the first
 * three-digit sequences, that's the style ID. So you need to detect style IDs
 * better" -- the owner's own words, after a sheet whose header read "Style
 * Number" reported "no style ID on the sheet" for every row.
 * ───────────────────────────────────────────────────────────────────────── */

async function plannedStyleSheet(csv) {
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const assets = await assetsFixtureWithRow({ extracted_text: csv });
  const env = { ...f.env, ASSETS: assets };
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    return { f, outcome };
  } finally {
    globalThis.fetch = realFetch;
  }
}

check("test_PRD_P0_204_style_ids_detected__a_style_number_header_is_read_and_the_first_three_number_groups_are_the_style_id", async () => {
  const csv =
    "Style Number,Title,Category,Subcategory,Price\n" +
    "001-001-005-BLK-S,Wool Coat,Jacket,Blazer,100.00\n" +
    "001-001-005-BLK-M,Wool Coat,Jacket,Blazer,100.00\n";
  const { f, outcome } = await plannedStyleSheet(csv);
  assert.equal(outcome.kind, "checklist", JSON.stringify(outcome));
  assert.equal(outcome.checklist.rows.length, 1, "both sizes are ONE product, grouped by the style ID");
  assert.equal(outcome.checklist.rows[0].sheetStyleId, "001-001-005", "the style ID is the first three groups, not the whole cell");
  void f;
});

check("test_PRD_P0_204_style_ids_detected__a_column_with_an_unfamiliar_header_is_found_by_what_its_values_look_like", async () => {
  const csv =
    "Ref,Title,Category,Subcategory,Price\n" +
    "001-001-006-WHT-L,Silk Scarf,Jacket,Vest,80.00\n" +
    "001-001-007-BLK-OS,Denim Cap,Jacket,Vest,40.00\n";
  const { outcome } = await plannedStyleSheet(csv);
  assert.equal(outcome.kind, "checklist", JSON.stringify(outcome));
  assert.deepEqual(outcome.checklist.rows.map((r) => r.sheetStyleId).sort(), ["001-001-006", "001-001-007"]);
});

check("test_PRD_P0_204_style_ids_detected__a_date_column_is_never_mistaken_for_style_numbers", async () => {
  const csv =
    "Received,Title,Category,Subcategory,Price\n" +
    "2026-10-01,Wool Coat,Jacket,Blazer,100.00\n" +
    "2026-10-02,Silk Scarf,Jacket,Blazer,80.00\n";
  const { outcome } = await plannedStyleSheet(csv);
  /* No style column at all: rows go through by category + subcategory, with no style ID claimed. */
  assert.equal(outcome.kind, "checklist", JSON.stringify(outcome));
  assert.ok(outcome.checklist.rows.every((r) => r.sheetStyleId === ""), JSON.stringify(outcome.checklist.rows.map((r) => r.sheetStyleId)));
});

check("test_PRD_P0_204_style_ids_detected__the_variation_tail_is_whatever_follows_the_first_three_groups", async () => {
  const csv =
    "Style #,Title,Category,Subcategory,Price\n" +
    "001 - 001 - 008,Wool Coat,Jacket,Blazer,100.00\n" +
    "001-001-009-S,Silk Scarf,Jacket,Blazer,80.00\n" +
    "001-001-010-OFF-WHT-M,Denim Cap,Jacket,Blazer,40.00\n";
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const result = await draftProductBatch(f.env, { text: csv, actor: "zeynep@vemians.com", role: "manager", mode: "add" });
    assert.equal(result.created.length, 3, JSON.stringify(result));
    const bases = f.mirror("SELECT import_style_number AS n FROM mirror_product WHERE import_style_number IS NOT NULL ORDER BY n").map((r) => r.n);
    assert.deepEqual(bases, ["001-001-008", "001-001-009", "001-001-010"], "spaces around dashes, a size alone, and a two-part colour all leave the same three-group ID");
    const options = f.mirror(
      "SELECT v.options AS o FROM mirror_variant v JOIN mirror_product p ON p.id = v.product_id WHERE p.import_style_number = '001-001-010'",
    ).map((r) => JSON.parse(r.o));
    assert.deepEqual(options, [{ Color: "OFF-WHT", Size: "M" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__cancel_actually_deletes_the_plan_never_just_the_local_panel", async () => {
  /* "I would have to hit cancel to actually clear a job in progress" -- the
     owner's own words, already assuming Cancel did this; it never reached
     the server before. Proven directly: cancel a plan, then confirm it is
     genuinely gone -- not resumable, not re-submittable. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  assert.equal(outcome.kind, "checklist");

  const cancelled = await cancelBatchPlan({ id: outcome.checklist.id, identity, env });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));

  assert.equal(await openBatchPlanFor(env, "zeynep@vemians.com"), null, "a cancelled plan must never be resumable");

  const row = outcome.checklist.rows[0].row;
  const result = await submitRow({ id: outcome.checklist.id, row, identity, env });
  assert.equal(result.ok, false, "a cancelled plan's own rows must never still be submittable");
  assert.equal(result.httpStatus, 404);
});

check("test_PRD_P0_152_style_number_grouping__cancel_refuses_a_different_actors_plan", async () => {
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  const wrongActor = { email: "someone-else@vemians.com", groups: ["vemians-manager"] };
  const result = await cancelBatchPlan({ id: outcome.checklist.id, identity: wrongActor, env });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 403);

  /* And it survives that refused attempt -- the real owner can still
     resume or cancel it normally afterward. */
  assert.ok(await openBatchPlanFor(env, "zeynep@vemians.com"), "the plan must still exist after a refused cancel attempt");
});

check("test_PRD_P0_152_style_number_grouping__cancelling_twice_is_harmless", async () => {
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const outcome = await dispatch(
    "catalog_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
  );
  const first = await cancelBatchPlan({ id: outcome.checklist.id, identity, env });
  assert.equal(first.ok, true);
  const second = await cancelBatchPlan({ id: outcome.checklist.id, identity, env });
  assert.equal(second.ok, true, "cancelling something already gone must never be treated as an error");
});

check("test_PRD_P0_152_style_number_grouping__a_plan_belongs_to_the_actor_who_raised_it", async () => {
  /* The same actor check PENDING's own approve() already enforces
     (P0-25's own "the approval token is never in the model's reach"),
     applied to the new checklist mechanism -- a plan is stashed with the
     actor who uploaded the sheet, and submitBatchPlanRow (agent.js) refuses
     anyone else's attempt to spend a row from it, whether that is a
     genuine attacker or just a stale/copy-pasted request. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist");
    const row = outcome.checklist.rows[0].row;

    const wrongActor = { email: "someone-else@vemians.com", groups: ["vemians-manager"] };
    const result = await submitRow({ id: outcome.checklist.id, row, identity: wrongActor, env });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);

    /* And the plan survives that refused attempt -- the actor who actually
       raised it can still submit it normally afterward. */
    const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };
    const retry = await submitRow({ id: outcome.checklist.id, row, identity, env });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.status, "created");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__the_checklists_own_title_can_be_edited_before_submitting", async () => {
  /* "The beauty of this workflow is the user gets to confirm and maybe
     modify... I think really the only thing that the user might want to
     tweak is the title" -- the owner's own words, reviewing the checklist.
     Proven directly: plan a row named "Wool Coat", submit it with a
     DIFFERENT title, and confirm the real, created product carries the
     edited title -- never the one the sheet itself proposed. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist");
    assert.match(outcome.checklist.rows[0].title, /Wool Coat/, "the checklist itself still shows the originally planned title");
    const row = outcome.checklist.rows[0].row;

    const result = await submitRow({ id: outcome.checklist.id, row, title: "Winter Parka", identity, env });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "created");
    assert.equal(result.title, "Winter Parka", "the result itself must reflect the edited title, not the planned one");

    const product = f.mirror("SELECT title FROM mirror_product WHERE title = 'Winter Parka'");
    assert.equal(product.length, 1, "the real created product must carry the edited title");
    const original = f.mirror("SELECT title FROM mirror_product WHERE title = 'Wool Coat'");
    assert.equal(original.length, 0, "the originally planned title must never have been used at all");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__a_blank_edited_title_falls_back_to_the_planned_one", async () => {
  /* An empty string is not an edit -- "submitted verbatim... still has to
     clear catalog.create_product's own real checks" only ever applies to a
     REAL replacement; a blank field left by mistake (or a client sending
     "" rather than omitting the field) must never reach Square as an
     actual empty title. */
  const f = await fixture({ actor: "zeynep@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const env = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
  const identity = { email: "zeynep@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "zeynep@vemians.com", role: "manager", env, allowed: new Set(["catalog_add_product_batch"]) },
    );
    const row = outcome.checklist.rows[0].row;

    const result = await submitRow({ id: outcome.checklist.id, row, title: "   ", identity, env });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.title, "Wool Coat", "a blank edit must fall back to the row's own planned title");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__a_named_category_with_no_subcategory_given_is_dropped_too", async () => {
  /* Confirmed directly: both a category AND a subcategory name are
     required to qualify -- a category-only row is dropped even when that
     category is real and already numbered. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let seed, result;
  try {
    seed = await draftProductBatch(f.env, {
      text: "Style #,Category,Subcategory,Description,Price\n72-01-001,Jacket,Blazer,Black Blazer,165.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(seed.created.length, 1);

    result = await draftProductBatch(f.env, {
      text: "title,category,price\nSome Coat,Jacket,50.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0, "category alone is not enough, even though 'Jacket' is real and already numbered");
  assert.equal(result.ready.length, 0);
  assert.equal(result.skipped.length, 0);
});

check("test_PRD_P0_152_style_number_grouping__two_named_rows_matching_the_same_category_become_two_separate_products", async () => {
  /* No style number to share a group base with -- each row is its own
     product, its own auto-generated index, never treated as variants of
     one. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let seed, result;
  try {
    seed = await draftProductBatch(f.env, {
      text: "Style #,Category,Subcategory,Description,Price\n73-01-001,Jacket,Blazer,Black Blazer,165.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(seed.created.length, 1);

    result = await draftProductBatch(f.env, {
      text: "title,category,subcategory,price\nWhite Blazer,Jacket,Blazer,175.00\nGrey Blazer,Jacket,Blazer,180.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 2, "two genuinely separate products, not variants of one");
  const styleIds = f
    .mirror("SELECT style_id FROM mirror_product WHERE title IN ('White Blazer', 'Grey Blazer') ORDER BY style_id")
    .map((r) => r.style_id);
  assert.deepEqual(styleIds, ["73-00-002", "73-00-003"], "each gets its own auto-generated index, never colliding");
});

check("test_PRD_P0_89_batch_preview_confirm__a_named_category_row_previews_with_auto_generated_style_id_and_sku", async () => {
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "title,category,subcategory,price\nWhite Blazer,Jacket,Blazer,175.00\n", "products", "add");
  assert.equal(preview.sampleRows.length, 1, "a named row previews as a real product, not dropped");
  const row = preview.sampleRows[0];
  assert.equal(row.title, "White Blazer");
  assert.equal(row.style_id, "(auto-generated)");
  assert.equal(row.sku, "(auto-generated)");
  assert.equal(row.variants, 1);
});

check("test_PRD_P0_89_batch_preview_confirm__a_named_category_row_with_nothing_to_match_still_previews_not_dropped", async () => {
  /* REVISED AGAIN — the real ingest no longer drops a named row that
     matches nothing existing either; it creates the category/subcategory
     on the fly instead (resolveNamedCategory, batch.js). Category
     creation is a real DB write, so this side-effect-free preview never
     attempts it -- but it must not understate what the real draft will
     actually do by silently omitting the row either, "how the agent
     interpreted everything" (P0-89's own standing goal). It previews the
     same way any other named row does, category/subcategory names shown
     exactly as given. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "title,category,subcategory,price\nMystery Item,Nonexistent Category,Nonexistent Sub,50.00\n", "products", "add");
  assert.equal(preview.sampleRows.length, 1);
  const row = preview.sampleRows[0];
  assert.equal(row.title, "Mystery Item");
  assert.equal(row.category, "Nonexistent Category");
  assert.equal(row.subcategory, "Nonexistent Sub");
});

check("test_PRD_P0_181_resubmit_matching_refinements__a_named_category_row_still_matches_on_a_byte_identical_resubmit", async () => {
  /* A sheet with no style-id column at all -- just Category/Subcategory/
     Title, this shop's own other real convention (resolveNamedCategory).
     Never a hypothetical: the direct "does the simplest possible resubmit
     even work" check underneath the harder cases below. REVISED: a real
     price CHANGE on the resubmit, never byte-identical -- Test-PRD-P0-194-
     resubmit_no_op_suppression now correctly suppresses a truly unchanged
     resubmit into nothing to assert against at all; the match mechanism
     this test actually proves still needs a real row to land. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  const csv1 = "title,category,subcategory,price\nWhite Blazer,Jacket,Blazer,175.00\n";
  const csv2 = "title,category,subcategory,price\nWhite Blazer,Jacket,Blazer,185.00\n";
  let seed, result;
  try {
    seed = await draftProductBatch(f.env, { text: csv1, actor: "keiko@vemians.com", role: "manager", mode: "add" });
    assert.equal(seed.created.length, 1, `expected the seed upload to create, got: ${JSON.stringify(seed)}`);
    result = await draftProductBatch(f.env, { text: csv2, actor: "keiko@vemians.com", role: "manager", mode: "update" });
    assert.equal(result.created.length, 1, `expected the resubmit to update, got: ${JSON.stringify(result)}`);
    assert.equal(result.created[0].action, "updated");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_181_resubmit_matching_refinements__a_stale_style_number_code_reused_by_an_unrelated_category_still_matches_by_name", async () => {
  /* "It's the same [expletive] spreadsheet I used to upload the items in
     the first place... you should be able to find them just by their
     category, subcategory, and name" -- the owner's own words, and the
     real bug the PREVIOUS fix (productsByTitle, above) did not cover:
     `category` is not null here -- resolveCategoryByCode resolves the
     row's own STALE numeric code to a REAL, but UNRELATED, category that
     happens to hold that number now (this shop's own recurring
     renumbering, reusing a freed code), before the correct Category/
     Subcategory NAME columns -- unchanged from the original upload -- ever
     get a say. A category-scoped title search under that wrong category
     can only ever find nothing. Widened exactly like the null-category
     case already was: an empty category-scoped result tries once more,
     catalog-wide by title alone, before giving up. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  const csv = "title,category,subcategory,price,style id\nWhite Blazer,Jacket,Blazer,175.00,01-01-001\n";
  /* A real price CHANGE on the resubmit, never byte-identical -- Test-PRD-
     P0-194-resubmit_no_op_suppression now correctly suppresses a truly
     unchanged resubmit into nothing to assert against; the category/name
     matching mechanism this test actually proves still needs a real row. */
  const csv2 = "title,category,subcategory,price,style id\nWhite Blazer,Jacket,Blazer,185.00,01-01-001\n";
  let seed, result;
  try {
    seed = await draftProductBatch(f.env, { text: csv, actor: "keiko@vemians.com", role: "manager", mode: "add" });
    assert.equal(seed.created.length, 1, `expected the seed upload to create, got: ${JSON.stringify(seed)}`);
    const jacket = f.categories().find((c) => c.name === "Jackets");
    assert.equal(jacket.numeric_id, "01", "sanity: Jackets really does hold the code this sheet's own style number claims");

    /* Simulates a LEGACY product that predates import_style_number
       entirely (this shop's real, already-live catalog, uploaded long
       before this week's matching features existed) -- nulled directly,
       since catalog.create_product itself can no longer produce one this
       way any more. Without this, tier 1 (the exact, literal style-number
       text) would trivially match regardless of anything below, and this
       test would prove nothing. */
    const before = f.mirror("SELECT id, handle FROM mirror_product WHERE title = 'White Blazer'")[0];
    f.mirrorDb._raw.prepare("UPDATE mirror_product SET import_style_number = NULL WHERE id = ?").run(before.id);

    /* Jackets itself gets renumbered away (freeing "01"), and a brand-new,
       totally unrelated top-level category claims the freed code -- both
       ordinary, previously-seen moves in this shop's own workflow, neither
       one touching THIS row's own Category/Subcategory NAME columns at
       all. */
    await approvedCall(f, "catalog.set_category_number", { category_id: jacket.id, numeric_id: "55" });
    const unrelated = (await approvedCall(f, "catalog.create_category", { name: "Handbags", reason: "test" })).data.category;
    await approvedCall(f, "catalog.set_category_number", { category_id: unrelated.id, numeric_id: "01" });

    result = await draftProductBatch(f.env, { text: csv2, actor: "keiko@vemians.com", role: "manager", mode: "update" });
    assert.equal(result.created.length, 1, `expected the resubmit to still find and update the real product, got: ${JSON.stringify(result)}`);
    assert.equal(result.created[0].action, "updated");
    assert.equal(result.created[0].handle, before.handle);

    const products = f.mirror("SELECT id FROM mirror_product WHERE title = 'White Blazer'");
    assert.equal(products.length, 1, "still the one product -- found by name despite the stale, now-reused code, no duplicate created");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_152_style_number_grouping__a_style_number_that_does_not_match_the_pattern_is_ignored_outright", async () => {
  /* "Ignore any rows that do not match our style ID nomenclature... if
     they don't have that style ID pattern, then just ignore that" -- the
     owner's own words, describing exactly a real sheet's own trailing
     footnote (a whole sentence sitting in the Style # cell, no dashes at
     all, and no Category/Subcategory columns filled in either -- not
     eligible for the named-category path below, so dropped outright the
     same as any other row with nothing to build a product from). */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Qty,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,2,30,165\n" +
    "Red rows = color not yet specified (TBD) please confirm color for these items.,,,,,,,,\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 1, "the one real row still goes through");
  assert.equal(result.skipped.length, 0, "the footnote is dropped outright, never reported as a problem");
});

check("test_PRD_P0_152_style_number_grouping__a_totals_rows_blank_style_number_is_dropped_not_a_parked_clash", async () => {
  /* REVISED — a trailing totals line (blank Style #, blank Category, a
     number in Qty) used to take the standalone path like any other
     style-id-less row, and got reported once something else about it
     failed (its own blank price). The owner's own words, having actually
     seen a real totals line preview as a near-empty "product": "Why are
     you including the totals with a bunch of not found?... if you don't
     have the qualifying, like the style ID, just don't include that row
     at all... why would you show that to me?" A blank style-id cell is
     no longer a different KIND of row from a garbled one — both are
     dropped outright by splitProductRecords, silently, never even
     reaching the point where its own blank price would matter. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv =
    "Style #,Category,Subcategory,Description,Color,Size,Qty,Cost (USD),Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,2,30,165\n" +
    ",,,TOTALS,,,3,,\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 1, "only the one real, style-numbered row becomes a product");
  assert.equal(result.ready.length, 0, "the totals row is dropped outright, never parked as a clash");
  assert.equal(result.skipped.length, 0, "dropped silently, not even reported as a skip");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0, "a product missing one of its own sizes is worse than not creating it yet");
  assert.equal(result.skipped.length, 0);
  assert.equal(result.ready.length, 1, "the whole group is parked for a person, not silently skipped");
  assert.match(result.ready[0].summary, /price "not-a-price"/);
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 16, "28 rows, 16 distinct products once grouped by style base");

  const jacket = f.categories().find((c) => c.name === "Jackets");
  const pants = f.categories().find((c) => c.name === "Pants");
  const coat = f.categories().find((c) => c.name === "Coats");
  assert.ok(jacket && jacket.numeric_id === "01" && !jacket.parent_id);
  assert.ok(pants && pants.numeric_id === "03" && !pants.parent_id);
  assert.ok(coat && coat.numeric_id === "04" && !coat.parent_id);

  const subNames = ["Blazers", "Denim Jackets", "Vests", "Dress Pants", "Trench Coats", "Winter Coats"];
  for (const name of subNames) {
    assert.equal(f.categories().filter((c) => c.name === name).length, 1, `${name} must be created exactly once across all its own rows`);
  }
  const blazer = f.categories().find((c) => c.name === "Blazers");
  const vest = f.categories().find((c) => c.name === "Vests");
  const denim = f.categories().find((c) => c.name === "Denim Jackets");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created[0].title, "Bomber Blazer");

  const product = f.mirror("SELECT source_description FROM mirror_product WHERE title = 'Bomber Blazer'")[0];
  assert.equal(product.source_description, "A hand-painted piece");
});

check("test_PRD_P0_152_style_number_grouping__the_preview_shows_the_same_title_fallback_the_real_draft_already_uses", async () => {
  /* "It should assume title is description by default and not expect a
     description at all from these ingests" — the owner's own words,
     reported back after the chat agent saw the PREVIEW's own title come
     back null on a real sheet with no title column (only Description) and
     asked a person which column was meant to be the title, instead of
     trusting the ingest -- draftGroupedProduct/the standalone loop already
     resolve this exact case automatically. previewBatch's own
     mapProductRow just never mirrored that same fallback, so it showed a
     misleadingly empty title for a row the real draft handles perfectly
     fine, prompting a question nobody needed to ask. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const noTitleColumn = await previewBatch(
    f.env,
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
      "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,30,165\n",
    "products",
    "add",
  );
  assert.equal(noTitleColumn.sampleRows[0].title, "Black hand-painted blazer", "the description stands in for the missing title, same as the real draft");
  assert.equal(noTitleColumn.sampleRows[0].description, null, "never shown as a SEPARATE description too -- it already became the title");

  const withTitleColumn = await previewBatch(
    f.env,
    "Style #,Title,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
      "001-001-001-BLK-S,Bomber Blazer,Jacket,Blazer,A hand-painted piece,Black,S,30,165\n",
    "products",
    "add",
  );
  assert.equal(withTitleColumn.sampleRows[0].title, "Bomber Blazer", "a real title column still wins outright");
  assert.equal(withTitleColumn.sampleRows[0].description, "A hand-painted piece", "and keeps its own separate description, unaffected");
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
    result = await draftProductBatch(f.env, { text: csv, actor: "priya@vemians.com", role: "manager" , mode: "add"});
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

/* ─────────────────────────────────────────────────────────────────────────
 * P0-152 (REVISED AGAIN) — "the only hard rule here is that we must have a
 * unique SKU number or ID for each item that's unique to each variation and
 * size... if that's true, then add the product" — the owner's own words,
 * walking back nearly every other per-row skip this file used to enforce
 * (a missing vendor/commission/unit cost, an unresolvable category or
 * subcategory, a malformed commission/quantity/vendor code) into something
 * the row is simply created without, noted rather than blocked on. The one
 * thing left that genuinely CANNOT be defaulted or left out is a real
 * price, and the one thing NEWLY enforced as a hard rule is that a SKU
 * must be unique across the WHOLE shop, not just within one call
 * (catalog.create_product's own check(), extended with variantBySku).
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_152_style_number_grouping__a_vendor_code_given_without_a_vendor_no_longer_blocks_the_row", async () => {
  const f = await fixture({ actor: "sana@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv =
    "title,category,price,style id,vendor code\n" + `Wool Coat,${outerwear.name},45.00,01-04-001,ACME-999\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "sana@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const row = f.mirror("SELECT custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  assert.match(JSON.parse(row.custom_fields)["import notes"], /vendor code "ACME-999" was given without a vendor -- left unset/);
});

check("test_PRD_P0_152_style_number_grouping__an_unparseable_unit_cost_with_a_vendor_is_preserved_not_blocking", async () => {
  const f = await fixture({ actor: "sana@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  f.mirrorDb._raw
    .prepare("INSERT INTO mirror_vendor (id, external_ref, name, commission_pct) VALUES ('vendor-seed', 'sqvendor-seed', 'Acme Mills', 15)")
    .run();
  const csv =
    "title,category,price,style id,vendor,cost\n" + `Wool Coat,${outerwear.name},450.00,01-04-001,Acme Mills,not-a-price\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "sana@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.skipped.length, 0, `expected no skips, got: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.created.length, 1);

  const product = f.mirror("SELECT id, custom_fields FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const customFields = JSON.parse(product.custom_fields);
  assert.match(customFields["import notes"], /unit cost "not-a-price" is not a plain number like 45.00 -- left unset/);
  assert.equal(customFields.cost, "not-a-price", "the raw text is still preserved, same as a vendor-less row already does");
  const variant = f.mirror("SELECT unit_cost_minor FROM mirror_variant WHERE product_id = ?", product.id)[0];
  assert.equal(variant.unit_cost_minor, 0, "never sent as a real argument -- left at the mirror's own default");
});

/* ─────────────────────────────────────────────────────────────────────────
 * "Make sure it doesn't make any more mistakes that are similar" — the
 * owner's own words, after the title/description preview mismatch above.
 * Two more of the same root cause (a rule implemented for the GROUPED,
 * style-numbered path never ported to the STANDALONE, blank-style-id path,
 * or never mirrored into previewBatch's own side-effect-free mapping) —
 * found by auditing every other place this file duplicates logic between
 * the real draft and its own preview, rather than waiting for a second
 * real upload to surface the next one.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_146_dynamic_option_values__revised_a_row_with_no_style_id_is_dropped_before_tbd_even_matters", async () => {
  /* REVISED — this used to prove the STANDALONE path (a row with no style
     number at all) filtered a literal "TBD" Color out of option_values,
     the same way draftGroupedProduct's own variation loop already did.
     There is no more standalone path (splitProductRecords' own header
     comment) -- a row with no style number is dropped before ANY of its
     other columns, TBD included, are ever read for a real write. The
     TBD-filter itself is still fully covered for the only path left
     (draftGroupedProduct's own variation loop, P0-152's own tests). */
  const f = await fixture({ actor: "tamsin@vemians.com", role: "manager" });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const csv = "title,category,price,size,color\n" + `Wool Coat,${outerwear.name},45.00,S,TBD\n`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    result = await draftProductBatch(f.env, { text: csv, actor: "tamsin@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(result.created.length, 0, "no style number at all -- dropped, not a real product row");
  assert.equal(result.ready.length, 0);
  assert.equal(result.skipped.length, 0, "dropped silently, not even reported as a skip");
});

check("test_PRD_P0_152_style_number_grouping__the_preview_shows_the_same_sku_fallback_the_real_draft_already_uses", async () => {
  /* REVISED (Test-PRD-P0-177-fluid_style_id): SKU is now always a real,
     opaque, system-generated code, with no relationship to the sheet's own
     style number at all -- the preview's own sku (and style_id) columns
     read the literal "(auto-generated)", unconditionally, matching the
     real draft's own generateSku/resolveStyleId, never the row's own raw
     text. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(
    f.env,
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
      "001-001-001-BLK-S,Jacket,Blazer,Black hand-painted blazer,Black,S,30,165\n",
    "products",
    "add",
  );
  assert.equal(preview.sampleRows[0].sku, "(auto-generated)");
  assert.equal(preview.sampleRows[0].style_id, "001-001-001 (from the sheet; the shop ID follows its category)");
});

check("test_PRD_P0_152_style_number_grouping__the_preview_drops_a_tbd_color_or_size_the_same_way_the_real_draft_does", async () => {
  /* "Any time you see TBD, just use like a default or no option... it
     doesn't need an option" — the owner's own words. The preview used to
     show a literal "TBD" as though it were a real color/size the product
     would actually end up with. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(
    f.env,
    "Style #,Category,Subcategory,Description,Color,Size,Cost (USD),Retail Price\n" +
      "001-001-003-TBD-S,Jacket,Blazer,Embellished blazer,TBD,S,35,125\n",
    "products",
    "add",
  );
  assert.equal(preview.sampleRows[0].color, null, "TBD previews as genuinely absent, matching what the real product ends up with");
  assert.equal(preview.sampleRows[0].size, "S", "a real size is unaffected");
});

check("test_PRD_P0_152_style_number_grouping__the_preview_says_a_blank_title_will_auto_generate_rather_than_showing_not_found", async () => {
  /* Neither a title NOR a description column at all is still never a real
     blank title in the actual product -- nextAutoTitle names it "<category>
     N" (P0-145). A DB round trip this side-effect-free preview cannot
     reproduce exactly, but showing a bare "(not found)" for something
     that will never actually be missing is the same class of mismatch the
     title/description bug already was. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "category,price,style id\nOuterwear,45.00,01-04-001\n", "products", "add");
  assert.equal(preview.sampleRows[0].title, "(auto-generated from its category)");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-89 (REVISED YET AGAIN) — the preview collapses a style-numbered
 * GROUP into one row, the same way the real draft turns it into one
 * product with several variations, rather than repeating the group's own
 * title/style_id once per raw CSV line. "It should be collapsed. I don't
 * want to see all the variants... just to show that the agent has properly
 * interpreted the product list" — the owner's own words.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_89_batch_preview_confirm__a_style_numbered_group_previews_size_color_price_sku_positionally", async () => {
  /* REVISED — a real person reading this table flagged two things as
     broken: "How can SKUs be not found?... it should never be not found.
     That's a failure mode," and "if I see S/M/L, I should see
     quantity/quantity/quantity... why do I see one/two and then S/M/L?"
     Deduplicating price/quantity by distinct value silently dropped below
     the variant count, breaking the positional correspondence with size;
     and a group's own SKU is never actually unknowable -- every
     style-numbered row already carries its own real one verbatim. Every
     per-variant field is now a "|"-joined list, one entry per row, always
     exactly `variants` long. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const csv =
    "Style #,Category,Description,Color,Size,Retail Price\n" +
    "001-001-001-BLK-S,Jacket,Black hand-painted blazer,Black,S,165.00\n" +
    "001-001-001-BLK-M,Jacket,Black hand-painted blazer,Black,M,165.00\n" +
    "001-001-001-BLK-L,Jacket,Black hand-painted blazer,Black,L,180.00\n";
  const preview = await previewBatch(f.env, csv, "products", "add");

  assert.equal(preview.rowCount, 3, "three raw CSV rows were read");
  assert.equal(preview.sampleRows.length, 1, "all three variants collapse into the one product they actually are");
  const row = preview.sampleRows[0];
  /* REVISED (Test-PRD-P0-177-fluid_style_id): sku/style_id are now always
     the literal "(auto-generated)", unconditionally -- neither one is ever
     a real, already-known value at preview time any more, so the old
     "never not found" guarantee is moot: there is no per-variant sku list
     to show at all. */
  assert.equal(row.style_id, "001-001-001 (from the sheet; the shop ID follows its category)");
  assert.equal(row.sku, "(auto-generated)");
  assert.equal(row.title, "Black hand-painted blazer");
  assert.equal(row.variants, 3, "the plainest possible confirmation that grouping actually happened");
  assert.equal(row.size, "S | M | L", "one entry per variant, in order");
  assert.equal(row.color, "Black | Black | Black", "repeated rather than collapsed, so it still lines up positionally with size");
  assert.equal(row.price, "165.00 | 165.00 | 180.00", "a real price difference between variants is shown, positionally, not deduplicated");
});

check("test_PRD_P0_89_batch_preview_confirm__a_lone_variant_group_still_previews_its_own_real_sku_same_as_before", async () => {
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "Style #,Category,Description,Color,Size,Retail Price\n001-001-002-RED-M,Jacket,Red Blazer,Red,M,150.00\n", "products", "add");
  const row = preview.sampleRows[0];
  assert.equal(row.variants, 1);
  assert.equal(row.sku, "(auto-generated)", "a group of exactly one variant previews the same literal fallback as any other -- never a real value");
  assert.equal(row.size, "M");
  assert.equal(row.color, "Red");
});

check("test_PRD_P0_89_batch_preview_confirm__a_row_with_no_style_id_never_appears_in_the_preview_at_all", async () => {
  /* REVISED — this used to prove a standalone row's own not-yet-minted SKU
     read as "(auto-generated)" rather than the alarming "(not found)"
     ("How can SKUs be not found?... that's a failure mode" -- the owner's
     own words). There is no more standalone preview row at all: "if you
     don't have the qualifying, like the style ID, just don't include that
     row at all... why would you show that to me?" -- the owner's own
     words, having actually seen a real totals/notes line preview as a
     near-empty "product." A row with no style number is dropped by
     previewBatch's own splitProductRecords call, the same as a garbled
     one always was, so this sheet previews as nothing at all. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const preview = await previewBatch(f.env, "title,category,price\nLoose Scarf,Accessories,35.00\n", "products", "add");
  assert.equal(preview.sampleRows.length, 0, "no style number at all -- not a real product row, not previewed either");
});

check("test_PRD_P0_89_batch_preview_confirm__a_style_id_less_row_in_a_mixed_sheet_is_dropped_the_group_still_previews", async () => {
  /* REVISED — this used to prove a grouped product and a standalone row in
     the same sheet each previewed correctly, side by side. There is no
     more standalone row to preview at all -- only the real, style-numbered
     group survives; "Loose Scarf" (no style number) is dropped outright,
     the same as it now is in the real draft too. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const csv =
    "title,Style #,Category,Color,Size,Retail Price\n" +
    ",001-001-003-BLU-S,Jacket,Blue,S,140.00\n" +
    ",001-001-003-BLU-M,Jacket,Blue,M,140.00\n" +
    "Loose Scarf,,Accessories,,,35.00\n";
  const preview = await previewBatch(f.env, csv, "products", "add");

  assert.equal(preview.rowCount, 3);
  assert.equal(preview.sampleRows.length, 1, "only the real, style-numbered group previews -- the style-id-less row is dropped outright");
  /* REVISED (Test-PRD-P0-177-fluid_style_id): style_id is always the
     literal "(auto-generated)" now, so the ONE surviving group is found by
     its own real, distinguishing field (color) instead. */
  const grouped = preview.sampleRows.find((r) => r.color === "Blue | Blue");
  assert.ok(grouped, "the style-numbered group must still be there");
  assert.equal(grouped.style_id, "001-001-003 (from the sheet; the shop ID follows its category)");
  assert.equal(grouped.variants, 2);
  assert.equal(grouped.size, "S | M");
  assert.equal(grouped.sku, "(auto-generated)");
  assert.equal(preview.sampleRows.find((r) => r.title === "Loose Scarf"), undefined, "the style-id-less row never appears in the preview at all");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-194 — "If I upload a CSV file and you see nothing to update because
 * all the values match existing, don't even show me these as an option...
 * you're giving me all of these options that I have to uncheck manually" —
 * the owner's own words. A matched row used to ALWAYS produce its own
 * catalog.update_product checklist entry, even one that would write back
 * the exact same price, cost and title already on file — a true no-op,
 * but still one more item a person had to notice and either approve (for
 * nothing) or uncheck.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_194_resubmit_no_op_suppression__a_byte_identical_resubmit_produces_no_row_at_all", async () => {
  const f = await fixture({ withCommerce: true });
  const csv = "title,category,price,cost,style id,quantity\nWool Coat,Outerwear,450.00,210.00,01-04-060,5\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    second = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.created.length, 0, `a byte-identical resubmit must produce nothing at all, got: ${JSON.stringify(second)}`);
  assert.equal(second.ready.length, 0, `expected no clash either, got: ${JSON.stringify(second)}`);
  assert.equal(second.skipped.length, 0);
});

check("test_PRD_P0_194_resubmit_no_op_suppression__a_real_price_change_still_shows_up_normally", async () => {
  const f = await fixture();
  const csv1 = "title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-061\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    const csv2 = "title,category,price,style id\nWool Coat,Outerwear,475.00,01-04-061\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.created.length, 1, `a real price change must still show up, got: ${JSON.stringify(second)}`);
  assert.equal(second.created[0].action, "updated");
});

check("test_PRD_P0_194_resubmit_no_op_suppression__the_checklist_itself_carries_no_entry_for_a_no_op_row", async () => {
  /* The real production path (dispatch -> stashed plan -> submit -> a
     second dispatch), not a direct draftProductBatch call -- proving the
     suppression happens before a person would ever see a checkbox to
     uncheck, not merely in the after-the-fact results table. */
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const csv = "title,category,price,style id\nWool Coat,Outerwear,450.00,01-04-062\n";
  const identity = { email: "priya@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let outcome;
  try {
    const env1 = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
    const first = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "priya@vemians.com", role: "manager", env: env1, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(first.kind, "checklist");
    const submitted = await submitRow({ id: first.checklist.id, row: first.checklist.rows[0].row, identity, env: env1 });
    assert.equal(submitted.status, "created", JSON.stringify(submitted));

    const env2 = { ...f.env, ASSETS: await assetsFixtureWithRow({ extracted_text: csv }) };
    outcome = await dispatch(
      "catalog_update_product_batch",
      { asset_id: "ast_1" },
      { actor: "priya@vemians.com", role: "manager", env: env2, allowed: new Set(["catalog_update_product_batch"]) },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(outcome.kind, "result", `a sheet with nothing to update must never produce a checklist, got: ${JSON.stringify(outcome)}`);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-179 — "If I resubmit all of the the um, the item like spreadsheet,
 * will you update all of the costs in a proper location and all the
 * missing information that matches?" — the owner's own question, which
 * turned out to have no real answer at all: draftGroupedProduct used to
 * call catalog.create_product unconditionally, so resubmitting the exact
 * same sheet a second time minted a second, duplicate product every time.
 *
 * "The matching is very simple. We match by style ID... if it exists and
 * you're putting in the same data, you just update it" — corrected, once
 * the LIVE style_id turned out to be exactly the mutable, category-derived
 * fact P0-177's own fluid_style_id redesign made it (the owner's own,
 * earlier words): the spreadsheet's own literal style-number TEXT is what
 * never changes, captured once at creation as mirror_product.
 * import_style_number and never touched again by anything — a later
 * category move/renumber moves the live style_id, never this. "No, no,
 * all the sizes are the same, all the options are the same, you match
 * them" -- confirmed the finer point: matching happens at the PRODUCT
 * level by import_style_number, and at the VARIATION level by matching
 * each row's own Color/Size against the product's CURRENT variations
 * (variantsWithOptionsOf/sameOptions, batch.js), never by row position.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_179_import_style_number_matching__resubmitting_the_same_style_number_updates_instead_of_duplicating", async () => {
  const f = await fixture();
  const csv1 = "title,category,price,cost,style id\nWool Coat,Outerwear,450.00,210.00,01-04-001\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let first;
  let second;
  try {
    first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1, `expected the first submission to create, got: ${JSON.stringify(first)}`);
    assert.equal(first.created[0].action, "created");

    /* Resubmitted: same style number, a real price/cost CHANGE. */
    const csv2 = "title,category,price,cost,style id\nWool Coat,Outerwear,475.00,225.00,01-04-001\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.skipped.length, 0, `expected no skips, got: ${JSON.stringify(second.skipped)}`);
  assert.equal(second.created.length, 1, "the resubmit still counts as one outcome, an update rather than a create");
  assert.equal(second.created[0].action, "updated");
  assert.equal(second.created[0].handle, first.created[0].handle, "the SAME product, never a second one");

  const products = f.mirror("SELECT id, handle FROM mirror_product WHERE title = 'Wool Coat'");
  assert.equal(products.length, 1, "still only one product exists -- the resubmit never duplicated it");

  const variant = f.mirror("SELECT price_minor, unit_cost_minor FROM mirror_variant WHERE product_id = ?", products[0].id)[0];
  assert.equal(variant.price_minor, 47500, "the resubmit's own new price actually landed");
  assert.equal(variant.unit_cost_minor, 22500, "the resubmit's own new cost actually landed, in the proper (vendor_information) location");
});

check("test_PRD_P0_179_import_style_number_matching__each_size_is_matched_by_its_own_color_size_never_by_row_position", async () => {
  const f = await fixture();
  const csv1 =
    "title,category,price,style id,color,size\n" +
    "Wool Coat,Outerwear,100.00,01-04-002,Black,S\n" +
    "Wool Coat,Outerwear,110.00,01-04-002,Black,M\n" +
    "Wool Coat,Outerwear,120.00,01-04-002,Black,L\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1, `expected the first submission to create, got: ${JSON.stringify(first)}`);

    /* Resubmitted with the ROWS REORDERED (L, then S, then M) and new
       prices — a position-based match would silently mismatch every
       price; only a real Color/Size match gets each one right. */
    const csv2 =
      "title,category,price,style id,color,size\n" +
      "Wool Coat,Outerwear,999.00,01-04-002,Black,L\n" +
      "Wool Coat,Outerwear,105.00,01-04-002,Black,S\n" +
      "Wool Coat,Outerwear,115.00,01-04-002,Black,M\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.skipped.length, 0, `expected no skips, got: ${JSON.stringify(second.skipped)}`);
  assert.equal(second.created.length, 1);
  assert.equal(second.created[0].action, "updated");

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variants = f.mirror("SELECT title, price_minor, options FROM mirror_variant WHERE product_id = ?", product.id);
  const bySize = Object.fromEntries(variants.map((v) => [JSON.parse(v.options).Size, v.price_minor]));
  assert.equal(bySize.S, 10500, "matched by its own Color/Size, not by the row's new position (1st)");
  assert.equal(bySize.M, 11500, "matched by its own Color/Size, not by the row's new position (3rd)");
  assert.equal(bySize.L, 99900, "matched by its own Color/Size, not by the row's new position (2nd)");
  assert.equal(variants.length, 3, "still exactly the three original variations, none added or removed");
});

check("test_PRD_P0_179_import_style_number_matching__a_genuinely_new_size_on_a_resubmit_is_added_not_a_clash", async () => {
  /* REVISED: "if there is additional options or additional sizes added to
     the same style ID, we're just adding more to the existing item... we're
     not rejecting them, we're adding to them" -- the owner's own words.
     This used to park the whole row as a clash ("XL is not an existing
     variation... add a new one by hand first"); catalog.update_product can
     now actually add it, given a real price to add it with. */
  const f = await fixture();
  const csv1 = "title,category,price,style id,size\nWool Coat,Outerwear,100.00,01-04-003,S\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1);

    /* Resubmitted with an extra row for a size that never existed before. */
    const csv2 =
      "title,category,price,style id,size\n" +
      "Wool Coat,Outerwear,100.00,01-04-003,S\n" +
      "Wool Coat,Outerwear,120.00,01-04-003,XL\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 0, "a real price means there is nothing left for a person to resolve by hand");
  assert.equal(second.created.length, 1, `expected the new size to actually be added, got: ${JSON.stringify(second)}`);
  assert.equal(second.created[0].action, "updated");

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variants = f.mirror("SELECT options, price_minor FROM mirror_variant WHERE product_id = ?", product.id);
  assert.equal(variants.length, 2, "the original S must survive, and the new XL must actually land");
  const xl = variants.find((v) => JSON.parse(v.options).Size === "XL");
  assert.ok(xl, "XL must actually exist as a real variation now");
  assert.equal(xl.price_minor, 12000);
  const s = variants.find((v) => JSON.parse(v.options).Size === "S");
  assert.equal(s.price_minor, 10000, "the original S variation must be untouched");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-193 — "If you're not able to add quantities to a product, it's a fail
 * mode and you cannot add that product and have to stop and ask for
 * clarification" -- the owner's own words. A brand-new size/color added on
 * a resubmit used to have no quantity mechanism at all (catalog.update_
 * product's own VARIATION_WITH_ID never had the field) -- it always
 * silently started at 0, with no tracking and no warning, no matter what
 * the sheet said, the exact failure mode this whole system exists to
 * prevent.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_193_new_variation_quantity_required__a_real_quantity_on_a_brand_new_size_actually_lands_as_real_stock", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,size\nWool Coat,Outerwear,100.00,01-04-050,S\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    const csv2 =
      "title,category,price,style id,size,quantity\n" +
      "Wool Coat,Outerwear,100.00,01-04-050,S,\n" +
      "Wool Coat,Outerwear,120.00,01-04-050,XL,6\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 0, `expected no clash, got: ${JSON.stringify(second)}`);
  assert.equal(second.created.length, 1, `expected the new size to actually be added, got: ${JSON.stringify(second)}`);

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variants = f.mirror("SELECT sku, options FROM mirror_variant WHERE product_id = ?", product.id);
  const xl = variants.find((v) => JSON.parse(v.options).Size === "XL");
  assert.ok(xl, "XL must actually exist as a real variation now");
  assert.equal(f.onHand(xl.sku), 6, "the sheet's own real quantity for the new size must actually land as real stock, never silently 0");
});

check("test_PRD_P0_193_new_variation_quantity_required__a_blank_quantity_on_a_brand_new_size_still_defaults_to_one_not_zero", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,size\nWool Coat,Outerwear,100.00,01-04-051,S\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    /* No quantity column at all -- "quantity is not required at all...
       assume 1," the same tolerance a fresh create already has. */
    const csv2 =
      "title,category,price,style id,size\n" +
      "Wool Coat,Outerwear,100.00,01-04-051,S\n" +
      "Wool Coat,Outerwear,120.00,01-04-051,XL\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 0, `expected no clash, got: ${JSON.stringify(second)}`);
  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variants = f.mirror("SELECT sku, options FROM mirror_variant WHERE product_id = ?", product.id);
  const xl = variants.find((v) => JSON.parse(v.options).Size === "XL");
  assert.ok(xl, "XL must still exist");
  assert.equal(f.onHand(xl.sku), 1, "a blank quantity cell still defaults to 1, never the old silent 0");
});

check("test_PRD_P0_193_new_variation_quantity_required__an_explicit_zero_on_a_brand_new_size_is_a_clash_not_a_silent_add", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,size\nWool Coat,Outerwear,100.00,01-04-052,S\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    const csv2 =
      "title,category,price,style id,size,quantity\n" +
      "Wool Coat,Outerwear,100.00,01-04-052,S,\n" +
      "Wool Coat,Outerwear,120.00,01-04-052,XL,0\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.created.length, 0, `an explicit 0 on a brand-new size must never silently add it, got: ${JSON.stringify(second)}`);
  assert.equal(second.ready.length, 1, `expected a parked clash asking for clarification, got: ${JSON.stringify(second)}`);
  assert.match(second.ready[0].summary, /quantity is 0/i, `expected the zero-quantity reason, got: ${JSON.stringify(second.ready[0])}`);

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variants = f.mirror("SELECT options FROM mirror_variant WHERE product_id = ?", product.id);
  assert.equal(variants.length, 1, "XL must not have been added at all while its own quantity is unresolved");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-179, REVISED AGAIN — "I just want you to resubmit the existing CSV and
 * update the products to make them all in-house and update their costs. Why
 * is it such a fucking problem?" -- the owner's own words, after a whole
 * resubmit group got blocked outright because NOT ONE of its rows named a
 * size/color the product had on file (a legacy product with no real
 * Size/Color structure yet, the common real case, not a partial mismatch).
 * Vendor and cost do not depend on any variation match at all --
 * catalog.set_square_attributes applies both UNIFORMLY to whatever
 * variations a product already has -- so draftProductUpdate falls back to
 * it, rather than a blocking clash, when EVERY row missed and gave no real
 * price to add a new variation with either.
 *
 * REVISED ONCE MORE — "we're not rejecting them, we're adding to them."
 * A wholly new color/size with a REAL PRICE is no longer a miss needing a
 * person at all: it is simply added, cost and all (see the test directly
 * below). The vendor/cost-only fallback here now only matters for the
 * narrower case it was always really about: every row missing AND no real
 * price given to add any of them with either.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_179_import_style_number_matching__a_wholly_new_color_with_a_real_price_is_added_with_vendor_and_cost", async () => {
  const f = await fixture();
  const csv1 = "title,category,price,style id,size\nWool Coat,Outerwear,100.00,01-04-006,S\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    /* A LEGACY product, predating the "every product gets a real vendor"
       default -- vendor_id nulled by hand, the way a real pre-existing
       Square item can genuinely be on file (P0-185's own tests seed the
       same way, for the same reason: a real, already-synced fact, not
       something any code path here could itself have produced). */
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    f.mirrorDb._raw.prepare("UPDATE mirror_variant SET vendor_id = NULL WHERE product_id = ?").run(product.id);

    /* Resubmitted with a wholly different size this product has never had
       at all, a real price, and a real cost. */
    const csv2 = "title,category,price,style id,size,cost\nWool Coat,Outerwear,130.00,01-04-006,XL,42.00\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 0, "a real price means there is nothing for a person to resolve by hand");
  assert.equal(second.created.length, 1, `expected XL to actually be added, got: ${JSON.stringify(second)}`);
  assert.equal(second.created[0].action, "updated");

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variants = f.mirror("SELECT options, price_minor, unit_cost_minor, vendor_id FROM mirror_variant WHERE product_id = ?", product.id);
  assert.equal(variants.length, 2, "the original S must survive, and XL must actually be added");
  const xl = variants.find((v) => JSON.parse(v.options).Size === "XL");
  assert.ok(xl, "XL must actually exist as a real variation now, not merely be named in a note");
  assert.equal(xl.price_minor, 13000);
  assert.equal(xl.unit_cost_minor, 4200, "the given cost lands on the new variation itself");
  const vendor = f.mirror("SELECT name FROM mirror_vendor WHERE id = ?", xl.vendor_id)[0];
  assert.equal(vendor.name, "In-house");
});

check("test_PRD_P0_179_import_style_number_matching__every_row_missing_with_no_real_price_still_falls_back_to_vendor_and_cost_only", async () => {
  /* The narrower case the fallback above was always really for: nothing to
     ADD a new variation with (no real price given), but a real cost still
     ought to land somewhere -- applied uniformly to whatever the product
     already has, same as catalog.set_square_attributes always does. */
  const f = await fixture();
  const csv1 = "title,category,price,style id,size\nWool Coat,Outerwear,100.00,01-04-007,S\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    f.mirrorDb._raw.prepare("UPDATE mirror_variant SET vendor_id = NULL WHERE product_id = ?").run(product.id);

    /* A new size, a real cost, but NO price at all for the new size --
       nothing to add a new variation with. */
    const csv2 = "title,style id,size,cost\nWool Coat,01-04-007,XL,42.00\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 0, "no longer blocked outright -- vendor/cost do not depend on any variation matching");
  assert.equal(second.created.length, 1, `expected the vendor/cost update to go through, got: ${JSON.stringify(second)}`);
  assert.equal(second.created[0].action, "updated");
  assert.match(second.created[0].summary, /In-house/i, "the vendor-less legacy product still gets defaulted to In-house");
  assert.match(second.created[0].summary, /XL/, "the specific new size is still named, so a person knows what still needs adding by hand");

  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variants = f.mirror("SELECT options, unit_cost_minor, vendor_id FROM mirror_variant WHERE product_id = ?", product.id);
  assert.equal(variants.length, 1, "the ORIGINAL size is untouched -- XL was never silently added with no real price");
  assert.equal(JSON.parse(variants[0].options).Size, "S");
  assert.equal(variants[0].unit_cost_minor, 4200, "cost still landed on the product's own existing variation");
  const vendor = f.mirror("SELECT name FROM mirror_vendor WHERE id = ?", variants[0].vendor_id)[0];
  assert.equal(vendor.name, "In-house");
});

check("test_PRD_P0_179_import_style_number_matching__stock_quantity_is_never_touched_by_a_resubmit", async () => {
  /* REVISED: still true exactly as stated -- catalog.update_product itself
     never pushes a second inventory count, here or anywhere. A real stock
     DISCREPANCY on a matched row is now reconciled too, but only via its
     OWN separate, gated inventory.adjust row (Test-PRD-P0-190-
     quantity_reconciliation_on_resubmit's own suite, below) -- never folded
     into this call. This fixture has no COMMERCE binding at all (the
     reconciliation's own `env.COMMERCE` guard), so that separate row is
     never even considered here; the two are independent regression suites
     on purpose. */
  const f = await fixture();
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-004,7\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1);
    const pushCountBefore = f.calls().filter((c) => c.path === "/v2/inventory/changes/batch-create").length;
    assert.equal(pushCountBefore, 1, "the initial create really did push a real stock count");

    /* Resubmitted with a DIFFERENT quantity -- this codebase's own
       inventory-ledger guarantee: no write outside inventory.adjust ever
       silently changes stock, and this resubmit is no exception. */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-004,99\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
    assert.equal(second.created.length, 1);
    assert.equal(second.created[0].action, "updated");

    const pushCountAfter = f.calls().filter((c) => c.path === "/v2/inventory/changes/batch-create").length;
    assert.equal(pushCountAfter, pushCountBefore, "the resubmit's own new quantity column must never push a second inventory count");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-190 — a matched resubmit's own quantity discrepancy is reconciled, via
 * its OWN separate inventory.adjust row, never folded into
 * catalog.update_product. "If there are discrepancies, I should upload the
 * same file again... you should just be updating the number of units,
 * because that's the only change" -- the owner's own words, after a real
 * item went live with zero units (now Test-PRD-P0-31's own creation-time
 * guard) and a resubmit alone could not fix it.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_190_quantity_reconciliation_on_resubmit__a_different_quantity_on_a_matched_row_queues_its_own_inventory_adjust", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-020,3\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1, `expected a create, got: ${JSON.stringify(first)}`);

    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;
    assert.equal(f.onHand(sku), 3, "the initial create's own quantity really landed in the ledger");

    /* Resubmitted: same style number, same everything else, a REAL
       quantity discrepancy (3 on file, 7 on the sheet). */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-020,7\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.skipped.length, 0, `expected no skips, got: ${JSON.stringify(second.skipped)}`);
  /* REVISED: price is unchanged between the two sheets -- Test-PRD-P0-194-
     resubmit_no_op_suppression now correctly suppresses the catalog edit
     itself (a true no-op on its own). The stock discrepancy itself is no
     longer auto-applied either -- current on hand (3) is not the known-bad
     0, so Test-PRD-P0-195-quantity_confirmation_required correctly treats a
     real sale between the sheet being made and this resubmit as the
     ordinary explanation, and parks the correction for a person to confirm
     on purpose rather than overwriting it on the sheet's own say-so. */
  assert.equal(second.created.length, 0, `expected no auto-apply, got: ${JSON.stringify(second)}`);
  assert.equal(second.ready.length, 1, `expected the stock adjustment parked for confirmation, got: ${JSON.stringify(second)}`);
  assert.match(second.ready[0].summary, /on hand is already 3, not 0/i, `expected the needs-confirmation reason, got: ${JSON.stringify(second.ready[0])}`);
  assert.equal(f.onHand(sku), 3, "stock must stay exactly where it was until a person explicitly confirms the sheet's own corrected count");
});

check("test_PRD_P0_190_quantity_reconciliation_on_resubmit__a_resubmit_with_the_same_quantity_queues_no_adjustment_at_all", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-021,5\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;

    /* Resubmitted with the IDENTICAL quantity -- "if everything was
       matching exactly, then you just skip it," the owner's own words. */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-021,5\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.created.length, 1, `an unchanged quantity must queue nothing extra, got: ${JSON.stringify(second)}`);
  assert.equal(second.created[0].action, "updated");
  assert.equal(f.onHand(sku), 5, "stock is untouched when the sheet already agrees with it");
});

check("test_PRD_P0_190_quantity_reconciliation_on_resubmit__a_blank_quantity_cell_on_resubmit_still_means_no_change", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-022,4\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;

    /* Resubmitted with NO quantity column at all -- a price-only correction,
       never a reason to touch stock on its own. */
    const csv2 = "title,category,price,style id\nWool Coat,Outerwear,130.00,01-04-022\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.created.length, 1, `a blank quantity cell must queue nothing extra, got: ${JSON.stringify(second)}`);
  assert.equal(f.onHand(sku), 4, "a blank cell is never a reason to zero out or otherwise move real stock");
});

check("test_PRD_P0_190_quantity_reconciliation_on_resubmit__an_unparseable_quantity_leaves_stock_alone_without_blocking_the_row", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-023,6\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;

    /* REVISED: a real price change alongside the typo'd quantity --
       Test-PRD-P0-194-resubmit_no_op_suppression now correctly suppresses
       a row with NEITHER a real price change NOR a real quantity change,
       leaving nothing to assert "still goes through" against; a real price
       change is what proves the garbage quantity cell did not block it. */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-023,some\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.skipped.length, 0, "a typo'd quantity cell is not a reason to skip the row");
  assert.equal(second.created.length, 1, `the real price update must still go through, got: ${JSON.stringify(second)}`);
  assert.equal(second.created[0].action, "updated");
  assert.equal(f.onHand(sku), 6, "an unparseable cell is never guessed at -- stock stays exactly where it was");
});

check("test_PRD_P0_190_quantity_reconciliation_on_resubmit__with_no_commerce_binding_configured_nothing_is_queued_or_blocked", async () => {
  /* The exact fixture every OTHER P0-179 test already uses -- no COMMERCE
     binding at all. A real deployment always has one; this only proves the
     feature degrades to its old behavior rather than throwing when it does
     not, matching exportProductsCsv's own same tolerance. */
  const f = await fixture();
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-024,2\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    /* REVISED: a real price change alongside the quantity column --
       Test-PRD-P0-194-resubmit_no_op_suppression now correctly suppresses
       a row with no commerce binding AND no other real change, leaving
       nothing to assert "still goes through" against. */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-024,9\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.created.length, 1, "with no commerce binding, nothing can be reconciled -- the real price update alone still goes through");
  assert.equal(second.created[0].action, "updated");
});

check("test_PRD_P0_190_quantity_reconciliation_on_resubmit__the_real_checklist_submit_path_does_not_reject_the_stock_row_over_an_unrelated_title_resend", async () => {
  /* A REAL production bug, found live: the browser's own checklistCard()
     (views.js) always resends the title box's CURRENT value on submit, for
     EVERY row, whether or not a person actually edited it (checkedItems()
     reads every li's own title input unconditionally). submitProductBatchRow
     used to fold that into `args` for every row regardless of its tool --
     fine for catalog.create_product/catalog.update_product, which both
     genuinely have a `title` field, but inventory.adjust's own schema is a
     closed { variant_id, delta }. Every stock-adjustment row was refused
     ("unknown argument 'title'") and silently parked as "needs a person"
     instead of ever moving stock -- the owner's own report, resubmitting a
     corrected sheet and the unit count still not moving. Reproduced here
     through the REAL chat dispatch -> checklist -> HTTP submit-row path
     (not a direct draftProductBatch call, which never touches editedTitle
     at all and could never have caught this -- the identical shape of gap
     Test-PRD-P0-180's own header comment already describes). */
  const f = await fixture({ withCommerce: true });
  const worker = (await import("../src/index.js")).default;
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-030,3\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;
    assert.equal(f.onHand(sku), 3);

    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-030,8\n";
    const assets = await assetsFixtureWithRow({ extracted_text: csv2 });

    const outcome = await dispatch(
      "catalog_update_product_batch",
      { asset_id: "ast_1" },
      { actor: "mara@vemians.com", role: "manager", env: { ...f.env, ASSETS: assets }, allowed: new Set(["catalog_update_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist", `expected a checklist, got: ${JSON.stringify(outcome)}`);
    /* REVISED: price is unchanged between the two sheets -- Test-PRD-P0-194-
       resubmit_no_op_suppression now correctly suppresses the catalog edit
       itself as a no-op, leaving only the one row this test is actually
       about: the stock adjustment. */
    assert.equal(outcome.checklist.rows.length, 1, `expected only the stock row, got: ${JSON.stringify(outcome.checklist.rows)}`);
    const stockRow = outcome.checklist.rows.find((r) => /stock by/.test(r.summary));
    assert.ok(stockRow, `expected a stock-adjustment row in the checklist, got: ${JSON.stringify(outcome.checklist.rows)}`);

    /* The real browser always sends `title`, unconditionally -- THE POINT
       of this test is that this must no longer matter for this row. */
    const runId = await httpStartRun(worker, { ...f.env, ...HTTP_ENV_EXTRA, ASSETS: assets }, outcome.checklist.id, [stockRow.row]);
    const res = await worker.fetch(
      new Request("http://localhost/agent/batch-submit-row", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER_CLAIMS), "content-type": "application/json" },
        body: JSON.stringify({ id: outcome.checklist.id, runId, row: stockRow.row, title: stockRow.title }),
      }),
      { ...f.env, ...HTTP_ENV_EXTRA, ASSETS: assets },
    );
    const text = await res.text();
    assert.equal(res.status, 200, `expected a real 200, got ${res.status}: ${text}`);
    const data = JSON.parse(text);
    assert.equal(data.ok, true);
    assert.equal(data.status, "updated", `the stock row must actually apply, never park over an unrelated title resend, got: ${text}`);
    assert.equal(f.onHand(sku), 8, "the real ledger must reflect the sheet's own corrected count");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-191 — "if we give you a spreadsheet and it says there's zero units for
 * all sizes, then don't add it, because there's something wrong with
 * that... why would we even add something that has no units" -- the
 * owner's own words, after a resubmit's own checklist reported "updating"
 * while Embellished Blazer still read 0 units for every size on the sheet
 * itself. Test-PRD-P0-31's own creation-time guard already refuses this for
 * a BRAND NEW product; a matched resubmit had no equivalent — quantity
 * reconciliation (Test-PRD-P0-190) only ever acts on a real DISAGREEMENT,
 * so a sheet whose every size already, consistently read 0 looked
 * identical to "nothing to reconcile," the correct behavior for an
 * unrelated price-only resubmit but the wrong one here.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_191_all_zero_resubmit_refused__every_size_reading_0_on_a_resubmit_is_a_clash_not_a_silent_update", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-040,3\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;
    assert.equal(f.onHand(sku), 3);

    /* The exact live scenario: a resubmit whose own quantity column reads
       0 -- whether that is a real reduction from stock on hand, or (as it
       was for Embellished Blazer) already 0 and never actually fixed. */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,120.00,01-04-040,0\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.created.length, 0, `a 0-everywhere resubmit must never silently apply, got: ${JSON.stringify(second)}`);
  assert.equal(second.ready.length, 1, `expected one parked clash, got: ${JSON.stringify(second)}`);
  assert.match(second.ready[0].summary, /every size .* reads 0 units/i, `expected the all-zero reason, got: ${JSON.stringify(second.ready[0])}`);
  assert.equal(f.onHand(sku), 3, "stock must stay exactly where it was -- never silently reduced to 0 on the strength of a suspect sheet");
});

check("test_PRD_P0_191_all_zero_resubmit_refused__one_sold_out_size_among_others_in_stock_is_never_flagged", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 =
    "title,category,price,style id,size,quantity\n" +
    "Wool Coat,Outerwear,100.00,01-04-041,S,3\n" +
    "Wool Coat,Outerwear,100.00,01-04-041,M,5\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let skuS;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    const variants = f.mirror("SELECT sku, options FROM mirror_variant WHERE product_id = ?", product.id);
    skuS = variants.find((v) => JSON.parse(v.options).Size === "S").sku;

    /* S has genuinely sold out; M is still in stock -- ordinary day-to-day
       inventory, never a reason to block the update to either size. */
    const csv2 =
      "title,category,price,style id,size,quantity\n" +
      "Wool Coat,Outerwear,100.00,01-04-041,S,0\n" +
      "Wool Coat,Outerwear,100.00,01-04-041,M,5\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  /* REVISED: S's own 3 -> 0 is a real, nonzero-current quantity disagreement
     -- Test-PRD-P0-195-quantity_confirmation_required now correctly parks it
     for a person to confirm on purpose, a real sale since the sheet was made
     being the ordinary explanation, rather than auto-applying it the way a
     known-bad 0 already safely would. The POINT of this test still holds
     either way: that park must never be the all-zero clash P0-191 itself
     guards against -- a single size's own stockout is never read as "every
     size reads 0," here or on the needs-confirmation path alike. */
  assert.equal(second.created.length, 0, `expected no auto-apply, got: ${JSON.stringify(second)}`);
  assert.equal(second.ready.length, 1, `expected S's own needs-confirmation park, got: ${JSON.stringify(second)}`);
  assert.doesNotMatch(second.ready[0].summary, /every size .* reads 0 units/i, "a single sold-out size must never be read as the all-zero clash");
  assert.match(second.ready[0].summary, /on hand is already 3, not 0/i, `expected S's own needs-confirmation reason, got: ${JSON.stringify(second.ready[0])}`);
  assert.equal(f.onHand(skuS), 3, "stock must stay exactly where it was until a person explicitly confirms the sheet's own 0");
});

check("test_PRD_P0_191_all_zero_resubmit_refused__the_real_price_change_is_never_half_applied", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-042,3\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);

    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,150.00,01-04-042,0\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 1, "expected an editable approval link, not a silent partial apply");
  assert.ok(second.ready[0].url, "expected a real, openable approval link");
  const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
  const variant = f.mirror("SELECT price_minor FROM mirror_variant WHERE product_id = ?", product.id)[0];
  assert.equal(variant.price_minor, 10000, "the price must NOT have silently changed while quantity was held for review -- it's all one parked decision");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-195 — a quantity correction on a resubmit is only ever auto-applied
 * when current on hand is the known-bad 0 (Test-PRD-P0-31's own standing
 * rule); any other disagreement needs a person to say so on purpose. "If we
 * have a product and we sold it and the quantities decreased, and then I
 * upload the original CSV file that has the original quantities, we don't
 * necessarily want to update them because they may have been sold
 * already... the only products we want to be updating by default are the
 * ones that have wrong values, like if it's zero quantities we want to
 * update those by default. All the other ones they should show up but they
 * should be unchecked -- I should tell you specifically that I want to
 * update these" -- the owner's own words.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_195_quantity_confirmation_required__a_known_bad_zero_on_hand_still_auto_applies_without_confirmation", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-060,3\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;
    assert.equal(f.onHand(sku), 3);

    /* Simulates a real sale that sold out the item entirely BETWEEN the
       create and this resubmit -- an append-only ledger row the same shape
       a real Square sale would post (inventory_level is a derived VIEW,
       Test-PRD-P0-31's own non-destructive ledger -- there is no column to
       overwrite here even for a test). */
    f.commerceDb._raw
      .prepare(
        "INSERT INTO inventory_adjustment (id, sku, location_id, delta, reason, actor) VALUES (?, ?, 'main', -3, 'sale', 'square-sync')",
      )
      .run(crypto.randomUUID(), sku);
    assert.equal(f.onHand(sku), 0, "sanity: the ledger now reads the known-bad 0");

    /* The SAME original sheet, resubmitted -- its own quantity (3) now
       disagrees with current on hand (0), and 0 is always a failure mode,
       never a real count worth preserving. */
    second = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(second.ready.length, 0, `a known-bad 0 must never need confirmation, got: ${JSON.stringify(second)}`);
  assert.equal(second.created.length, 1, `expected the stock correction to auto-apply, got: ${JSON.stringify(second)}`);
  assert.match(second.created[0].summary, /stock by \+3 \(0 -> 3\)/, `expected the real correction, got: ${JSON.stringify(second.created[0])}`);
  assert.equal(f.onHand(sku), 3, "a known-bad 0 is corrected without waiting for anyone to confirm it");
});

check("test_PRD_P0_195_quantity_confirmation_required__the_checklist_path_shows_the_row_unchecked_but_applies_it_once_explicitly_submitted", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-061,3\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;
    assert.equal(f.onHand(sku), 3);

    const assets = await assetsFixtureWithRow({
      extracted_text: "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-061,9\n",
    });
    const outcome = await dispatch(
      "catalog_update_product_batch",
      { asset_id: "ast_1" },
      { actor: "mara@vemians.com", role: "manager", env: { ...f.env, ASSETS: assets }, allowed: new Set(["catalog_update_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist", `expected a checklist, got: ${JSON.stringify(outcome)}`);
    const stockRow = outcome.checklist.rows.find((r) => /stock by/.test(r.summary));
    assert.ok(stockRow, `expected a stock-adjustment row in the checklist, got: ${JSON.stringify(outcome.checklist.rows)}`);
    /* The POINT of this test: the row is shown, same checklist, but flagged
       unchecked-by-default -- never silently folded into the ready-to-go set
       the way a price/title correction already safely is. */
    assert.equal(stockRow.needsConfirmation, true, `expected the row flagged for confirmation, got: ${JSON.stringify(stockRow)}`);
    assert.match(stockRow.confirmReason, /on hand is already 3, not 0/i, `expected the needs-confirmation reason, got: ${JSON.stringify(stockRow)}`);
    assert.equal(f.onHand(sku), 3, "nothing applies merely by appearing in the checklist");

    /* A person explicitly checks the box and submits THIS row -- the real
       browser's own batch-submit-row call, driven here exactly the way
       Test-PRD-P0-190's own checklist-submit-path test already does. */
    const worker = (await import("../src/index.js")).default;
    const runId = await httpStartRun(worker, { ...f.env, ...HTTP_ENV_EXTRA, ASSETS: assets }, outcome.checklist.id, [stockRow.row]);
    const res = await worker.fetch(
      new Request("http://localhost/agent/batch-submit-row", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER_CLAIMS), "content-type": "application/json" },
        body: JSON.stringify({ id: outcome.checklist.id, runId, row: stockRow.row, title: stockRow.title }),
      }),
      { ...f.env, ...HTTP_ENV_EXTRA, ASSETS: assets },
    );
    const data = JSON.parse(await res.text());
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.status, "updated", "explicitly submitting a needs-confirmation row must actually apply it, never re-park it");
    assert.equal(f.onHand(sku), 9, "the person's own explicit opt-in applies the sheet's own corrected count");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_195_quantity_confirmation_required__the_direct_upload_path_parks_it_as_a_clash_and_applies_only_once_approved", async () => {
  const f = await fixture({ withCommerce: true });
  const csv1 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-062,3\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let second;
  let sku;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1);
    const product = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'")[0];
    sku = f.mirror("SELECT sku FROM mirror_variant WHERE product_id = ?", product.id)[0].sku;
    assert.equal(f.onHand(sku), 3);

    /* The direct, no-checkbox /products/batch upload -- nothing here can
       default a checkbox to unchecked, so a needs-confirmation row is
       reclassified into an ordinary clash instead, the same gate every
       other low-confidence row already gets. */
    const csv2 = "title,category,price,style id,quantity\nWool Coat,Outerwear,100.00,01-04-062,11\n";
    second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
    assert.equal(second.created.length, 0, `expected no auto-apply, got: ${JSON.stringify(second)}`);
    assert.equal(second.ready.length, 1, `expected a parked clash, got: ${JSON.stringify(second)}`);
    assert.ok(second.ready[0].url, "expected a real, openable approval link");
    assert.equal(f.onHand(sku), 3, "stock must stay exactly where it was until the clash is approved");

    const id = second.ready[0].url.split("/").pop();
    const approver = { email: "owner@vemians.com", role: "owner", verified: true };
    const result = await approvePending(f.env, id, approver);
    assert.equal(result.ok, true, result.error);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(f.onHand(sku), 11, "once a person actually approves it, the sheet's own corrected count really lands");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-192 — "I see that embellished blazer has a TBD option name... we still
 * want to update the number of different sizes... you can treat it as a
 * generic option and still update the size quantities" -- the owner's own
 * words, suspecting a literal stored "TBD" was why a resubmit kept failing
 * to match. A fresh row's own "TBD" is already dropped before matching
 * (draftProductUpdate's own rawOptValues filter); an EXISTING variant
 * synced with a literal "TBD" (predating that filter, or carrying it in
 * from Square some other way) got no such treatment on ITS side of the
 * SAME comparison -- sameOptions' own strict key-count check would see one
 * more key on the stored side than a freshly-filtered row ever has, so a
 * legacy variant like this could never be recognized again.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_192_legacy_tbd_option_matching__a_variant_with_a_literal_stored_tbd_color_still_matches_on_resubmit", async () => {
  const f = await fixture({ withCommerce: true });
  const outerwear = f.categories().find((c) => c.name === "Outerwear");

  /* Built directly, the way a real sync from Square (or an import that
     predates the TBD filter) could actually have recorded it -- never
     through catalog.create_product, which would already drop "TBD" and
     so could never reproduce the exact legacy shape this test is about. */
  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_product (id, external_ref, handle, title, category_id, source_version, import_style_number) VALUES" +
        " ('prod-legacy','SQ_ITEM_LEGACY','embellished-blazer','Embellished blazer', ?, 1, '001-001-003')",
    )
    .run(outerwear.id);
  f.mirrorDb._raw
    .prepare(
      "INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, ordinal, price_minor, currency, options, vendor_id, unit_cost_minor, unit_cost_currency) VALUES" +
        " ('var-legacy-s','SQ_VAR_S','prod-legacy','SKU-LEGACY-S','TBD, S',0,12500,'USD','{\"Color\":\"TBD\",\"Size\":\"S\"}',NULL,0,'USD')",
    )
    .run();

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result;
  try {
    const csv = "Style #,Category,Description,Color,Size,Qty,Retail Price\n001-001-003-TBD-S,Outerwear,Embellished blazer,TBD,S,4,125.00\n";
    result = await draftProductBatch(f.env, { text: csv, actor: "mara@vemians.com", role: "manager", mode: "update" });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(result.ready.length, 0, `expected a clean match, never a clash over the stored "TBD", got: ${JSON.stringify(result)}`);
  /* REVISED: the sheet's own price (125.00) already matches what is
     seeded -- Test-PRD-P0-194-resubmit_no_op_suppression now correctly
     suppresses the catalog edit itself as a no-op, leaving only the one
     real change: the never-yet-stocked legacy variant's own real count.
     "Never a second, duplicate product" is verified below instead, via the
     mirror itself, now that there is no catalog.update_product row of its
     own to read a handle off of. */
  assert.equal(result.created.length, 1, `expected only the real stock correction, got: ${JSON.stringify(result)}`);
  const stockRow = result.created.find((r) => /stock by/.test(r.summary));
  assert.match(stockRow.summary, /stock by \+4 \(0 -> 4\)/, "the real, never-yet-stocked legacy variant's own count actually lands");
  assert.equal(f.onHand("SKU-LEGACY-S"), 4, "the ledger now reflects the sheet's own real count for this exact legacy variant");

  const products = f.mirror("SELECT id FROM mirror_product WHERE handle = 'embellished-blazer'");
  assert.equal(products.length, 1, "still only one product -- the legacy TBD shape never caused a duplicate to be created alongside it");
});

check("test_PRD_P0_179_import_style_number_matching__a_later_category_move_never_breaks_a_future_resubmits_own_match", async () => {
  /* "We have very specific categories... you should be able to determine
     which item is in there, and just find it and update it" -- the owner's
     own words. import_style_number is captured once, at creation, and
     stays put even once the live, category-derived style_id has moved on
     (P0-177's own fluid_style_id) -- proving the whole POINT of a second,
     separate, permanent key: style_id alone could never survive this. */
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });

  /* The style-numbered sheet's own catCode/subCode ("01"/"04") resolve
     straight to Casual by NUMBER (resolveCategoryByCode) -- no Category
     name column needed here, the same path a real numbered resubmit uses. */
  const csv1 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Casual,100.00,01-04-005\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1, `expected the first submission to create, got: ${JSON.stringify(first)}`);

    const before = f.mirror("SELECT id, handle, style_id, import_style_number FROM mirror_product WHERE title = 'Wool Coat'")[0];
    assert.equal(before.style_id, "01-04-001", "sanity: a real, category-derived style_id, not null");
    assert.equal(before.import_style_number, "01-04-005");

    /* A real category move, the ordinary way -- reassigns style_id, never
       import_style_number (catalog.update_product's own job, unrelated to
       this feature). Moved to a bare top-level category on purpose: this
       codebase's own rule is that only a SUBcategory ever carries a
       style_id at all, so this is a real, unambiguous change away from
       "01-04-001", not a coincidental re-derivation of the same value. */
    const knitwear = f.categories().find((c) => c.name === "Knitwear");
    const moved = await approvedCall(f, "catalog.update_product", { handle: before.handle, category_id: knitwear.id });
    assert.equal(moved.ok, true, moved.error);

    const after = f.mirror("SELECT style_id, import_style_number FROM mirror_product WHERE id = ?", before.id)[0];
    assert.notEqual(after.style_id, before.style_id, "the live style_id really did move with the category, as designed");
    assert.equal(after.import_style_number, "01-04-005", "import_style_number never moves -- the whole reason it exists");

    /* A resubmit of the ORIGINAL sheet, unchanged category cell and all --
       still finds and updates the SAME product, even though its style_id
       is now something else entirely. */
    const csv2 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Casual,130.00,01-04-005\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
    assert.equal(second.created.length, 1, `expected the resubmit to update, got: ${JSON.stringify(second)}`);
    assert.equal(second.created[0].action, "updated");
    assert.equal(second.created[0].handle, before.handle);

    const products = f.mirror("SELECT id FROM mirror_product WHERE import_style_number = '01-04-005'");
    assert.equal(products.length, 1, "still the one product -- the resubmit found it by import_style_number, not by the now-stale style_id");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_179_import_style_number_matching__the_preview_shows_a_matched_row_as_an_update_not_a_fresh_create", async () => {
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const csv1 = "title,category,price,style id\nWool Coat,Outerwear,100.00,01-04-006\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let created;
  try {
    created = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(created.created.length, 1);

  /* The identical style number, previewed again -- side-effect-free
     (nothing here ever calls Square), but no longer blind to the fact
     that a real match is already on file. */
  const csv2 = "title,category,price,style id\nWool Coat,Outerwear,130.00,01-04-006\n";
  const preview = await previewBatch(f.env, csv2, "products", "update");
  assert.equal(preview.sampleRows.length, 1);
  assert.match(preview.sampleRows[0].will_update, /Wool Coat/);
  assert.equal(preview.sampleRows[0].sku, "(unchanged)");
  assert.equal(preview.sampleRows[0].style_id, "(unchanged)");

  /* A brand-new style number on the same sheet previews the ordinary way
     -- no match, no `will_update` field at all. */
  const csv3 = "title,category,price,style id\nDenim Jacket,Outerwear,80.00,01-04-007\n";
  const freshPreview = await previewBatch(f.env, csv3, "products", "update");
  assert.equal("will_update" in freshPreview.sampleRows[0], false);
  assert.equal(freshPreview.sampleRows[0].sku, "(auto-generated)");
});

check("test_PRD_P0_179_import_style_number_matching__the_pending_match_note_never_reads_as_a_negative_result", async () => {
  /* "What you're showing me is very confusing. You should not do that" --
     the owner's own words, about this exact note on a real 16-row update
     preview, worded the way it used to be: "no existing product found...
     yet". Every row without a style-number match shows this note in
     preview (category/subcategory/title is never even attempted there --
     see previewBatch's own header comment), so on an ordinary multi-row
     update it appears on EVERY row, reading like a wall of failures even
     though nothing has actually been checked yet. Reworded to lead with
     what happens next, never with an absence that sounds like a verdict. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();
  const csv = "title,category,price,style id\nBrand New Style,Outerwear,80.00,01-04-999\n";
  const preview = await previewBatch(f.env, csv, "products", "update");
  const note = preview.sampleRows[0].update_note;
  assert.ok(note, "a row with no style-number match still gets a note explaining why");
  assert.doesNotMatch(note, /no existing product found/i, "must never lead with an absence that reads as a negative verdict");
  assert.doesNotMatch(note, /\byet\b/i, "\"...yet\" reads as a countdown to failure, not a plain, calm pending state");
  assert.match(note, /pending|will be checked|not yet (confirmed|decided)/i, "must say plainly that the real check still happens on submit");
});

check("test_PRD_P0_179_import_style_number_matching__a_blank_vendor_previews_as_in_house_on_add_but_unchanged_on_update", async () => {
  /* "Shouldn't you be doing an in-house instead of a dash? Since if a
     vendor is not provided, then it must be in-house" -- the owner's own
     words. True only for CREATE (vendorRefOrInHouse, catalog-writer.js) --
     draftProductUpdate's own header comment is explicit that vendor/
     vendor_code/commission are never touched by an update at all, matched
     or not, so a blank cell means something different in each mode, and
     the preview must say the one that is actually true for the row it is
     showing. */
  const { previewBatch } = await import("../src/batch.js");
  const f = await fixture();

  const addPreview = await previewBatch(f.env, "title,category,price,style id\nWool Coat,Outerwear,100.00,01-04-005\n", "products", "add");
  assert.equal(addPreview.sampleRows[0].vendor, "In-house", "a genuinely new product really does get In-house automatically");

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const created = await draftProductBatch(f.env, {
      text: "title,category,price,style id\nWool Coat,Outerwear,100.00,01-04-005\n",
      actor: "mara@vemians.com",
      role: "manager",
      mode: "add",
    });
    assert.equal(created.created.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }

  const updatePreview = await previewBatch(f.env, "title,category,price,style id\nWool Coat,Outerwear,130.00,01-04-005\n", "products", "update");
  assert.equal(updatePreview.sampleRows[0].vendor, "(unchanged)", "an update never touches vendor at all -- a blank cell here is not a future In-house assignment");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-180 — a real HTTP-level bug found while wiring "updated" through this
 * same checklist submit path: submitBatchPlanRow's own success return used
 * to be `{ ok: true, status: 200, ...result, done, total }`, and `result`
 * (submitProductBatchRow's own return) ALREADY has its own `status`
 * ("created"/"updated"/"parked"/"skipped") -- object-spread order let that
 * string silently overwrite the literal 200, and index.js's own route
 * handed it straight to `new Response(body, { status: out.status })`,
 * which throws for anything but an integer 200-599. Every ordinary,
 * successful row submission through the checklist's own progress bar hit
 * this -- and no earlier test ever caught it, because every earlier test
 * called submitBatchPlanRow directly (P0-63's own header comment has the
 * identical shape of gap: a function-level test can never see a bug that
 * only exists in how its caller turns the result into a real Response).
 * Fixed by giving the real HTTP code its own name (`httpStatus`), which
 * `result` never has, so it can never collide with `result`'s own
 * `status` again.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_180_batch_submit_row_http_status__the_real_route_returns_a_real_200_not_a_thrown_response", async () => {
  const f = await fixture();
  const worker = (await import("../src/index.js")).default;
  const csv = "title,category,price,style id\nWool Coat,Outerwear,100.00,01-04-008\n";
  /* The SAME ASSETS binding for both calls below -- agent_batch_plan (the
     stashed checklist) now lives there durably (Test-PRD-P0-183-durable_
     batch_bookkeeping), not in a process-wide in-memory Map any more, so a
     second call reusing a DIFFERENT (or absent) ASSETS binding would
     genuinely no longer find the plan the first call just created -- the
     real, intended behavior this test's own two separate calls must match. */
  const assets = await assetsFixtureWithRow({ extracted_text: csv });

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "mara@vemians.com", role: "manager", env: { ...f.env, ASSETS: assets }, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist", `expected a checklist, got: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.checklist.rows.length, 1);

    const runId = await httpStartRun(worker, { ...f.env, ...HTTP_ENV_EXTRA, ASSETS: assets }, outcome.checklist.id, [outcome.checklist.rows[0].row]);
    const res = await worker.fetch(
      new Request("http://localhost/agent/batch-submit-row", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER_CLAIMS), "content-type": "application/json" },
        body: JSON.stringify({ id: outcome.checklist.id, runId, row: outcome.checklist.rows[0].row }),
      }),
      { ...f.env, ...HTTP_ENV_EXTRA, ASSETS: assets },
    );
    /* THE POINT: a real, well-formed 200, constructed without throwing --
       before this fix, building this exact Response is what crashed. */
    const text = await res.text();
    assert.equal(res.status, 200, `expected a real 200, got ${res.status}: ${text}`);
    const data = JSON.parse(text);
    assert.equal(data.ok, true);
    assert.equal(data.status, "created", "the JSON body's own semantic status is untouched by the HTTP-status fix");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-183 — "you should not be losing files like this," the owner's own
 * words, after several real Worker redeploys in one real working session
 * each discarded an in-progress preview/checklist mid-task. Neither
 * `agent_last_preview` (which asset an actor most recently previewed) nor
 * `agent_batch_plan` (a stashed, reviewed checklist) was ever an in-memory
 * Map keyed by JS object identity -- both are durable D1 tables now
 * (shared/db/assets.sql) -- so the tests below deliberately build a BRAND
 * NEW `env` object for the "later" call in each pair, sharing only the same
 * underlying ASSETS binding, never the same JS object the first call used.
 * A test that reused the identical `env` object throughout would not prove
 * durability at all -- the old in-memory Map would have passed that test
 * too, since it was keyed by actor, not by which object called it. "We want
 * to make sure that we keep track of at least a few files... in sequence...
 * it's better to just have them than get rid of them every time" -- the
 * owner's own words, proven directly: nothing here ever deletes an older
 * preview record or a fully-submitted plan.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_183_durable_batch_bookkeeping__a_last_preview_survives_an_entirely_new_env_object", async () => {
  const f = await fixture({ actor: "noor@vemians.com", role: "manager" });
  const csv = "title,category,price,style id,cost\nWool Coat,Outerwear,450.00,01-04-001,210.00\n";
  const assets = await assetsFixtureWithRow({ extracted_text: csv });

  const preview = await dispatch(
    "catalog_preview_add_product_batch",
    { asset_id: "ast_1" },
    { actor: "noor@vemians.com", role: "manager", env: { ...f.env, ASSETS: assets }, allowed: new Set(["catalog_preview_add_product_batch"]) },
  );
  assert.equal(preview.block.is_error, false);

  /* A BRAND NEW env object -- not the one the preview call used, only the
     same underlying ASSETS db, the way a fresh Worker isolate after a
     redeploy would still reach the same durable database but starts with
     nothing of its own in memory. */
  const freshEnv = { ...f.env, ASSETS: assets };
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let outcome;
  try {
    outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "a_guess_the_model_made_up" },
      { actor: "noor@vemians.com", role: "manager", env: freshEnv, allowed: new Set(["catalog_add_product_batch"]) },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(outcome.kind, "checklist", `expected the real, previewed file to still be found, got: ${JSON.stringify(outcome)}`);
  assert.match(outcome.checklist.rows[0].title, /Wool Coat/);
});

check("test_PRD_P0_183_durable_batch_bookkeeping__an_older_preview_is_never_erased_by_a_newer_one", async () => {
  const f = await fixture({ actor: "priya@vemians.com", role: "manager" });
  const assets = await assetsFixtureWithRow({ extracted_text: "title,category,price\nFirst File,Outerwear,10.00\n", filename: "first.csv" });
  const ctx = { actor: "priya@vemians.com", role: "manager", env: { ...f.env, ASSETS: assets }, allowed: new Set(["catalog_preview_add_product_batch"]) };

  const firstPreview = await dispatch("catalog_preview_add_product_batch", { asset_id: "ast_1" }, ctx);
  assert.equal(firstPreview.block.is_error, false);

  const rows = assets._raw.prepare("SELECT actor, batch_kind, asset_id FROM agent_last_preview WHERE actor = 'priya@vemians.com'").all();
  assert.equal(rows.length, 1, "the first preview really did get recorded");
  assert.equal(rows[0].asset_id, "ast_1");

  /* A second, later file previewed by the SAME actor -- the older record
     above must still be sitting there afterward, untouched. */
  await assets._raw
    .prepare("INSERT INTO asset(id, store_key, filename, content_type, size_bytes, uploaded_by, extracted_text, text_truncated) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
    .run("ast_2", "assets/ast_2", "second.csv", "text/csv", 50, "priya@vemians.com", "title,category,price\nSecond File,Outerwear,20.00\n");
  const secondPreview = await dispatch("catalog_preview_add_product_batch", { asset_id: "ast_2" }, ctx);
  assert.equal(secondPreview.block.is_error, false);

  const after = assets._raw.prepare("SELECT asset_id FROM agent_last_preview WHERE actor = 'priya@vemians.com' ORDER BY id").all();
  assert.deepEqual(
    after.map((r) => r.asset_id),
    ["ast_1", "ast_2"],
    "both previews are still there, in sequence -- the older one was never deleted or overwritten",
  );
});

check("test_PRD_P0_183_durable_batch_bookkeeping__a_checklist_survives_an_entirely_new_env_object_across_two_row_submissions", async () => {
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const csv =
    "title,category,price,style id,cost\n" +
    "Wool Coat,Outerwear,450.00,01-04-001,210.00\n" +
    "Silk Scarf,Outerwear,80.00,01-04-002,20.00\n";
  const assets = await assetsFixtureWithRow({ extracted_text: csv });
  const identity = { email: "keiko@vemians.com", groups: ["vemians-manager"] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const outcome = await dispatch(
      "catalog_add_product_batch",
      { asset_id: "ast_1" },
      { actor: "keiko@vemians.com", role: "manager", env: { ...f.env, ASSETS: assets }, allowed: new Set(["catalog_add_product_batch"]) },
    );
    assert.equal(outcome.kind, "checklist");
    assert.equal(outcome.checklist.rows.length, 2);
    const [rowA, rowB] = outcome.checklist.rows;

    /* Two ENTIRELY SEPARATE env objects, one per row -- "each its own fresh
       Cloudflare invocation" (this mechanism's own header comment), sharing
       only the same underlying ASSETS db, never any JS object in common. */
    const first = await submitRow({ id: outcome.checklist.id, row: rowA.row, identity, env: { ...f.env, ASSETS: assets } });
    assert.equal(first.ok, true, JSON.stringify(first));

    const second = await submitRow({ id: outcome.checklist.id, row: rowB.row, identity, env: { ...f.env, ASSETS: assets } });
    assert.equal(second.ok, true, JSON.stringify(second));

    /* "It's better to just have them than get rid of them every time" --
       the completed upload is still a real job with every row checked off,
       not deleted, just spent. */
    const job = assets._raw.prepare("SELECT status, total, runs FROM ingest_job WHERE id = ?").get(outcome.checklist.id);
    assert.ok(job, "a fully-submitted upload must still exist, never deleted");
    assert.equal(job.status, "done");
    assert.equal(job.total, 2);
    assert.equal(job.runs, 2, "each Submit click was its own run");
    const rows = assets._raw.prepare("SELECT submitted, outcome, claimed_at FROM ingest_row WHERE job_id = ? ORDER BY rowid").all(outcome.checklist.id);
    assert.deepEqual(rows.map((r) => [r.submitted, r.outcome]), [[1, "created"], [1, "created"]], "every row checked off with its outcome");
    assert.ok(rows.every((r) => r.claimed_at), "and claimed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-181 — refining P0-179's own resubmit-matching, immediately after
 * shipping it: "our style ID numbers may be different, we may have changed
 * them, but the categories and subcategories and names have not... if you
 * find the same item with the same title that we are providing you, then
 * that's a match, just update it," the owner's own words, plus "the most
 * important match... our style ID... because that's how we want to
 * identify items externally... there may be situations where we want to
 * bulk update a bunch of items based on their style IDs" — import_style_
 * number alone (P0-179) only ever recognizes a resubmit of the EXACT text
 * given at creation; it cannot recognize a resubmit keyed on an item's
 * CURRENT, already-moved style_id, and it cannot recognize an item whose
 * style number was deliberately RENUMBERED (rather than merely re-filed).
 * Two more, tried in order, only once import_style_number itself finds
 * nothing: the live style_id (productByStyleId), then category+
 * subcategory+title (productsByCategoryAndTitle) — confident when exactly
 * one candidate turns up, parked as a clash ("if you have any doubts, pop
 * up a window... if you're confident, then just update") when more than
 * one does. Also: "make sure that when we're doing an update that you
 * populate the in-house because if there is no vendor specified it's
 * in-house — we want to make sure the cost fields are properly updated."
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_181_resubmit_matching_refinements__a_resubmit_matches_by_the_current_live_style_id_after_a_category_move", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });
  const formal = (await approvedCall(f, "catalog.create_category", { name: "Formal", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: formal.id, numeric_id: "06" });

  const csv1 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Casual,100.00,01-04-005\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1, `expected the first submission to create, got: ${JSON.stringify(first)}`);

    const before = f.mirror("SELECT id, handle, style_id, import_style_number FROM mirror_product WHERE title = 'Wool Coat'")[0];
    assert.equal(before.style_id, "01-04-001");

    /* A real category move -- style_id becomes "01-06-001", import_style_
       number stays "01-04-005" forever. A person now bulk-editing this
       item types its CURRENT style_id, "01-06-001" -- not the stale
       original text -- since that is what they actually see on the item
       today. */
    const moved = await approvedCall(f, "catalog.update_product", { handle: before.handle, category_id: formal.id });
    assert.equal(moved.ok, true, moved.error);
    const after = f.mirror("SELECT style_id, import_style_number FROM mirror_product WHERE id = ?", before.id)[0];
    assert.equal(after.style_id, "01-06-001", "sanity: a real, different, non-null style_id after the move");
    assert.equal(after.import_style_number, "01-04-005", "unchanged -- the whole point of the separate field");

    /* Resubmitted keyed on the CURRENT style_id, not the stale original. */
    const csv2 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Formal,140.00,01-06-001\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
    assert.equal(second.created.length, 1, `expected the resubmit to update, got: ${JSON.stringify(second)}`);
    assert.equal(second.created[0].action, "updated");
    assert.equal(second.created[0].handle, before.handle);

    const products = f.mirror("SELECT id, style_id FROM mirror_product WHERE title = 'Wool Coat'");
    assert.equal(products.length, 1, "still the one product -- found by its CURRENT live style_id, no duplicate created");
    const variant = f.mirror("SELECT price_minor FROM mirror_variant WHERE product_id = ?", before.id)[0];
    assert.equal(variant.price_minor, 14000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_181_resubmit_matching_refinements__a_renumbered_style_number_still_matches_by_category_subcategory_and_title", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });

  const csv1 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Casual,100.00,01-04-005\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1, `expected the first submission to create, got: ${JSON.stringify(first)}`);
    const before = f.mirror("SELECT id, handle FROM mirror_product WHERE title = 'Wool Coat'")[0];

    /* A COMPLETELY different style number -- deliberately renumbered, not
       merely moved -- matches neither import_style_number nor the live
       style_id at all. Same category/subcategory NAMES and same title,
       though, so the fallback still finds it. */
    const csv2 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Casual,155.00,77-77-001\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
    assert.equal(second.created.length, 1, `expected the renumbered resubmit to update, got: ${JSON.stringify(second)}`);
    assert.equal(second.created[0].action, "updated");
    assert.equal(second.created[0].handle, before.handle);

    const products = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'");
    assert.equal(products.length, 1, "still the one product -- found by category/subcategory/title, no duplicate created");
    const variant = f.mirror("SELECT price_minor FROM mirror_variant WHERE product_id = ?", before.id)[0];
    assert.equal(variant.price_minor, 15500);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_181_resubmit_matching_refinements__an_ambiguous_title_match_parks_as_a_clash_not_a_guess", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });

  /* Two GENUINELY DIFFERENT products that happen to share the exact same
     title in the exact same subcategory (two different style numbers, so
     two separate groups, two separate products). */
  const csv1 =
    "title,category,subcategory,price,style id\n" +
    "Wool Coat,Outerwear,Casual,100.00,01-04-005\n" +
    "Wool Coat,Outerwear,Casual,120.00,01-04-006\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 2, `expected two separate products, got: ${JSON.stringify(first)}`);

    /* A THIRD, unrelated style number, same category/subcategory/title --
       matches neither existing product by style number, and now matches
       BOTH of them by category+title. Too ambiguous to guess. */
    const csv2 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Casual,999.00,01-04-007\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
    assert.equal(second.created.length, 0, "never silently created a third, and never silently updated either");
    assert.equal(second.ready.length, 1, "parked for a person, the same as any other clash");
    assert.match(second.ready[0].summary, /matches 2 existing products/);

    const products = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'");
    assert.equal(products.length, 2, "neither existing product was touched, and no third one was created");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-181, REVISED — a real production report the day after this shipped:
 * "Just tried to update products and it found no existing products???" A
 * sheet carrying only a bare numeric style-number code, no Category/
 * Subcategory NAME columns, whose categories had since been renumbered
 * (this shop's own recurring workflow) defeats every earlier tier at
 * once: import_style_number is null (the product predates P0-179), the
 * live style_id has moved on (the renumber), and resolveCategoryByCode
 * has nothing left to resolve `category` by (no name column, and the
 * code no longer matches any current category's number) -- so the
 * category+title fallback, which required a resolved category, never
 * even ran. Same "same title, same product" reasoning as the fallback
 * above, just widened to search the whole catalog by title alone when
 * there is no category left to scope it to.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_181_resubmit_matching_refinements__matches_by_title_alone_across_the_whole_catalog_when_category_resolution_itself_fails", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  const casual = (await approvedCall(f, "catalog.create_category", { name: "Casual", parent_id: outerwear.id, reason: "test" })).data
    .category;
  await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "04" });

  const csv1 = "title,category,subcategory,price,style id\nWool Coat,Outerwear,Casual,100.00,01-04-005\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 1, `expected the first submission to create, got: ${JSON.stringify(first)}`);
    const before = f.mirror("SELECT id, handle FROM mirror_product WHERE title = 'Wool Coat'")[0];

    /* Categories renumbered since creation -- "01" is now free and belongs
       to nothing "04" would still resolve, so a bare numeric code plus no
       Category/Subcategory name column leaves resolveCategoryByCode with
       nothing to match at all. `category` comes back null, not an error. */
    await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "09" });
    await approvedCall(f, "catalog.set_category_number", { category_id: casual.id, numeric_id: "02" });

    const csv2 = "title,price,style id\nWool Coat,155.00,01-04-005\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
    assert.equal(second.created.length, 1, `expected the title-only fallback to update, got: ${JSON.stringify(second)}`);
    assert.equal(second.created[0].action, "updated");
    assert.equal(second.created[0].handle, before.handle);

    const products = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'");
    assert.equal(products.length, 1, "still the one product -- found by title alone, no duplicate created");
    const variant = f.mirror("SELECT price_minor FROM mirror_variant WHERE product_id = ?", before.id)[0];
    assert.equal(variant.price_minor, 15500);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_181_resubmit_matching_refinements__an_ambiguous_catalog_wide_title_match_parks_as_a_clash_naming_every_candidate", async () => {
  const f = await fixture();
  const outerwear = f.categories().find((c) => c.name === "Outerwear");
  const accessories = f.categories().find((c) => c.name === "Accessories");
  await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "01" });
  await approvedCall(f, "catalog.set_category_number", { category_id: accessories.id, numeric_id: "02" });

  /* Two GENUINELY DIFFERENT products, in two DIFFERENT top-level
     categories, that happen to share the exact same title. */
  const csv1 =
    "title,category,price,style id\n" +
    "Wool Coat,Outerwear,100.00,01-04-005\n" +
    "Wool Coat,Accessories,120.00,02-04-006\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager", mode: "add" });
    assert.equal(first.created.length, 2, `expected two separate products, got: ${JSON.stringify(first)}`);

    /* Renumbered out from under both categories, and no name column to
       resolve either -- `category` is null, so the fallback searches the
       WHOLE catalog by title and finds both products at once. */
    await approvedCall(f, "catalog.set_category_number", { category_id: outerwear.id, numeric_id: "07" });
    await approvedCall(f, "catalog.set_category_number", { category_id: accessories.id, numeric_id: "08" });

    const csv2 = "title,price,style id\nWool Coat,999.00,01-04-007\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager", mode: "update" });
    assert.equal(second.created.length, 0, "never silently updated either, and never silently created a third");
    assert.equal(second.ready.length, 1, "parked for a person, the same as any other clash");
    assert.match(second.ready[0].summary, /matches 2 existing products/);
    assert.match(second.ready[0].summary, /anywhere in the catalog/, "names the widened, category-less scope, not a specific category");

    const products = f.mirror("SELECT id FROM mirror_product WHERE title = 'Wool Coat'");
    assert.equal(products.length, 2, "neither existing product was touched, and no third one was created");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_181_resubmit_matching_refinements__a_legacy_vendor_less_product_gets_in_house_assigned_so_cost_can_update", async () => {
  const f = await fixture();
  const csv1 = "title,category,price,style id\nWool Coat,Outerwear,100.00,01-04-005\n";

  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  try {
    const first = await draftProductBatch(f.env, { text: csv1, actor: "mara@vemians.com", role: "manager" , mode: "add"});
    assert.equal(first.created.length, 1);
    const before = f.mirror("SELECT id, handle FROM mirror_product WHERE title = 'Wool Coat'")[0];

    /* Simulates a LEGACY product from before every product always got a
       real vendor -- cleared directly, since catalog.create_product itself
       can no longer produce one this way any more. */
    f.mirrorDb._raw.prepare("UPDATE mirror_variant SET vendor_id = NULL WHERE product_id = ?").run(before.id);
    const vendorless = f.mirror(
      "SELECT v.vendor_id FROM mirror_variant v WHERE v.product_id = ?",
      before.id,
    )[0];
    assert.equal(vendorless.vendor_id, null, "sanity: genuinely no vendor at all, the legacy state this test means to prove");

    /* Resubmitted with a real cost -- must not park as a clash over a
       vendor this file can safely default on its own. */
    const csv2 = "title,category,price,style id,cost\nWool Coat,Outerwear,100.00,01-04-005,42.00\n";
    const second = await draftProductBatch(f.env, { text: csv2, actor: "mara@vemians.com", role: "manager" , mode: "update"});
    assert.equal(second.created.length, 1, `expected the resubmit to update, got: ${JSON.stringify(second)}`);
    assert.equal(second.created[0].action, "updated");

    const after = f.mirror(
      "SELECT v.unit_cost_minor, mv.name AS vendor FROM mirror_variant v JOIN mirror_vendor mv ON mv.id = v.vendor_id WHERE v.product_id = ?",
      before.id,
    )[0];
    assert.equal(after.vendor, "In-house", "populated automatically -- no vendor named means In-house");
    assert.equal(after.unit_cost_minor, 4200, "the cost actually landed, in the proper (vendor_information) location");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_208_every_variation_has_every_option__rows_of_one_product_with_different_options_are_filled_not_refused", async () => {
  /* A real sheet: row 47 (style 001-004-002, "Evening dress") came back
     'Square POST /v2/catalog/object failed with 400 ... Expected ItemVariation
     to have 2 Item Option Values, got 0'. Rows of one product that name a
     colour and a size, only a size, or neither, made variations with different
     numbers of option values, which Square refuses. Each now carries a value
     for every option the item declares. */
  const f = await fixture({ actor: "keiko@vemians.com", role: "manager" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.square;
  let result, again;
  try {
    result = await draftProductBatch(f.env, {
      text:
        "Style #,Category,Subcategory,Description,Price\n" +
        "001-004-002-BLK-M,Jackets,Evening Dresses,Evening dress,100.00\n" +
        "001-004-002-BLK,Jackets,Evening Dresses,Evening dress,100.00\n" +
        "001-004-002,Jackets,Evening Dresses,Evening dress,100.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "add",
    });
    assert.equal(result.ready.length, 0, `expected no refusal, got: ${JSON.stringify(result.ready)}`);
    assert.equal(result.created.length, 1, JSON.stringify(result));
    const item = [...f.square.objects.values()].find((o) => o.type === "ITEM" && o.item_data?.name === "Evening dress");
    assert.ok(item, "the product reached Square");
    const declared = item.item_data.item_options.length;
    assert.equal(declared, 2, "colour and size");
    for (const v of item.item_data.variations) {
      assert.equal(v.item_variation_data.item_option_values.length, declared, "every variation carries a value for every option");
    }

    /* The update path: a product that already has colour and size gets a new
       size-only row on a later sheet. */
    again = await draftProductBatch(f.env, {
      text: "Style #,Category,Subcategory,Description,Price\n001-004-002-XL,Jackets,Evening Dresses,Evening dress,100.00\n",
      actor: "keiko@vemians.com",
      role: "manager", mode: "update",
    });
    assert.equal(again.ready.length, 0, `expected no refusal on the update, got: ${JSON.stringify(again.ready)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
