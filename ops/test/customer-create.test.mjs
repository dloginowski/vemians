/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * customer.create — Square's own Customer Directory, not the encrypted vault
 * P0-33 still describes and does not build. `t.square_client` is injected
 * directly (the same seam catalog-write.test.mjs uses for `t.square`), so
 * this needs no real Square account, token or network call.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

import { runTool, RESOURCES, TOOLS } from "../src/tools/index.js";
import { createApprovalStore } from "../src/tools/approval.js";
import { createRateLimiter } from "../src/tools/rate.js";
import { createSeedCatalogSource } from "../src/tools/catalog-source.js";
import { CAPS } from "../src/tools/caps.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const PRD = path.join(REPO, "docs", "PRD.md");
const AUDIT_SQL = fs.readFileSync(path.join(REPO, "shared", "db", "audit.sql"), "utf8");

/* batch.js reaches mcp.js, which reaches skills.js, which reads SKILL.md
   files — a static import of batch.js would resolve before this line ever
   ran, so it is dynamic, after the loader that teaches node what a .md
   import means is registered. */
register("../../shared/test/text-modules.mjs", import.meta.url);
const { draftCustomerBatch } = await import("../src/batch.js");

/* A real AUDIT binding — every runTool call writes one, even a refusal. */
function auditDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(AUDIT_SQL);
  const wrap = (sql) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async run() {
        const r = db.prepare(sql).run(...bound);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db };
}

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* A fake Square client: `.post(path, body)` records the call and answers the
   way CreateCustomer does. No fetch, no token, no network. */
function fakeSquareClient() {
  const calls = [];
  let seq = 0;
  return {
    calls,
    async post(p, body) {
      calls.push({ path: p, body });
      if (p !== "/v2/customers") return { errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] };
      seq += 1;
      return { customer: { id: `CUST_${seq}`, ...body } };
    },
  };
}

function fixture({ actor = "mara@vemians.com", role = "manager" } = {}) {
  const square_client = fakeSquareClient();
  return {
    square_client,
    ctx: {
      actor,
      role,
      env: { AUDIT: auditDb() },
      approvals: createApprovalStore(),
      rate: createRateLimiter(),
      catalog: createSeedCatalogSource(),
      square_client,
    },
  };
}

async function approvedCall(f, name, args, ctx) {
  const gate = await runTool(name, args, ctx ?? f.ctx);
  assert.equal(gate.needsApproval, true, "a T2 call must ask first");
  return runTool(name, args, { ...(ctx ?? f.ctx), approvalToken: gate.data.approval.token });
}

check("test_PRD_P0_61_square_customer_intake__a_full_row_creates_a_square_customer_after_approval", async () => {
  const f = fixture();
  const args = { given_name: "Priya", family_name: "Kapoor", email_address: "priya@example.com", phone_number: "+15551234567" };
  const res = await approvedCall(f, "customer.create", args);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.created, true);
  assert.match(res.data.square_customer_id, /^CUST_/);
  assert.equal(f.square_client.calls.length, 1);
  assert.equal(f.square_client.calls[0].path, "/v2/customers");
  assert.equal(f.square_client.calls[0].body.given_name, "Priya");
});

check("test_PRD_P0_61_square_customer_intake__at_least_one_identifying_field_is_required", async () => {
  const f = fixture();
  const gate = await runTool("customer.create", { note: "walked in, no details given" }, f.ctx);
  assert.equal(gate.ok, false);
  assert.match(gate.error, /at least one of/);
  assert.equal(f.square_client.calls.length, 0);
});

check("test_PRD_P0_61_square_customer_intake__a_malformed_email_is_refused_before_square_sees_it", async () => {
  const f = fixture();
  const gate = await runTool("customer.create", { given_name: "Priya", email_address: "not-an-email" }, f.ctx);
  assert.equal(gate.ok, false);
  assert.match(gate.error, /does not look like an email/);
  assert.equal(f.square_client.calls.length, 0);
});

check("test_PRD_P0_61_square_customer_intake__staff_cannot_even_ask_for_this_write", async () => {
  const f = fixture({ actor: "ana@vemians.com", role: "staff" });
  const res = await runTool("customer.create", { given_name: "Priya" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /requires the manager role/);
  assert.equal(f.square_client.calls.length, 0);
});

check("test_PRD_P0_61_square_customer_intake__this_tool_holds_no_binding_the_customer_family_uses", async () => {
  /* The whole reason this is not P0-33: it touches no `customers` or
     `identity` store, so nothing it does can be confused for that family's
     job, and P0-08's promise about that family is untouched by this tool
     existing at all. */
  assert.deepEqual(TOOLS["customer.create"].stores, []);
  assert.deepEqual(TOOLS["customer.create"].resources, ["square_client"]);
  assert.ok(RESOURCES.includes("square_client"));
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-60 — the customer half of the spreadsheet importer
 * ───────────────────────────────────────────────────────────────────────── */

function fakeSquareFetch() {
  const calls = [];
  let seq = 0;
  const impl = async (url, init = {}) => {
    const p = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: p, method, body });
    if (p === "/v2/customers" && method === "POST") {
      seq += 1;
      return new Response(JSON.stringify({ customer: { id: `CUST_${seq}`, ...body } }), { status: 200 });
    }
    return new Response(JSON.stringify({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }), {
      status: 404,
    });
  };
  impl.calls = calls;
  return impl;
}

async function withFakeSquare(fn) {
  const square = fakeSquareFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = square;
  try {
    return { square, result: await fn(square) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const BATCH_ENV = { SQUARE_ACCESS_TOKEN: "fixture-token", SQUARE_ENV: "sandbox", OPS_HOST: "ops.vemians.com" };

check("test_PRD_P0_60_spreadsheet_products__a_clean_customer_row_becomes_one_ready_to_review_approval", async () => {
  const csv =
    "given_name,family_name,email_address,phone_number\n" + "Priya,Kapoor,priya@example.com,+15551234567\n";
  const { result } = await withFakeSquare((square) =>
    draftCustomerBatch(
      { ...BATCH_ENV, AUDIT: auditDb() },
      { text: csv, actor: "mara@vemians.com", role: "manager" },
    ),
  );
  assert.equal(result.skipped.length, 0);
  assert.equal(result.ready.length, 1);
  assert.equal(result.ready[0].title, "Priya Kapoor");
  assert.match(result.ready[0].url, /\/approvals\//);
});

check("test_PRD_P0_60_spreadsheet_products__a_blank_customer_row_is_reported_not_silently_dropped", async () => {
  const csv = "given_name,family_name,email_address,phone_number\n,,,\nAlex,,,\n";
  const { result, square } = await withFakeSquare((sq) =>
    draftCustomerBatch(
      { ...BATCH_ENV, AUDIT: auditDb() },
      { text: csv, actor: "mara@vemians.com", role: "manager" },
    ),
  );
  assert.equal(result.ready.length, 1, "the second row has a name and is fine");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].row, 2);
  assert.match(result.skipped[0].reason, /at least one of/);
  /* Only the row that actually resolved ever reached Square. */
  assert.equal(square.calls.length, 0, "parking never calls Square — only approving does");
});

check("test_PRD_P0_60_spreadsheet_products__more_customer_rows_than_the_cap_is_refused_up_front", async () => {
  const tooMany = CAPS.BATCH_MAX_ROWS + 1;
  const csv = "given_name\n" + Array.from({ length: tooMany }, (_, i) => `Person ${i}`).join("\n");
  const result = await draftCustomerBatch(
    { ...BATCH_ENV, AUDIT: auditDb() },
    { text: csv, actor: "mara@vemians.com", role: "manager" },
  );
  assert.equal(result.tooMany, tooMany);
  assert.deepEqual(result.ready, []);
  assert.deepEqual(result.skipped, []);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const prd = fs.readFileSync(PRD, "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
