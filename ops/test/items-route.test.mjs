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
       VALUES ('p1', 'sqitem1', 'wool-coat', 'Wool Coat', 'active', ?, ?, 'cat1')`,
    )
    .run(overrides.channel ?? "in_store", custom);
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

check("test_PRD_P0_71_items_tab__a_tile_expands_to_the_full_screen_instead_of_cramming_data_into_a_cell", async () => {
  /* The owner's own words: "when I click on the item, it's gonna
     expand to my entire phone screen, and I should see all of that
     data." Same convention as TABLE_CARD_CSS's own .table-card.full in
     the chat log — the SAME element grows in place via a toggled
     class, not a second element or separate scroll state. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /class="item-expand"/, "every tile needs its own expand control");
  assert.match(body, /\.item-tile\.full\s*\{[^}]*position:\s*fixed/s);
  assert.match(body, /classList\.toggle\("full"\)/, "the expand button must toggle the SAME element, not open a second one");
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
     .send-btn rule is a neutral fill; only #chat's own Send (the id the
     real agent composer's form alone carries) stays accent-coloured. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(
    body,
    /\.input-bar \.send-btn\s*\{[^}]*background:\s*var\(--accent\)/s,
    "the shared send-btn rule must not be the agent's own orange",
  );
  assert.match(body, /#chat \.send-btn\s*\{[^}]*background:\s*var\(--accent\)/s, "the real agent composer must still be orange");
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
      "VALUES ('p1', 'sqitem1', 'wool-coat', 'Wool Coat', 'active', 'in_store', '{}')",
  );
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /id="category-menu"/);
  assert.match(body, /id="category-btn"[^>]* hidden/, "the filter button must be hidden with nothing to filter by");
});

check("test_PRD_P0_71_items_tab__no_redundant_title_wastes_space_the_tab_bar_already_spent", async () => {
  /* The owner's own words: "we have the tab, we know we're in items
     right now. Get rid of all that stuff." The tab bar itself already
     names the page; a second, page-drawn "Items" heading right under
     it was pure wasted vertical space on a phone. The grid now starts
     right at .ops's own existing top padding, no title block eating
     into it first. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /class="greet"/, "no redundant title section may remain");
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
  seedProduct(mirror, { channel: "in_store" });
  const e = env(mirror);
  const res = await postForm("/items/wool-coat/channel", MANAGER, e, { channel: "website" });
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

test("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", async () => {
  const prd = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "PRD.md"),
    "utf8",
  );
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
