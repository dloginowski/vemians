/*
 * commerce.js's inventory.adjust — PRD-backed regression checks.
 *
 *     Run: node --test test/commerce.test.mjs   (from ops/)
 *
 * See catalog-write.test.mjs's own top comment for the general contract
 * (every check must carry a Test-PRD-P0-NN label that exists in docs/PRD.md,
 * enforced by the P0-30 check at the end of this file too).
 *
 * NO SQUARE ACCOUNT, TOKEN OR NETWORK CALL IS INVOLVED. `fakeSquareInventory`
 * below is a stub: it seeds ONE catalog item from the shared adapter test's
 * own fixture (proven against Square's documented shapes there), and
 * accepts/replays BatchChangeInventory PHYSICAL_COUNT events — enough to
 * exercise inventory.adjust's own push-then-sync round trip, never enough to
 * prove Square's live API accepts these bodies (only a sandbox token could).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { d1FromSql } from "../../shared/test/d1.mjs";
import { runTool } from "../src/tools/index.js";
import { createApprovalStore } from "../src/tools/approval.js";
import { createRateLimiter } from "../src/tools/rate.js";
import { createSquareCatalogWriter } from "../src/tools/catalog-writer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.join(HERE, "..");
const REPO = path.join(OPS, "..");
const DB_DIR = path.join(REPO, "shared", "db");
const SQUARE_DIR = path.join(REPO, "shared", "commerce", "square");
const PRD = path.join(REPO, "docs", "PRD.md");

const MIRROR_SQL = fs.readFileSync(path.join(SQUARE_DIR, "schema.sql"), "utf8");
const COMMERCE_SQL = fs.readFileSync(path.join(DB_DIR, "commerce.sql"), "utf8");
const AUDIT_SQL = fs.readFileSync(path.join(DB_DIR, "audit.sql"), "utf8");
const CATALOG_SEED = JSON.parse(
  fs.readFileSync(path.join(SQUARE_DIR, "test", "fixtures", "catalog-list.json"), "utf8"),
).objects;

/* ── labels, for the P0-30 traceability check ───────────────────────────── */

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function squareEnv(extra = {}) {
  return {
    SQUARE_ACCESS_TOKEN: "fixture-token",
    SQUARE_ENV: "sandbox",
    SQUARE_LOCATION_ID: "LOC_SQUARE_MAIN",
    LOCATION_ID: "main",
    ...extra,
  };
}

/*
 * A stub Square that seeds the catalog from the shared adapter fixture, then
 * accepts and replays BatchChangeInventory PHYSICAL_COUNT events — exactly
 * the two calls inventory.adjust's own run() makes (push, then pull to sync).
 */
function fakeSquareInventory(seed = CATALOG_SEED, { failRetrieve = false } = {}) {
  const objects = new Map(seed.map((o) => [o.id, structuredClone(o)]));
  const changes = [];
  const calls = [];
  let seq = 0;

  const impl = async (url, init = {}) => {
    const p = new URL(url).pathname;
    const method = init.method ?? "GET";
    const record = { method, path: p };
    calls.push(record);

    if (p === "/v2/catalog/list") return jsonRes({ objects: [...objects.values()] });
    if (p === "/v2/vendors/search") return jsonRes({ vendors: [] });

    if (p === "/v2/inventory/changes/batch-create") {
      const body = JSON.parse(init.body);
      record.body = body;
      for (const c of body.changes ?? []) {
        seq += 1;
        if (c.type === "PHYSICAL_COUNT") {
          changes.push({ type: "PHYSICAL_COUNT", physical_count: { id: `PC_${seq}`, ...c.physical_count } });
        }
      }
      return jsonRes({ counts: [] });
    }

    if (p === "/v2/inventory/changes/batch-retrieve") {
      /* Reproduces a real production failure: Square's own batch-retrieve
         call, right after a successful push, answering 400. */
      if (failRetrieve) return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST" }] }, 400);
      const body = JSON.parse(init.body);
      record.body = body;
      const ids = body.catalog_object_ids ?? [];
      const matched = changes.filter(
        (c) => !ids.length || ids.includes(c.physical_count?.catalog_object_id),
      );
      return jsonRes({ changes: matched });
    }

    return jsonRes({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }, 404);
  };

  impl.calls = calls;
  return impl;
}

async function fixture({ actor = "mara@vemians.com", role = "manager", failRetrieve = false } = {}) {
  const square = fakeSquareInventory(CATALOG_SEED, { failRetrieve });
  const mirrorDb = d1FromSql(MIRROR_SQL);
  const commerceDb = d1FromSql(COMMERCE_SQL);
  const auditDb = d1FromSql(AUDIT_SQL);
  const env = { CATALOG_MIRROR: mirrorDb, COMMERCE: commerceDb, AUDIT: auditDb, ...squareEnv() };

  const writer = createSquareCatalogWriter(squareEnv(), {
    mirrorDb,
    commerceDb,
    clientOptions: { fetchImpl: square, sleep: async () => {}, maxAttempts: 1 },
  });
  await writer.adapter.pullCatalog({ full: true });
  const seededCalls = square.calls.length;

  const variant = mirrorDb._raw
    .prepare("SELECT id, external_ref, sku FROM mirror_variant WHERE sku = 'VEM-COAT-40'")
    .get();

  return {
    square,
    mirrorDb,
    commerceDb,
    variant,
    ctx: {
      actor,
      role,
      env,
      approvals: createApprovalStore(),
      rate: createRateLimiter(),
      square: writer,
    },
    /* Square calls made SINCE the seed sync — the ones a check is about. */
    calls: () => square.calls.slice(seededCalls),
    onHand: (sku) => {
      const row = commerceDb._raw.prepare("SELECT on_hand FROM inventory_level WHERE sku = ?").get(sku);
      return row?.on_hand ?? 0;
    },
  };
}

const staff = { actor: "ana@vemians.com", role: "staff" };

async function approvedCall(f, name, args, ctx) {
  const gate = await runTool(name, args, ctx ?? f.ctx);
  assert.equal(gate.needsApproval, true, "a T2 call must ask first");
  return runTool(name, args, { ...(ctx ?? f.ctx), approvalToken: gate.data.approval.token });
}

/* ─────────────────────────────────────────────────────────────────────────
 * P0-31 — inventory.adjust: the count is still never written directly
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_31_inventory_ledger__a_receipt_raises_stock_from_zero", async () => {
  const f = await fixture();
  assert.equal(f.onHand("VEM-COAT-40"), 0, "nothing counted yet");

  const res = await approvedCall(f, "inventory.adjust", { variant_id: f.variant.id, delta: 5 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.on_hand, 5);
  assert.equal(f.onHand("VEM-COAT-40"), 5);

  /* Square's own PHYSICAL_COUNT event, not a number written straight into
     our own ledger — the pushed body carries the resulting ABSOLUTE count. */
  const pushed = f.calls().find((c) => c.path === "/v2/inventory/changes/batch-create");
  assert.equal(pushed.body.changes[0].physical_count.quantity, "5");
});

check("test_PRD_P0_31_inventory_ledger__a_removal_lowers_stock_by_the_delta", async () => {
  const f = await fixture();
  await approvedCall(f, "inventory.adjust", { variant_id: f.variant.id, delta: 5 });
  const res = await approvedCall(f, "inventory.adjust", { variant_id: f.variant.id, delta: -2 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.on_hand, 3);
  assert.equal(f.onHand("VEM-COAT-40"), 3);
});

check("test_PRD_P0_31_inventory_ledger__a_zero_delta_is_refused", async () => {
  const f = await fixture();
  const res = await runTool("inventory.adjust", { variant_id: f.variant.id, delta: 0 }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /would change nothing/);
  assert.equal(f.calls().length, 0, "refused before Square is ever touched");
});

check("test_PRD_P0_31_inventory_ledger__a_removal_that_would_go_negative_is_refused", async () => {
  const f = await fixture();
  await approvedCall(f, "inventory.adjust", { variant_id: f.variant.id, delta: 3 });
  const before = f.calls().length;
  const res = await runTool("inventory.adjust", { variant_id: f.variant.id, delta: -10 }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /negative/);
  assert.equal(f.calls().length, before, "refused before the SECOND (over-limit) write reaches Square");
  assert.equal(f.onHand("VEM-COAT-40"), 3, "the earlier, valid adjustment still stands");
});

check("test_PRD_P0_31_inventory_ledger__an_unknown_variation_is_refused", async () => {
  const f = await fixture();
  const res = await runTool("inventory.adjust", { variant_id: "no-such-variant", delta: 1 }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /no variation/);
});

check("test_PRD_P0_31_inventory_ledger__staff_cannot_adjust_stock", async () => {
  const f = await fixture();
  const res = await runTool("inventory.adjust", { variant_id: f.variant.id, delta: 1 }, { ...f.ctx, ...staff });
  assert.equal(res.ok, false);
  assert.equal(f.calls().length, 0);
});

check("test_PRD_P0_31_inventory_ledger__the_count_is_recomputed_fresh_in_run_not_trusted_from_check", async () => {
  /* Real time (and someone else's sale or receipt) can pass between a T2
     check() and its approved run() — this proves run() re-reads the current
     count rather than trusting whatever check() saw a moment earlier. */
  const f = await fixture();
  await approvedCall(f, "inventory.adjust", { variant_id: f.variant.id, delta: 4 });

  const gate = await runTool("inventory.adjust", { variant_id: f.variant.id, delta: 2 }, f.ctx);
  assert.equal(gate.needsApproval, true);
  assert.match(gate.data.would, /4 -> 6/);

  /* Something else moves stock in the gap between check() and run(). */
  await approvedCall(f, "inventory.adjust", { variant_id: f.variant.id, delta: -1 });
  assert.equal(f.onHand("VEM-COAT-40"), 3);

  const res = await runTool(
    "inventory.adjust",
    { variant_id: f.variant.id, delta: 2 },
    { ...f.ctx, approvalToken: gate.data.approval.token },
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.on_hand, 5, "3 (the CURRENT count) + 2, not the stale 4 + 2 = 6 check() once saw");
});

check("test_PRD_P0_31_inventory_ledger__a_failed_immediate_resync_does_not_refuse_the_adjustment", async () => {
  /* Reproduces a real production incident: the push to Square succeeded
     (it is the authoritative write, ADR-009) but the immediate follow-up
     sync — this call's own best-effort shortcut to reflect that back
     without waiting for the next cron — answered 400. That must never
     make the whole call look refused: the count Square itself will report
     from here on is the one just pushed, full stop. */
  const f = await fixture({ failRetrieve: true });
  const res = await approvedCall(f, "inventory.adjust", { variant_id: f.variant.id, delta: 5 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.on_hand, 5, "the optimistic, just-pushed count, not a stale local read");
  assert.equal(res.data.synced, false, "honest about the immediate resync having failed");
});

check("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", () => {
  const prd = fs.readFileSync(PRD, "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used in commerce.test.mjs but not documented in docs/PRD.md`);
  }
});
