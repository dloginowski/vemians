/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * POST /webhooks/square — the PUSH half of the mirror sync (ADR-009:
 * "mirrored... on webhook and on a nightly reconcile"). Test-PRD-P0-48's own
 * text already claimed "what runs on a schedule is exactly what runs on a
 * webhook" before this route existed to make it true; these checks are what
 * makes that sentence honest.
 *
 * A real Worker fetch, same discipline as items-route.test.mjs: no reaching
 * into squareWebhook directly, since the point is proving the route wiring
 * (signature check before anything else touches the payload, then the
 * correct trigger) works end to end through worker.fetch.
 *
 * syncFromSquare itself — full vs incremental, what a real sync does — is
 * already covered by ops/test/sync.test.mjs and square.test.mjs; this file's
 * job is only "does a verified webhook actually call it," which a MISSING
 * SQUARE_ACCESS_TOKEN proves cleanly and without reaching the network: the
 * route has no seam to inject a fake Square client (production calls
 * syncFromSquare(env, {}) with no opts, on purpose — a webhook is not a
 * test), so an unset credential is the one failure syncFromSquare can reach
 * with no adapter and no fetch at all, recording exactly the
 * "credential_unset" row describeFailure names.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const worker = (await import("../src/index.js")).default;

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const SIGNATURE_KEY = "test-signing-key";
const NOTIFICATION_URL = "https://ops.vemians.test/webhooks/square";

function mirrorDb() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "commerce", "square", "schema.sql"), "utf8");
  const db = new DatabaseSync(":memory:");
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
        const info = db.prepare(text).run(...bound);
        return { success: true, meta: { changes: info.changes } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db };
}

function env(mirror, extra = {}) {
  return {
    SURFACE: "ops",
    CATALOG_MIRROR: mirror,
    SQUARE_WEBHOOK_SIGNATURE_KEY: SIGNATURE_KEY,
    SQUARE_WEBHOOK_URL: NOTIFICATION_URL,
    ...extra,
  };
}

function sign(body) {
  return createHmac("sha256", SIGNATURE_KEY).update(NOTIFICATION_URL + body, "utf8").digest("base64");
}

/* A fake ExecutionContext: waitUntil collects the promise instead of firing
   it into the void, so a test can await the background sync the route
   deliberately does not wait on before answering Square. */
function fakeCtx() {
  const promises = [];
  return { waitUntil: (p) => promises.push(p), settle: () => Promise.all(promises) };
}

async function post(body, headers, e, ctx) {
  return worker.fetch(
    new Request(NOTIFICATION_URL, { method: "POST", headers, body }),
    e,
    ctx,
  );
}

check("test_PRD_P0_38_webhook_authenticity__an_unsigned_square_webhook_is_rejected_before_anything_reads_it", async () => {
  const mirror = mirrorDb();
  const body = JSON.stringify({ type: "catalog.version.updated", event_id: "evt_1", data: { object: {} } });
  const res = await post(body, {}, env(mirror));
  assert.equal(res.status, 401);
  assert.equal(mirror._raw.prepare("SELECT count(*) AS n FROM mirror_sync").get().n, 0, "nothing was touched");
});

check("test_PRD_P0_38_webhook_authenticity__a_tampered_body_fails_verification_even_with_a_present_signature", async () => {
  const mirror = mirrorDb();
  const real = JSON.stringify({ type: "catalog.version.updated", event_id: "evt_1", data: { object: {} } });
  const tampered = real.replace("evt_1", "evt_2");
  const res = await post(tampered, { "x-square-hmacsha256-signature": sign(real) }, env(mirror));
  assert.equal(res.status, 401);
});

check("test_PRD_P0_48_scheduled_mirror_sync__a_verified_catalog_webhook_triggers_the_same_sync_the_cron_runs", async () => {
  const mirror = mirrorDb();
  const body = JSON.stringify({
    type: "catalog.version.updated",
    event_id: "evt_1",
    created_at: "2026-09-17T00:00:00Z",
    data: { object: { catalog_version: { updated_at: "2026-09-17T00:00:00Z" } } },
  });
  const ctx = fakeCtx();
  /* No SQUARE_ACCESS_TOKEN on purpose — see this file's own top comment: the
     route calls syncFromSquare(env, {}) with no injection seam, so this is
     the one outcome provable without a real Square client. */
  const res = await post(body, { "x-square-hmacsha256-signature": sign(body) }, env(mirror), ctx);
  assert.equal(res.status, 200, "Square gets its ack immediately");
  await ctx.settle();
  const row = mirror._raw.prepare("SELECT ok, note FROM mirror_sync WHERE id = 'catalog'").get();
  assert.ok(row, "the webhook actually called syncFromSquare, not just acknowledged Square");
  assert.equal(row.ok, 0);
  assert.match(row.note, /credential_unset/);
});

check("test_PRD_P0_48_scheduled_mirror_sync__an_unhandled_event_type_is_acknowledged_but_triggers_no_sync", async () => {
  const mirror = mirrorDb();
  const body = JSON.stringify({ type: "payment.updated", event_id: "evt_1", data: { object: {} } });
  const ctx = fakeCtx();
  const res = await post(body, { "x-square-hmacsha256-signature": sign(body) }, env(mirror), ctx);
  assert.equal(res.status, 200);
  await ctx.settle();
  assert.equal(mirror._raw.prepare("SELECT count(*) AS n FROM mirror_sync").get().n, 0, "an unhandled type is not a resync instruction");
});

check("test_PRD_P0_48_scheduled_mirror_sync__the_route_only_accepts_post", async () => {
  const mirror = mirrorDb();
  const res = await worker.fetch(new Request(NOTIFICATION_URL, { method: "GET" }), env(mirror));
  assert.equal(res.status, 405);
});

check("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const prd = fs.readFileSync(path.join(here, "..", "..", "docs", "PRD.md"), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(`\`${label}\``), `${label} is not declared in docs/PRD.md`);
  }
});
