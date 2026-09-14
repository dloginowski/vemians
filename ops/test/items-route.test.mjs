/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * /items driven the way assets-route.test.mjs and batch-route.test.mjs drive
 * their routes: a real Worker fetch, a real-shaped Access assertion, and the
 * real mirror schema over node:sqlite rather than a fake store — the
 * archive-only triggers and index views are not the point here, but a
 * hand-rolled fake table could still drift from what the real one selects.
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
const { approvePending } = await import("../src/approvals.js");
const { approvalResultPage } = await import("../src/views.js");

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
const MANAGER = { email: "mara@example.test", policy_id: MANAGER_POLICY };
const STAFF = { email: "ana@example.test", policy_id: STAFF_POLICY };
const STRANGER = { email: "stranger@example.test", policy_id: "unmapped-policy" };

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

/* The real mirror schema, over node:sqlite — same discipline as
   catalog-write.test.mjs and assets-route.test.mjs: a hand-rolled fake table
   could quietly drift from mirror_product_index's own real column list. */
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
        const r = db.prepare(text).run(...bound);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db, db };
}

/* One seeded product, with a category and a custom field already set —
   directly by SQL, the same way a completed nightly sync plus a prior
   catalog.set_custom_fields call would have left it. No Square account or
   adapter involved; this file is the HTTP surface, not the sync. */
function seedProduct(mirror, overrides = {}) {
  mirror.db.exec(
    "INSERT INTO mirror_category (id, external_ref, name) VALUES ('cat1', 'sqcat1', 'Outerwear')",
  );
  const custom = JSON.stringify(overrides.custom_fields ?? { "unit cost": "210.00", vendor: "Acme Mills" });
  mirror.db
    .prepare(
      `INSERT INTO mirror_product (id, external_ref, handle, title, status, channel, custom_fields, category_id)
       VALUES ('p1', 'sqitem1', 'wool-coat', 'Wool Coat', ?, ?, ?, 'cat1')`,
    )
    .run(overrides.status ?? "active", overrides.channel ?? "direct_link", custom);
  mirror.db.exec(
    "INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, price_minor, currency) " +
      "VALUES ('v1', 'sqvar1', 'p1', 'VEM-100', 'One size', 45000, 'USD')",
  );
}

/* Every T2 call appends an INTENT audit row before it will even return
   needsApproval — runTool refuses outright with no AUDIT binding at all,
   same as it would in a real Worker missing one. */
function auditDb() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "db", "audit.sql"), "utf8");
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

function env(mirror) {
  return {
    SURFACE: "ops",
    MANAGER_POLICY_ID: MANAGER_POLICY,
    STAFF_POLICY_ID: STAFF_POLICY,
    CATALOG_MIRROR: mirror,
    AUDIT: auditDb(),
  };
}

function get(path, claims, e) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }), e);
}

function postForm(path, claims, e, fields) {
  const form = new URLSearchParams(fields);
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims), "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    e,
  );
}

check("test_PRD_P0_71_items_tab__the_items_tab_shows_every_field_including_custom_ones", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Wool Coat/);
  assert.match(body, /Outerwear/);
  assert.match(body, /VEM-100/);
  assert.match(body, /unit cost/);
  assert.match(body, /210\.00/);
  assert.match(body, /vendor/);
  assert.match(body, /Acme Mills/);
});

check("test_PRD_P0_71_items_tab__the_grid_is_two_columns_on_a_phone_and_fills_in_more_as_it_widens", async () => {
  /* The owner's own words: "on my phone, I want a two column layout...
     as it gets wider, it will just fill the entire screen." The old
     auto-fill(minmax(240px, 1fr)) never fit two columns below ~500px
     (2 * 240px alone exceeds most phone screens), collapsing to one.
     Fixed at exactly 2 below 480px; auto-fill takes over above it. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.items-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, 1fr\)/s);
  assert.match(body, /@media \(min-width: 480px\)\s*\{\s*\.items-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(240px, 1fr\)\)/s);
});

check("test_PRD_P0_104_items_grid_scrolls_in_place__the_grid_has_its_own_height_cap_and_scrollbar", async () => {
  /* Caught live: typing into the search box re-filters tiles, changing
     the grid's own content height on every keystroke — with no height
     cap of its own, that moved the WHOLE page, losing sight of the grid
     on a short screen. The owner's own words: "make sure that the items
     list is its own frame so that it scales to fit content, and it has
     its own scroll bar instead of scrolling the entire page." Same
     technique .log (the chat history) already uses for the identical
     reason. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.items-grid\s*\{[^}]*max-height:\s*min\(72vh, 900px\)/s);
  assert.match(body, /\.items-grid\s*\{[^}]*overflow-y:\s*auto/s);
});

check("test_PRD_P0_71_items_tab__a_tile_expands_to_the_full_screen_instead_of_cramming_data_into_a_cell", async () => {
  /* The owner's own words: "when I click on the item, it's gonna
     expand to my entire phone screen, and I should see all of that
     data." Same convention as TABLE_CARD_CSS's own .table-card.full in
     the chat log — the SAME element grows in place via a toggled
     class, not a second element or separate scroll state. No dedicated
     Expand button (P0-130) — a click anywhere on a COLLAPSED tile
     expands it; P0-133 changed closing to a dedicated button only. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /class="item-expand"/, "the dedicated expand button was removed by P0-130");
  assert.match(body, /\.item-tile\.full\s*\{[^}]*position:\s*fixed/s);
  assert.match(body, /classList\.add\("full"\)/, "a click on a collapsed tile must expand the SAME element, not open a second one");
});

check("test_PRD_P0_71_items_tab__the_search_box_sits_below_the_grid_not_above_it", async () => {
  /* The owner's own words: "it's not easy to put in stuff at the top
     of the screen of the phone." A thumb reaches the bottom of a phone
     screen far more easily than the top. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const gridAt = body.indexOf('id="items-grid"');
  const searchAt = body.indexOf('id="item-search"');
  assert.ok(gridAt >= 0 && searchAt >= 0, "both the grid and the search box must be present");
  assert.ok(searchAt > gridAt, "the search box must come after the grid in document order");
});

check("test_PRD_P0_71_items_tab__the_search_box_shares_the_chat_composers_own_class_not_matched_values", async () => {
  /* The owner's own words, after the two drifted visibly out of sync
     once already: "if you're gonna match, just make the agent input
     look the same as the search... just make them the same looking."
     The search input's own wrapper now carries class="input-bar" —
     the literal same shared class the chat composer's own .chat-bar
     carries (INPUT_BAR_CSS) — rather than a second, independently
     duplicated set of matching CSS values that can drift again. The
     input no longer sits immediately inside the div — a filter button
     (P0-71's own follow-up, the category menu) now comes first — so
     this checks both are present inside the same bar rather than
     requiring them adjacent. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const bar = /<div class="input-bar">([\s\S]*?)<\/div>/.exec(body);
  assert.ok(bar, "the search bar itself must render with class=\"input-bar\"");
  assert.match(bar[1], /<input type="text" id="item-search"/);
});

check("test_PRD_P0_71_items_tab__the_search_box_is_fixed_to_the_bottom_regardless_of_content", async () => {
  /* The owner's own correction, pointing at a screenshot with the
     chat composer stranded mid-screen on a short page: "does that
     look like it's on the bottom? ... there's not enough content to
     make them on the bottom." position: sticky (a first pass) only
     repositions an element once its own normal position would scroll
     past the viewport edge — a short catalog never reaches that
     point. .input-bar (shared with the chat composer) uses position:
     fixed instead, anchored to the real viewport regardless of how
     little content exists above it. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.input-bar\s*\{[^}]*position:\s*fixed/s);
  assert.match(body, /\.input-bar\s*\{[^}]*bottom:\s*8px/s);
});

check("test_PRD_P0_102_items_search_matches_chat__the_bar_has_a_search_button_and_a_category_filter_button", async () => {
  /* The owner's own words: "it needs a search button on the right...
     it might be a magnifying glass. And on the left side, add a
     little hamburger menu like button..." Both share the chat
     composer's own button classes (icon-btn on the left, send-btn on
     the right) rather than new, independently styled buttons. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const bar = /<div class="input-bar">([\s\S]*?)<\/div>/.exec(body)[1];
  assert.match(bar, /<button type="button" class="icon-btn" id="category-btn"/, "a filter button must sit on the left");
  assert.match(bar, /<button type="button" class="send-btn" id="item-search-btn"/, "a search button must sit on the right");
});

check("test_PRD_P0_102_items_search_matches_chat__the_icon_buttons_share_the_chat_composers_own_classes", async () => {
  /* The actual reason Items' bar never had buttons before this: ITEMS_CSS
     never imported OPS_CSS, where .icon-btn/.send-btn used to be scoped
     to ".chat .chat-bar" specifically. Moved into INPUT_BAR_CSS (which
     ITEMS_CSS does import) and rescoped to plain .input-bar, so this is
     the same rule reaching a new surface, not a second copy of it. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.input-bar \.icon-btn\s*\{[^}]*width:\s*34px/s);
  assert.match(body, /\.input-bar \.send-btn\s*\{[^}]*width:\s*34px/s);
  assert.doesNotMatch(body, /\.chat \.chat-bar \.icon-btn/s, "the old chat-only scoping must not still be set");
});

check("test_PRD_P0_102_items_search_matches_chat__the_search_button_is_not_the_agents_own_orange", async () => {
  /* The owner's own words: "don't style the search button orange, because
     orange indicates AI input... agentic input... that's the only thing
     that should have that orange decoration." The shared .input-bar
     .send-btn rule is a neutral fill; only #chat's own Send and (since
     Test-PRD-P0-129-dashboard_send_requires_content) the Dashboard's own
     #dash-send — the two composer buttons whose own active/disabled
     state needs a visible ON/OFF read — stay accent-coloured. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(
    body,
    /\.input-bar \.send-btn\s*\{[^}]*background:\s*var\(--accent\)/s,
    "the shared send-btn rule must not be the agent's own orange",
  );
  assert.match(body, /#chat \.send-btn, #dash-send\s*\{[^}]*background:\s*var\(--accent\)/s, "the real agent composer (and the dashboard's own send) must still be orange");
});

check("test_PRD_P0_102_items_search_matches_chat__the_category_menu_lists_only_categories_actually_present", async () => {
  /* "A little menu to select existing categories" — existing on the
     products actually rendered, not the full catalog category list a
     manager could create from. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<div class="category-menu" id="category-menu" hidden>/);
  assert.match(body, /<button type="button" class="category-item" data-category="">All categories<\/button>/);
  assert.match(body, /<button type="button" class="category-item" data-category="Outerwear">Outerwear<\/button>/);
});

check("test_PRD_P0_102_items_search_matches_chat__the_menu_actually_starts_hidden_not_just_marked_so", async () => {
  /* Caught live: the menu rendered permanently open. .category-menu's own
     display: flex is an author style, which beats the browser's default
     [hidden] { display: none } UA rule regardless of specificity — so the
     hidden attribute on the element (asserted above) did nothing at all
     without an explicit override restating none for [hidden]. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.category-menu\[hidden\]\s*\{[^}]*display:\s*none/s);
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__a_held_mic_button_sits_between_the_input_and_search", async () => {
  /* The owner's own words: "let's also add a microphone to the search
     bar... by holding that microphone input, you can... describe what
     items you're looking for." Same icon-btn shape as the filter and
     attach buttons, plus its own mic-btn class for the orange fill. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const bar = /<div class="input-bar">([\s\S]*?)<\/div>/.exec(body)[1];
  assert.match(bar, /id="item-search"[\s\S]*id="item-mic-btn"[\s\S]*id="item-search-btn"/, "the mic must sit between the search input and the search button");
  assert.match(bar, /id="item-mic-btn"[^>]*class="icon-btn mic-btn"|class="icon-btn mic-btn"[^>]*id="item-mic-btn"/, "the mic button must carry both the shared shape and its own orange colour class");
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__the_mic_is_orange_not_the_neutral_icon_btn_fill", async () => {
  /* The owner's own words: "the microphone should be orange because
     that is an agentic input." A dedicated .mic-btn rule, not a change
     to the shared .icon-btn fill every other icon button (filter,
     attach) still uses. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.input-bar \.mic-btn\s*\{[^}]*background:\s*var\(--accent\)/s);
});

check("test_PRD_P0_102_items_search_matches_chat__no_category_menu_or_filter_button_when_nothing_is_categorised", async () => {
  /* A category picker over zero categories is not a feature — it is an
     empty box that still opens. The filter button itself is hidden
     rather than rendered as a dead click target. */
  const mirror = mirrorDb();
  mirror.db.exec(
    "INSERT INTO mirror_product (id, external_ref, handle, title, status, channel, custom_fields) " +
      "VALUES ('p1', 'sqitem1', 'wool-coat', 'Wool Coat', 'active', 'direct_link', '{}')",
  );
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /id="category-menu"/);
  assert.match(body, /id="category-btn"[^>]* hidden/, "the filter button must be hidden with nothing to filter by");
});

check("test_PRD_P0_106_search_plan_has_a_category_and_keywords__picking_a_category_never_types_into_the_search_box", async () => {
  /* The owner's own words: "I don't wanna eat up the input area with
     text... it's part of the actual selector. It's not necessarily me
     putting text." A dedicated #category-label line names the pick
     instead — itemSearch.value is never touched by it. Superseded from a
     line floating above the search bar to the top of the page (Test-
     PRD-P0-109-status_line_matches_greeting): see that check below. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<span id="category-label">All categories<\/span>/);
  /* The toggle/outside-click/escape wiring itself now lives in the
     shared dropdownMenuScript() helper (views.js) — itemsPage() only
     supplies what happens when an item is picked. This is the rendered
     OUTPUT of that helper, not its own call-site source, so the closure
     variable is "item" (the helper's own local name), not "btn". */
  const clickHandlerAt = body.indexOf('menu.addEventListener("click"');
  assert.ok(clickHandlerAt > -1, "the category menu must wire its pick through the shared dropdown helper");
  const clickHandler = body.slice(clickHandlerAt, clickHandlerAt + 200);
  assert.doesNotMatch(clickHandler, /itemSearch\.value/, "picking a category must not write into the search box");
  assert.match(clickHandler, /toggleCategory\(item\.dataset\.category\)/, "picking a category must go through the shared multi-select toggle");
});

check("test_PRD_P0_106_search_plan_has_a_category_and_keywords__the_filter_combines_category_and_free_text", async () => {
  /* Both apply at once (AND, not either/or) — the owner's own worked
     example layers a category switch with a colour keyword in the same
     request. Each tile's own data-category (exact) is checked alongside
     data-search (substring), matching the real category_name column
     rather than a second guess parsed out of the combined search blob. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /data-category="Outerwear"/, "each tile needs its own clean category attribute, not only inside the combined search blob");
  const filterFn = body.slice(body.indexOf("function filterItems"), body.indexOf("function filterItems") + 400);
  assert.match(filterFn, /selectedCategories\.has\(el\.dataset\.category\)/);
  assert.match(filterFn, /el\.dataset\.search\.includes\(q\)/);
});

check("test_PRD_P0_107_voice_search_skill__more_than_one_category_can_be_selected_at_once", async () => {
  /* The owner's own words: "the agent would pass the category as part of
     its result, and that menu would automatically select one or more
     categories to satisfy the search." A Set, not a single string —
     toggling one category on never clears another already on. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /const selectedCategories = new Set\(\)/);
  const toggleFn = body.slice(body.indexOf("function toggleCategory"), body.indexOf("function toggleCategory") + 300);
  assert.match(toggleFn, /selectedCategories\.add\(name\)/, "picking a new category must add to the set, not replace it");
  assert.match(toggleFn, /selectedCategories\.delete\(name\)/, "picking an already-active category must remove just that one");
  /* Picking a category must not auto-close the menu — multi-select needs
     a second and third click to still land. */
  const clickHandler = body.slice(body.indexOf('categoryMenuEl.addEventListener("click"'), body.indexOf('categoryMenuEl.addEventListener("click"') + 300);
  assert.doesNotMatch(clickHandler, /categoryMenuEl\.hidden = true/, "picking a category must not close the multi-select menu");
});

check("test_PRD_P0_107_voice_search_skill__the_menu_visibly_checks_whats_currently_selected", async () => {
  /* "That menu would automatically select one or more categories" — a
     visible checked state in the menu itself, not only the dim label
     above the bar. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.category-menu \.category-item\.active\s*\{[^}]*background:\s*rgba\(217, 119, 87, 0\.14\)/s);
  assert.match(body, /function markCategoryMenu/);
  assert.match(body, /classList\.toggle\("active"/);
});

check("test_PRD_P0_106_search_plan_has_a_category_and_keywords__a_voice_driven_category_switch_is_labelled_agent_not_category", async () => {
  /* The owner's own words: "I want to see... the necessary combination of
     categories and/or search pattern created by the agent... add an
     agent colon before the search." Distinguishes an agent-picked
     category from a manually clicked one in the same label slot. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const sendToAgentFn = body.slice(body.indexOf("async function sendToAgent"), body.indexOf("async function sendToAgent") + 1500);
  assert.match(sendToAgentFn, /setAgentCategories\(matches\)/, "a category switch from voice must be labelled Agent, not Category");
  assert.match(sendToAgentFn, /data\.keywords/, "leftover keywords from the plan must still reach the search box");
});

check("test_PRD_P0_107_voice_search_skill__a_voice_category_switch_replaces_the_whole_set", async () => {
  /* "It knows that I need to switch my category to dresses" — a full
     replacement of whatever was selected before, not an addition to it,
     unlike a manual click's own toggle. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const setAgentFn = body.slice(body.indexOf("function setAgentCategories"), body.indexOf("function setAgentCategories") + 250);
  assert.match(setAgentFn, /selectedCategories\.clear\(\)/, "an agent-driven switch must clear whatever was selected before adding its own picks");
});

check("test_PRD_P0_109_status_line_matches_greeting__the_status_line_sits_at_the_top_in_the_greet_spot", async () => {
  /* The owner's own words: "instead of putting categories above the
     search bar, let's put them up above where in the agent chat it
     says hi Dimitri... use that same font, same kind of layout." Moved
     from a line floating above the search bar to a plain, in-flow
     .greet section at the very top of the page — the same spot and
     font (.greet h1) opsPage()'s own greeting uses. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<section class="greet">\s*<h1><span id="category-label">All categories<\/span>/);
  const greetAt = body.indexOf('<section class="greet">');
  const gridAt = body.indexOf('<div class="items-grid"');
  assert.ok(greetAt > -1 && gridAt > -1 && greetAt < gridAt, "the status line must sit above the grid, not below it");
  /* The old floating element above the bar is gone — this is a move, not
     an addition. */
  assert.doesNotMatch(body, /<div class="category-label"/);
});

check("test_PRD_P0_109_status_line_matches_greeting__the_line_is_always_shown_never_hidden", async () => {
  /* "Hi Dimitri" never hides itself depending on what you have typed; the
     status line here does the same now — "All categories" is itself the
     answer when nothing is picked, rather than an empty, hidden line. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const updateFn = body.slice(body.indexOf("function updateCategoryLabel"), body.indexOf("function updateCategoryLabel") + 300);
  assert.doesNotMatch(updateFn, /categoryLabel\.hidden/, "the status line must never be toggled hidden");
  assert.match(updateFn, /"All categories"/);
});

check("test_PRD_P0_109_status_line_matches_greeting__the_page_container_shares_the_agent_pages_own_top_and_side_padding", async () => {
  /* theme.css's own generic .ops (24px top, 16px sides, centred) was never
     overridden here — only opsPage()'s own OPS_CSS overrode it — so the
     status line silently sat twice as far from the top as "Hi Dimitri"
     despite living in the exact same .greet markup. Caught live: "you
     need to match the agent exactly... that exact place." The fix moved
     the shared part of .ops (max-width, top, sides, and the 76px bottom
     that clears .input-bar alone) into OPS_DARK_CSS, which ITEMS_CSS
     already imports. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  /* theme.css's own generic .ops rule is still present in the inlined
     stylesheet (it always is — page() inlines it unconditionally) but no
     longer decides anything here: this tightened rule comes later in the
     cascade at equal specificity, so it wins regardless. */
  assert.match(body, /\.ops\s*\{[^}]*max-width:\s*64rem;\s*padding:\s*12px 8px 76px/s);
});

check("test_PRD_P0_112_dashboard_status_filter__the_item_tile_hidden_attribute_actually_hides_it", async () => {
  /* The same [hidden]-vs-explicit-display trap caught twice already this
     session (.category-menu, .input-bar button): .item-tile sets
     display: flex, which always beats the browser's own default
     [hidden] { display: none } regardless of specificity — so
     filterItems()'s own el.hidden = ... has silently never actually
     hidden a filtered-out tile since Items' own search/category filter
     was first built. Caught as a byproduct of chasing the Dashboard's
     own "a ticket shows in every mode" report, which turned out to be
     the very same bug class hitting a different tile class. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.item-tile\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

check("test_PRD_P0_112_dashboard_status_filter__unchecking_a_category_never_leaves_it_looking_orange", async () => {
  /* The owner's own words: "when I uncheck a category selection, I
     expect the button to not be orange anymore, but it is." The class
     toggle itself was already correct (verified directly with a real
     browser, not assumed) — the bug was :hover sharing the exact same
     accent border/text colour as .active, so a just-unchecked button
     still looked selected for as long as the pointer sat over it, which
     is usually right where a click just happened. :hover is now neutral;
     .active (declared after it) still wins the tie while a checked
     button is hovered, so "checked" is the only thing orange means here. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.category-menu \.category-item:hover \{ border-color: var\(--ink\); color: var\(--ink\); \}/);
  const hoverAt = body.indexOf(".category-menu .category-item:hover");
  const activeAt = body.indexOf(".category-menu .category-item.active {");
  assert.ok(hoverAt > -1 && activeAt > hoverAt, ".active must be declared after :hover so it wins the specificity tie while hovered");
});

check("test_PRD_P0_71_items_tab__no_redundant_title_wastes_space_the_tab_bar_already_spent", async () => {
  /* The owner's own words: "we have the tab, we know we're in items
     right now. Get rid of all that stuff." The tab bar itself already
     names the page; a second, page-drawn "Items" heading right under
     it was pure wasted vertical space on a phone. Test-PRD-P0-109-
     status_line_matches_greeting later gave .greet a real job here (the
     live category status, not a page title) — this check only guards
     against a REDUNDANT literal "Items" heading returning, not against
     .greet existing at all. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /<h1>Items<\/h1>/, "no redundant Items heading may remain");
});

check("test_PRD_P0_71_items_tab__items_no_longer_draws_its_own_copy_of_the_tab_bar_or_banner", async () => {
  /* The persistent shell (index.js's / route, views.js's shellPage()) is the
     ONLY place the tab bar AND the "employees only" strip render now — the
     owner's own words: "the header is always present. Everything else is
     an iframe." A page loaded INTO that iframe drawing either a second
     time would be exactly the duplication tabs exist to avoid. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /shell-nav/);
  assert.doesNotMatch(body, /class="bar"/);
});

check("test_PRD_P0_71_items_tab__a_broken_mirror_index_fails_plainly_not_as_a_raw_exception", async () => {
  /* The real regression this guards: custom_fields was added to
     mirror_product by hand (ALTER TABLE, run once against production —
     this schema has no migration runner), but mirror_product_index is a
     VIEW, and SQLite compiles a view's own column list at CREATE VIEW
     time — altering the base table does not update it. Modelled here by
     using the OLD view shape (no custom_fields) against the NEW code that
     expects the column, exactly what production looked like right after
     the table alone was migrated. */
  const mirror = mirrorDb();
  mirror.db.exec("DROP VIEW mirror_product_index");
  mirror.db.exec(
    `CREATE VIEW mirror_product_index AS
     SELECT id, external_ref, handle, title, source_description, status, channel, category_id, source_version, synced_at
     FROM mirror_product WHERE archived_at IS NULL`,
  );
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.match(body, /mirror_product_index also needs recreating/, "the fix, not just the fact of failure, must be on screen");
  assert.doesNotMatch(body, /no such column/i, "a raw SQL error must not reach the person reading this page");
});

check("test_PRD_P0_71_items_tab__only_manager_and_above_see_the_edit_controls", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);

  const staffView = await (await get("/items", STAFF, env(mirror))).text();
  assert.doesNotMatch(staffView, /\/items\/wool-coat\/custom-fields/, "staff must not see an edit form at all");

  const managerView = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(managerView, /\/items\/wool-coat\/custom-fields/);
  assert.match(managerView, /\/items\/wool-coat\/channel/);
});

check("test_PRD_P0_71_items_tab__an_unmapped_identity_cannot_reach_the_items_tab", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STRANGER, env(mirror));
  assert.equal(res.status, 403);
});

check("test_PRD_P0_71_items_tab__the_items_tab_degrades_plainly_with_no_mirror_bound", async () => {
  const res = await get("/items", STAFF, { SURFACE: "ops", MANAGER_POLICY_ID: MANAGER_POLICY, STAFF_POLICY_ID: STAFF_POLICY });
  assert.equal(res.status, 503);
});

/*
 * The actual click on /approvals/<id> is exercised the same way
 * catalog-write.test.mjs's own P0-35 check does it: approvePending() called
 * directly with a hand-built, already-verified approver, rather than
 * through worker.fetch — a real Cloudflare Access signature is a whole
 * JWKS round trip this file has no need to fake, and P0-35's own suite
 * already proves the HTTP /approvals/ route calls approvePending()
 * correctly. What THIS file is responsible for is everything before that
 * click: that a tile's own form actually parks the right tool call.
 */
const OWNER = { email: "owner@vemians.com", role: "owner", verified: true };

check("test_PRD_P0_71_items_tab__editing_custom_fields_from_a_tile_parks_a_t2_approval", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const e = env(mirror);
  const res = await postForm("/items/wool-coat/custom-fields", MANAGER, e, {
    field_name_0: "unit cost",
    field_value_0: "225.00",
    field_name_1: "vendor",
    field_value_1: "",
    field_name_2: "season",
    field_value_2: "Fall 2026",
  });
  assert.equal(res.status, 303);
  const location = res.headers.get("location");
  assert.match(location, /^\/approvals\//, "must hand off to the SAME approval page every other catalog write uses");

  /* Nothing has actually changed yet — parking is not approving. */
  const stillOld = mirror.db.prepare("SELECT custom_fields FROM mirror_product WHERE handle = 'wool-coat'").get();
  assert.match(stillOld.custom_fields, /Acme Mills/);

  const id = location.slice("/approvals/".length);
  const approved = await approvePending(e, id, OWNER);
  assert.equal(approved.ok, true, approved.error);

  const updated = mirror.db.prepare("SELECT custom_fields FROM mirror_product WHERE handle = 'wool-coat'").get();
  const fields = JSON.parse(updated.custom_fields);
  assert.deepEqual(fields, { "unit cost": "225.00", season: "Fall 2026" }, "update one, remove one (blank), add one — one patch");
});

check("test_PRD_P0_71_items_tab__editing_the_channel_from_a_tile_also_parks_a_t2_approval", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "direct_link" });
  const e = env(mirror);
  const res = await postForm("/items/wool-coat/channel", MANAGER, e, { on_website: "on" });
  assert.equal(res.status, 303);
  const location = res.headers.get("location");

  const id = location.slice("/approvals/".length);
  const approved = await approvePending(e, id, OWNER);
  assert.equal(approved.ok, true, approved.error);

  const updated = mirror.db.prepare("SELECT channel FROM mirror_product WHERE handle = 'wool-coat'").get();
  assert.equal(updated.channel, "website");
});

check("test_PRD_P0_71_items_tab__approving_an_items_tab_edit_sends_the_approver_back_to_items", () => {
  /* The routing half (index.js choosing backHref from the parked tool's own
     name) is exercised by inspection here rather than a second HTTP round
     trip through real Access verification — approvalResultPage() is what
     that routing decision actually renders, so this is what a person
     clicking "Approve and run" from an Items-tab tile would see. */
  const withItemsBack = approvalResultPage(true, { updated: true }, { backHref: "/items", backLabel: "Back to Items" });
  assert.match(withItemsBack, /href="\/items"/);
  assert.match(withItemsBack, /Back to Items/);

  const withDefault = approvalResultPage(true, { updated: true });
  assert.match(withDefault, /href="\/"/);
  assert.match(withDefault, /Back to ops/);
});

check("test_PRD_P0_71_items_tab__staff_cannot_propose_an_item_edit_either", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/custom-fields", STAFF, env(mirror), {
    field_name_0: "vendor",
    field_value_0: "Someone Else",
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);

  const unchanged = mirror.db.prepare("SELECT custom_fields FROM mirror_product WHERE handle = 'wool-coat'").get();
  assert.match(unchanged.custom_fields, /Acme Mills/, "nothing must be parked, let alone applied, from a staff submission");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-130 — the tile IS the photo; everything else moves into .item-detail,
 * shown only once expanded; no dedicated Expand button; the channel edit
 * form is a single checkbox.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_130_item_tile_photo__a_synced_image_renders_as_the_tiles_own_background", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  mirror.db.exec(
    "INSERT INTO mirror_image (id, external_ref, product_id, source_url, ordinal, media_key) " +
      "VALUES ('img1', 'sqimg1', 'p1', 'https://square.example/photo.jpg', 0, 'products/wool-coat/0.jpg')",
  );
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<div class="item-photo" style="background-image:url\('https:\/\/media\.vemians\.com\/products\/wool-coat\/0\.jpg'\)">/);
});

check("test_PRD_P0_130_item_tile_photo__no_synced_image_falls_back_to_the_plain_fill", async () => {
  /* No generated placeholder art (the storefront's own toneFor() graphic) —
     a plain internal utility grid, unlike the public shop's front door, has
     no reason to grow its own generator for the same job a flat
     var(--image-ground) fill already does honestly. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<div class="item-photo">/, "no image_key must render with no inline background-image style at all");
});

check("test_PRD_P0_131_item_status_filter__the_collapsed_tile_shows_title_price_sku_and_short_tags", async () => {
  /* The owner's own words: "title on top left, price top right, SKU
     bottom left, and then a few of the tags, but shorten them." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<div class="item-top"><h3>Wool Coat<\/h3>\s*<div class="item-top-right">\s*<span class="item-price">\$ 450<\/span>/);
  assert.match(
    body,
    /<div class="item-bottom"><span class="item-sku">VEM-100<\/span><div class="item-tags"><span class="item-tag channel-direct_link">In store<\/span><span class="item-tag">Outerwear<\/span><\/div><\/div>/,
  );
});

check("test_PRD_P0_130_item_tile_photo__everything_else_moves_into_the_expanded_only_detail_section", async () => {
  /* Channel, status, every variation and every custom field still render —
     just inside .item-detail, which ITEMS_CSS hides until the tile itself
     carries .full (P0-130's own click-anywhere-to-expand). */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const detail = /<div class="item-detail">([\s\S]*?)<\/article>/.exec(body);
  assert.ok(detail, "the tile must carry an .item-detail section");
  assert.match(detail[1], /item-badges/);
  assert.match(detail[1], /unit cost/);
  assert.match(body, /\.item-detail\s*\{[^}]*display:\s*none/s);
  assert.match(body, /\.item-tile\.full \.item-detail\s*\{[^}]*display:\s*flex/s);
});

check("test_PRD_P0_130_item_tile_photo__no_dedicated_expand_button_a_click_anywhere_expands_it", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /item-expand/);
  assert.match(
    body,
    /const tile = e\.target\.closest\("\.item-tile"\);\s*\n\s*if \(!tile \|\| e\.target\.closest\("\.item-edit"\) \|\| tile\.classList\.contains\("full"\)\) return;/,
    "a click anywhere on a COLLAPSED tile expands it, except inside the edit form or once already expanded",
  );
});

check("test_PRD_P0_130_item_tile_photo__the_channel_edit_control_is_a_single_checkbox", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "website" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /<select name="channel">/, "the 3-way select was replaced by a checkbox");
  assert.match(body, /<input type="checkbox" name="on_website" checked>/, "already-website must render checked");
});

check("test_PRD_P0_130_item_tile_photo__leaving_the_checkbox_unchecked_sets_direct_link", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "website" });
  const e = env(mirror);
  /* A real browser submits nothing at all for an unchecked checkbox. */
  const res = await postForm("/items/wool-coat/channel", MANAGER, e, {});
  assert.equal(res.status, 303);
  const id = res.headers.get("location").slice("/approvals/".length);
  const approved = await approvePending(e, id, OWNER);
  assert.equal(approved.ok, true, approved.error);
  const updated = mirror.db.prepare("SELECT channel FROM mirror_product WHERE handle = 'wool-coat'").get();
  assert.equal(updated.channel, "direct_link");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-131 — In Store / Web / Inactive status filter; inactive tiles show
 * only an "Inactive" tag; letterbox bars are a flat translucent fill.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_131_item_status_filter__the_dropdown_defaults_to_in_store", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const select = /<select id="item-status-filter" class="dash-status-select">([\s\S]*?)<\/select>/.exec(body);
  assert.ok(select, "the status filter must render");
  assert.match(select[1], /<option value="in_store" selected>In Store<\/option>/);
  assert.match(select[1], /<option value="web">Web<\/option>/);
  assert.match(select[1], /<option value="inactive">Inactive<\/option>/);
});

check("test_PRD_P0_131_item_status_filter__in_store_shows_every_active_item_any_channel_web_narrows_to_website", async () => {
  /* The owner's own words: "in store, which will show all of the items
     that we have in store that are active, basically... web, which will
     show us just the items that are on the web." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const fn = body.slice(body.indexOf("function matchesStatusFilter"), body.indexOf("function filterItems"));
  assert.match(fn, /statusFilter === "web" \? el\.dataset\.channel === "website" : true/, "In Store ignores channel; Web narrows to website");
});

check("test_PRD_P0_131_item_status_filter__inactive_items_are_excluded_from_the_other_two_views", async () => {
  /* "By default, neither this in store nor the web view should show the
     inactive items." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const fn = body.slice(body.indexOf("function matchesStatusFilter"), body.indexOf("function filterItems"));
  assert.match(fn, /if \(el\.dataset\.status === "inactive"\) return false;/);
  assert.match(fn, /if \(statusFilter === "inactive"\) return el\.dataset\.status === "inactive";/);
});

check("test_PRD_P0_131_item_status_filter__the_default_filter_is_applied_the_moment_the_page_loads", async () => {
  /* Inactive items must start hidden without anyone touching the dropdown
     — a bare filterItems() call after the listeners are wired, not only
     one triggered by a later "change" or "input" event. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const afterWiring = body.slice(body.indexOf('itemStatusFilterEl.addEventListener("change"'));
  assert.match(afterWiring, /\}\);\s*\n(?:\/\*[\s\S]*?\*\/\s*\n)?filterItems\(\);/, "filterItems() must run once, unconditionally, right after the dropdown is wired");
});

check("test_PRD_P0_131_item_status_filter__an_inactive_products_tile_carries_data_status_and_shows_only_the_inactive_tag", async () => {
  /* "When the item is not activated, I don't need to see any of the
     other tags... it's just inactive." Draft and archived both collapse
     into the same "inactive" bucket — the owner thinks of status as a
     two-state thing, not Square's own three-value lifecycle. */
  const mirror = mirrorDb();
  seedProduct(mirror, { status: "draft", channel: "website" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /data-status="inactive" data-channel="website"/);
  assert.match(
    body,
    /<div class="item-bottom"><span class="item-sku">VEM-100<\/span><div class="item-tags"><span class="item-tag item-tag-inactive">Inactive<\/span><\/div><\/div>/,
    "an inactive tile must show only the Inactive tag, not its channel or category",
  );
});

check("test_PRD_P0_131_item_status_filter__the_overlay_bars_are_a_flat_translucent_fill_not_a_gradient", async () => {
  /* The owner's own words: "a dim half transparent gray background for
     the text on top and bottom... almost like we're looking at a
     letterbox" — a flat fill reads evenly regardless of what part of the
     photo sits behind it, unlike a gradient that fades toward one edge. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.item-top, \.item-bottom \{[^}]*background:\s*rgba\(25, 24, 23, 0\.75\)/s);
  assert.doesNotMatch(body, /\.item-top\s*\{[^}]*linear-gradient/s);
  assert.doesNotMatch(body, /\.item-bottom\s*\{[^}]*linear-gradient/s);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-132 — a deep link into one product's own expanded view, copyable from
 * a button that only appears once the tile is expanded.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_132_item_deep_link__every_tile_carries_its_own_handle_and_a_hidden_share_button", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /data-handle="wool-coat"/);
  assert.match(body, /class="item-share"/);
  assert.match(body, /\.item-share\s*\{[^}]*display:\s*none/s, "the share button must be hidden on a collapsed tile");
  assert.match(body, /\.item-tile\.full \.item-share\s*\{[^}]*display:\s*inline-flex/s, "and shown once the tile is expanded");
});

check("test_PRD_P0_132_item_deep_link__clicking_share_does_not_also_collapse_the_tile", async () => {
  /* The click-delegation handler must special-case .item-share the same
     way it already special-cases .item-edit — otherwise the very click
     that copies the link would also collapse the tile out from under it. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const handler = body.slice(body.indexOf('addEventListener("click", (e) => {\n  const shareBtn'), body.indexOf("shareLink(shareBtn)") + 60);
  assert.match(handler, /const shareBtn = e\.target\.closest\("\.item-share"\);/);
  assert.match(handler, /shareLink\(shareBtn\);\s*\n\s*return;/);
});

check("test_PRD_P0_132_item_deep_link__the_link_is_a_hash_not_a_server_route", async () => {
  /* The owner's own words: "I want to get a deep link into that expanded
     view so I can send it to somebody." The whole catalog already renders
     in one response, so #item-<handle> costs nothing a real route would
     otherwise fetch. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /"#item-" \+ encodeURIComponent\(handle\)/);
});

check("test_PRD_P0_132_item_deep_link__opening_a_linked_item_forces_it_visible_and_expanded", async () => {
  /* "Whoever opens the link sees the product, not today's filter state" —
     a linked product must un-hide itself even if it would otherwise be
     filtered out by category or status. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const fn = body.slice(body.indexOf('location.hash.startsWith("#item-")'), body.indexOf('location.hash.startsWith("#item-")') + 500);
  assert.match(fn, /linked\.hidden = false;/);
  assert.match(fn, /linked\.classList\.add\("full"\);/);
  assert.match(fn, /linked\.scrollIntoView/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-133 — closing an expanded tile takes a dedicated button, not a click
 * anywhere on its body (which stays the way a COLLAPSED tile expands).
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_133_item_close_button__every_tile_carries_a_close_button_hidden_until_expanded", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<button type="button" class="item-close" aria-label="Close" title="Close">/);
  assert.match(body, /\.item-close\s*\{[^}]*display:\s*none/s, "the close button must be hidden on a collapsed tile");
  assert.match(body, /\.item-tile\.full \.item-close\s*\{[^}]*display:\s*inline-flex/s, "and shown once the tile is expanded");
});

check("test_PRD_P0_133_item_close_button__clicking_it_collapses_the_tile", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const handler = body.slice(body.indexOf('const closeBtn = e.target.closest(".item-close");'), body.indexOf('const closeBtn = e.target.closest(".item-close");') + 150);
  assert.match(handler, /closeBtn\.closest\("\.item-tile"\)\.classList\.remove\("full"\);/);
});

check("test_PRD_P0_133_item_close_button__a_click_on_an_already_expanded_tiles_body_does_nothing", async () => {
  /* The owner's own words: "it's too easy to click somewhere wrong and it
     will close, and that's not a good experience." A click on the tile
     itself only ever ADDS .full now (a collapsed tile expands); it never
     removes it — only .item-close does that. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /tile\.classList\.toggle\("full"\)/, "the tile body must not toggle .full at all any more");
  assert.match(body, /tile\.classList\.contains\("full"\)\) return;\s*\n\s*tile\.classList\.add\("full"\);/);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", async () => {
  const prd = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "PRD.md"),
    "utf8",
  );
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
