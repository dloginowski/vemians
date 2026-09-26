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
/* A distinct identity from STAFF, only for the P0-129 checks below — see
   P0_115_STAFF's own comment, further down this file, for why: this
   file's own runTool calls all share ONE module-level rate limiter
   (src/tools/rate.js) keyed by actor email, and these checks land early
   enough in the file that using the heavily-shared "ana@example.test"
   pushed an unrelated, later check in this same file over that budget. */
const P0_129_STAFF = { email: "dana@example.test", policy_id: STAFF_POLICY };

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

check("test_PRD_P0_114_dashboard_default_mode__with_nothing_at_all_the_default_falls_back_to_task", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /let currentMode = "task"/);
});

check("test_PRD_P0_114_dashboard_default_mode__auto_selects_ticket_when_tasks_are_empty_but_tickets_are_not", async () => {
  /* The owner's own words: "you should auto select mode which has
     something to show... in general you should default to tasks or
     tickets, whichever is not empty." A ticket that exists but is not
     assigned to the viewer means Tasks is empty while Tickets is not, so
     the default must not land on the empty one. */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "facilities", status: "open" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /let currentMode = "ticket"/);
});

check("test_PRD_P0_114_dashboard_default_mode__a_task_assigned_to_the_viewer_still_wins_the_default", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "facilities", status: "open", assigned_to: "ana@example.test" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /let currentMode = "task"/);
});

check("test_PRD_P0_114_dashboard_default_mode__only_closed_tickets_still_counts_as_empty", async () => {
  /* Judged against what the client's own default status filter will
     actually show (open only), not the raw row count — a dashboard with
     only closed tickets must not default to a mode that then renders
     empty once that filter applies. */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "facilities", status: "closed" });

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

check("test_PRD_P0_108_ops_dashboard__a_resolved_customer_ticket_does_not_trigger_customer_precedence", async () => {
  /* Customer precedence is for an OPEN customer ticket specifically — a
     resolved one falls through to the ordinary "whichever is not empty"
     rule (Test-PRD-P0-114-dashboard_default_mode) instead: Tasks is
     still empty here, but Tickets is not (the resolved ticket itself
     still counts — it is not closed), so the default lands on "ticket"
     via that rule, not on "task" via a false customer-precedence match. */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { category: "customer", status: "resolved" });

  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /let currentMode = "ticket"/);
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
  assert.match(body, /<section class="greet">\s*<h1 id="dash-status-heading">Showing: <span id="kind-label">All<\/span>/);
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
     .ops rule (top/sides/bottom) now lives in OPS_DARK_CSS, which
     TICKETS_CSS already imports, instead of silently falling back to
     theme.css's own roomier generic default. Bottom is 64px, not the
     original 76px — see Test-PRD-P0-157's own comment on .ops. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  /* theme.css's own generic .ops rule is still present in the inlined
     stylesheet (it always is — page() inlines it unconditionally) but no
     longer decides anything here: this tightened rule comes later in the
     cascade at equal specificity, so it wins regardless. */
  assert.match(body, /\.ops\s*\{[^}]*max-width:\s*64rem;\s*padding:\s*12px 8px 64px/s);
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
     so the bar is disabled rather than silently defaulting to Tickets.
     Send's own disabling is now updateSendState()'s job (Test-PRD-P0-129-dashboard_send_requires_content) —
     it still ends up disabled in All mode (updateSendState()'s own "else
     disabled = true" branch), just no longer via this direct assignment. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const setModeFn = body.slice(body.indexOf("function setMode"), body.indexOf("function setMode") + 2200);
  assert.match(setModeFn, /updateSendState\(\);/);
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

check("test_PRD_P0_129_dashboard_send_requires_content__picking_a_mode_alone_does_not_enable_send", async () => {
  /* The owner's own words: "the send arrow in dashboard also needs a
     disabled state (same dark gray glyph) when there is no entry." The
     same bug P0-124 already fixed on #chat's own Send: setMode() used to
     enable Send purely by mode (any valid mode, empty field or not).
     updateSendState() checks the mode-appropriate content instead —
     titleInput's own value for a text mode, a picked file for a file
     mode — disabled outright when no mode is picked at all. */
  const res = await get("/dashboard", P0_129_STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const stateFn = body.slice(body.indexOf("function updateSendState"), body.indexOf("function updateSendState") + 400);
  assert.match(stateFn, /sendBtn\.disabled = !fileInput\.files\[0\]/, "a file mode must require an actual picked file");
  assert.match(stateFn, /sendBtn\.disabled = !titleInput\.value\.trim\(\)/, "a text mode must require actual typed content");
  assert.match(stateFn, /sendBtn\.disabled = true/, "no mode at all must stay disabled outright");
  const setModeFn = body.slice(body.indexOf("function setMode"), body.indexOf("function setMode") + 1600);
  assert.match(setModeFn, /updateSendState\(\);/, "setMode() must delegate to updateSendState() rather than assign disabled by mode alone");
  assert.doesNotMatch(setModeFn, /sendBtn\.disabled = !isTextMode && !isFileMode/, "the old mode-only assignment must be gone");
});

check("test_PRD_P0_129_dashboard_send_requires_content__typing_attaching_and_dictation_all_re_check_the_buttons_own_state", async () => {
  /* updateSendState() only helps if it actually runs after everything
     that can change either input — the same class of gap #chat's own
     composer already had to close. */
  const res = await get("/dashboard", P0_129_STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /titleInput\.addEventListener\("input", updateSendState\)/, "typing a title must re-check the button's own state");
  const changeHandler = body.slice(body.indexOf("fileInput.addEventListener"), body.indexOf("fileInput.addEventListener") + 300);
  assert.match(changeHandler, /updateSendState\(\);/, "picking a file must re-check the button's own state");
  const resetFn = body.slice(body.indexOf("function resetAttachment"), body.indexOf("function resetAttachment") + 300);
  assert.match(resetFn, /updateSendState\(\);/, "clearing an attachment must re-check the button's own state too");
  /* Dictation fills dash-title via the shared dictationScript() helper,
     which sets .value directly (no native "input" event) — it must
     dispatch one itself so this page's own listener above still fires. */
  const resultHandler = body.slice(body.indexOf('addEventListener("result"'), body.indexOf('addEventListener("result"') + 700);
  assert.match(resultHandler, /field\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/, "a dictation result must dispatch a real input event for the page's own listener to react to");
});

check("test_PRD_P0_129_dashboard_send_requires_content__dash_send_shares_the_agent_composers_own_orange_scheme", async () => {
  /* Rather than duplicate four declarations under a second selector,
     #dash-send joins #chat .send-btn in the same grouped rule — one
     dim-orange-plus-dark-gray-glyph disabled look, one
     bright-orange-plus-white-glyph active look, for both. --ground only
     reads as a deliberate dark gray against something bright enough to
     contrast it — verified directly before assuming otherwise that
     #dash-send's own previous neutral fill would still show a glyph at
     all (it would not: near-black on near-black, the same
     disappearing-icon failure mode P0-128 diagnosed on the mic). */
  const res = await get("/dashboard", P0_129_STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /#chat \.send-btn, #dash-send \{ background: var\(--accent\); color: var\(--ink\); \}/, "dash-send must share the active look");
  assert.match(body, /#chat \.send-btn:disabled, #dash-send:disabled \{ background: rgba\(217, 119, 87, 0\.35\); color: var\(--ground\)/, "dash-send must share the disabled look");
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__all_mode_renders_a_section_for_every_kind_with_something_in_it", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "Assigned", assigned_to: "ana@example.test" });
  const finance = sqliteDb("finance");
  seedExpense(finance, "exp_1");
  const assets = sqliteDb("assets");
  seedAsset(assets, "ast_1");
  const res = await get("/dashboard", STAFF, env({ tickets, finance, assets }));
  const body = await res.text();
  for (const kind of ["task", "ticket", "expense", "upload"]) {
    assert.match(body, new RegExp(`<details class="dash-group" data-kind="${kind}"`), `must render a ${kind} accordion section when it has something in it`);
  }
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__tasks_and_tickets_start_open_expenses_and_uploads_start_closed", async () => {
  /* The owner's own words: "with tasks or tickets auto expanding." */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "Assigned", assigned_to: "ana@example.test" });
  const finance = sqliteDb("finance");
  seedExpense(finance, "exp_1");
  const assets = sqliteDb("assets");
  seedAsset(assets, "ast_1");
  const res = await get("/dashboard", STAFF, env({ tickets, finance, assets }));
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
    body.indexOf('</div>\n  <div class="category-menu"'),
  );
  assert.doesNotMatch(expenseGroup, /dash-mine-sep/);
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__each_section_shows_its_own_count", async () => {
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "First" });
  seedTicket(tickets, "tik_2", { number: 2, title: "Second", assigned_to: "ana@example.test" });
  const res = await get("/dashboard", STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<summary><span class="dash-group-label">Tickets<\/span> \(<span class="dash-group-count">2<\/span>\)<\/summary>/);
  assert.match(body, /<summary><span class="dash-group-label">Tasks<\/span> \(<span class="dash-group-count">1<\/span>\)<\/summary>/);
});

check("test_PRD_P0_111_dashboard_all_mode_grouping__narrowing_to_one_mode_hides_the_other_three_sections", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const filterFn = body.slice(body.indexOf("function filterFeed"), body.indexOf("function filterFeed") + 400);
  assert.match(filterFn, /group\.hidden = !show/);
  assert.match(filterFn, /group\.open = true/, "the single remaining visible group must be forced open");
});

check("test_PRD_P0_114_dashboard_default_mode__the_accordion_chrome_only_shows_in_all_mode", async () => {
  /* The owner's own words: "no need for accordion for selected modes.
     Accordion is only when showing all." Narrowing to one mode hides
     that group's own <summary> (rather than removing it) — a browser
     falls back to no marker at all for a present-but-hidden summary, so
     the content shows plainly with no collapse chevron and nothing left
     to click; switching back to All restores it. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const filterFn = body.slice(body.indexOf("function filterFeed"), body.indexOf("function filterFeed") + 1300);
  assert.match(filterFn, /summary\.hidden = true/);
  assert.match(filterFn, /summary\.hidden = false/);
});

check("test_PRD_P0_172_dashboard_tile_spacing__mine_and_rest_groups_carry_their_own_vertical_gap", async () => {
  /* The owner's own words: "use consistent vertical padding in the
     dashboard between items to kind of match the same padding that you
     use everywhere else because right now they're just too stuck
     together." .ticket-list's own gap only separates .dash-mine, the
     <hr> separator, and .dash-rest as whole blocks from each other —
     it does not reach the .ticket-tile elements nested inside those
     wrapper divs, which had no gap of their own, so consecutive tiles
     within the same group rendered edge-to-edge. Uses P0_129_STAFF (not
     STAFF) since this check lands early enough in the file to push a
     later STAFF-keyed check over this file's shared rate-limit budget
     otherwise — see that identity's own comment above. */
  const res = await get("/dashboard", P0_129_STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /\.dash-mine,\s*\.dash-rest\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*gap:\s*8px;\s*\}/);
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
  assert.match(body, /<h1 id="dash-status-heading">Showing: <span id="kind-label">All<\/span>[^<]*<select id="status-filter" class="dash-status-select">\s*<option value="open" selected>Open<\/option>/);
});

check("test_PRD_P0_112_dashboard_status_filter__closed_is_hidden_by_default_all_lifts_it", async () => {
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  const applyFn = body.slice(body.indexOf("function applyStatusFilter"), body.indexOf("function applyStatusFilter") + 400);
  assert.match(applyFn, /currentStatus === "all" \|\| \(currentStatus === "open" \? status !== "closed" : status === currentStatus\)/);
});

check("test_PRD_P0_116_dashboard_status_line_refinements__no_results_appends_after_the_dropdown_not_in_place_of_it", async () => {
  /* Superseding P0-112's own "swaps for" behaviour: "no results still
     needs a menu selector, no results is appended on the end." */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<select id="status-filter" class="dash-status-select">[\s\S]*?<\/select> <span id="status-no-results" class="dash-status-select" hidden>No Results<\/span>/);
  const refreshFn = body.slice(body.indexOf("function refreshCounts"), body.indexOf("function refreshCounts") + 1100);
  assert.doesNotMatch(refreshFn, /statusFilter\.hidden/, "the dropdown itself is never hidden");
  assert.match(refreshFn, /statusNoResults\.hidden = anyVisible/);
});

check("test_PRD_P0_125_status_headings_all_match__the_showing_heading_shares_the_bumped_size_with_every_other_page", async () => {
  /* P0-116's own words: "bump up the font size for the selection
     heading," scoped to #dash-status-heading alone at the time so
     opsPage's "Hi Dimitri" and Items' "All categories" kept their
     smaller original size. Test-PRD-P0-125-status_headings_all_match
     asked for the opposite: "make sure that the agents and the items
     also have the bigger font size for the top header... just so it's
     all consistent." The shared .greet h1 rule itself now carries the
     15px (see ops-page.test.mjs's own P0-125 check); the Dashboard's own
     #dash-status-heading override is gone — nothing left to bump on top
     of a base that already matches it. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /\.greet h1 \{ font-size: 15px;/);
  assert.doesNotMatch(body, /#dash-status-heading \{ font-size: 15px; \}/, "the now-redundant Dashboard-only override must be gone");
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

check("test_PRD_P0_114_dashboard_default_mode__an_empty_group_carries_no_redundant_placeholder_text", async () => {
  /* The owner's own words: "get rid of 'Nothing here yet.' It's
     redundant." The summary's own (0) already says so in All mode, and
     the status line's own "No Results" swap already says so for a
     narrowed-down single mode (P0-112) — an empty group's own body is
     now just empty, not a third repetition of the same fact. */
  const res = await get("/dashboard", STAFF, env({ finance: null, assets: null }));
  const body = await res.text();
  assert.doesNotMatch(body, /Nothing here yet/);
});

/* A distinct identity from STAFF, only for the checks below — this file's
   own AUDIT-less runTool calls all share ONE module-level rate limiter
   (src/tools/rate.js) across every test file in this run, keyed by actor
   email; enough of the suite already calls tools as "ana@example.test"
   that a check landing late in the run can be silently rate-capped and
   see empty data even though its own scenario is set up correctly. */
const P0_115_STAFF = { email: "priya@example.test", policy_id: STAFF_POLICY };

check("test_PRD_P0_115_dashboard_hide_empty_groups__an_empty_kind_renders_no_accordion_section_at_all", async () => {
  /* The owner's own words: "don't show empty accordions at all! So when
     showing all — only tickets expandable section," given a dashboard
     with only tickets in it. No FINANCE/ASSETS binding here means
     Expenses and Uploads have nothing at all, and Tasks has nothing
     since the one ticket is unassigned — only the Tickets section
     should exist in the DOM, not just be hidden or collapsed. */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "A general ticket" });
  const res = await get("/dashboard", P0_115_STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /<details class="dash-group" data-kind="ticket"/);
  assert.doesNotMatch(body, /<details class="dash-group" data-kind="task"/);
  assert.doesNotMatch(body, /<details class="dash-group" data-kind="expense"/);
  assert.doesNotMatch(body, /<details class="dash-group" data-kind="upload"/);
});

check("test_PRD_P0_115_dashboard_hide_empty_groups__choosing_an_empty_mode_from_the_selector_still_shows_no_results", async () => {
  /* Nothing to unhide or force open for a kind with no <details> section
     at all — refreshCounts()'s own "is anything visible" check already
     finds zero regardless, so the status line's own No Results swap
     covers this case for free, with no special-casing needed. */
  const tickets = sqliteDb("tickets");
  seedTicket(tickets, "tik_1", { title: "A general ticket" });
  const res = await get("/dashboard", P0_115_STAFF, env({ tickets, finance: null, assets: null }));
  const body = await res.text();
  assert.match(body, /DASH_KIND_LABEL = \{ ticket: "Tickets", task: "Tasks", expense: "Expenses", upload: "Uploads" \}/);
  assert.match(body, /data-kind="upload">Uploads<\/button>/, "the mode selector itself still offers every kind, empty or not");
});
