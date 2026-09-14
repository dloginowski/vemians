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
  const sql = overrides.created_at
    ? "INSERT INTO ticket (id, number, title, body, category, priority, status, created_by, assigned_to, created_at)" +
      " VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)"
    : "INSERT INTO ticket (id, number, title, body, category, priority, status, created_by, assigned_to)" +
      " VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)";
  const args = [
    id,
    overrides.number ?? 1,
    overrides.title ?? "Backroom shelving is loose",
    overrides.category ?? "facilities",
    overrides.priority ?? "normal",
    overrides.status ?? "open",
    overrides.created_by ?? "ana@example.test",
    overrides.assigned_to ?? null,
  ];
  if (overrides.created_at) args.push(overrides.created_at);
  db._raw.prepare(sql).run(...args);
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
  assert.match(body, /data-kind="ticket task" data-status="open" href="\/tickets\/tik_1"/);
  assert.match(body, /data-kind="ticket" data-status="open" href="\/tickets\/tik_2"/);
});

check("test_PRD_P0_108_ops_dashboard__default_kind_is_task_with_no_open_customer_ticket", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "facilities", status: "open" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /let currentMode = "task"/);
});

check("test_PRD_P0_108_ops_dashboard__an_open_customer_ticket_switches_the_default_to_tickets", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "customer", status: "open" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /let currentMode = "ticket"/);
});

check("test_PRD_P0_108_ops_dashboard__a_resolved_customer_ticket_does_not_switch_the_default", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "customer", status: "resolved" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /let currentMode = "task"/);
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
  assert.match(body, /<form class="chat" method="post" action="\/tickets\/new"[^>]*id="dash-compose">/);
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
  assert.match(body, /<section class="greet">\s*<h1>Showing: <span id="kind-label">All<\/span>/);
  const greetAt = body.indexOf('<section class="greet">');
  const feedAt = body.indexOf('id="dash-feed"');
  assert.ok(greetAt > -1 && feedAt > -1 && greetAt < feedAt, "the mode indicator must sit above the feed, not below it");
  assert.doesNotMatch(body, /<div class="category-label"/, "the old floating element above the bar must be gone, not duplicated");
});

check("test_PRD_P0_109_status_line_matches_greeting__the_mode_indicator_is_always_shown_never_hidden", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const setModeFn = body.slice(body.indexOf("function setMode"), body.indexOf("function setMode") + 700);
  assert.doesNotMatch(setModeFn, /kindLabel\.hidden/, "the mode indicator must never be toggled hidden");
  assert.match(setModeFn, /: "All"/);
  /* "Showing: " is now static markup around #kind-label, not re-set on
     every mode switch — the label itself only ever holds the mode name. */
  assert.match(body, />Showing: <span id="kind-label">/);
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

check("test_PRD_P0_110_dashboard_modes__exactly_one_mode_is_active_a_plain_string_not_a_set", async () => {
  /* The owner's own correction: "we are not dealing with selections and
     filtering items. We are dealing with modes." Multi-select (a Set) is
     gone; the current mode is one plain string. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.doesNotMatch(body, /new Set\(/, "there must be no multi-select Set left in the mode selector's own script");
  assert.match(body, /let currentMode = /);
});

check("test_PRD_P0_110_dashboard_modes__each_mode_posts_to_its_own_route", async () => {
  /* "When we type in something in the bar and then hit submit, that's a
     new ticket... in a task, that's a new task... uploads should look
     different... same goes for invoices." One shared compose form,
     re-pointed per mode rather than four separate forms. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /DASH_MODE_ACTION = \{ ticket: "\/tickets\/new", task: "\/tickets\/new", expense: "\/expenses\/new", upload: "\/assets\/new" \}/);
});

check("test_PRD_P0_110_dashboard_modes__ticket_and_task_modes_show_text_input_and_mic_not_attach", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const setModeFn = body.slice(body.indexOf("function setMode"), body.indexOf("function setMode") + 1600);
  assert.match(setModeFn, /const isTextMode = mode === "ticket" \|\| mode === "task"/);
  assert.match(setModeFn, /micBtn\.hidden = !isTextMode/);
});

check("test_PRD_P0_110_dashboard_modes__upload_and_expense_modes_show_a_plus_button_not_the_mic", async () => {
  /* The owner's own words: "we're not necessarily putting in text. We are
     literally selecting... instead of the voice, the microphone, we have
     a plus button." */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<button type="button" class="icon-btn" id="dash-attach" aria-label="Attach a file" title="Attach a file" hidden>/);
  const setModeFn = body.slice(body.indexOf("function setMode"), body.indexOf("function setMode") + 1600);
  assert.match(setModeFn, /const isFileMode = mode === "upload" \|\| mode === "expense"/);
  assert.match(setModeFn, /attachBtn\.hidden = !isFileMode/);
});

check("test_PRD_P0_110_dashboard_modes__the_attach_button_is_never_styled_agentic_orange", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.doesNotMatch(body, /id="dash-attach"[^>]*mic-btn/, "the + button must stay the neutral icon-btn look, never the orange mic-btn one");
});

check("test_PRD_P0_110_dashboard_modes__all_mode_disables_the_bar_instead_of_defaulting_to_an_action", async () => {
  /* Browsing only — there is nothing an "All" submission would even mean,
     so the bar is disabled rather than silently defaulting to Tickets. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const setModeFn = body.slice(body.indexOf("function setMode"), body.indexOf("function setMode") + 2200);
  assert.match(setModeFn, /sendBtn\.disabled = !isTextMode && !isFileMode/);
  assert.match(setModeFn, /titleInput\.disabled = !isTextMode && !isFileMode/);
});

check("test_PRD_P0_110_dashboard_modes__a_file_mode_submission_with_no_file_picked_is_blocked_client_side", async () => {
  /* fileInput itself is never marked required — it is permanently hidden
     (only ever opened via the + button), and a hidden-but-required field
     is a real native-validation footgun. Checked in the submit handler
     instead, where preventDefault() actually stops the request. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.doesNotMatch(body, /fileInput\.required = /, "the hidden file input itself must never carry a required attribute");
  const submitHandler = body.slice(body.indexOf('composeForm.addEventListener("submit"'), body.indexOf('composeForm.addEventListener("submit"') + 300);
  assert.match(submitHandler, /e\.preventDefault\(\)/);
  assert.match(submitHandler, /!fileInput\.files\[0\]/);
});

check("test_PRD_P0_110_dashboard_modes__the_bar_button_hidden_attribute_actually_hides_it", async () => {
  /* The same [hidden]-vs-explicit-display trap .category-menu was caught
     by earlier this session: .input-bar button sets display: inline-flex,
     which always beats the browser's own [hidden] { display: none }
     default regardless of specificity. Needed here for the first time
     because this is the first .input-bar button ever toggled via the
     hidden ATTRIBUTE (mic/attach swap per mode) rather than .remove()d
     outright. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /\.input-bar button\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

check("test_PRD_P0_110_dashboard_modes__the_expense_mode_reuses_the_receipt_scanners_own_accept_and_capture", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const setModeFn = body.slice(body.indexOf("function setMode"), body.indexOf("function setMode") + 1600);
  assert.match(setModeFn, /fileInput\.accept = mode === "expense" \? "image\/\*" : ""/);
  assert.match(setModeFn, /setAttribute\("capture", "environment"\)/);
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__all_mode_renders_four_accordion_sections", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  for (const kind of ["task", "ticket", "expense", "upload"]) {
    assert.match(body, new RegExp(`<details class="dash-group" data-kind="${kind}"`), `must render a ${kind} accordion section`);
  }
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__tasks_and_tickets_start_open_expenses_and_uploads_start_closed", async () => {
  /* The owner's own words: "with tasks or tickets auto expanding." */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<details class="dash-group" data-kind="task" open>/);
  assert.match(body, /<details class="dash-group" data-kind="ticket" open>/);
  assert.match(body, /<details class="dash-group" data-kind="expense">/);
  assert.match(body, /<details class="dash-group" data-kind="upload">/);
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__my_own_tickets_sort_oldest_first_above_a_separator", async () => {
  /* The owner's own words: "sort all items assigned or related to me at
     the top with a horizontal separator... with oldest assignment or
     ticket at the top." */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_new", { number: 1, title: "Mine, newer", assigned_to: "ana@example.test", created_at: "2026-06-01T00:00:00Z" });
  seedTicket(tickets, "tik_old", { number: 2, title: "Mine, older", assigned_to: "ana@example.test", created_at: "2026-01-01T00:00:00Z" });
  seedTicket(tickets, "tik_other", { number: 3, title: "Not mine", created_by: "mara@example.test", created_at: "2026-03-01T00:00:00Z" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  const ticketGroup = body.slice(
    body.indexOf('<details class="dash-group" data-kind="ticket"'),
    body.indexOf('<details class="dash-group" data-kind="expense"'),
  );
  const oldMineAt = ticketGroup.indexOf("Mine, older");
  const newMineAt = ticketGroup.indexOf("Mine, newer");
  const sepAt = ticketGroup.indexOf('<hr class="dash-mine-sep">');
  const otherAt = ticketGroup.indexOf("Not mine");
  assert.ok(
    oldMineAt > -1 && oldMineAt < newMineAt && newMineAt < sepAt && sepAt < otherAt,
    "order must be: oldest mine, newer mine, separator, everyone else",
  );
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__no_separator_when_everything_in_a_group_is_mine_or_nobodys", async () => {
  /* A lone group needs no rule to separate it from nothing — e.g. staff's
     own expense.list is already scoped to their own submissions, so the
     Expenses group there is 100% "mine" with nothing to separate from. */
  const finance = sqliteDb("finance");
  seedExpense(finance, "exp_1", { employee_id: "ana@example.test" });
  const res = await get("/dashboard", STAFF, env({ finance, assets: null }));
  const body = await res.text();
  const expenseGroup = body.slice(
    body.indexOf('<details class="dash-group" data-kind="expense"'),
    body.indexOf('<details class="dash-group" data-kind="upload"'),
  );
  assert.doesNotMatch(expenseGroup, /dash-mine-sep/);
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__each_section_shows_its_own_count", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "First" });
  seedTicket(tickets, "tik_2", { number: 2, title: "Second" });
  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<summary><span class="dash-group-label">Tickets<\/span> \(<span class="dash-group-count">2<\/span>\)<\/summary>/);
  assert.match(body, /<summary><span class="dash-group-label">Tasks<\/span> \(<span class="dash-group-count">0<\/span>\)<\/summary>/);
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__narrowing_to_one_mode_hides_the_other_three_sections", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const filterFn = body.slice(body.indexOf("function filterFeed"), body.indexOf("function filterFeed") + 400);
  assert.match(filterFn, /group\.hidden = !show/);
  assert.match(filterFn, /group\.open = true/, "the single remaining visible group must be forced open");
});

check("test_PRD_P0_112_dashboard_status_filter__closed_tickets_carry_their_own_data_status", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "Open one", status: "open" });
  seedTicket(tickets, "tik_2", { number: 2, title: "Closed one", status: "closed" });
  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /data-status="open"[^>]*href="\/tickets\/tik_1"/);
  assert.match(body, /data-status="closed"[^>]*href="\/tickets\/tik_2"/);
});

check("test_PRD_P0_112_dashboard_status_filter__the_dropdown_defaults_to_open_next_to_the_mode_name", async () => {
  /* The owner's own words: "add to the Showing: [mode] - [status
     dropdown]." Don't show any closed tickets unless requested — Open is
     the default selection, not All statuses. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /Showing: <span id="kind-label">All<\/span>[^<]*<select id="status-filter" class="dash-status-select">\s*<option value="open" selected>Open<\/option>/);
});

check("test_PRD_P0_112_dashboard_status_filter__closed_is_hidden_by_default_all_lifts_it", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const applyFn = body.slice(body.indexOf("function applyStatusFilter"), body.indexOf("function applyStatusFilter") + 400);
  assert.match(applyFn, /currentStatus === "all" \|\| \(currentStatus === "open" \? status !== "closed" : status === currentStatus\)/);
});

check("test_PRD_P0_112_dashboard_status_filter__the_dropdown_swaps_for_no_results_when_nothing_matches", async () => {
  /* The owner's own words: "make... Nothing to show for this mode.
     appear in place of status drop down if nothing is found, but
     shortened to 'No Results'." */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<span id="status-no-results" class="dash-status-select" hidden>No Results<\/span>/);
  const refreshFn = body.slice(body.indexOf("function refreshCounts"), body.indexOf("function refreshCounts") + 1100);
  assert.match(refreshFn, /statusFilter\.hidden = !anyVisible/);
  assert.match(refreshFn, /statusNoResults\.hidden = anyVisible/);
});

check("test_PRD_P0_112_dashboard_status_filter__each_groups_own_count_reflects_whats_actually_visible", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const refreshFn = body.slice(body.indexOf("function refreshCounts"), body.indexOf("function refreshCounts") + 1100);
  assert.match(refreshFn, /countEl\.textContent = String\(visible\)/);
});

check("test_PRD_P0_112_dashboard_status_filter__the_mine_separator_hides_itself_once_either_side_is_empty_on_screen", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const refreshFn = body.slice(body.indexOf("function refreshCounts"), body.indexOf("function refreshCounts") + 1100);
  assert.match(refreshFn, /mineVisible = \[\.\.\.group\.querySelectorAll\("\.dash-mine \.ticket-tile"\)\]\.some\(\(t\) => !t\.hidden\)/);
  assert.match(refreshFn, /sep\.hidden = !\(mineVisible && restVisible\)/);
});

check("test_PRD_P0_112_dashboard_status_filter__expenses_and_uploads_sort_newest_first_even_within_mine", async () => {
  /* The owner's own correction once "oldest first" (right for Tickets/
     Tasks) had been applied everywhere: "for expenses and uploads sort
     by newest at the top." */
  const finance = sqliteDb("finance");
  seedExpense(finance, "exp_old", { description: "Old expense", incurred_on: "2026-01-01" });
  seedExpense(finance, "exp_new", { description: "New expense", incurred_on: "2026-06-01" });
  const res = await get("/dashboard", STAFF, env({ finance, assets: null }));
  const body = await res.text();
  const expenseGroup = body.slice(
    body.indexOf('<details class="dash-group" data-kind="expense"'),
    body.indexOf('<details class="dash-group" data-kind="upload"'),
  );
  const newAt = expenseGroup.indexOf("New expense");
  const oldAt = expenseGroup.indexOf("Old expense");
  assert.ok(newAt > -1 && oldAt > -1 && newAt < oldAt, "the newer expense must render before the older one");
});
