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
  const custom = JSON.stringify(overrides.custom_fields ?? { "unit cost": "210.00" });
  mirror.db
    .prepare(
      `INSERT INTO mirror_product (id, external_ref, handle, title, source_description, status, channel, custom_fields, style_id, commission_pct, category_id)
       VALUES ('p1', 'sqitem1', 'wool-coat', 'Wool Coat', ?, ?, ?, ?, ?, ?, 'cat1')`,
    )
    .run(
      overrides.description ?? "",
      overrides.status ?? "active",
      overrides.channel ?? "direct_link",
      custom,
      overrides.style_id ?? null,
      overrides.commission_pct ?? null,
    );
  /* vendor moved off mirror_product entirely (Test-PRD-P0-136-square_
     custom_attributes, revised for Retail Plus) — a real mirror_vendor row,
     referenced from the ordinal-0 variation, "one vendor per product." */
  let vendorId = null;
  if (overrides.vendor) {
    vendorId = "vendor1";
    mirror.db
      .prepare("INSERT INTO mirror_vendor (id, external_ref, name) VALUES (?, 'sqvendor1', ?)")
      .run(vendorId, overrides.vendor);
  }
  mirror.db
    .prepare(
      `INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, price_minor, currency, vendor_id, vendor_code, unit_cost_minor, unit_cost_currency)
       VALUES ('v1', 'sqvar1', 'p1', 'VEM-100', 'One size', 45000, 'USD', ?, ?, ?, ?)`,
    )
    .run(
      vendorId,
      overrides.vendor_code ?? null,
      overrides.unit_cost_minor ?? 0,
      overrides.unit_cost_currency ?? "USD",
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

function env(mirror, commerce) {
  return {
    SURFACE: "ops",
    MANAGER_POLICY_ID: MANAGER_POLICY,
    STAFF_POLICY_ID: STAFF_POLICY,
    CATALOG_MIRROR: mirror,
    AUDIT: auditDb(),
    ...(commerce ? { COMMERCE: commerce } : {}),
  };
}

/* shared/db/commerce.sql, over node:sqlite — same discipline as mirrorDb()
   above, for the ONE query the Items tab makes into this store (a batched
   read of inventory_level, for "show current count"). */
function commerceDb() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "db", "commerce.sql"), "utf8");
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
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db };
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
  seedProduct(mirror, { vendor: "Acme Mills" });
  const res = await get("/items", STAFF, env(mirror));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Wool Coat/);
  assert.match(body, /Outerwear/);
  assert.match(body, /VEM-100/);
  assert.match(body, /unit cost/);
  assert.match(body, /210\.00/);
  /* vendor is Square's own Custom Attribute now (P0-136), not a custom_fields
     entry — its own labeled row, not a generic key/value pair. */
  assert.match(body, /<span>Vendor<\/span><span>Acme Mills<\/span>/);
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
  /* The real regression this guards: a column added to a mirror_* table by
     hand (ALTER TABLE, run once against production — this schema has no
     migration runner) does not reach that table's own *_index VIEW, since
     SQLite compiles a view's own column list at CREATE VIEW time. REVISED
     (P0-137): listAllProducts's own product query moved off
     mirror_product_index onto mirror_product directly (archived rows must
     surface here too), so a stale PRODUCT view can no longer break this
     particular read — but the variants/vendors/categories/images it also
     reads are still each a separate *_index view, so this same failure
     mode is modelled here against mirror_variant_index instead: the OLD
     shape (no unit_cost_minor) against the NEW code that expects the
     column, exactly what production looked like right after only the
     table was migrated. */
  const mirror = mirrorDb();
  mirror.db.exec("DROP VIEW mirror_variant_index");
  mirror.db.exec(
    `CREATE VIEW mirror_variant_index AS
     SELECT id, external_ref, product_id, sku, title, ordinal, price_minor, currency, options,
            tracks_stock, vendor_id, vendor_code, source_version, synced_at
     FROM mirror_variant WHERE archived_at IS NULL`,
  );
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.match(body, /its own \*_index view likely needs recreating too/, "the fix, not just the fact of failure, must be on screen");
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

check("test_PRD_P0_135_item_edit_applies_immediately__editing_custom_fields_from_a_tile_needs_no_second_confirmation", async () => {
  /* The owner's own words: "I'm still seeing confirmation dialogs whenever
     I try to add a custom field... I shouldn't have to do this every
     time." Submitting the form IS the decision — it applies in the same
     request, with no /approvals/<id> hop and no second click. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/custom-fields", MANAGER, env(mirror), {
    field_name_0: "unit cost",
    field_value_0: "225.00",
    field_name_1: "vendor",
    field_value_1: "",
    field_name_2: "season",
    field_value_2: "Fall 2026",
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/items", "no /approvals/<id> hop — straight back to the tab");

  const updated = mirror.db.prepare("SELECT custom_fields FROM mirror_product WHERE handle = 'wool-coat'").get();
  const fields = JSON.parse(updated.custom_fields);
  assert.deepEqual(fields, { "unit cost": "225.00", season: "Fall 2026" }, "update one, remove one (blank), add one — one patch, already applied");
});

check("test_PRD_P0_135_item_edit_applies_immediately__editing_the_channel_from_a_tile_needs_no_second_confirmation_either", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "direct_link" });
  const res = await postForm("/items/wool-coat/channel", MANAGER, env(mirror), { on_website: "on" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/items");

  const updated = mirror.db.prepare("SELECT channel FROM mirror_product WHERE handle = 'wool-coat'").get();
  assert.equal(updated.channel, "website", "already applied — no approval step waited on it");
});

check("test_PRD_P0_135_item_edit_applies_immediately__a_refused_edit_still_reports_the_reason_and_writes_nothing", async () => {
  /* Applying immediately must not mean applying blindly — the tool's own
     check() still runs and can still refuse (here: setting the SAME
     channel it already has, the existing no-op guard). */
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "direct_link" });
  const res = await postForm("/items/wool-coat/channel", MANAGER, env(mirror), {});
  assert.equal(res.status, 400);
  assert.match(await res.text(), /already direct_link/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__a_refusal_is_json_not_a_new_page", async () => {
  /* The owner's own words: "I don't want these errors to send me to a new
     page. They need to validate input like the style ID." A check()
     refusal can only be known server-side (this one needs the product's
     OWN current channel), so it still comes from the server — but as JSON
     the page's own script can show inline, never a refusalPage a form
     submission would navigate to. */
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "direct_link" });
  const res = await postForm("/items/wool-coat/channel", MANAGER, env(mirror), {});
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.match(body.error, /already direct_link/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_page_intercepts_edit_form_submits_and_shows_the_error_inline", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /document\.getElementById\("items-grid"\)\.addEventListener\("submit", async \(e\) => \{/,
    "edit form submits must be intercepted, not left to navigate the browser",
  );
  assert.match(body, /e\.preventDefault\(\)/);
  assert.match(
    body,
    /p\.className = "item-edit-error"/,
    "a refusal renders inline, in its own element, not a new page",
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-136 — style_id and vendor, Square's own Custom Attributes, in the
 * Items tab. The tool's own behaviour (format, conflicts, Square calls) is
 * exercised in catalog-write.test.mjs, whose fixture injects a fake Square
 * client into the tool's own ctx directly; this file's own env() has no
 * SQUARE_ACCESS_TOKEN at all (real ops.vemians.com never runs without one,
 * so nothing here should paper over that with a fake route-level seam) —
 * so what's tested here is everything the route does BEFORE ever touching
 * Square: the markup, and the manager-only gate that refuses before runTool
 * is even called.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_136_square_custom_attributes__the_tile_shows_style_id_and_vendor_when_set", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { style_id: "01-04-001", vendor: "Acme Mills" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<span>Style ID<\/span><span>01-04-001<\/span>/);
  assert.match(body, /<span>Vendor<\/span><span>Acme Mills<\/span>/);
});

check("test_PRD_P0_136_square_custom_attributes__the_tile_shows_vendor_code_and_unit_cost_when_set", async () => {
  /* vendor_code and unit cost live on the SAME real Square Vendor
     association as vendor (Retail Plus/Premium, revised), so both are only
     meaningful — and only shown — alongside a vendor. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills", vendor_code: "ACME-4471", unit_cost_minor: 4250 });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<span>Vendor code<\/span><span>ACME-4471<\/span>/);
  assert.match(body, /<span>Unit cost<\/span><span>\$ 42\.50<\/span>/);
});

check("test_PRD_P0_136_square_custom_attributes__neither_row_renders_when_unset", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /<span>Style ID<\/span>/);
  assert.doesNotMatch(body, /<span>Vendor<\/span>/);
});

check("test_PRD_P0_136_square_custom_attributes__the_edit_form_posts_to_square_attributes_prefilled_with_current_values", async () => {
  /* Two separate forms now, both still square-attributes — style_id moved
     into the variations accordion's own header (P0-135's own revision),
     vendor/vendor_code/commission stayed where they were. unit_cost moved
     out of any form at all, once it stopped being one value for the whole
     product ("all the variants can have a different unit cost too") — it
     is now a per-variation field reached through /variations, and the
     header's own "Cost" input is a pure client-side broadcaster like MSRP,
     prefilled from nothing (see the P0-135 accordion test below for its
     own per-variation value). */
  const mirror = mirrorDb();
  seedProduct(mirror, {
    style_id: "01-04-001",
    vendor: "Acme Mills",
    vendor_code: "ACME-4471",
    unit_cost_minor: 4250,
    commission_pct: 20,
  });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const squareAttrForms = [...body.matchAll(/<form method="post" action="\/items\/wool-coat\/square-attributes"[^>]*>/g)];
  assert.equal(squareAttrForms.length, 2, "style_id and vendor/vendor_code/commission are two separate forms now");
  assert.match(body, /<span class="variations-header-label">Style ID<\/span>/, "a real label now, not just the placeholder");
  assert.match(body, /<input name="style_id" value="01-04-001" placeholder="NN-NN-NNN" pattern="\\d\{2\}-\\d\{2\}-\\d\{3\}"/);
  assert.doesNotMatch(body, /<input name="unit_cost"/, "unit_cost is no longer a real form field anywhere");
  assert.match(body, /<input class="variations-unit-cost" placeholder="Cost/);
  assert.match(body, /<input name="vendor" value="Acme Mills" placeholder="Vendor">/);
  /* "Hint for vendor SKU should be just vendor SKU, not 'own SKU'... as
     short as possible... commission just say COMM" — short placeholders,
     with the fuller wording moved to a title tooltip instead of dropped. */
  assert.match(body, /<input name="vendor_code" value="ACME-4471" placeholder="Vendor SKU" title="The vendor's own SKU\/code">/);
  assert.match(body, /<input name="commission" value="20" placeholder="COM%" title="Commission % \(0-100\)">/);
  /* "Center the vendor SKU content too" — the owner's own words, extending
     the centering cost/MSRP/style_id already have to this field as well. */
  assert.match(body, /\.item-edit input\[name="vendor_code"\]\s*\{\s*text-align: center;\s*\}/);
});

check("test_PRD_P0_136_square_custom_attributes__staff_cannot_reach_the_route_before_square_is_ever_touched", async () => {
  /* The route's own manager-only gate refuses BEFORE calling runTool at
     all, so this never needs a working Square client to test — the same
     reason the channel and custom-fields staff-refusal checks above don't
     either. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/square-attributes", STAFF, env(mirror), { vendor: "Someone Else" });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

/* ─────────────────────────────────────────────────────────────────────────
 * "Category dropdown, or type in a new one" (/items/<handle>/category) and
 * the variations accordion (/items/<handle>/variations) — new routes, the
 * owner's own words: "uncategorized should be a drop down... select an
 * existing category, or just type in... it will create one if there isn't
 * one," and "an expandable accordion header for the variations... variation
 * names editable... no SKU anywhere." Both reach catalog.update_product,
 * which needs a working Square client this file deliberately never fakes
 * (see the P0-136 section's own top comment) — so what is tested here is
 * everything BEFORE that point: the manager-only gate, and every refusal
 * the route itself can give with no Square client at all.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_135_item_edit_applies_immediately__category_route_refuses_a_blank_id_before_square_is_touched", async () => {
  /* "There should be a category dropdown... browse and select a
     category." The picker posts an id it read straight off the tree, so
     this route no longer resolves or creates anything from free text — a
     blank id (nothing picked yet) is refused before runTool is even
     called. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/category", MANAGER, env(mirror), { category_id: "  " });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.match(body.error, /choose a category/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__category_route_staff_cannot_reach_it", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/category", STAFF, env(mirror), { category_id: "cat1" });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_135_item_edit_applies_immediately__details_route_staff_cannot_reach_it", async () => {
  /* "Where's the item label and where is the description fields?" — the
     new title/description route gets the same manager-only gate as every
     other edit route on this tile. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/details", STAFF, env(mirror), {
    title: "New Title",
    description: "New description",
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_135_item_edit_applies_immediately__variations_route_refuses_with_no_rows_before_square_is_touched", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/variations", MANAGER, env(mirror), {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /no variations to save/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__variations_route_staff_cannot_reach_it", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/variations", STAFF, env(mirror), {
    variant_id_0: "v1",
    title_0: "One size",
    price_0: "45.00",
    currency_0: "USD",
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_variations_accordion_has_no_sku_anywhere_only_a_hidden_variant_id", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { style_id: "01-04-001", unit_cost_minor: 4250, vendor: "Acme Mills" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, />VEM-100</, "no SKU text anywhere in a manager's own expanded view");
  assert.match(body, /<input type="hidden" name="variant_id_0" value="v1">/);
  assert.match(body, /<input type="hidden" name="currency_0" value="USD">/);
  assert.match(body, /<input class="variation-title" name="title_0" value="One size" placeholder="Variation name">/);
  assert.match(body, /<input class="variation-price" name="price_0" value="450\.00" placeholder="Price">/);
  /* style_id lives in the accordion's own header; unit cost is now this
     ONE variation's own field, since "all the variants can have a
     different unit cost too." */
  assert.match(body, /<span class="variations-header-label">Style ID<\/span>/);
  assert.match(body, /<input name="style_id" value="01-04-001" placeholder="NN-NN-NNN"/, "just the format hint, no parentheses, now that there's a real label");
  assert.match(body, /<input class="variation-unit-cost" name="unit_cost_0" value="42\.50" placeholder="Cost">/);
  /* "For the cost field, again, just cost, nothing else... you should not
     have hints overflowing" — the header's own broadcasters carry only
     the bare word now, not the longer "— every variation's ..." tails. */
  assert.match(body, /<input class="variations-unit-cost" placeholder="Cost">/);
  assert.match(body, /<input class="variations-msrp" placeholder="MSRP">/);
  /* "On the right side... the unit cost and then the MSRP... so that they
     align with the children who also have their own unit cost and their
     own MSRP" — cost before price, in both the header and every row. */
  assert.ok(
    body.indexOf('class="variations-unit-cost"') < body.indexOf('class="variations-msrp"'),
    "header: unit cost before MSRP",
  );
  assert.ok(
    body.indexOf('name="unit_cost_0"') < body.indexOf('name="price_0"'),
    "each variation row: unit cost before price, aligned with the header above it",
  );
  /* "A row of 3 small components [-][##][+], then [COST][MSRP]" — the
     stepper is a command, not a fact about the variation, so it comes
     right after the variation's own name and ahead of its cost/price. */
  assert.ok(
    body.indexOf('name="title_0"') < body.indexOf('class="variation-stock-count"'),
    "the stock stepper follows the variation's own name",
  );
  assert.ok(
    body.indexOf('class="variation-stock-count"') < body.indexOf('name="unit_cost_0"'),
    "the stock stepper comes before cost/price, not after",
  );
  /* The direct-link deep link is the one place a SKU still matters — the
     owner's own words: "if you do a direct link, that makes sense...
     otherwise it's completely not our problem" — so data-sku must still
     be there for shareLink() to read, even though nothing displays it. */
  assert.match(body, /data-sku="VEM-100"/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__cost_field_shows_even_with_no_vendor_yet", async () => {
  /* "Need a COST field to the left of MSRP" — the field itself always
     renders now, the same as style_id/MSRP always do, even for a product
     with no vendor yet. Unit cost is still a fact about a VENDOR's
     product — typing into it without one is refused server-side, same as
     always — but the field is no longer hidden entirely. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<input class="variation-unit-cost" name="unit_cost_0"/, "the per-variation cost field shows without a vendor too");
  assert.match(body, /<input class="variations-unit-cost" placeholder="Cost/, "the header cost broadcaster shows without a vendor too");
  /* Still ordered before price/MSRP, in both the header and each row. */
  assert.ok(body.indexOf('class="variations-unit-cost"') < body.indexOf('class="variations-msrp"'));
  assert.ok(body.indexOf('name="unit_cost_0"') < body.indexOf('name="price_0"'));
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_accordion_header_is_decorated_and_the_body_is_indented", async () => {
  /* "Decorate the header so it's obvious it's an expandable accordion...
     not just a chevron" and "indent [the variation rows] a little so
     it's clearer it's underneath the accordion it belongs to." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /\.variations-header\s*\{[^}]*background: var\(--image-ground\)/);
  assert.match(body, /\.variations-body\s*\{[^}]*padding-left: 10px/);
  assert.match(body, /<span class="variations-label">Variations<\/span>/, "the header names the section it belongs to, next to the chevron");
});

check("test_PRD_P0_135_item_edit_applies_immediately__header_and_row_fields_are_centered_and_aligned", async () => {
  /* "Make them all center aligned, like the cost and the MSRP field" —
     was right-justified. "Scale that [style_id] input field to only fit
     that exact amount of characters" — 9 for NN-NN-NNN. "Ensure the two
     header fields, the cost and the MSRP, are aligned exactly with the
     cost and MSRP fields in the children rows. Give the children rows a
     slight inset... on the right side." */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /\.variations-header input, \.variations-body input\[name\^="price_"\], \.variations-body input\[name\^="unit_cost_"\]\s*\{\s*text-align: center;/,
  );
  /* REVISED: "make the style ID box vertically aligned with the inventory
     plus/minus box... shift the style ID label over... you may increase
     the style ID font size to fill that box so it's the same width as
     the inventory fields below it" — width matches the stock stepper's
     own width, with a larger font-size, and the spacer moved to BEFORE
     style_id (between it and "Variations") so style_id/Cost/MSRP read as
     one packed group at the header's own right end, the same way
     stepper/Cost/price already are in each row. REVISED AGAIN: "make the
     inventory menu a tiny bit wider if you are at limit with style id" —
     both widened from 5.5em to 6em together. REVISED AGAIN: "remove some
     side padding, it's wider than it has to be" — the wider box no
     longer needs the shared 5px side padding, so it dropped to 3px.
     REVISED AGAIN: "balance it out against inventory to get them
     matching 100%" — .variation-stock-stepper itself has zero side
     padding (its buttons sit flush against its own border), so zero,
     not any smaller nonzero value, is the actual match. */
  assert.match(body, /\.variations-header input\[name="style_id"\]\s*\{[^}]*width: 6em[^}]*font-size: 13px[^}]*padding: 1px 0/, "zero side padding matches the stepper beside it, whose own buttons sit flush against its border");
  assert.match(body, /<span class="variations-header-spacer"><\/span>/, "an invisible spacer absorbs the header's own leftover width, the same way each row's own title does");
  assert.match(body, /\.variations-header-spacer\s*\{\s*flex: 1 1 auto;\s*\}/);
  assert.match(body, /\.variations-body \.row\s*\{[^}]*padding: 3px 8px 3px 0/, "an 8px right inset matches the header's own 8px right padding");
  const accordionMarkup2 = body.indexOf('<div class="variations-accordion">');
  const spacerMarkup = body.indexOf('<span class="variations-header-spacer">');
  /* Two forms share this same action now (the vendor form, moved above
     the accordion in an earlier revision, and style_id's own, inside it)
     — search from the accordion onward for style_id's own occurrence. */
  const styleIdFormMarkup = body.indexOf('action="/items/wool-coat/square-attributes"', accordionMarkup2);
  assert.ok(
    body.indexOf('<span class="variations-label">Variations</span>') < spacerMarkup && spacerMarkup < styleIdFormMarkup,
    "the spacer now sits between the Variations label and the style_id form",
  );
});

check("test_PRD_P0_135_item_edit_applies_immediately__title_and_description_are_editable_by_a_manager", async () => {
  /* "Where's the item label and where is the description fields? Shouldn't
     we be able to change that?" */
  const mirror = mirrorDb();
  seedProduct(mirror, { description: "A warm winter coat." });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<form method="post" action="\/items\/wool-coat\/details">/);
  assert.match(body, /<input class="item-title-input" name="title" value="Wool Coat" placeholder="Title">/);
  assert.match(body, /<textarea name="description" placeholder="Description">A warm winter coat\.<\/textarea>/);
  /* "Move the title, description, and the vendor fields up above the
     variants" — both forms now render before the accordion, and custom
     fields still come after it. */
  const accordionMarkup = body.indexOf('<div class="variations-accordion">');
  assert.ok(accordionMarkup > -1);
  assert.ok(
    body.indexOf('action="/items/wool-coat/details"') < accordionMarkup,
    "title/description form comes before the variations accordion",
  );
  assert.ok(
    body.indexOf('name="vendor" value=') < accordionMarkup,
    "the vendor form comes before the variations accordion",
  );
  assert.ok(
    accordionMarkup < body.indexOf('action="/items/wool-coat/custom-fields"'),
    "custom fields still come after the variations accordion",
  );
});

check("test_PRD_P0_135_item_edit_applies_immediately__title_and_description_are_not_editable_by_staff", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { description: "A warm winter coat." });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /\/items\/wool-coat\/details/);
  assert.doesNotMatch(body, /<textarea/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-137 — Active: Square's own sale lifecycle. The tool's own behaviour
 * (the Square write, the mirror sync) is exercised in catalog-write.test.mjs,
 * whose fixture injects a fake Square client — this file's own env() has no
 * SQUARE_ACCESS_TOKEN at all, so what's tested here is everything the route
 * and the page do BEFORE ever touching Square: the markup, the layout, and
 * the manager-only gate that refuses before runTool is even called.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_137_item_active_toggle__web_and_active_are_plain_checkboxes_in_item_badges", async () => {
  /* The owner's own words: "the two buttons for active and web have the
     same style like checkboxes so that I can toggle either one of them."
     Both render as .item-checkbox-toggle now, not the old .item-tag-toggle
     pill. An earlier pass moved them into the title's own row instead,
     which broke the title/description layout, and was reverted — both
     stay in .item-badges, beside the category control. */
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "website" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /item-tag-toggle/, "the pill design is gone, reversed by this same feature");
  assert.match(
    body,
    /<form method="post" action="\/items\/wool-coat\/active" class="active-toggle-form">\s*<label class="item-checkbox-toggle">\s*<input type="checkbox" name="active" checked>\s*Active\s*<\/label>\s*<\/form>/,
  );
  const badges = body.indexOf('<div class="item-badges">');
  const webForm = body.indexOf('<form method="post" action="/items/wool-coat/channel" class="web-toggle-form">');
  const activeForm = body.indexOf('<form method="post" action="/items/wool-coat/active" class="active-toggle-form">');
  const categoryForm = body.indexOf('<form method="post" action="/items/wool-coat/category" class="category-form">');
  assert.ok(badges > -1 && badges < webForm, "Web/Active live inside .item-badges");
  assert.ok(webForm < activeForm && activeForm < categoryForm, "Web, then Active, then the category control");
});

check("test_PRD_P0_137_item_active_toggle__unchecked_when_the_product_is_not_active", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { status: "archived" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /<label class="item-checkbox-toggle">\s*<input type="checkbox" name="active">\s*Active\s*<\/label>/,
  );
});

check("test_PRD_P0_137_item_active_toggle__neither_toggle_is_editable_by_staff", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "website" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /<form method="post" action="\/items\/wool-coat\/active"/);
  assert.doesNotMatch(body, /name="active"/);
});

check("test_PRD_P0_137_item_active_toggle__staff_cannot_reach_the_route_before_square_is_ever_touched", async () => {
  /* The route's own manager-only gate refuses BEFORE calling runTool at
     all, so this never needs a working Square client to test — the same
     reason the square-attributes staff-refusal check above doesn't either. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/active", STAFF, env(mirror), { active: "on" });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_137_item_active_toggle__an_archived_product_still_surfaces_so_it_can_be_restored", async () => {
  /* P0-131's own "Inactive" filter has never actually shown an archived
     product before this feature — mirror_product_index excludes archived
     rows by definition, and there was nothing to restore one WITH. This is
     the one explicit call (listAllProducts) that surfaces them now, the
     same way mirror.js's own archivedProducts() already does. */
  const mirror = mirrorDb();
  seedProduct(mirror, { status: "archived" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /data-status="inactive"/);
  assert.match(body, /<span class="item-tag item-tag-inactive">Inactive<\/span>/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-138 — the categories/subcategories accordion, right above Variants.
 * The tool's own behaviour (the Square write, the retroactive resort) is
 * exercised in catalog-write.test.mjs; this file's own env() has no
 * SQUARE_ACCESS_TOKEN at all, so what's tested here is the markup, the
 * tree structure, and the manager-only gate that refuses before runTool
 * is even called.
 * ───────────────────────────────────────────────────────────────────────── */

function seedCategoryTree(mirror) {
  /* Beyond seedProduct's own single flat 'cat1'/Outerwear row: a real
     nested tree — Outerwear (01) -> Coats (05) -> Casual (unnumbered) —
     plus a second, unrelated top-level Knitwear, to prove sibling
     ordering and indentation both work. */
  mirror.db.exec("UPDATE mirror_category SET numeric_id = '01' WHERE id = 'cat1'");
  mirror.db.exec("INSERT INTO mirror_category (id, external_ref, name, parent_id, numeric_id) VALUES ('cat2', 'sqcat2', 'Coats', 'cat1', '05')");
  mirror.db.exec("INSERT INTO mirror_category (id, external_ref, name, parent_id) VALUES ('cat3', 'sqcat3', 'Casual', 'cat2')");
  mirror.db.exec("INSERT INTO mirror_category (id, external_ref, name) VALUES ('cat4', 'sqcat4', 'Knitwear')");
}

check("test_PRD_P0_138_nested_categories__the_accordion_lives_under_admin_collapsed_by_default", async () => {
  /* REVISED: "move the category designer... header. Put it in there
     because really that should be only modified by an admin." The
     Categories accordion is no longer its own top-level section right
     above Variations — it moved inside the renamed "Admin" disclosure,
     alongside the one blank custom-field row, both after Variations. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const adminIdx = body.indexOf("<summary>Admin</summary>");
  const categoriesIdx = body.indexOf('<div class="categories-accordion">');
  const variationsIdx = body.indexOf('<div class="variations-accordion">');
  assert.ok(adminIdx > -1, "the disclosure is now labeled Admin");
  assert.ok(variationsIdx > -1 && variationsIdx < adminIdx, "Variations still renders before Admin");
  assert.ok(categoriesIdx > adminIdx, "the category designer now lives inside the Admin disclosure");
  assert.doesNotMatch(body, /class="categories-accordion expanded"/, "collapsed by default, the same as Variations");
});

check("test_PRD_P0_138_nested_categories__the_tree_nests_and_indents_by_depth", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  /* Outerwear (depth 0) -> Coats (depth 1) -> Casual (depth 2). */
  assert.match(body, /<span class="category-node-name">Outerwear<\/span>/);
  /* Each .category-node nests physically inside its own parent's box, so
     a flat one-step indent (18px, the toggle/spacer's own rendered width)
     on every non-top-level node compounds through ordinary box-model
     nesting into the full depth*18px visual offset — Casual (two levels
     down) still only carries its OWN 18px in the markup; the other 18px
     comes from its parent Coats' own box already being shifted. */
  assert.match(body, /padding-left: 0px"[\s\S]{0,220}Outerwear/);
  assert.match(body, /padding-left: 18px"[\s\S]{0,220}Coats/);
  assert.match(body, /padding-left: 18px"[\s\S]{0,220}Casual/);
  /* Each node's own numeric_id shows what it has (or a blank box for
     Casual, which has none yet), and carries its own category id for the
     change handler to post back. */
  assert.match(
    body,
    /<input class="category-numeric-id" data-category-id="cat1" data-category-name="Outerwear" value="01"/,
  );
  assert.match(
    body,
    /<input class="category-numeric-id" data-category-id="cat3" data-category-name="Casual" value=""/,
  );
  assert.match(body, /<button type="button" class="category-add-toggle" data-parent-id="cat2"[^>]*>\+<\/button>/, "every node gets its own add-subcategory toggle");
});

check("test_PRD_P0_138_nested_categories__the_indent_step_matches_the_toggles_own_rendered_width", async () => {
  /* The owner's own correction: "the indentation of each subcategory...
     has to start right where the chevron pointing down is." A subcategory
     column only lands exactly under its parent's own toggle when the
     per-depth indent step equals the toggle/spacer's own rendered width —
     so this pins both numbers to the SAME value, not just to each other's
     current hardcoded copies. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const toggleWidth = /\.category-node-toggle\s*\{[^}]*width:\s*(\d+)px/.exec(body)?.[1];
  const spacerWidth = /\.category-node-toggle-spacer\s*\{[^}]*width:\s*(\d+)px/.exec(body)?.[1];
  assert.ok(toggleWidth, "the toggle's own width must be found in the rendered CSS");
  assert.equal(spacerWidth, toggleWidth, "the leaf spacer must match the toggle's own width");
  assert.match(body, new RegExp(`padding-left: ${toggleWidth}px"[\\s\\S]{0,220}Coats`), "depth 1's indent step equals the toggle's own width");
});

check("test_PRD_P0_138_nested_categories__a_node_with_children_gets_its_own_expandable_caret", async () => {
  /* The owner's own words: "every row underneath the categories row needs
     to be an expandable row" — a node with subcategories of its own gets
     the same caret convention the outer accordions already use,
     collapsed by default; a leaf gets an equal-width spacer instead, so
     the name column still lines up either way. Order within a row: the
     caret, the name, the + (add a subcategory), then the numeric ID
     LAST. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /\.category-node\.expanded > \.category-children\s*\{\s*display:\s*block;\s*\}/);
  assert.match(body, /\.category-children\s*\{\s*display:\s*none;\s*\}/, "collapsed by default");

  const outerwearNameIdx = body.indexOf('<span class="category-node-name">Outerwear</span>');
  const outerwearRow = body.slice(outerwearNameIdx - 400, outerwearNameIdx + 500);
  assert.match(outerwearRow, /class="category-node-toggle"/, "Outerwear has a subcategory (Coats), so it gets a real caret");
  const nameIdx = outerwearRow.indexOf("category-node-name");
  const addIdx = outerwearRow.indexOf("category-add-toggle");
  const idIdx = outerwearRow.indexOf("category-numeric-id");
  assert.ok(nameIdx < addIdx && addIdx < idIdx, "name, then +, then the numeric ID last");

  const casualNameIdx = body.indexOf('<span class="category-node-name">Casual</span>');
  const casualRow = body.slice(casualNameIdx - 150, casualNameIdx + 200);
  assert.match(casualRow, /class="category-node-toggle-spacer"/, "Casual has no children yet, so a spacer, not a caret");
  assert.doesNotMatch(casualRow, /class="category-node-toggle"/);
});

check("test_PRD_P0_138_nested_categories__top_level_categories_use_their_own_wrapper_class_not_category_children", async () => {
  /* Regression: also caught live, in the same headless-browser pass as the
     [hidden] fix above. The top-level tree's own wrapper originally reused
     the class ".category-children" — the SAME class every node's own
     nested-children container uses — so the blanket "collapsed by
     default" rule (.category-children { display: none }) hid the ENTIRE
     top-level list too, with no .category-node.expanded ancestor able to
     ever reveal it again. Renamed to .categories-tree, a name no node's
     own children container shares. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<div class="categories-tree">/);
  const treeIdx = body.indexOf('<div class="categories-tree">');
  const outerwearIdx = body.indexOf('<span class="category-node-name">Outerwear</span>');
  assert.ok(treeIdx > -1 && treeIdx < outerwearIdx, "the top-level tree wraps the real nodes, under its own class");
  assert.doesNotMatch(
    body.slice(treeIdx, treeIdx + 40),
    /category-children/,
    "the top-level wrapper must never be .category-children — that class is collapsed by default with no way to reopen it",
  );
});

check("test_PRD_P0_138_nested_categories__add_forms_are_hidden_by_default_even_under_a_css_class_selector", async () => {
  /* Regression: caught live via a headless-browser check before shipping —
     an unconditional `.category-add-form { display: flex }` was beating
     the [hidden] attribute's own display:none (a class selector outranks
     an attribute one), so every add-form showed open at once instead of
     only the one just clicked. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /\.category-add-form\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(body, /<div class="category-add-form" hidden>/);
});

check("test_PRD_P0_138_nested_categories__the_accordion_is_absent_for_staff", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /<div class="categories-accordion">/);
});

check("test_PRD_P0_138_nested_categories__the_top_level_add_button_lives_in_the_header_with_no_label_text", async () => {
  /* "The add category button needs to be in the header on the right
     side... we don't need the 'add category' text... it's pretty
     self-explanatory." The top-level + moves out of its own labeled row
     in .categories-body and into .categories-header itself, opposite the
     caret; the "Add a category" label text is gone entirely. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const headerIdx = body.indexOf('<div class="categories-header">');
  const bodyIdx = body.indexOf('<div class="categories-body">');
  assert.ok(headerIdx > -1 && bodyIdx > headerIdx, "the header comes before the body");
  const header = body.slice(headerIdx, bodyIdx);
  assert.match(header, /<button type="button" class="category-add-toggle" data-parent-id=""[^>]*>\+<\/button>/, "the top-level add toggle now lives in the header");
  assert.doesNotMatch(body, />Add a category</, "no leftover label text — the button is self-explanatory");
  const addFormIdx = body.indexOf('<div class="category-add-form" hidden>');
  assert.ok(addFormIdx > bodyIdx, "the (still hidden) add-form itself stays in the body, right after the header");
});

check("test_PRD_P0_138_nested_categories__staff_cannot_reach_either_route_before_square_is_ever_touched", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const create = await postForm("/items/wool-coat/categories/create", STAFF, env(mirror), { name: "Eyewear" });
  assert.equal(create.status, 403);
  assert.match(await create.text(), /manager/i);

  const number = await postForm("/items/wool-coat/categories/number", STAFF, env(mirror), { category_id: "cat1", numeric_id: "01" });
  assert.equal(number.status, 403);
  assert.match(await number.text(), /manager/i);
});

check("test_PRD_P0_138_nested_categories__resync_route_is_manager_only_and_post_only", async () => {
  /* "There are already defined category and subcategories on Square main
     page right now. Why aren't you synchronizing them?" — /items/resync
     (catalog.resync_from_square) is the manual escape hatch, gated the
     same way as the two routes above: denied before runTool ever reaches
     Square. This file's own env() has no SQUARE_ACCESS_TOKEN at all (see
     the P0-136 section's own comment on why), so a MANAGER call is not
     exercised end to end here — that belongs to catalog-write.test.mjs's
     own fixture, which injects a fake Square client directly. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const denied = await postForm("/items/resync", STAFF, env(mirror), {});
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /manager/i);

  const wrongMethod = await get("/items/resync", MANAGER, env(mirror));
  assert.equal(wrongMethod.status, 405);
});

check("test_PRD_P0_31_inventory_ledger__stock_shows_zero_with_no_commerce_binding", async () => {
  /* A deployment with no COMMERCE binding still renders the Items tab —
     every variation just shows 0 in stock rather than the whole tab
     going down over a store this page has never needed before. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<button type="button" class="variation-stock-step" data-variant-id="v1" data-delta="-1"/);
  assert.match(body, /<input type="text" class="variation-stock-count" value="0" readonly/);
  assert.match(body, /<button type="button" class="variation-stock-step" data-variant-id="v1" data-delta="1"/);
  /* "One continuous row with no padding! Fixed width of parent" — all
     three pieces share one wrapper, so the row's own gap between fields
     never lands between the minus button, the count and the plus button. */
  const stepperStart = body.indexOf('<span class="variation-stock-stepper">');
  const stepperEnd = body.indexOf("</span>", stepperStart);
  const stepper = body.slice(stepperStart, stepperEnd);
  assert.match(stepper, /^<span class="variation-stock-stepper"><button[^>]*data-delta="-1"[^>]*>&minus;<\/button><input type="text" class="variation-stock-count"[^>]*><button[^>]*data-delta="1"[^>]*>\+<\/button>$/);
});

check("test_PRD_P0_31_inventory_ledger__stock_reads_the_live_commerce_ledger", async () => {
  /* "Show current count, adjust with +/-" — the count shown is whatever
     inventory_level (the ledger's own derived VIEW) currently says for
     this variation's own SKU, batched the same way vendor names/images
     already are (one read, not one query per variation). */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const commerce = commerceDb();
  commerce._raw.exec(
    "INSERT INTO location (id, name) VALUES ('main', 'Vemians')",
  );
  commerce._raw
    .prepare(
      "INSERT INTO inventory_adjustment (id, sku, location_id, delta, reason, actor) VALUES (?, 'VEM-100', 'main', 7, 'receipt', 'system:test')",
    )
    .run("adj-1");
  const res = await get("/items", MANAGER, env(mirror, commerce));
  const body = await res.text();
  assert.match(body, /<input type="text" class="variation-stock-count" value="7" readonly/);
});

check("test_PRD_P0_31_inventory_ledger__inventory_route_staff_cannot_reach_it", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/inventory", STAFF, env(mirror), { variant_id: "v1", delta: "1" });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_31_inventory_ledger__inventory_route_refuses_a_zero_delta_before_square_is_touched", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/inventory", MANAGER, env(mirror), { variant_id: "v1", delta: "0" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /non-zero whole-number change/);
});

check("test_PRD_P0_31_inventory_ledger__inventory_route_refuses_a_non_integer_delta", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/inventory", MANAGER, env(mirror), { variant_id: "v1", delta: "abc" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /non-zero whole-number change/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_web_toggle_is_a_plain_checkbox_rendered_either_way", async () => {
  /* REVISED: "move the web and the active buttons... make them the same
     style as the rest of the fields... have the same style like checkboxes
     so that I can toggle either one of them" — this REVERSES the earlier
     pill-with-embedded-checkbox design ("the web tag itself should be
     clickable to toggle it... a little checkbox inside the tag"), back to
     a plain labeled checkbox. Still renders even when OFF — there has to
     be something to click to turn it back on. */
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "direct_link" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<form method="post" action="\/items\/wool-coat\/channel" class="web-toggle-form">/);
  assert.match(body, /<label class="item-checkbox-toggle">\s*<input type="checkbox" name="on_website">\s*Web\s*<\/label>/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_web_toggle_is_checked_when_already_on_the_website", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "website" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<label class="item-checkbox-toggle">\s*<input type="checkbox" name="on_website" checked>\s*Web\s*<\/label>/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_category_control_is_one_picker_showing_the_full_path", async () => {
  /* REVISED AGAIN: "I want one menu, one dropdown, just one. And in it
     is a path... dresses / cocktail... right next to it is the full
     width name of the item... the path auto scales, auto fits... the
     content." Back to ONE button labeled with the full path, opening a
     tree menu — the two-select design (a prior revision) is gone.
     REVISED once more: "it needs to be the same square style, exactly
     the same height, the same style, has a chevron in it... an
     extension of the same UI [as] the field for the name" — the label
     is its own span (so the JS that updates it on a pick never wipes
     out the chevron icon sitting beside it), and a CARET_ICON <svg>
     renders right after it, rotated to point down like a <select>'s
     own arrow. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<input type="text" name="category_id" value="cat1" hidden>/);
  assert.match(body, /<button type="button" class="category-picker-btn"[^>]*>[\s\S]{0,40}<span class="category-picker-btn-label">Outerwear<\/span><svg/);
  assert.match(body, /<button type="button" class="category-picker-option selected" data-category-id="cat1" data-category-path="Outerwear">Outerwear<\/button>/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_picker_shows_the_full_ancestor_path_when_nested", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  mirror.db.exec("INSERT INTO mirror_category (id, external_ref, name, parent_id) VALUES ('cat2', 'sqcat2', 'Coats', 'cat1')");
  mirror.db.exec("UPDATE mirror_product SET category_id = 'cat2' WHERE id = 'p1'");
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<span class="category-picker-btn-label">Outerwear \/ Coats<\/span>/);
  assert.match(body, /data-category-id="cat2" data-category-path="Outerwear \/ Coats"/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__an_uncategorized_product_shows_the_placeholder_and_no_selection", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  mirror.db.exec("UPDATE mirror_product SET category_id = NULL WHERE id = 'p1'");
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<input type="text" name="category_id" value="" hidden>/);
  assert.match(body, /<span class="category-picker-btn-label">Uncategorized<\/span>/);
  assert.doesNotMatch(body, /category-picker-option selected/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_save_button_starts_disabled_and_only_renders_for_a_manager", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const managerBody = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(managerBody, /<button type="button" class="item-save-all" aria-label="Save changes" title="Save changes" disabled>/);

  const staffBody = await (await get("/items", STAFF, env(mirror))).text();
  assert.doesNotMatch(staffBody, /<button[^>]*class="item-save-all"/, "a role that cannot edit gets no Save button at all");
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_page_script_tracks_dirty_state_and_saves_only_changed_forms", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /function refreshDirtyState\(field\)/);
  assert.match(body, /tile\.classList\.toggle\("dirty", tileDirty\)/);
  assert.match(body, /async function saveTile\(tile\)/);
  assert.match(body, /tile\.querySelectorAll\("form\[data-dirty='1'\]"\)/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__resetting_a_field_to_its_original_value_clears_the_dirty_state", async () => {
  /* The owner's own words: "resetting values should clear save state" —
     dirty is recomputed from scratch on every change, comparing against
     defaultValue/defaultChecked (the browser's own record of what the
     field actually shipped with), not a one-way latch that stays set
     forever once a field is touched at all. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /function isFieldDirty\(el\) \{/);
  assert.match(body, /el\.checked !== el\.defaultChecked/);
  assert.match(body, /el\.value !== el\.defaultValue/);
  assert.match(body, /field\.classList\.toggle\("field-dirty", isFieldDirty\(field\)\)/);
  assert.match(
    body,
    /const formDirty = \[\.\.\.form\.querySelectorAll\("input"\)\]\.some\(isFieldDirty\);\s*\n\s*if \(formDirty\) \{\s*\n\s*form\.dataset\.dirty = "1";\s*\n\s*\} else \{\s*\n\s*delete form\.dataset\.dirty;/,
    "a form with nothing left different from its original value must stop being marked dirty",
  );
  assert.match(body, /saveBtn\.disabled = !tileDirty;/, "the Save button must re-disable once nothing in the tile is dirty any more");
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_page_script_propagates_msrp_to_every_variation_price", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /e\.target\.matches\("\.variations-msrp"\)/);
  assert.match(body, /accordion\?\.querySelectorAll\("\.variation-price"\)\.forEach\(\(input\) => \{\s*\n\s*input\.value = e\.target\.value;/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__a_changed_field_and_a_msrp_propagated_field_both_get_the_dirty_highlight", async () => {
  /* The owner's own words: "any changed fields should be marked with an
     orange highlight, and so is the save button." refreshDirtyState is
     called on the field the change event actually fired on, and ALSO on
     every .variation-price input the MSRP field's own propagation
     touches — not just whichever one the person actually typed into. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /const form = e\.target\.closest\([^)]*\);\s*\n\s*if \(form\) refreshDirtyState\(e\.target\);/);
  assert.match(
    body,
    /input\.value = e\.target\.value;\s*\n\s*refreshDirtyState\(input\);\s*\n\s*\}\);/,
    "every propagated variation price gets the highlight refreshed too, not just the MSRP field itself",
  );
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_dirty_highlight_css_covers_text_fields_selects_and_checkboxes", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /\.item-tile input\.field-dirty, \.item-tile select\.field-dirty \{ border-color: var\(--accent\); \}/);
  assert.match(body, /\.item-tile input\.field-dirty\[type="checkbox"\] \{ outline: [^}]*var\(--accent\)/);
  assert.match(body, /\.item-save-all:not\(:disabled\) \{ color: var\(--accent\); \}/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_edit_area_is_a_plain_div_not_a_details_disclosure", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror, { style_id: "01-04-001", vendor: "Acme Mills", commission_pct: 20 });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<div class="item-edit">/, "the edit area must no longer be a <details> a manager has to open first");
  assert.doesNotMatch(body, /<details class="item-edit">/);
  assert.doesNotMatch(body, /<summary>Edit<\/summary>/, "no more generic Edit toggle to click before anything is visible");
});

check("test_PRD_P0_135_item_edit_applies_immediately__existing_custom_fields_are_always_visible_only_a_new_blank_row_is_collapsed", async () => {
  /* REVISED: "get rid of all except one add custom field... that dropdown
     where it says add custom fields, that should be called admin." The
     blank row for a brand-new field moved into its own <form>, still
     inside the renamed "Admin" disclosure; the existing field's own row
     stays outside it, in its own separate form, visible without opening
     anything. */
  const mirror = mirrorDb();
  seedProduct(mirror); // seeds a "unit cost" custom field, see seedProduct()
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const addFieldStart = body.indexOf('<details class="item-add-field">');
  assert.ok(addFieldStart > -1, "a blank row must still be offered behind its own disclosure");
  const existingFieldIndex = body.indexOf('<input name="field_name_0" value="unit cost"');
  assert.ok(existingFieldIndex > -1, "the existing field's row must render with its current name/value");
  assert.ok(existingFieldIndex < addFieldStart, "the existing field must render before (outside) the Admin disclosure");

  /* The blank row for a brand-new field is INSIDE the disclosure, and it
     is the ONLY blank row offered now — up to 3 were offered before. */
  const addFieldHtml = body.slice(addFieldStart);
  assert.match(addFieldHtml, /<summary>Admin<\/summary>/);
  assert.match(addFieldHtml, /name="field_name_1" placeholder="Field name"/, "a blank row for a new field must be offered");
  assert.doesNotMatch(addFieldHtml, /name="field_name_2"/, "only one blank row now, not up to three");
});

check("test_PRD_P0_71_items_tab__approving_an_items_tab_edit_sends_the_approver_back_to_items", () => {
  /* P0-135 made the Items tab's OWN form apply immediately, with no
     /approvals/<id> hop at all — but catalog.set_channel and catalog.
     set_custom_fields still reach this same generic approval page when an
     AGENT proposes one conversationally (a real decision for a human to
     review, unlike a form someone already filled in and submitted
     themselves). index.js's own ITEMS_TAB_TOOLS-driven backHref still
     needs to send that approver back to /items rather than the agent
     page, so this still exercises the routing half by inspection. */
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
    field_name_0: "unit cost",
    field_value_0: "999.00",
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);

  const unchanged = mirror.db.prepare("SELECT custom_fields FROM mirror_product WHERE handle = 'wool-coat'").get();
  assert.match(unchanged.custom_fields, /210\.00/, "nothing must be parked, let alone applied, from a staff submission");
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

check("test_PRD_P0_131_item_status_filter__the_collapsed_tile_shows_title_price_style_id_and_short_tags", async () => {
  /* The owner's own words: "title on top left, price top right, SKU
     bottom left, and then a few of the tags, but shorten them." REVISED:
     "these [SKUs] are generated automatically by Square and we should not
     be editing them at all... we don't need to see them in our ops
     dashboard" — style_id (this shop's own nomenclature) took that spot
     instead. */
  const mirror = mirrorDb();
  seedProduct(mirror, { style_id: "01-04-001" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<div class="item-top"><h3>Wool Coat<\/h3>\s*<div class="item-top-right">\s*<span class="item-price">\$ 450<\/span>/);
  /* "I don't want to see the in-store tag... what's the in-store for?" —
     direct_link (the default, seeded here) gets no channel tag at all
     now, only the category. */
  assert.match(
    body,
    /<div class="item-bottom"><span class="item-style-id">01-04-001<\/span><div class="item-tags"><span class="item-tag">Outerwear<\/span><\/div><\/div>/,
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
    /const tile = e\.target\.closest\("\.item-tile"\);\s*\n\s*if \(!tile \|\| e\.target\.closest\("\.item-edit, \.item-badges, \.variations-accordion"\) \|\| tile\.classList\.contains\("full"\)\) return;/,
    "a click anywhere on a COLLAPSED tile expands it, except inside an edit control or once already expanded",
  );
});

check("test_PRD_P0_130_item_tile_photo__only_a_website_item_gets_a_channel_tag", async () => {
  /* "Web is a much shorter, cleaner tag... what's the in-store for?" —
     direct_link (the assumed, unremarkable default) gets no tag at all;
     only being ALSO on the website is worth calling out. */
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "website" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /<div class="item-bottom"><span class="item-style-id"><\/span><div class="item-tags"><span class="item-tag channel-website">Web<\/span><span class="item-tag">Outerwear<\/span><\/div><\/div>/,
  );
  assert.doesNotMatch(body, />In store</, "In store is never rendered as a tag any more");
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
  /* A real browser submits nothing at all for an unchecked checkbox. */
  const res = await postForm("/items/wool-coat/channel", MANAGER, env(mirror), {});
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/items");
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
    /<div class="item-bottom"><span class="item-style-id"><\/span><div class="item-tags"><span class="item-tag item-tag-inactive">Inactive<\/span><\/div><\/div>/,
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
  const handler = body.slice(body.indexOf("const shareBtn = e.target.closest"), body.indexOf("shareLink(shareBtn)") + 60);
  assert.match(handler, /const shareBtn = e\.target\.closest\("\.item-share"\);/);
  assert.match(handler, /shareLink\(shareBtn\);\s*\n\s*return;/);
});

check("test_PRD_P0_132_item_deep_link__the_link_is_a_hash_not_a_server_route", async () => {
  /* The owner's own words: "I want to get a deep link into that expanded
     view so I can send it to somebody." The whole catalog already renders
     in one response, so #item-<sku> costs nothing a real route would
     otherwise fetch. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /"#item-" \+ encodeURIComponent\(sku\)/);
});

check("test_PRD_P0_134_deep_link_by_sku__the_link_is_keyed_on_sku_not_the_handle_or_title", async () => {
  /* The owner's own words: "you made a deep link to black dress, and
     that's not going to work for us. It needs to be to the SKU number...
     the SKU is always going to be a unique number, a unique location, a
     unique product... we do not want to be making our deep links based
     on item names. The titles and descriptions may change in the future,
     and that's going to break our linking." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /data-sku="VEM-100"/);
  assert.match(body, /const sku = btn\.closest\("\.item-tile"\)\.dataset\.sku;/, "shareLink must copy the tile's own SKU, not its handle");
  assert.match(
    body,
    /const sku = decodeURIComponent\(location\.hash\.slice\("#item-"\.length\)\);\s*\n\s*const linked = \[\.\.\.document\.querySelectorAll\("\.item-tile"\)\]\.find\(\(el\) => el\.dataset\.sku === sku\);/,
    "opening a link must match the tile by SKU, not handle",
  );
});

check("test_PRD_P0_134_deep_link_by_sku__a_product_with_no_sku_disables_the_share_button", async () => {
  /* No variations means no stable identifier to copy — a disabled button,
     not a link that would collide with every other SKU-less product. */
  const mirror = mirrorDb();
  mirror.db.exec(
    "INSERT INTO mirror_product (id, external_ref, handle, title, status, channel, custom_fields) " +
      "VALUES ('p2', 'sqitem2', 'no-sku-yet', 'No SKU Yet', 'active', 'direct_link', '{}')",
  );
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const tileAt = body.indexOf('data-handle="no-sku-yet"');
  const tile = body.slice(Math.max(0, tileAt - 300), tileAt + 600);
  assert.match(tile, /data-sku=""/);
  assert.match(tile, /<button type="button" class="item-share"[^>]* disabled>/);
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
  const handler = body.slice(body.indexOf('const closeBtn = e.target.closest(".item-close");'), body.indexOf('const closeBtn = e.target.closest(".item-close");') + 700);
  assert.match(handler, /const tile = closeBtn\.closest\("\.item-tile"\);/);
  assert.match(handler, /tile\.classList\.remove\("full"\);/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__closing_a_dirty_tile_asks_for_confirmation_first", async () => {
  /* The owner's own words: "if you try to close the expanded page, it
     will warn you that you have unsaved changes." A plain confirm() over
     .dirty — the same class the Save button's own enable/disable state
     already tracks, so there is nothing new to keep in sync. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const handler = body.slice(body.indexOf('const closeBtn = e.target.closest(".item-close");'), body.indexOf('const closeBtn = e.target.closest(".item-close");') + 700);
  assert.match(handler, /tile\.classList\.contains\("dirty"\) && !confirm\(/);
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

check("test_PRD_P0_132_item_deep_link__expanding_or_closing_a_tile_keeps_the_hash_in_step", async () => {
  /* The owner's own words: "keep my panel open when I reload the page...
     you should be able to, after reloading the page, just reopen the same
     deep link panel." A plain click to expand never touched the hash
     before — only an explicit Share click did — so setDeepLinkHash() must
     now be called from both the expand and the close branches, using
     history.replaceState (not a real navigation) so neither grows the
     back-button history. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /function setDeepLinkHash\(tile\) \{\s*\n\s*const sku = tile\?\.dataset\.sku;\s*\n\s*const hash = sku \? "#item-" \+ encodeURIComponent\(sku\) : "";\s*\n\s*history\.replaceState\(null, "", location\.pathname \+ hash\);\s*\n\}/,
  );
  const closeHandler = body.slice(body.indexOf('const closeBtn = e.target.closest(".item-close");'), body.indexOf('const closeBtn = e.target.closest(".item-close");') + 700);
  assert.match(closeHandler, /tile\.classList\.remove\("full"\);\s*\n\s*setDeepLinkHash\(null\);/);
  const expandHandler = body.slice(body.indexOf('tile.classList.contains("full")) return;'), body.indexOf('tile.classList.contains("full")) return;') + 200);
  assert.match(expandHandler, /tile\.classList\.add\("full"\);\s*\n\s*setDeepLinkHash\(tile\);/);
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
