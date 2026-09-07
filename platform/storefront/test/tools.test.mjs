/*
 * Agent tool layer — PRD-backed regression checks.
 *
 *     Run: node --test test/            (from platform/storefront)
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
 *     (P0-30) parses THIS FILE's own test names and asserts it, so an invented
 *     or renamed label fails the run instead of drifting silently.
 *   * UNLABELED CHECKS ARE NOT ACCEPTABLE. A new guarantee needs a PRD feature
 *     first; if there is no feature for it, write the feature.
 *   * When behaviour changes, the PRD feature and its labeled check move in the
 *     SAME change as the code. A tool edit with a stale PRD is a process
 *     failure, not a follow-up.
 *
 * Mechanics: the REAL schemas in platform/db/*.sql are loaded into separate
 * in-memory node:sqlite databases — D1 is SQLite, and a check against a fake
 * store proves nothing about the triggers that carry half the guarantees. A
 * thin adapter gives each one the D1 `prepare().bind().all()/first()/run()`
 * shape, so the tools under test run the same code they run on Cloudflare.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { runTool, TOOLS, STORE_BINDINGS, describeTools } from "../src/tools/index.js";
import { createApprovalStore } from "../src/tools/approval.js";
import { createRateLimiter } from "../src/tools/rate.js";
import { createSeedCatalogSource } from "../src/tools/catalog-source.js";
import { AUDIT_DOMAINS } from "../src/tools/audit.js";
import { CAPS } from "../src/tools/caps.js";
import { T3_ABSENT } from "../src/tools/tiers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT = path.join(HERE, "..");
const REPO = path.join(STOREFRONT, "..", "..");
const DB_DIR = path.join(REPO, "platform", "db");
const PRD = path.join(REPO, "docs", "PRD.md");
const TOOLS_DIR = path.join(STOREFRONT, "src", "tools");

/* ── a D1 binding, over the real schema ─────────────────────────────────── */

function d1(store) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(fs.readFileSync(path.join(DB_DIR, `${store}.sql`), "utf8"));

  const wrap = (sql) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...bound) };
      },
      async first(column) {
        const row = db.prepare(sql).get(...bound);
        if (row === undefined) return null;
        return column === undefined ? row : row[column];
      },
      async run() {
        const r = db.prepare(sql).run(...bound);
        return {
          success: true,
          meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) },
        };
      },
    };
    return stmt;
  };

  return {
    prepare: wrap,
    /* Test-side escape hatch. Tools never see this. */
    _raw: db,
  };
}

/* An env with every store the ops Worker binds. IDENTITY is bound on the
 * Worker but must remain unreachable from the registry — asserted below. */
function opsEnv() {
  return {
    CUSTOMERS: d1("customers"),
    COMMERCE: d1("commerce"),
    PEOPLE: d1("people"),
    FINANCE: d1("finance"),
    AUDIT: d1("audit"),
    IDENTITY: d1("identity"),
  };
}

function seed(env) {
  const cu = env.CUSTOMERS._raw;
  cu.exec(`
    INSERT INTO customer(id, birth_year, notes) VALUES ('cus_1', 1985, 'prefers navy');
    INSERT INTO customer(id, birth_year) VALUES ('cus_2', 1991);
    INSERT INTO customer_fit(customer_id, garment, size_label) VALUES ('cus_1','tops','IT 42');
    INSERT INTO customer_consent(customer_id, purpose, granted, source)
      VALUES ('cus_1','fit_profile',1,'in_store'), ('cus_1','marketing',1,'checkout');
  `);

  const co = env.COMMERCE._raw;
  co.exec(`
    INSERT INTO location(id,name) VALUES ('loc_1','Flagship');
    INSERT INTO "order"(id,order_number,channel,external_id,customer_id,status,total_minor,currency,placed_at)
      VALUES ('ord_1',1,'shopify','gid/1','cus_1','paid',560000,'USD','2026-09-01T10:00:00Z'),
             ('ord_2',2,'pos','pos/1','cus_1','fulfilled',98000,'USD','2026-09-02T10:00:00Z');
    INSERT INTO order_line(id,order_id,product_handle,sku_snapshot,title_snapshot,quantity,unit_price_minor,currency)
      VALUES ('lin_1','ord_1','shearling-trimmed-wool-coat','VEM-0001','Shearling-trimmed wool-blend coat',1,560000,'USD');
    INSERT INTO inventory_adjustment(id,sku,location_id,delta,reason,actor)
      VALUES ('adj_seed','VEM-0001','loc_1',4,'count','seed@vemians.com');
    INSERT INTO inventory_reservation(id,sku,location_id,quantity) VALUES ('res_seed','VEM-0001','loc_1',1);
  `);

  const pe = env.PEOPLE._raw;
  pe.exec(`
    INSERT INTO employee(id,email,name,role) VALUES
      ('emp_1','ana@vemians.com','Ana','staff'),
      ('emp_2','mara@vemians.com','Mara','manager');
    INSERT INTO shift(id,employee_id,location_id,starts_at,ends_at) VALUES
      ('shf_1','emp_1','loc_1','2026-09-08T09:00:00Z','2026-09-08T17:00:00Z'),
      ('shf_2','emp_2','loc_1','2026-09-09T09:00:00Z','2026-09-09T17:00:00Z');
  `);

  const fi = env.FINANCE._raw;
  fi.exec(`
    INSERT INTO budget(id,name,period,limit_minor,currency) VALUES ('bud_1','Marketing','2026-Q3',500000,'USD');
    INSERT INTO expense(id,budget_id,employee_id,employee_name,description,amount_minor,currency,incurred_on,status,receipt_r2_key)
      VALUES ('exp_1','bud_1','ana@vemians.com','ana@vemians.com','Lookbook prints',120000,'USD','2026-09-01','submitted','r2/receipts/exp_1.pdf'),
             ('exp_2','bud_1','tomas@vemians.com','tomas@vemians.com','Window install',900000,'USD','2026-09-02','submitted','r2/receipts/exp_2.pdf'),
             ('exp_3','bud_1','ana@vemians.com','ana@vemians.com','Courier',4500,'USD','2026-09-03','submitted',NULL),
             ('exp_4','bud_1','ana@vemians.com','ana@vemians.com','Studio hire',60000,'USD','2026-09-04','submitted','r2/receipts/exp_4.pdf');
  `);
  return env;
}

/* One place to build a ctx, so no test can accidentally invent an actor. */
function fixture({ actor = "mara@vemians.com", role = "manager", rate } = {}) {
  const env = seed(opsEnv());
  const approvals = createApprovalStore();
  const catalog = createSeedCatalogSource();
  /* A limiter per fixture: one test's traffic must not deny another's. */
  const limiter = rate ?? createRateLimiter();
  return {
    env,
    approvals,
    catalog,
    ctx: { actor, role, env, approvals, catalog, rate: limiter },
    audit(where = "") {
      return env.AUDIT._raw.prepare(`SELECT * FROM audit_log ${where} ORDER BY id`).all();
    },
  };
}

const staff = { actor: "ana@vemians.com", role: "staff" };

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

/* ─────────────────────────────────────────────────────────────────────────
 * P0-21 — every call is audited, before it returns and before it acts
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_21_append_only_audit__a_successful_read_writes_one_row_before_returning", async () => {
  const f = fixture();
  const before = f.audit();
  assert.equal(before.length, 0);

  const res = await runTool("customer.profile", { customer_id: "cus_1" }, f.ctx);
  assert.equal(res.ok, true);

  const rows = f.audit();
  assert.equal(rows.length, 1, "exactly one audit row for one successful read");
  assert.equal(rows[0].id, res.auditId, "the returned auditId is that row");
  assert.equal(rows[0].actor, "mara@vemians.com");
  assert.equal(rows[0].tool, "customer.profile");
  assert.equal(rows[0].result, "ok");
  assert.equal(JSON.parse(rows[0].detail).stores[0], "customers");
});

check("test_PRD_P0_21_append_only_audit__a_denied_call_is_audited_as_denied", async () => {
  const f = fixture(staff);
  const res = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);
  assert.equal(res.ok, false);

  const rows = f.audit();
  assert.equal(rows.length, 1, "a denial is not a silent return");
  assert.equal(rows[0].result, "denied");
  assert.equal(rows[0].tool, "expense.approve");
  assert.equal(rows[0].actor, "ana@vemians.com");
  assert.equal(res.auditId, rows[0].id);
});

check("test_PRD_P0_21_append_only_audit__an_unknown_tool_is_audited_before_it_is_refused", async () => {
  const f = fixture();
  const res = await runTool("order.refund", { order_id: "ord_1" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /no tool/);
  const rows = f.audit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "denied");
  assert.equal(rows[0].tool, "order.refund");
  assert.equal(rows[0].domain, "commerce", "the namespace picks a legal audit domain");
});

check("test_PRD_P0_21_append_only_audit__a_failure_after_the_intent_row_appends_a_second_row", async () => {
  const f = fixture();
  /* Break the store the tool is about to read, after every gate has passed. */
  f.env.COMMERCE.prepare = () => {
    throw new Error("commerce store unavailable");
  };
  const res = await runTool("order.get", { order_id: "ord_1" }, f.ctx);
  assert.equal(res.ok, false);

  const rows = f.audit();
  assert.equal(rows.length, 2, "intent row, then the failure row");
  assert.equal(rows[0].result, "ok");
  assert.equal(rows[1].result, "error");
  assert.equal(JSON.parse(rows[1].detail).reverses, rows[0].id, "the failure points at the intent row");
});

check("test_PRD_P0_21_append_only_audit__an_unavailable_audit_store_stops_the_call_entirely", async () => {
  const f = fixture();
  f.env.AUDIT = null; /* fail closed: no audit binding at all */

  const res = await runTool(
    "expense.approve",
    { expense_id: "exp_1" },
    { ...f.ctx, env: f.env, approvalToken: "whatever" },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /audit unavailable/);
  assert.equal(res.auditId, null);

  /* And nothing happened: the expense is untouched. */
  const row = f.env.FINANCE._raw.prepare("SELECT status, approved_by FROM expense WHERE id='exp_1'").get();
  assert.equal(row.status, "submitted");
  assert.equal(row.approved_by, null);
});

check("test_PRD_P0_21_append_only_audit__the_log_refuses_an_update_or_a_delete_from_the_tool_layer", async () => {
  const f = fixture();
  await runTool("catalog.search", { q: "coat" }, f.ctx);
  const raw = f.env.AUDIT._raw;
  assert.throws(() => raw.exec("UPDATE audit_log SET result='denied'"), /append-only/);
  assert.throws(() => raw.exec("DELETE FROM audit_log"), /append-only/);
});

check("test_PRD_P0_21_append_only_audit__every_tool_domain_is_one_the_schema_accepts", () => {
  /* No mapping any more: an audit row names the store the action actually
     touched. This asserts the code's list and the schema's CHECK agree, so
     widening one without the other fails here rather than at runtime. */
  const sql = fs.readFileSync(path.join(DB_DIR, "audit.sql"), "utf8");
  for (const domain of AUDIT_DOMAINS) {
    assert.ok(sql.includes(`'${domain}'`), `audit.sql CHECK does not accept '${domain}'`);
  }
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.ok(AUDIT_DOMAINS.includes(tool.domain), `${name} has domain '${tool.domain}', which the CHECK rejects`);
  }
});

check("test_PRD_P0_21_append_only_audit__arguments_are_recorded_and_secretish_values_are_redacted", async () => {
  const f = fixture();
  await runTool("catalog.search", { q: "coat", limit: 5 }, f.ctx);
  const row = f.audit().at(-1);
  assert.deepEqual(JSON.parse(row.arguments), { q: "coat", limit: 5 });
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-23 — the actor is the Access identity, and the role gates the tool
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_23_group_derived_roles__a_staff_role_is_denied_a_manager_tool", async () => {
  const f = fixture(staff);
  const res = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /requires the manager role/);
  assert.equal(res.needsApproval, undefined, "a denied call is not offered an approval token");
  assert.equal(JSON.parse(f.audit().at(-1).detail).reason, "role");

  /* And a manager gets past that same gate. */
  const g = fixture({ actor: "mara@vemians.com", role: "manager" });
  const ok = await runTool("expense.approve", { expense_id: "exp_1" }, g.ctx);
  assert.equal(ok.needsApproval, true, "the manager reaches the approval gate instead");
});

check("test_PRD_P0_23_group_derived_roles__actor_cannot_be_passed_as_an_argument", async () => {
  const f = fixture(staff);
  const res = await runTool(
    "customer.profile",
    { customer_id: "cus_1", actor: "owner@vemians.com" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /identity comes from Cloudflare Access/);

  const row = f.audit().at(-1);
  assert.equal(row.result, "denied");
  assert.equal(row.actor, "ana@vemians.com", "audited as the real caller, not the claimed one");
  assert.equal(JSON.parse(row.detail).field, "actor");
});

check("test_PRD_P0_23_group_derived_roles__no_tool_schema_declares_an_identity_or_scope_field", () => {
  const forbidden = ["actor", "role", "on_behalf_of", "email", "store", "stores", "sql", "env"];
  for (const [name, tool] of Object.entries(TOOLS)) {
    for (const field of Object.keys(tool.schema)) {
      assert.ok(!forbidden.includes(field), `${name} declares '${field}' as an argument`);
    }
  }
});

check("test_PRD_P0_23_group_derived_roles__a_call_with_no_access_identity_runs_nothing", async () => {
  const f = fixture();
  const res = await runTool("customer.profile", { customer_id: "cus_1" }, { ...f.ctx, actor: undefined });
  assert.equal(res.ok, false);
  assert.match(res.error, /no verified Access identity/);
  assert.equal(f.audit().length, 0, "there is no actor to attribute a row to");
});

check("test_PRD_P0_23_group_derived_roles__staff_see_their_own_schedule_and_managers_see_everyone", async () => {
  const f = fixture(staff);
  const mine = await runTool("schedule.view", { from: "2026-09-07", to: "2026-09-13" }, f.ctx);
  assert.equal(mine.ok, true);
  assert.equal(mine.data.scope, "own");
  assert.deepEqual(mine.data.shifts.map((s) => s.id), ["shf_1"]);

  const g = fixture();
  const all = await runTool("schedule.view", { from: "2026-09-07", to: "2026-09-13" }, g.ctx);
  assert.equal(all.data.scope, "all");
  assert.deepEqual(all.data.shifts.map((s) => s.id), ["shf_1", "shf_2"]);
});

check("test_PRD_P0_23_group_derived_roles__staff_see_only_their_own_expenses", async () => {
  const f = fixture(staff);
  const res = await runTool("expense.list", {}, f.ctx);
  assert.equal(res.data.scope, "own");
  assert.ok(res.data.expenses.every((e) => e.employee_id === "ana@vemians.com"));
  assert.ok(res.data.expenses.length > 0);

  const g = fixture();
  const wide = await runTool("expense.list", {}, g.ctx);
  assert.equal(wide.data.scope, "all");
  assert.ok(wide.data.expenses.length > res.data.expenses.length);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-24 — scope is a binding
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_24_binding_scoped_tools__a_tool_receives_only_the_stores_it_declares", async () => {
  const f = fixture();

  /* budget.status declares `finance`. Take every other store off the env: if it
   * held a wider handle it would be reaching for one of these. */
  const narrow = { FINANCE: f.env.FINANCE, AUDIT: f.env.AUDIT };
  const res = await runTool("budget.status", {}, { ...f.ctx, env: narrow });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.budgets.length, 1);

  /* And the converse: a tool cannot borrow a store it did not declare. Give it
   * every store EXCEPT the one it declared and it fails rather than falling
   * back to whatever else is attached. */
  const wrong = { ...f.env, FINANCE: undefined };
  const denied = await runTool("budget.status", {}, { ...f.ctx, env: wrong });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /binding FINANCE/);

  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.ok(Array.isArray(tool.stores), `${name} declares no stores array`);
    for (const store of tool.stores) {
      assert.ok(STORE_BINDINGS[store], `${name} declares unbindable store '${store}'`);
    }
  }
});

check("test_PRD_P0_24_binding_scoped_tools__no_tool_can_reach_the_identity_vault", async () => {
  assert.equal(STORE_BINDINGS.identity, undefined, "the registry has no identity binding at all");
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.ok(!tool.stores.includes("identity"), `${name} declares the identity store`);
  }

  /* Even with IDENTITY bound on the Worker, a tool's db has no handle to it. */
  const f = fixture();
  assert.ok(f.env.IDENTITY, "the ops Worker does bind IDENTITY");
  const res = await runTool("customer.profile", { customer_id: "cus_1" }, f.ctx);
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(res.data).includes("identity"), false);
});

check("test_PRD_P0_24_binding_scoped_tools__a_missing_binding_is_an_error_not_a_silent_undefined", async () => {
  const f = fixture();
  const env = { ...f.env, FINANCE: undefined };
  const res = await runTool("budget.status", {}, { ...f.ctx, env });
  assert.equal(res.ok, false);
  assert.match(res.error, /binding FINANCE is not attached/);
  assert.equal(f.audit().at(-1).result, "error");
});

check("test_PRD_P0_24_binding_scoped_tools__a_cross_domain_read_is_a_second_tool_not_a_wider_binding", () => {
  /* customer.history joins commerce by id and holds no customers binding. */
  assert.deepEqual(TOOLS["customer.history"].stores, ["commerce"]);
  assert.deepEqual(TOOLS["customer.profile"].stores, ["customers"]);
  /* No tool anywhere holds two stores at once. */
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.ok(tool.stores.length <= 1, `${name} binds ${tool.stores.length} stores`);
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-25 — reads run, writes are gated, caps are code, nothing deletes
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_25_write_approval_gate__a_t2_call_without_a_token_returns_needs_approval_and_changes_nothing", async () => {
  const f = fixture();
  const res = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);

  assert.equal(res.ok, false);
  assert.equal(res.needsApproval, true);
  assert.equal(res.tier, "T2");
  assert.ok(res.data.approval.token.startsWith("apr_"));

  const row = f.env.FINANCE._raw.prepare("SELECT status, approved_by FROM expense WHERE id='exp_1'").get();
  assert.equal(row.status, "submitted", "nothing was approved");
  assert.equal(row.approved_by, null);

  const audit = f.audit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].result, "pending_approval");
});

check("test_PRD_P0_25_write_approval_gate__the_same_call_with_the_issued_token_executes_once", async () => {
  const f = fixture();
  const first = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);
  const token = first.data.approval.token;

  const second = await runTool("expense.approve", { expense_id: "exp_1" }, { ...f.ctx, approvalToken: token });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.data.applied, true);

  const row = f.env.FINANCE._raw.prepare("SELECT status, approved_by, approved_at FROM expense WHERE id='exp_1'").get();
  assert.equal(row.status, "approved");
  assert.equal(row.approved_by, "mara@vemians.com");
  assert.ok(row.approved_at);

  /* Single use: replaying the token gets a fresh pending_approval, not a second write. */
  const replay = await runTool("expense.approve", { expense_id: "exp_1" }, { ...f.ctx, approvalToken: token });
  assert.equal(replay.ok, false);

  const results = f.audit().map((r) => r.result);
  assert.deepEqual(results, ["pending_approval", "ok", "denied"]);
});

check("test_PRD_P0_25_write_approval_gate__a_token_does_not_carry_to_a_different_change", async () => {
  const f = fixture();
  const issued = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);
  const token = issued.data.approval.token;

  /* Approval was for exp_1. exp_4 would otherwise approve cleanly; the token
   * must not carry, so it comes back needing its own approval. */
  const swap = await runTool("expense.approve", { expense_id: "exp_4" }, { ...f.ctx, approvalToken: token });
  assert.equal(swap.needsApproval, true);
  const row = f.env.FINANCE._raw.prepare("SELECT status FROM expense WHERE id='exp_4'").get();
  assert.equal(row.status, "submitted");
});

check("test_PRD_P0_25_write_approval_gate__a_price_change_beyond_the_cap_is_refused_not_warned", async () => {
  const f = fixture();
  const shard = await f.catalog.get("cashmere-crewneck");
  const overCap = Math.round(shard.price_minor * 1.5);

  const res = await runTool(
    "catalog.set_price",
    { handle: "cashmere-crewneck", price_minor: overCap, currency: "USD", reason: "sale" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.equal(res.needsApproval, undefined, "a capped change is refused, not sent for approval");
  assert.match(res.error, new RegExp(`exceeds the ${CAPS.PRICE_CHANGE_MAX_PCT}% cap`));
  assert.equal(f.audit().at(-1).result, "denied");
  assert.deepEqual(await f.catalog.staged(), [], "nothing was staged");

  /* Inside the cap, the same tool reaches the approval gate and then stages. */
  const inCap = Math.round(shard.price_minor * 1.1);
  const gate = await runTool(
    "catalog.set_price",
    { handle: "cashmere-crewneck", price_minor: inCap, currency: "USD", reason: "sale" },
    f.ctx,
  );
  assert.equal(gate.needsApproval, true);
  assert.deepEqual(await f.catalog.staged(), [], "still nothing staged without the token");

  const done = await runTool(
    "catalog.set_price",
    { handle: "cashmere-crewneck", price_minor: inCap, currency: "USD", reason: "sale" },
    { ...f.ctx, approvalToken: gate.data.approval.token },
  );
  assert.equal(done.ok, true, done.error);
  const staged = await f.catalog.staged();
  assert.equal(staged.length, 1);
  assert.deepEqual(staged[0].patch, [
    { op: "replace", field: "price_minor", from: shard.price_minor, to: inCap },
  ]);
});

check("test_PRD_P0_25_write_approval_gate__an_expense_over_the_monetary_cap_is_refused_in_code", async () => {
  const f = fixture();
  const res = await runTool("expense.approve", { expense_id: "exp_2" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /exceeds the approval cap/);
  assert.equal(res.needsApproval, undefined);
  assert.equal(f.env.FINANCE._raw.prepare("SELECT status FROM expense WHERE id='exp_2'").get().status, "submitted");
  assert.ok(CAPS.EXPENSE_APPROVE_MAX_MINOR < 900000);
});

check("test_PRD_P0_25_write_approval_gate__the_submitter_cannot_approve_their_own_expense", async () => {
  const f = fixture({ actor: "ana@vemians.com", role: "manager" });
  const res = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /cannot approve their own/);
  assert.equal(f.audit().at(-1).result, "denied");
});

check("test_PRD_P0_25_write_approval_gate__an_expense_with_no_r2_receipt_is_not_approvable", async () => {
  const f = fixture();
  const res = await runTool("expense.approve", { expense_id: "exp_3" }, f.ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /receipt/);
});

check("test_PRD_P0_25_write_approval_gate__a_t1_tool_proposes_and_writes_nothing", async () => {
  const f = fixture(staff);
  const res = await runTool(
    "customer.update_fit",
    { customer_id: "cus_1", garment: "tops", size_label: "IT 44" },
    f.ctx,
  );
  assert.equal(res.ok, true);
  assert.equal(res.tier, "T1");
  assert.equal(res.data.applied, false);
  assert.equal(res.data.proposal.version_rows.length, 1);
  assert.equal(res.data.proposal.version_rows[0].actor, "ana@vemians.com");

  const fit = f.env.CUSTOMERS._raw.prepare("SELECT size_label FROM customer_fit WHERE customer_id='cus_1'").get();
  assert.equal(fit.size_label, "IT 42", "the store is untouched");
  assert.equal(f.env.CUSTOMERS._raw.prepare("SELECT count(*) c FROM customer_version").get().c, 0);

  const submit = await runTool(
    "expense.submit",
    {
      description: "Taxi to shoot",
      amount_minor: 8500,
      currency: "USD",
      incurred_on: "2026-09-05",
      receipt_r2_key: "r2/receipts/new.pdf",
    },
    f.ctx,
  );
  assert.equal(submit.ok, true);
  assert.equal(submit.data.applied, false);
  assert.equal(submit.data.proposal.values.employee_id, "ana@vemians.com");
  assert.equal(f.env.FINANCE._raw.prepare("SELECT count(*) c FROM expense").get().c, 4, "no row inserted");
});

check("test_PRD_P0_25_write_approval_gate__read_tools_run_directly_with_no_approval", async () => {
  const f = fixture();
  for (const name of ["catalog.search", "order.search", "expense.list"]) {
    const res = await runTool(name, {}, f.ctx);
    assert.equal(res.ok, true, `${name}: ${res.error}`);
    assert.equal(res.tier, "T0");
    assert.equal(res.needsApproval, undefined);
  }
});

check("test_PRD_P0_25_write_approval_gate__page_sizes_are_capped_in_the_query_not_the_prompt", async () => {
  const f = fixture();
  const over = await runTool("catalog.search", { limit: CAPS.MAX_ROWS + 500 }, f.ctx);
  assert.equal(over.ok, false, "a limit beyond the cap is a schema error, not a silent clamp");
  const ok = await runTool("catalog.search", { limit: 3 }, f.ctx);
  assert.equal(ok.data.results.length, 3);
  assert.equal(ok.data.limit, 3);
});

check("test_PRD_P0_25_write_approval_gate__a_caller_over_the_rate_cap_is_refused_and_audited", async () => {
  const f = fixture({ rate: createRateLimiter({ max: 2, windowMs: 60_000 }) });
  assert.equal((await runTool("catalog.search", {}, f.ctx)).ok, true);
  assert.equal((await runTool("catalog.search", {}, f.ctx)).ok, true);

  const over = await runTool("catalog.search", {}, f.ctx);
  assert.equal(over.ok, false);
  assert.match(over.error, /rate cap/);

  const row = f.audit().at(-1);
  assert.equal(row.result, "denied");
  assert.equal(JSON.parse(row.detail).reason, "rate_cap");

  /* The cap is per identity, not global: another caller is unaffected. */
  const other = await runTool("catalog.search", {}, { ...f.ctx, actor: "ana@vemians.com", role: "staff" });
  assert.equal(other.ok, true);
});

check("test_PRD_P0_25_write_approval_gate__no_tool_source_file_contains_a_delete_statement", () => {
  const files = fs
    .readdirSync(TOOLS_DIR, { recursive: true })
    .filter((f) => String(f).endsWith(".js"))
    .map((f) => path.join(TOOLS_DIR, String(f)));
  assert.ok(files.length >= 8, "expected the tool layer to be more than a couple of files");

  /* The erasure workflow is the single exception the contract allows, and it is
   * owner-only and writes an erasure_request first. It is not built yet, so the
   * allowance is a named path, not a hole. */
  const ERASURE = path.join(TOOLS_DIR, "erasure.js");
  const DELETE = /\bDELETE\s+FROM\b/i;

  const offenders = files.filter((file) => file !== ERASURE && DELETE.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((f) => path.basename(f)), [], "a DELETE outside the erasure workflow");

  if (fs.existsSync(ERASURE)) {
    const text = fs.readFileSync(ERASURE, "utf8");
    assert.match(text, /erasure_request/, "the erasure workflow must write its request first");
    assert.match(text, /owner/, "the erasure workflow must be owner-gated");
  }

  /* And no tool advertises destruction, whatever the SQL says. */
  for (const name of Object.keys(TOOLS)) {
    assert.ok(!/\b(delete|destroy|purge|drop)\b/i.test(name), `${name} is a destructive name`);
  }
  assert.ok(T3_ABSENT.some((t) => t.name === "order.refund"));
});

check("test_PRD_P0_25_write_approval_gate__every_write_tool_names_its_undo_path", () => {
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (tool.tier === "T0") continue;
    assert.ok(tool.undo && tool.undo.length > 5, `${name} declares no undo path`);
  }
  /* And the description an agent sees carries tier, stores and undo. */
  const described = describeTools("staff");
  assert.ok(described.every((d) => d.tier && Array.isArray(d.stores)));
  assert.ok(described.every((d) => d.min_role !== "manager" && d.min_role !== "owner"));
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-08 / P0-09 / P0-12 — the customer tools
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_08_customers_no_identifiers__customer_profile_returns_no_name_email_or_phone", async () => {
  const f = fixture(staff);
  const res = await runTool("customer.profile", { customer_id: "cus_1" }, f.ctx);
  assert.equal(res.ok, true);

  const json = JSON.stringify(res.data);
  for (const field of ["name", "email", "phone", "notes"]) {
    assert.ok(!new RegExp(`"${field}"`).test(json), `customer.profile returned a '${field}' field`);
  }
  assert.equal(res.data.profile.customer_id, "cus_1");
  assert.equal(res.data.profile.birth_year, 1985);
  assert.equal(res.data.profile.has_notes, true, "the existence of notes, never the notes");
  assert.ok(!json.includes("prefers navy"), "note text leaked into a T0 response");
});

check("test_PRD_P0_08_customers_no_identifiers__no_customer_tool_response_can_carry_an_identifier", async () => {
  const f = fixture(staff);
  const responses = [];
  responses.push(await runTool("customer.profile", { customer_id: "cus_1" }, f.ctx));
  responses.push(await runTool("customer.fit", { customer_id: "cus_1" }, f.ctx));
  responses.push(await runTool("customer.history", { customer_id: "cus_1" }, f.ctx));

  for (const res of responses) {
    assert.equal(res.ok, true, res.error);
    const json = JSON.stringify(res.data);
    for (const pattern of [/"name"/, /"email"/, /"phone"/, /@vemians\.com/]) {
      assert.ok(!pattern.test(json), `${pattern} appeared in a customer tool response`);
    }
  }
  /* The customer tools never even name the identity store's columns. */
  const src = fs.readFileSync(path.join(TOOLS_DIR, "customers.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/customer_identity|name_enc|email_hmac/.test(code));
  assert.ok(!/SELECT \*/i.test(code), "SELECT * would leak a column added later");
});

check("test_PRD_P0_09_data_minimisation__history_is_derived_from_commerce_never_duplicated", async () => {
  const f = fixture(staff);
  const res = await runTool("customer.history", { customer_id: "cus_1" }, f.ctx);
  assert.equal(res.data.count, 2);
  assert.deepEqual(res.data.lifetime, { total_minor: 658000, currency: "USD" });

  /* The profile store holds no copy of it. */
  const cols = f.env.CUSTOMERS._raw.prepare("PRAGMA table_info('customer')").all().map((c) => c.name);
  assert.ok(!cols.some((c) => /order|spend|lifetime/i.test(c)));
});

check("test_PRD_P0_12_reversible_edits__an_update_proposes_the_version_row_before_the_patch", async () => {
  const f = fixture(staff);
  const res = await runTool(
    "customer.update_fit",
    { customer_id: "cus_1", garment: "tops", size_label: "IT 44" },
    f.ctx,
  );
  const p = res.data.proposal;
  assert.deepEqual(p.changes, [{ field: "size_label", old_value: "IT 42", new_value: "IT 44" }]);
  assert.deepEqual(p.version_rows[0], {
    customer_id: "cus_1",
    table_name: "customer_fit",
    field: "size_label",
    old_value: "IT 42",
    new_value: "IT 44",
    actor: "ana@vemians.com",
  });
  assert.equal(p.patch.op, "update");
  assert.deepEqual(p.patch.set, { size_label: "IT 44" });

  /* Applying the proposal by hand is exactly what the schema expects. */
  const raw = f.env.CUSTOMERS._raw;
  const v = p.version_rows[0];
  raw
    .prepare(
      "INSERT INTO customer_version(customer_id,table_name,field,old_value,new_value,actor)" +
        " VALUES (?,?,?,?,?,?)",
    )
    .run(v.customer_id, v.table_name, v.field, v.old_value, v.new_value, v.actor);
  raw.prepare("UPDATE customer_fit SET size_label=? WHERE customer_id=? AND garment=?")
    .run("IT 44", "cus_1", "tops");
  assert.equal(raw.prepare("SELECT size_label FROM customer_fit WHERE customer_id='cus_1'").get().size_label, "IT 44");
  assert.throws(() => raw.exec("UPDATE customer_version SET new_value='IT 50'"), /append-only/);
});

check("test_PRD_P0_12_reversible_edits__a_fit_update_without_recorded_consent_is_refused", async () => {
  const f = fixture(staff);
  const res = await runTool(
    "customer.update_fit",
    { customer_id: "cus_2", garment: "tops", size_label: "IT 40" },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /consent/);
  assert.equal(f.audit().at(-1).result, "denied");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-14 / P0-15 / P0-17 — commerce reads
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_14_order_line_snapshot__order_get_returns_the_line_snapshots", async () => {
  const f = fixture(staff);
  const res = await runTool("order.get", { order_id: "ord_1" }, f.ctx);
  assert.equal(res.ok, true);
  const line = res.data.lines[0];
  assert.equal(line.product_handle, "shearling-trimmed-wool-coat");
  assert.equal(line.title_snapshot, "Shearling-trimmed wool-blend coat");
  assert.equal(line.sku_snapshot, "VEM-0001");
  assert.equal(line.unit_price_minor, 560000);
});

check("test_PRD_P0_15_money_minor_units__tool_responses_carry_integer_minor_amounts_and_a_currency", async () => {
  const f = fixture();
  const order = await runTool("order.get", { order_id: "ord_1" }, f.ctx);
  assert.ok(Number.isInteger(order.data.order.total_minor));
  assert.equal(order.data.order.currency, "USD");

  const budget = await runTool("budget.status", { period: "2026-Q3" }, f.ctx);
  const b = budget.data.budgets[0];
  for (const field of ["limit_minor", "committed_minor", "pending_minor", "remaining_minor"]) {
    assert.ok(Number.isInteger(b[field]), `${field} is not an integer`);
  }
  assert.equal(b.currency, "USD");
  assert.equal(b.derived, true, "a budget balance is derived on read, never stored");
  assert.equal(b.pending_minor, 1084500);
  assert.equal(b.committed_minor, 0);

  const search = await runTool("catalog.search", { q: "coat" }, f.ctx);
  assert.ok(search.data.results.every((r) => Number.isInteger(r.price_minor) && r.currency));
});

check("test_PRD_P0_17_channel_agnostic_orders__order_search_filters_by_channel_with_no_schema_change", async () => {
  const f = fixture(staff);
  const pos = await runTool("order.search", { channel: "pos" }, f.ctx);
  assert.equal(pos.data.count, 1);
  assert.equal(pos.data.orders[0].id, "ord_2");
  const json = JSON.stringify(pos.data);
  for (const banned of ["card", "cvv", "pan", "expiry"]) {
    assert.ok(!json.toLowerCase().includes(banned), `${banned} appeared in an order response`);
  }
});

check("test_PRD_P1_01_agent_read_tools__inventory_check_is_a_live_store_read_not_the_static_build", async () => {
  const f = fixture(staff);
  const res = await runTool("inventory.check", { sku: "VEM-0001" }, f.ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.live, true);
  assert.equal(res.data.levels[0].on_hand, 4);
  assert.equal(res.data.available_total, 3, "available is on_hand minus reserved");

  /* Change the store; the next call must show the new number, not a cached one. */
  /* Stock moves by posting to the ledger; the count is a view and cannot be
     written. Seed was 4, so +5 reaches 9. */
  f.env.COMMERCE._raw.exec(
    "INSERT INTO inventory_adjustment(id,sku,location_id,delta,reason,actor)" +
    " VALUES ('adj_t','VEM-0001','loc_1',5,'receipt','seed@vemians.com')");
  const again = await runTool("inventory.check", { sku: "VEM-0001" }, f.ctx);
  assert.equal(again.data.levels[0].on_hand, 9);
  assert.equal(again.data.available_total, 8);

  /* Every read tool is T0 and audited; none of them asks for approval. */
  const reads = [
    "catalog.search", "catalog.get", "customer.profile", "customer.fit", "customer.history",
    "order.search", "order.get", "inventory.check", "schedule.view", "budget.status", "expense.list",
  ];
  for (const name of reads) {
    assert.ok(TOOLS[name], `${name} is missing from the registry`);
    assert.equal(TOOLS[name].tier, "T0", `${name} is not a read tier`);
  }
});

check("test_PRD_P0_02_catalog_git_shards__search_reads_the_index_and_a_write_reads_the_shard", async () => {
  const f = fixture();
  const search = await runTool("catalog.search", { brand: "Vestra" }, f.ctx);
  assert.ok(search.data.results.length >= 1);
  assert.ok(search.data.results.every((r) => r.source === "index"));

  const get = await runTool("catalog.get", { handle: "cashmere-crewneck" }, f.ctx);
  assert.equal(get.data.product.source, "shard");
  assert.equal(get.data.product.path, "catalog/products/cashmere-crewneck.json");

  /* The read path is one swappable interface, so the Git-backed source drops in. */
  const custom = createSeedCatalogSource([
    { handle: "test-item", brand: "X", name: "Test", minor: 1000, currency: "USD", eyebrow: "new" },
  ]);
  const res = await runTool("catalog.search", {}, { ...f.ctx, catalog: custom });
  assert.deepEqual(res.data.results.map((r) => r.handle), ["test-item"]);
  assert.equal(res.data.source, "seed");

  /* Catalog tools hold no D1 binding at all. */
  for (const name of ["catalog.search", "catalog.get", "catalog.set_price"]) {
    assert.deepEqual(TOOLS[name].stores, []);
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-18 — scheduling
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_18_no_double_booking__a_draft_flags_an_overlap_and_writes_nothing", async () => {
  const f = fixture(staff);
  const res = await runTool(
    "schedule.draft",
    {
      location_id: "loc_1",
      shifts: [
        { employee_id: "emp_1", starts_at: "2026-09-08T16:00:00Z", ends_at: "2026-09-08T20:00:00Z" },
        { employee_id: "emp_1", starts_at: "2026-09-10T09:00:00Z", ends_at: "2026-09-10T17:00:00Z" },
      ],
    },
    f.ctx,
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.applied, false);
  assert.equal(res.data.proposal.conflicts, 1);
  assert.equal(res.data.proposal.publishable, false);
  assert.equal(res.data.proposal.rows[0].conflicts[0].shift_id, "shf_1");
  assert.equal(res.data.proposal.rows[1].conflicts.length, 0);
  assert.equal(f.env.PEOPLE._raw.prepare("SELECT count(*) c FROM shift").get().c, 2, "no shift written");

  /* The guarantee itself is the trigger, not the flag above. */
  assert.throws(
    () =>
      f.env.PEOPLE._raw.exec(
        "INSERT INTO shift(id,employee_id,starts_at,ends_at)" +
          " VALUES('shf_x','emp_1','2026-09-08T16:00:00Z','2026-09-08T20:00:00Z')",
      ),
    /overlaps an existing booking/,
  );
});

check("test_PRD_P0_18_no_double_booking__back_to_back_shifts_draft_cleanly", async () => {
  const f = fixture(staff);
  const res = await runTool(
    "schedule.draft",
    {
      shifts: [{ employee_id: "emp_1", starts_at: "2026-09-08T17:00:00Z", ends_at: "2026-09-08T20:00:00Z" }],
    },
    f.ctx,
  );
  assert.equal(res.data.proposal.conflicts, 0);
  assert.equal(res.data.proposal.publishable, true);
});

check("test_PRD_P0_18_no_double_booking__an_inverted_interval_is_refused_before_it_is_drafted", async () => {
  const f = fixture(staff);
  const res = await runTool(
    "schedule.draft",
    {
      shifts: [{ employee_id: "emp_1", starts_at: "2026-09-09T18:00:00Z", ends_at: "2026-09-09T09:00:00Z" }],
    },
    f.ctx,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /inverted or empty interval/);
  assert.equal(f.audit().at(-1).result, "denied");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-19 — approval is a one-way door
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_19_approved_expense_immutable__an_approved_expense_cannot_be_approved_or_edited_again", async () => {
  const f = fixture();
  const gate = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);
  const done = await runTool(
    "expense.approve",
    { expense_id: "exp_1" },
    { ...f.ctx, approvalToken: gate.data.approval.token },
  );
  assert.equal(done.ok, true);

  const again = await runTool("expense.approve", { expense_id: "exp_1" }, f.ctx);
  assert.equal(again.ok, false);
  assert.match(again.error, /reversing entry/);

  assert.throws(
    () => f.env.FINANCE._raw.exec("UPDATE expense SET amount_minor=1 WHERE id='exp_1'"),
    /cannot be edited/,
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-01 — one store per tool, no cross-store transaction
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_01_store_topology__each_store_is_its_own_database_in_the_tool_layer", async () => {
  const f = fixture();
  /* Six separate connections; a statement prepared on one cannot see another. */
  assert.throws(() => f.env.FINANCE._raw.prepare('SELECT * FROM "order"').all(), /no such table/);
  assert.throws(() => f.env.CUSTOMERS._raw.prepare("SELECT * FROM expense").all(), /no such table/);
  assert.equal(Object.keys(STORE_BINDINGS).length, 4, "the registry reaches four of the six stores");
  assert.ok(!Object.keys(STORE_BINDINGS).includes("audit"), "audit is written by the registry, not by a tool");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-30 — traceability
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", () => {
  assert.ok(fs.existsSync(PRD), `${PRD} not found: PRD-backed checks cannot be traced`);
  const prd = fs.readFileSync(PRD, "utf8");

  /* Read this file's own test names rather than trusting the running set. */
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const names = [...source.matchAll(/^check\("(test_PRD_[A-Za-z0-9_]+)"/gm)].map((m) => m[1]);
  assert.ok(names.length >= 30, `expected a real suite, found ${names.length} checks`);

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
});
