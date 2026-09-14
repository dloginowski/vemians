/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * /dashboard driven the way tickets-route.test.mjs drives /tickets: a real
 * Worker fetch, a real-shaped Access assertion, and the real ticket/finance/
 * assets schemas over node:sqlite rather than a fake store. This file is the
 * aggregation itself — that three already-tested T0 reads (ticket.list,
 * expense.list, assets.list) land in one feed, that a ticket assigned to the
 * viewer also counts as a task, that expense.list's own per-employee scoping
 * survives being read from here, and that the default view picks tasks
 * unless an open customer ticket says otherwise. It does not re-test any of
 * those three tools' own behaviour — tools.test.mjs already does that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
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

const MANAGER_POLICY = "56e4eee0-0000-4000-8000-000000000003";
const STAFF_POLICY = "f6e1649c-0000-4000-8000-000000000002";
const STAFF = { email: "ana@example.test", policy_id: STAFF_POLICY };
const STRANGER = { email: "stranger@example.test", policy_id: "unmapped-policy" };

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

function sqliteDb(storeName) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "db", `${storeName}.sql`), "utf8");
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
        const r = db.prepare(text).run(...bound);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db };
}

function seedTicket(db, id, overrides = {}) {
  db._raw
    .prepare(
      "INSERT INTO ticket (id, number, title, body, category, priority, status, created_by, assigned_to)" +
        " VALUES (?, ?, ?, '', ?, ?, ?, 'ana@example.test', ?)",
    )
    .run(
      id,
      overrides.number ?? 1,
      overrides.title ?? "Backroom shelving is loose",
      overrides.category ?? "facilities",
      overrides.priority ?? "normal",
      overrides.status ?? "open",
      overrides.assigned_to ?? null,
    );
}

function seedExpense(db, id, overrides = {}) {
  db._raw
    .prepare(
      "INSERT INTO expense (id, employee_id, employee_name, description, amount_minor, currency, incurred_on)" +
        " VALUES (?, ?, ?, ?, ?, 'USD', ?)",
    )
    .run(
      id,
      overrides.employee_id ?? "ana@example.test",
      overrides.employee_name ?? "Ana",
      overrides.description ?? "Packing tape",
      overrides.amount_minor ?? 1250,
      overrides.incurred_on ?? "2026-09-01",
    );
}

function seedAsset(db, id, overrides = {}) {
  db._raw
    .prepare(
      "INSERT INTO asset (id, store_key, filename, content_type, size_bytes, uploaded_by) VALUES (?, ?, ?, 'text/csv', 512, ?)",
    )
    .run(id, `assets/${id}`, overrides.filename ?? "vendor-price-list.csv", overrides.uploaded_by ?? "mara@example.test");
}

function env({ tickets, finance, assets } = {}) {
  const e = {
    SURFACE: "ops",
    MANAGER_POLICY_ID: MANAGER_POLICY,
    STAFF_POLICY_ID: STAFF_POLICY,
    TICKETS: tickets ?? sqliteDb("tickets"),
    AUDIT: sqliteDb("audit"),
  };
  if (finance !== null) e.FINANCE = finance ?? sqliteDb("finance");
  if (assets !== null) e.ASSETS = assets ?? sqliteDb("assets");
  return e;
}

function get(path, claims, e) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }), e);
}

check("test_PRD_P0_108_ops_dashboard__a_stranger_with_no_mapped_role_is_refused", async () => {
  const res = await get("/dashboard", STRANGER, env());
  assert.equal(res.status, 403);
});

check("test_PRD_P0_108_ops_dashboard__only_get_is_accepted", async () => {
  const res = await worker.fetch(
    new Request("http://localhost/dashboard", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion(STAFF) } }),
    env(),
  );
  assert.equal(res.status, 405);
});

check("test_PRD_P0_108_ops_dashboard__lists_tickets_expenses_and_uploads_together", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "Backroom shelving is loose" });
  const finance = sqliteDb("finance");
  seedExpense(finance, "exp_1", { description: "Packing tape" });
  const assets = sqliteDb("assets");
  seedAsset(assets, "ast_1", { filename: "vendor-price-list.csv" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance, assets }));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Backroom shelving is loose/);
  assert.match(body, /Packing tape/);
  assert.match(body, /vendor-price-list\.csv/);
});

check("test_PRD_P0_108_ops_dashboard__a_ticket_assigned_to_the_viewer_carries_both_kinds", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "Restock the window display", assigned_to: "ana@example.test" });
  seedTicket(tickets, "tik_2", { number: 2, title: "Reorder tissue paper" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /data-kind="ticket task" href="\/tickets\/tik_1"/);
  assert.match(body, /data-kind="ticket" href="\/tickets\/tik_2"/);
});

check("test_PRD_P0_108_ops_dashboard__default_kind_is_task_with_no_open_customer_ticket", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "facilities", status: "open" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /new Set\(\["task"\]\)/);
});

check("test_PRD_P0_108_ops_dashboard__an_open_customer_ticket_switches_the_default_to_tickets", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "customer", status: "open" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /new Set\(\["ticket"\]\)/);
});

check("test_PRD_P0_108_ops_dashboard__a_resolved_customer_ticket_does_not_switch_the_default", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "customer", status: "resolved" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /new Set\(\["task"\]\)/);
});

check("test_PRD_P0_108_ops_dashboard__expenses_stay_scoped_to_the_viewer_for_staff", async () => {
  const finance = sqliteDb("finance");
  seedExpense(finance, "exp_1", { employee_id: "ana@example.test", description: "Expense filed by ana" });
  seedExpense(finance, "exp_2", { employee_id: "mara@example.test", description: "Expense filed by mara" });

  const res = await get("/dashboard", STAFF, env({ finance, assets: null }));
  const body = await res.text();
  assert.match(body, /Expense filed by ana/);
  assert.doesNotMatch(body, /Expense filed by mara/, "expense.list's own per-employee scoping must not be bypassed here");
});

check("test_PRD_P0_108_ops_dashboard__a_missing_finance_or_assets_binding_degrades_instead_of_refusing", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "Backroom shelving is loose" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  assert.equal(res.status, 200, "the page must still render with only the tickets source available");
  const body = await res.text();
  assert.match(body, /Backroom shelving is loose/);
});

check("test_PRD_P0_108_ops_dashboard__the_compose_bar_still_posts_to_tickets_new", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<form class="chat" method="post" action="\/tickets\/new">/);
});

check("test_PRD_P0_108_ops_dashboard__the_compose_mic_is_plain_dictation_not_agentic", async () => {
  /* The owner's own words: "it's not an agentic microphone." class="icon-btn"
     alone, never "mic-btn" — the orange agentic look stays reserved for the
     agent composer and Items' own voice search. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<button type="button" class="icon-btn" id="dash-mic"/);
  assert.doesNotMatch(body, /id="dash-mic"[^>]*mic-btn/);
});

check("test_PRD_P0_108_ops_dashboard__the_kind_filter_menu_offers_all_four_views_plus_all", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  for (const kind of ["", "task", "ticket", "expense", "upload"]) {
    assert.match(body, new RegExp(`data-kind="${kind}"`), `filter menu must offer data-kind="${kind}"`);
  }
});

check("test_PRD_P0_109_status_line_matches_greeting__the_mode_indicator_sits_at_the_top_in_the_greet_spot", async () => {
  /* The owner's own words: "in our dashboard, instead of categories, we
     essentially have a mode selector... indicating the currently
     selected mode in the same space... so that all of these tabs have
     kinda matching layouts." Same .greet spot and font Items now uses
     for its own category status, and opsPage() uses for "Hi Dimitri". */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "facilities", status: "open" });
  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<section class="greet">\s*<h1 id="kind-label">Showing: All<\/h1>\s*<\/section>/);
  const greetAt = body.indexOf('<section class="greet">');
  const feedAt = body.indexOf('id="dash-feed"');
  assert.ok(greetAt > -1 && feedAt > -1 && greetAt < feedAt, "the mode indicator must sit above the feed, not below it");
  assert.doesNotMatch(body, /<div class="category-label"/, "the old floating element above the bar must be gone, not duplicated");
});

check("test_PRD_P0_109_status_line_matches_greeting__the_mode_indicator_is_always_shown_never_hidden", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const updateFn = body.slice(body.indexOf("function updateKindLabel"), body.indexOf("function updateKindLabel") + 300);
  assert.doesNotMatch(updateFn, /kindLabel\.hidden/, "the mode indicator must never be toggled hidden");
  assert.match(updateFn, /"Showing: All"/);
});

check("test_PRD_P0_109_status_line_matches_greeting__the_page_container_shares_the_agent_pages_own_top_and_side_padding", async () => {
  /* Same fix as Items (see items-route.test.mjs's own check): the shared
     .ops rule (top/sides/76px bottom) now lives in OPS_DARK_CSS, which
     TICKETS_CSS already imports, instead of silently falling back to
     theme.css's own roomier generic default. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  /* theme.css's own generic .ops rule is still present in the inlined
     stylesheet (it always is — page() inlines it unconditionally) but no
     longer decides anything here: this tightened rule comes later in the
     cascade at equal specificity, so it wins regardless. */
  assert.match(body, /\.ops\s*\{[^}]*max-width:\s*64rem;\s*padding:\s*12px 8px 76px/s);
});
