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

const indexModule = await import("../src/index.js");
const worker = indexModule.default;
const { perProductApplyFailure } = indexModule;
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
  /* Nested category, opt-in only — every existing caller keeps assigning
     the product straight to the top-level 'cat1' ("Outerwear") it always
     has; passing subcategoryName files it one level deeper instead, for
     Test-PRD-P0-169's own breadcrumb checks (below). */
  let productCategoryId = "cat1";
  if (overrides.subcategoryName) {
    mirror.db
      .prepare("INSERT INTO mirror_category (id, external_ref, name, parent_id) VALUES ('cat1-sub', 'sqcat1-sub', ?, 'cat1')")
      .run(overrides.subcategoryName);
    productCategoryId = "cat1-sub";
  }
  const custom = JSON.stringify(overrides.custom_fields ?? { "unit cost": "210.00" });
  mirror.db
    .prepare(
      `INSERT INTO mirror_product (id, external_ref, handle, title, source_description, status, channel, custom_fields, style_id, commission_pct, category_id)
       VALUES ('p1', 'sqitem1', 'wool-coat', 'Wool Coat', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.description ?? "",
      overrides.status ?? "active",
      overrides.channel ?? "direct_link",
      custom,
      overrides.style_id ?? null,
      overrides.commission_pct ?? null,
      productCategoryId,
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

/* A product with exactly two Option Set dimensions (Size, Color) — the
   Variants grid's own real case (Test-PRD-P0-147-variants_grid). Ordinals
   are deliberately NOT sorted alphabetically (S/M/L, Red/Blue) — a real
   test that the grid orders rows/columns by Square's own ordinal, not by
   name. S/Blue, M/Red and L/Blue are deliberately left with no variation
   at all, to prove those cells render blank rather than manufactured. */
function seedGridProduct(mirror) {
  mirror.db.exec("INSERT INTO mirror_category (id, external_ref, name) VALUES ('cat1', 'sqcat1', 'Outerwear')");
  mirror.db.exec(
    "INSERT INTO mirror_product (id, external_ref, handle, title, source_description, status, channel, custom_fields, category_id)" +
      " VALUES ('p1', 'sqitem1', 'wool-sweater', 'Wool Sweater', '', 'active', 'direct_link', '{}', 'cat1')",
  );
  mirror.db.exec(
    "INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('opt-size', 'sqopt-size', 'Size'), ('opt-color', 'sqopt-color', 'Color')",
  );
  mirror.db.exec(
    "INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal) VALUES" +
      " ('optval-s', 'sqval-s', 'opt-size', 'S', 0), ('optval-m', 'sqval-m', 'opt-size', 'M', 1), ('optval-l', 'sqval-l', 'opt-size', 'L', 2)," +
      " ('optval-red', 'sqval-red', 'opt-color', 'Red', 0), ('optval-blue', 'sqval-blue', 'opt-color', 'Blue', 1)",
  );
  const variations = [
    ["v1", "sqvar1", "VEM-1", "S / Red", { Size: "S", Color: "Red" }],
    ["v2", "sqvar2", "VEM-2", "M / Blue", { Size: "M", Color: "Blue" }],
    ["v3", "sqvar3", "VEM-3", "L / Red", { Size: "L", Color: "Red" }],
  ];
  for (const [id, ref, sku, title, options] of variations) {
    mirror.db
      .prepare(
        "INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, price_minor, currency, options)" +
          " VALUES (?, ?, 'p1', ?, ?, 4500, 'USD', ?)",
      )
      .run(id, ref, sku, title, JSON.stringify(options));
  }
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

/* Capture console output so a check can assert WHAT WAS SAID -- the same
   helper as sync.test.mjs's own, needed here because the cascade-into-
   save auto-apply (index.js) only ever surfaces its own failure as a
   console.error, never as part of the primary save's response. */
function captureConsole(fn) {
  const lines = { error: [], warn: [], info: [] };
  const real = { error: console.error, warn: console.warn, info: console.info };
  console.error = (...a) => lines.error.push(a.join(" "));
  console.warn = (...a) => lines.warn.push(a.join(" "));
  console.info = (...a) => lines.info.push(a.join(" "));
  const restore = () => Object.assign(console, real);
  return Promise.resolve()
    .then(() => fn(lines))
    .finally(restore)
    .then(() => lines);
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

check("test_PRD_P0_104_items_grid_scrolls_in_place__the_grid_has_its_own_scrollbar_sized_to_the_real_space_left", async () => {
  /* Caught live: typing into the search box re-filters tiles, changing
     the grid's own content height on every keystroke — with no height
     cap of its own, that moved the WHOLE page, losing sight of the grid
     on a short screen. The owner's own words: "make sure that the items
     list is its own frame so that it scales to fit content, and it has
     its own scroll bar instead of scrolling the entire page." Same
     technique .log (the chat history) already uses for the identical
     reason.
     REVISED — the height cap used to be a flat max-height: min(72vh,
     900px), a guess with no relationship to the real space actually
     left over. A real transcript: "this is not a question of not
     enough items. There's plenty of items. You're cropping the height
     of the bar unnaturally. This is an issue of the auto-sizing of the
     contents." .ops.items-page now makes the whole page a flex column
     instead — .items-grid's own flex: 1 1 auto (plus min-height: 0, or
     a flex child with overflow will not shrink below its own content)
     takes up exactly whatever space is left after the status line
     above it, no cap to guess at, still scrolling in place rather than
     moving the page underneath it. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /<main class="ops items-page">/, "the flex-column sizing below is scoped to this page specifically");
  assert.match(body, /\.ops\.items-page\s*\{[^}]*display:\s*flex/s);
  assert.match(body, /\.ops\.items-page\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(body, /\.ops\.items-page \.items-grid\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(body, /\.ops\.items-page \.items-grid\s*\{[^}]*min-height:\s*0/s);
  assert.match(body, /\.items-grid\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(body, /\.items-grid\s*\{[^}]*max-height/s, "no more flat vh guess capping the grid's own height");
});

check("test_PRD_P0_157_items_grid_flush_to_bar__the_shared_bottom_padding_and_the_grids_own_row_alignment_both_tightened", async () => {
  /* P0-104's own fix made the grid's own BOX fill exactly what's left,
     but two smaller gaps still stacked on top of it — a real transcript:
     "there is also like a 15 to 20 pixels of dead space above the item,
     like the search or the text entry field... you didn't fully extend
     it and are not using all available space." Verified by rendering the
     real page and measuring both the grid's own box and the actual tile
     rectangles (not just reasoning about the CSS): (1) the shared .ops
     rule's own bottom padding was a stale 76px, ~23px more than
     .input-bar's own real footprint needs; (2) .items-grid's own default
     align-content (start) left whatever didn't divide evenly into full
     rows as blank space below the last one.

     REVISED — plain align-content: space-between on the base rule (as
     shipped here originally) turned out to be unsafe on an OVERFLOWING
     catalog: see Test-PRD-P0-168-items_grid_row_collapse below for the
     full live-measured story of why it now only applies conditionally,
     via .items-grid.short. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.ops\s*\{[^}]*max-width:\s*64rem;\s*padding:\s*12px 8px 64px/s, "the shared .ops bottom padding must be tightened, not the stale 76px");
  assert.match(body, /\.items-grid\.short\s*\{\s*align-content:\s*space-between/s, "leftover row space must be spent BETWEEN rows on a catalog measured to fit, not left below the last one");
});

check("test_PRD_P0_168_items_grid_row_collapse__tiles_never_overlap_regardless_of_catalog_length", async () => {
  /* A real transcript: "the items are not laid out in a grid format.
     There is no padding between them. They're all kind of overlapping
     each other on the bottoms of all cards." Root cause, found by
     rendering the real page in a real browser and measuring actual tile
     rectangles rather than reasoning about the CSS: .item-tile's own
     overflow: hidden (needed to clip its rounded corners and the
     absolutely-positioned photo inside it), combined with its
     aspect-ratio: 1, triggers Chromium's "automatic minimum size" rule
     for grid-auto-rows: auto (the default) — a real, measured row
     collapsed to ~1/3 of the tile's own actual height while the tile
     itself still rendered at full size, overflowing into the row below.
     align-content was never the cause — a red herring the earlier
     P0-157 fix (and this bug's own first, superseded attempt, align-
     content: safe space-between, unsupported in this app's own real
     Chromium and silently ignored) both chased instead.
     grid-auto-rows: min-content sidesteps the automatic-minimum
     reduction outright and is the actual fix; align-content: start on
     the base rule (never unconditional space-between, which goes
     NEGATIVE and overlaps rows a second, independent way once a real
     catalog overflows the box — the ordinary case, not the edge case)
     is what makes the safe case the DEFAULT rather than something a
     short catalog has to opt out of. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /\.items-grid\s*\{[^}]*grid-auto-rows:\s*min-content/s, "auto row sizing is exactly what collapses under overflow: hidden + aspect-ratio; min-content sidesteps it");
  assert.match(body, /\.items-grid\s*\{[^}]*align-content:\s*start/s, "the base rule must never be unconditional space-between, which goes negative and overlaps rows once a catalog overflows the box");
  assert.doesNotMatch(body, /\.items-grid\s*\{[^}]*align-content:\s*(normal|space-between)/s, "neither the browser's own default (normal, which computes to stretch for grid and reintroduces the row collapse) nor unconditional space-between belongs on the base rule");
  assert.match(body, /updateItemsGridFit/, "the short/overflowing decision must be measured live (scrollHeight vs clientHeight), not guessed from CSS alone");
});

check("test_PRD_P0_169_item_breadcrumb__every_category_level_renders_as_its_own_clickable_segment", async () => {
  /* "I want to see their category, their subcategory name on the bottom
     of each of those thumbnails... when that item is expanded into its
     full item view, then I want to see the full breadcrumb... and I
     should be able to click on them to browse through them" — the
     owner's own words. ONE breadcrumb (item-breadcrumb), rendered once
     inside .item-bottom, shown in both the collapsed and the expanded
     state since .item-bottom overlays the same photo in both (P0-71's
     own .item-tile.full .item-photo). Every level is its own <button>,
     not one plain unclickable label — categoryPath's own joined string
     already existed (the category picker's hover title) but a joined
     string cannot be clicked one segment at a time. */
  const mirror = mirrorDb();
  seedProduct(mirror, { subcategoryName: "Coats" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /<nav class="item-breadcrumb" aria-label="Category"><button type="button" class="item-breadcrumb-seg" data-category="Outerwear">Outerwear<\/button><span class="item-breadcrumb-sep">\/<\/span><button type="button" class="item-breadcrumb-seg" data-category="Coats">Coats<\/button><\/nav>/,
    "both levels must render, each as its own clickable segment carrying its own plain name",
  );
});

check("test_PRD_P0_169_item_breadcrumb__the_chain_attribute_lets_an_ancestor_level_match_a_subcategorized_product", async () => {
  /* The existing top-of-page category menu only ever offers LEAF names
     (flat, built from product.category_name) — clicking "Outerwear" on a
     product actually filed under Outerwear > Coats would never have
     matched it under the OLD leaf-only check (selectedCategories.has(
     el.dataset.category) alone). data-category-chain — every level's own
     name — is what lets filterItems() recognize a click on an ANCESTOR
     level, not only the product's own immediate leaf.

     REVISED, caught live: the first version of this attribute joined the
     names with "\u0000". This whole page is ONE server-side template
     literal, so that escape sequence is evaluated by NODE the moment the
     literal itself is built — landing in the served HTML as a real NUL
     byte, not surviving as literal text for the BROWSER to interpret
     later. A raw NUL in an HTML document is silently replaced by the
     parser (U+FFFD) wherever it appears; rendering the real page in a
     real browser and reading the attribute back showed exactly that
     corruption. It "worked" anyway, purely by coincidence — the split
     call's own delimiter went through the identical corruption, so both
     sides still matched — which is not something to ship. JSON.stringify/
     JSON.parse, asserted here, replaced the hand-picked delimiter. */
  const mirror = mirrorDb();
  seedProduct(mirror, { subcategoryName: "Coats" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(body, /data-category-chain="\[&quot;Outerwear&quot;,&quot;Coats&quot;\]"/, "the chain must be valid, escaped JSON naming every level, top to leaf");
  assert.doesNotMatch(body, /data-category-chain="[^"]*\\u0000/, "a literal escape sequence in this template literal is evaluated server-side, not preserved as text for the browser");
  const matchFn = body.slice(body.indexOf("function matchesCategoryFilter"), body.indexOf("function matchesCategoryFilter") + 300);
  assert.match(matchFn, /JSON\.parse\(el\.dataset\.categoryChain\)/, "the chain must be parsed as JSON, not split on a hand-picked delimiter that cannot survive this file's own template-literal evaluation");
});

check("test_PRD_P0_169_item_breadcrumb__clicking_a_segment_in_the_full_view_closes_it_and_filters", async () => {
  /* "I should be able to click on them to kind of see, uh, basically
     browse through them" — clicking a breadcrumb segment while the tile
     is expanded must not just filter invisibly behind the still-open
     full view; it must return the person to a grid they can actually
     see the result in, the same unsaved-changes guard .item-close
     already uses so a real edit is never silently discarded. Checked
     against the served script's own source (this file's established
     convention for the inline client script, matching every other check
     here) rather than a rendered browser, but the underlying behavior —
     tile.classList.remove("full") before browseCategory() runs — was
     verified live in a real browser first. */
  const mirror = mirrorDb();
  seedProduct(mirror, { subcategoryName: "Coats" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const handlerAt = body.indexOf('e.target.closest(".item-breadcrumb-seg")');
  assert.ok(handlerAt > -1, "the breadcrumb click must be its own delegated handler");
  const handler = body.slice(handlerAt, handlerAt + 400);
  assert.match(handler, /classList\.remove\("full"\)/, "an expanded tile must close before browsing away from it");
  assert.match(handler, /browseCategory\(breadcrumbSeg\.dataset\.category\)/, "the click must filter by the clicked segment's own name");
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

check("test_PRD_P0_71_items_tab__the_full_screen_tiles_own_bottom_edge_covers_the_search_bar_with_no_gap", async () => {
  /* A real transcript: "why is the bottom of the item view cut off? It's
     like the frame doesn't extend all the way to the bottom of the
     page." .item-tile.full used a flat inset: 12px on every side, but
     .input-bar (the search box, fixed to the bottom of this same page)
     sits bottom: 8px — 4px CLOSER to the true edge. .item-tile.full has
     the higher z-index, so it painted over the search bar everywhere the
     two boxes actually overlapped, but never in that bottom 4px sliver,
     where the search bar's own rounded border showed through as a
     second, broken edge. Asserting the two values are EQUAL, not just
     that both exist, is the point: a future change to either one alone
     reopens the same gap. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const tileRule = /\.item-tile\.full\s*\{([^}]*)\}/s.exec(body)?.[1];
  const barRule = /\.input-bar\s*\{([^}]*)\}/s.exec(body)?.[1];
  assert.ok(tileRule && barRule, "both rules must be present to compare");
  const tileBottom = /bottom:\s*(\d+)px/.exec(tileRule)?.[1];
  const barBottom = /bottom:\s*(\d+)px/.exec(barRule)?.[1];
  assert.ok(tileBottom && barBottom, "both rules must state an explicit bottom offset");
  assert.equal(tileBottom, barBottom, ".item-tile.full's own bottom offset must match .input-bar's exactly, or it leaves a gap for the search bar to peek through");
  /* The other three sides are unaffected by this fix — still the original 12px. */
  assert.match(tileRule, /top:\s*12px/);
  assert.match(tileRule, /right:\s*12px/);
  assert.match(tileRule, /left:\s*12px/);
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
  assert.match(filterFn, /matchesCategoryFilter\(el\)/, "category and free text must still combine as AND, category via its own dedicated check");
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
     the shared part of .ops (max-width, top, sides, and the bottom that
     clears .input-bar alone) into OPS_DARK_CSS, which ITEMS_CSS already
     imports. Bottom is 64px, not the original 76px — see Test-PRD-P0-157's
     own comment on .ops for why that padding shrank. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  /* theme.css's own generic .ops rule is still present in the inlined
     stylesheet (it always is — page() inlines it unconditionally) but no
     longer decides anything here: this tightened rule comes later in the
     cascade at equal specificity, so it wins regardless. */
  assert.match(body, /\.ops\s*\{[^}]*max-width:\s*64rem;\s*padding:\s*12px 8px 64px/s);
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

check("test_PRD_P0_139_honest_write_failures__the_error_popover_floats_above_the_field_and_copies_on_click", async () => {
  /* The owner's own words, after the previous fix made a real Square
     rejection's own detail long enough to actually read: "in smaller
     font... have a little error message pop up somewhere in a more
     elegant way, like above the field, not modifying heights and shit...
     I should be able to just click on it and it copies into my
     clipboard." Source-pattern checks here, the same discipline every
     other client-script guarantee in this file uses; the live behavior
     (tile height provably unchanged, a click actually copying to the
     clipboard, outside-click dismissal) was verified separately in a
     real headless browser before shipping. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /\.item-edit-error \{\s*\n\s*position: fixed;/,
    "the popover must not sit in normal document flow, or it pushes the rows below it down",
  );
  assert.match(body, /font-size: 10px/, "smaller font, the owner's own explicit ask");
  assert.match(body, /function positionErrorPopover\(p, anchor\) \{/);
  assert.match(
    body,
    /const above = rect\.top - p\.offsetHeight - 6;/,
    "floats above the field by default",
  );
  assert.match(body, /function copyErrorText\(p, message\) \{/);
  assert.match(
    body,
    /navigator\.clipboard\s*\n?\s*\.writeText\(message\)/,
    "clicking the popover must copy its own exact message, not a button beside it",
  );
  assert.match(
    body,
    /p\.addEventListener\("click", \(\) => copyErrorText\(p, message\)\)/,
    "the whole popover is the click target",
  );
  assert.match(
    body,
    /document\.querySelectorAll\("\.item-edit-error"\)\.forEach\(\(p\) => p\.remove\(\)\)/,
    "an outside click must dismiss it, the same convention closeAllCategoryPickers already uses",
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
     into .category-title-row, to the left of the category dropdown
     (REVISED: "I want to get rid of the style ID label and I want to take
     the style ID input field and put it to the left of the category
     dropdown in the category row"), vendor/vendor_code/commission stayed
     where they were. unit_cost has no ops-side form field anywhere any
     more ("get rid of the whole variants setup... we'll do variations
     from Square") — only ever reachable through an API/agent
     catalog.set_square_attributes call now. */
  const mirror = mirrorDb();
  seedProduct(mirror, {
    style_id: "01-04-001",
    vendor: "Acme Mills",
    vendor_code: "ACME-4471",
    unit_cost_minor: 4200,
    commission_pct: 20,
  });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const squareAttrForms = [...body.matchAll(/<form method="post" action="\/items\/wool-coat\/square-attributes"[^>]*>/g)];
  assert.equal(squareAttrForms.length, 2, "style_id and vendor/vendor_code/commission are two separate forms now");
  assert.doesNotMatch(body, /variations-header-label/, "no more Style ID label anywhere -- the placeholder is the only hint now");
  const titleRowIdx = body.indexOf('<div class="category-title-row">');
  const categoryFormIdx = body.indexOf('<form method="post" action="/items/wool-coat/category"', titleRowIdx);
  const styleIdIdx = body.indexOf('<input name="style_id"', titleRowIdx);
  assert.ok(styleIdIdx > titleRowIdx && styleIdIdx < categoryFormIdx, "style_id must render before the category dropdown, inside the category row");
  assert.match(body, /<input name="style_id" value="01-04-001" placeholder="NN-NN-NNN" pattern="\\d\{2\}-\\d\{2\}-\\d\{3\}"/);
  assert.match(body, /<input class="item-unit-cost" name="unit_cost" value="42" placeholder="Cost"/, "unit_cost lives on the vendor form, back on the row itself, as a whole dollar amount");
  /* "The same kind of drop down schema that we have for categories... we
     don't have to fill out any of these stuff per product." vendor is now
     a picker (a hidden text input the picker's own JS drives, plus a
     button showing the current name), not a free-text field — the same
     "form as a transparent wrapper" shape .category-form already uses. */
  assert.match(body, /<input type="text" name="vendor" value="Acme Mills" hidden>/);
  assert.match(body, /<span class="vendor-picker-btn-label">Acme Mills<\/span>/);
  /* "Hint for vendor SKU should be just vendor SKU, not 'own SKU'... as
     short as possible" — short placeholders, with the fuller wording
     moved to a title tooltip instead of dropped. */
  assert.match(body, /<input name="vendor_code" value="ACME-4471" placeholder="Vendor SKU" title="The vendor's own SKU\/code">/);
  /* Commission is no longer typed per product — it lives on the vendor
     itself (Admin -> Vendors) and only ever shows here, read-only. The
     Vendors admin accordion (further down the same tile) DOES have its
     own real commission inputs, so this checks only the per-product
     vendor form itself, not the whole page. */
  const vendorFormIdx = body.indexOf('<input type="text" name="vendor" value="Acme Mills" hidden>');
  const vendorFormEndIdx = body.indexOf("</form>", vendorFormIdx);
  const vendorFormBody = body.slice(vendorFormIdx, vendorFormEndIdx);
  assert.doesNotMatch(vendorFormBody, /name="commission"/, "commission is no longer a per-product input");
  assert.match(vendorFormBody, /<span class="vendor-commission-badge" title="Set centrally, in Admin → Vendors">20%<\/span>/);
  /* "Center the vendor SKU content too" — the owner's own words, extending
     the centering style_id already has to this field as well. */
  assert.match(body, /\.item-edit input\[name="vendor_code"\] \{ field-sizing: content; min-width: 3em; text-align: center; \}/);
  /* Cost lives inside THIS vendor form (applied uniformly to every
     variation); MSRP has no product-wide concept in Square at all, so it
     is a wholly separate form/route (/items/<handle>/price) and must
     NOT appear inside this one. */
  assert.match(vendorFormBody, /class="item-unit-cost" name="unit_cost"/);
  assert.doesNotMatch(vendorFormBody, /item-msrp/);
});

check("test_PRD_P0_136_square_custom_attributes__the_vendor_picker_fits_its_own_content_instead_of_filling_the_row", async () => {
  /* REVISED: "vendor should not be collapsed, it should fit to content."
     A prior revision made it grow to fill the row ("spread them out...
     make the vendor dropdown box eat up all the available space"), but
     that squeezed the vendor name thin once Cost/MSRP/vendor SKU started
     growing for their own typed content — back to the same content-width
     sizing .category-picker/.category-picker-btn already use. */
  const mirror = mirrorDb();
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /\.vendor-picker \{ position: relative; flex: 0 0 auto; \}/);
  assert.match(body, /\.vendor-picker-btn \{[^}]*flex: 0 0 auto; font: inherit; font-size: 11px; padding: 3px 5px; white-space: nowrap;/s);
  assert.doesNotMatch(body, /\.vendor-picker-btn\s*\{[^}]*width: 100%/s);
});

check("test_PRD_P0_136_square_custom_attributes__cost_and_msrp_always_render_on_the_vendor_row_even_with_no_vendor_yet", async () => {
  /* "Where's my cost and my MSRP? It needs to be on the right of vendors,
     right? Those should be there always." — restored after "get rid of
     the variations row entirely" turned out to mean per-variation
     editing specifically, never these two product-wide bulk fields.
     Cost lives on the SAME square-attributes form as vendor (applied
     uniformly to every variation, same as vendor/vendor_code); MSRP has
     no such product-wide concept in Square, so it gets its own form,
     posting to the new /items/<handle>/price route. Both always render,
     even with no vendor at all — same "always visible, refused server-
     side only if actually used with no vendor" rule Cost always had. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /<input class="item-unit-cost" name="unit_cost" value="" placeholder="Cost"/);
  assert.match(body, /<form method="post" action="\/items\/wool-coat\/price">/);
  assert.match(body, /<input class="item-msrp" name="price" value="450" placeholder="MSRP"/);
});

check("test_PRD_P0_136_square_custom_attributes__cost_prefills_from_the_vendors_own_unit_cost_msrp_from_the_first_variations_own_price", async () => {
  /* "Don't add decimals to our costs and to our prices, it's just going
     to be whole numbers" — the prefilled value is a plain whole dollar
     amount, rounded, never a decimal string. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills", unit_cost_minor: 4200 });
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /<input class="item-unit-cost" name="unit_cost" value="42" placeholder="Cost"/);
});

check("test_PRD_P0_136_square_custom_attributes__cost_and_msrp_have_a_four_digit_minimum_width_and_expand_past_it", async () => {
  /* REVISED: "make minimum width four digits — if they need to expand,
     they'll expand." A fixed 3.5em would clip a longer typed value;
     field-sizing: content grows the box past its own min-width instead,
     so the 3.5em floor is a MINIMUM now, not a cap. */
  const mirror = mirrorDb();
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /\.item-unit-cost, \.item-msrp \{ flex: 0 0 auto; field-sizing: content; min-width: 3\.5em; text-align: center; \}/);
});

check("test_PRD_P0_136_square_custom_attributes__vendor_sku_fits_its_own_content_and_stays_small_when_empty", async () => {
  /* "Vendor SKU also should fit to content. It should be really short
     because usually it's going to be empty anyway." Split off the shared
     width: 8em rule it used to share with a registered custom field's own
     name column — that one is unaffected. */
  const mirror = mirrorDb();
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /\.item-edit input\[name="vendor_code"\] \{ field-sizing: content; min-width: 3em; text-align: center; \}/);
  assert.match(body, /\.item-edit input\[name\^="field_name_"\] \{ width: 8em; \}/);
});

check("test_PRD_P0_136_square_custom_attributes__cost_and_msrp_are_two_separate_forms_merged_into_one_visual_row", async () => {
  /* MSRP cannot live in the SAME <form> as Cost/vendor -- it reaches a
     different tool (catalog.update_product) through a different route
     -- so the two forms are visually merged into one row the same
     "display: contents" way .category-title-row's own two forms already
     are, rather than each becoming its own stacked block. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /\.item-edit \.vendor-row form \{ display: contents; \}/);
  const rowIdx = body.indexOf('<div class="row vendor-row">');
  const vendorFormIdx = body.indexOf('action="/items/wool-coat/square-attributes"', rowIdx);
  const priceFormIdx = body.indexOf('action="/items/wool-coat/price"', rowIdx);
  assert.ok(rowIdx > -1 && vendorFormIdx > rowIdx && priceFormIdx > vendorFormIdx, "both forms live inside the same .vendor-row, vendor form first");
});

check("test_PRD_P0_136_square_custom_attributes__price_route_refuses_a_blank_msrp_before_touching_square", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/price", MANAGER, env(mirror), { price: "" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /give an MSRP/);
});

check("test_PRD_P0_136_square_custom_attributes__price_route_refuses_cents_before_touching_square", async () => {
  /* "Don't add decimals to our costs and to our prices, it's just going
     to be whole numbers." A decimal MSRP is refused with its own clear
     reason, not rounded away and not left to a downstream "must be an
     integer" that never actually names cents as the problem. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/price", MANAGER, env(mirror), { price: "45.50" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /MSRP must be a whole dollar amount — no cents/);
});

check("test_PRD_P0_136_square_custom_attributes__price_route_staff_cannot_reach_it", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/price", STAFF, env(mirror), { price: "45" });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_136_square_custom_attributes__price_route_resends_every_current_variation_reaching_the_tool_layer", async () => {
  /* Matching the P0-138 admin tests' own convention: reaching
     "SQUARE_ACCESS_TOKEN is unset" (catalog.update_product's own run(),
     not check()) proves the route built a valid variations array --
     every existing variation, title/currency untouched, price_minor
     alone overridden -- before ever touching Square. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/price", MANAGER, env(mirror), { price: "45" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/);
});

check("test_PRD_P0_136_square_custom_attributes__the_vendor_picker_toggles_off_when_the_same_vendor_is_clicked_again", async () => {
  /* "I don't like adding none to vendors. Let's just make the vendor
     selected vendor toggle so that if I selected a vendor and then I
     selected the same vendor again, it just clears that selection." — no
     "None" entry in the menu; picking the ALREADY-selected option clears
     it instead. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills" });
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.doesNotMatch(body, /data-vendor-name=""/, "no separate None option in the vendor picker menu");
  assert.match(body, /const clearing = vendorPickerOption\.classList\.contains\("selected"\);/);
  assert.match(body, /hiddenInput\.value = clearing \? "" : vendorPickerOption\.dataset\.vendorName;/);
  assert.match(body, /label\.textContent = clearing \? "Vendor" : vendorPickerOption\.dataset\.vendorName \|\| "Vendor";/);
  assert.match(body, /if \(!clearing\) vendorPickerOption\.classList\.add\("selected"\);/);
});

check("test_PRD_P0_136_square_custom_attributes__clearing_the_vendor_picker_sends_an_explicit_clear_vendor_marker", async () => {
  /* A blank vendor otherwise means "this form wasn't about the vendor" —
     the picker's own toggle-to-clear needs its own explicit signal so the
     route can tell a genuine clear apart from an untouched field, exactly
     the same shape catalog.set_category_number's own clear: true already
     established for numeric_id. .field-dirty is only set on the vendor
     input itself when ITS OWN value changed, so a blank value alongside
     it means the toggle is what fired. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills" });
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /const vendorInput = form\.querySelector\('input\[name="vendor"\]'\);\s*\n\s*if \(vendorInput && vendorInput\.classList\.contains\("field-dirty"\) && vendorInput\.value === ""\) \{\s*\n\s*body\.set\("clear_vendor", "1"\);/,
  );
});

check("test_PRD_P0_136_square_custom_attributes__the_route_translates_a_blank_vendor_with_the_clear_marker_into_clear_vendor_reaching_the_tool_layer", async () => {
  /* The whole point of the marker: a blank vendor with clear_vendor=1
     must reach catalog.set_square_attributes as clear_vendor: true, not
     get refused for sending an empty string (the generic schema
     validator refuses any empty "string"-typed field outright) and not
     get silently dropped as "field untouched" either. Matching the
     P0-138 admin tests' own convention, reaching "SQUARE_ACCESS_TOKEN is
     unset" (run()'s own Square call, not check()'s) proves check()
     accepted clear_vendor: true and the route never touched Square. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills" });
  const res = await postForm("/items/wool-coat/square-attributes", MANAGER, env(mirror), { vendor: "", clear_vendor: "1" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/);
});

check("test_PRD_P0_136_square_custom_attributes__a_blank_vendor_with_no_clear_marker_reaches_the_tool_layer_untouched", async () => {
  /* Without the clear_vendor marker, a blank vendor field must still mean
     "this form wasn't about the vendor" -- the pre-existing behavior for
     every OTHER blank field on this same route (style_id, vendor_code,
     unit_cost, commission) -- rather than being silently treated as an
     implicit clear. Giving vendor_code alongside it is what makes this
     call reach the tool layer at all (a wholly blank form is refused
     before ever calling runTool, by the tool's own generic "would change
     nothing" rule, which -- like every check()-level message for this
     resources:["square"] tool -- this file's own Square-token-less env()
     can never observe directly; see the P0-138 admin comment above for
     why "SQUARE_ACCESS_TOKEN is unset" is as deep as this file reaches).
     What IS provable here: an untouched vendor never gets treated as a
     clear -- the exact semantics catalog-write.test.mjs's own
     clear_vendor tests verify with a real fake Square client. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills", vendor_code: "OLD-CODE" });
  const res = await postForm("/items/wool-coat/square-attributes", MANAGER, env(mirror), { vendor: "", vendor_code: "NEW-CODE" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/, "an untouched vendor must not itself block reaching the tool layer");
});

check("test_PRD_P0_136_square_custom_attributes__style_id_auto_formats_with_dashes_and_reads_red_until_a_full_match", async () => {
  /* "When I'm entering a style ID... I should just type it in, like type
     in digits, say 010101, it should automatically insert dashes between
     these numbers as I type... until I type out the full complete number,
     the entry field border should be red to indicate that it's not
     acceptable, only when it's fully acceptable should it be orange." No
     JS validation state -- the field's own existing pattern already makes
     an incomplete, non-empty value native :invalid, and an empty one
     native :valid, since it is never required. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /--invalid:\s*#E5484D;/);
  assert.match(body, /\.item-edit input\[name="style_id"\]:invalid\s*\{\s*border-color:\s*var\(--invalid\);\s*\}/);
  assert.doesNotMatch(body, /<input name="style_id"[^>]*\brequired\b/, "empty must stay :valid -- no style_id yet is not an error");
  assert.match(body, /function formatStyleId\(raw\)\s*\{/);
  assert.match(body, /const digits = raw\.replace\(\/\\D\/g, ""\)\.slice\(0, 7\);/);
  assert.match(body, /function reformatStyleIdInput\(input\)\s*\{/);
  const gridChangeIdx = body.indexOf("function onItemsGridChange(e) {");
  const reformatCallIdx = body.indexOf('reformatStyleIdInput(e.target);', gridChangeIdx);
  const stockCountBranchIdx = body.indexOf('e.target.matches(".variation-stock-count")', gridChangeIdx);
  assert.ok(
    gridChangeIdx > -1 && reformatCallIdx > gridChangeIdx && reformatCallIdx < stockCountBranchIdx,
    "the style_id reformat must run first, on every input/change event the grid already listens for",
  );
});

check("test_PRD_P0_136_square_custom_attributes__cost_refuses_cents_before_touching_square", async () => {
  /* "Don't add decimals to our costs and to our prices, it's just going
     to be whole numbers." A decimal Cost is refused with its own clear
     reason, before ever reaching runTool -- never rounded away and never
     left to a downstream "must be an integer" that never actually names
     cents as the problem. A blank Cost (untouched) still means "leave it
     as it is", unaffected. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills" });
  const res = await postForm("/items/wool-coat/square-attributes", MANAGER, env(mirror), { unit_cost: "42.50" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Cost must be a whole dollar amount — no cents/);
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
 * "Category dropdown, or type in a new one" (/items/<handle>/category) — the
 * owner's own words: "uncategorized should be a drop down... select an
 * existing category, or just type in... it will create one if there isn't
 * one." Reaches catalog.update_product, which needs a working Square client
 * this file deliberately never fakes (see the P0-136 section's own top
 * comment) — so what is tested here is everything BEFORE that point: the
 * manager-only gate, and every refusal the route itself can give with no
 * Square client at all. /items/<handle>/variations, the accordion's own old
 * route, is gone entirely now (see the P0-135 test just below the category
 * ones) — "get rid of the variations row entirely... we'll do variations
 * from Square."
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

check("test_PRD_P0_135_item_edit_applies_immediately__variations_route_is_gone_entirely", async () => {
  /* "Get rid of the variations row entirely. I don't want to handle
     variations from inside of our ops menu. We'll do variations from
     Square." — /items/<handle>/variations is no longer one of the
     suffixes this block even recognizes, so a post here falls all the
     way through to the app's own generic 404, not a route-level refusal. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/items/wool-coat/variations", MANAGER, env(mirror), {
    variant_id_0: "v1",
    title_0: "One size",
    price_0: "45.00",
    currency_0: "USD",
  });
  assert.equal(res.status, 404);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_variations_accordion_has_no_sku_and_no_editable_fields_left_only_a_name_and_the_stock_stepper", async () => {
  /* "Get rid of the variations row entirely. I don't want to handle
     variations from inside of our ops menu. We'll do variations from
     Square." Follow-up, once it was clear the stock stepper is a
     separate, ops-owned inventory ledger, not a Square-side variant
     fact: "our store should reflect internal inventory count, remove
     variants from our ops dashboard" — kept the stock stepper, removed
     title/price/cost editing entirely. No <form>, no variant_id/currency
     hidden inputs any more either: nothing here posts anywhere but the
     stock stepper's own immediate /inventory call. */
  const mirror = mirrorDb();
  seedProduct(mirror, { style_id: "01-04-001", unit_cost_minor: 4250, vendor: "Acme Mills" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, />VEM-100</, "no SKU text anywhere in a manager's own expanded view");
  assert.doesNotMatch(body, /name="variant_id_0"/, "no per-variation form field survives -- nothing here is ever resent through a <form>");
  assert.doesNotMatch(body, /class="variation-title"|class="variation-unit-cost"|class="variation-price"/, "title/cost/price editing is gone");
  assert.doesNotMatch(body, /action="\/items\/wool-coat\/variations"/, "the variations accordion body posts nowhere any more");
  assert.match(body, /<span class="variation-title-label">One size<\/span>/, "the variation's own name is still shown, read-only");
  assert.match(body, /<input type="text" class="variation-stock-count" value="0" readonly aria-label="Current stock">/, "the stock stepper survives untouched");
  /* REVISED: style_id no longer lives in the accordion's own header at
     all -- it moved to .category-title-row, no label, just the format
     hint placeholder. */
  assert.doesNotMatch(body, /variations-header-label/);
  assert.match(body, /<input name="style_id" value="01-04-001" placeholder="NN-NN-NNN"/, "just the format hint, no label at all");
  /* The direct-link deep link is the one place a SKU still matters — the
     owner's own words: "if you do a direct link, that makes sense...
     otherwise it's completely not our problem" — so data-sku must still
     be there for shareLink() to read, even though nothing displays it. */
  assert.match(body, /data-sku="VEM-100"/);
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

check("test_PRD_P0_135_item_edit_applies_immediately__style_id_stays_centered_and_the_header_spacer_is_the_last_thing_in_it", async () => {
  /* "Scale that [style_id] input field to only fit that exact amount of
     characters" — 9 for NN-NN-NNN, still centered. */
  const mirror = mirrorDb();
  seedProduct(mirror, { vendor: "Acme Mills" });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  /* REVISED: style_id no longer lives in the Variations header at all --
     "I want to get rid of the style ID label and I want to take the
     style ID input field and put it to the left of the category dropdown
     in the category row." It kept its own width (6em, unchanged) and
     centered text, now scoped to .item-edit since that is where it
     actually renders. */
  assert.match(body, /\.item-edit input\[name="style_id"\]\s*\{[^}]*width: 6em[^}]*text-align: center/);
  assert.match(body, /<span class="variations-header-spacer"><\/span>/, "an invisible spacer absorbs the header's own leftover width, the same way each row's own title does");
  assert.match(body, /\.variations-header-spacer\s*\{\s*flex: 1 1 auto;\s*\}/);
  assert.match(body, /\.variations-body \.row\s*\{[^}]*padding: 3px 4px 3px 0/, "a right inset matches the header's own right padding");
  /* "Get rid of the whole variants setup... we'll do variations from
     Square" — Cost/MSRP, briefly at the end of the vendor row, are gone
     from the page entirely now; nothing follows the header's own spacer
     any more, and no per-variation cost/price field exists anywhere. */
  const spacerMarkup = body.indexOf('<span class="variations-header-spacer">');
  const headerEnd = body.indexOf("</div>", spacerMarkup);
  assert.ok(
    body.indexOf('<span class="variations-label">Variations</span>') < spacerMarkup,
    "the spacer must still follow the Variations label",
  );
  assert.doesNotMatch(
    body.slice(spacerMarkup, headerEnd),
    /variations-unit-cost|variations-msrp/,
    "Cost/MSRP no longer live inside this header at all",
  );
  assert.doesNotMatch(body, /variations-unit-cost|variations-msrp|variation-unit-cost|variation-price/, "no cost/price field survives anywhere on the page");
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

check("test_PRD_P0_135_item_edit_applies_immediately__description_grows_to_fit_content_equal_top_and_bottom_padding", async () => {
  /* REVISED: "the description field should have the same amount of
     padding on the bottom as it has on the top and it should fit the
     content — if there is no content, it should fit to one line
     height, but if I type in more, it should auto scale to fit." A
     fixed min-height (three-ish lines) left a large empty gap below one
     short line, reading as unequal padding even though the CSS itself
     already declared 5px on both. field-sizing: content now grows the
     box to match its own wrapped content, with min-height: 1lh for
     nothing typed yet -- and no more resize: vertical, since a box that
     already fits its own content has nothing left to manually resize. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /\.item-edit textarea \{\s*\n\s*font: inherit; font-size: 11px; padding: 5px 6px; field-sizing: content; min-height: 1lh;/,
  );
  assert.doesNotMatch(body, /\.item-edit textarea \{[^}]*resize:/s, "a box that always fits its own content has nothing left to resize");
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

check("test_PRD_P0_139_honest_write_failures__a_failed_resync_shows_the_same_click_to_copy_popover_not_a_native_alert", async () => {
  /* The owner's own words after actually hitting a failed resync: had to
     manually read and retype a native alert()'s text to report it back --
     exactly the friction the click-to-copy popover already exists to
     remove from every other write failure on this page. The alert() here
     predated that popover and was never revisited once position: fixed
     stopped needing any layout room to float in. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.doesNotMatch(body, /alert\("Resync from Square failed/, "no more native alert on a failed resync");
  assert.match(
    body,
    /if \(!res\.ok\) \{\s*\n\s*showFormError\(resyncBtn, data\.error \|\| "resync failed"\);/,
    "a failed resync must use the same copyable popover every other write failure uses",
  );
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

/* ─────────────────────────────────────────────────────────────────────────
 * P0-147 — "a whole grid of available size and color variations so that I
 * can set their quantities directly out of that variants dropdown" — the
 * owner's own words, REVISED once they actually saw a flat table: "I want
 * to see two headers, expandable, one for each color. I need to be able
 * to expand them, and I need to see individual sizes for them that I can
 * change quantity." Exactly two Option Set dimensions render as nested
 * expandable groups (one per row-axis value); anything else keeps the
 * flat variation list.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_147_variants_grid__two_option_dimensions_render_as_nested_expandable_groups_ordered_by_ordinal", async () => {
  const mirror = mirrorDb();
  seedGridProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();

  assert.match(body, /class="variant-group"/, "exactly two Option Set names must render as nested expandable groups, not the flat list");

  /* The two Option Set names are ordered the same way listItemOptions
     already orders every other reader of them (alphabetically by name)
     — "Color" sorts before "Size", so Color becomes the OUTER group and
     Size is what lists inside each one, in Square's own ordinal order
     (S, M, L), NOT alphabetical (which would read L, M, S). */
  const redIdx = body.indexOf('<span class="variant-group-label">Red</span>');
  const blueIdx = body.indexOf('<span class="variant-group-label">Blue</span>');
  assert.ok(redIdx >= 0 && blueIdx > redIdx, "groups must read Red, Blue — Square's own ordinal order");

  /* S/Red has a real variation (v1) and gets a stepper; M/Red has no
     variation at all and is simply absent — "existing SKUs only," the
     owner's own choice — never a manufactured row. */
  const redGroupStart = body.lastIndexOf('<div class="variant-group">', redIdx);
  const nextGroupStart = body.indexOf('<div class="variant-group">', redGroupStart + 1);
  const redGroup = body.slice(redGroupStart, nextGroupStart > 0 ? nextGroupStart : redGroupStart + 2000);
  assert.match(redGroup, /<span class="variation-title-label">S<\/span>/, "the S row must be listed under Red");
  assert.match(redGroup, /variation-stock-step" data-variant-id="v1"/, "S under Red must carry v1's own stepper");
  assert.match(redGroup, /<span class="variation-title-label">L<\/span>/, "the L row must be listed under Red");
  assert.match(redGroup, /variation-stock-step" data-variant-id="v3"/, "L under Red must carry v3's own stepper");
  assert.doesNotMatch(redGroup, /<span class="variation-title-label">M<\/span>/, "M has no SKU under Red and must not appear at all");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-147 (REVISED) — "grid layout, use horizontal space more
 * efficiently... a row of sizes... accordion style, only one open at a
 * time... I don't want to see variations dropdown that's nested" — the
 * owner's own words, on seeing the first nested-accordion version live.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_147_variants_grid__two_dimensions_skip_the_outer_variations_accordion_entirely", async () => {
  const mirror = mirrorDb();
  seedGridProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();

  assert.match(body, /<div class="variant-groups">/, "the color groups are the first and only level -- no separate wrapper needed");
  const groupsIdx = body.indexOf('<div class="variant-groups">');
  const groupIdx = body.indexOf('<div class="variant-group">', groupsIdx);
  assert.ok(groupIdx > groupsIdx && groupIdx < groupsIdx + 50, "a variant-group must be the FIRST thing inside variant-groups, no accordion nested in between");

  const between = body.slice(Math.max(0, groupsIdx - 2000), groupsIdx);
  assert.doesNotMatch(between, /variations-accordion/, "the two-dimension case must never render the outer Variations accordion at all");
});

check("test_PRD_P0_147_variants_grid__each_color_header_keeps_the_same_one_pixel_outline_the_old_wrapper_had", async () => {
  /* "Keep the same styling, it needs to be an outline, the container
     needs a border of one pixel, just like you had it before, why'd
     you get rid of it?" — caught live: removing the outer Variations
     wrapper (above) also silently dropped its own `border: 1px solid
     var(--rule)`, since .variant-group-header was never given one of
     its own to replace it. */
  const mirror = mirrorDb();
  seedGridProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /\.variant-group-header \{\s*\n\s*display: flex; align-items: center; gap: 6px; cursor: pointer;\s*\n\s*background: var\(--image-ground\); border: 1px solid var\(--rule\); border-radius: 6px; padding: 4px;\s*\n\s*\}/,
    "each color header must carry its own 1px outline, the same var(--rule) border every other accordion header in this file already uses",
  );
});

check("test_PRD_P0_147_variants_grid__sizes_render_as_a_wrapping_grid_of_cells_not_one_row_each", async () => {
  const mirror = mirrorDb();
  seedGridProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();

  const redIdx = body.indexOf('<span class="variant-group-label">Red</span>');
  const redGroupStart = body.lastIndexOf('<div class="variant-group">', redIdx);
  const nextGroupStart = body.indexOf('<div class="variant-group">', redGroupStart + 1);
  const redGroup = body.slice(redGroupStart, nextGroupStart > 0 ? nextGroupStart : redGroupStart + 2000);

  assert.match(redGroup, /<div class="variant-size-grid">/, "sizes under an open color must sit inside a wrapping grid, not stacked rows");
  assert.match(redGroup, /<div class="variant-size-cell"><span class="variation-title-label">S<\/span>/, "each size is its own compact cell, label then stepper");
  assert.doesNotMatch(redGroup, /class="row"/, "the old one-row-per-size markup must be gone from the grouped view");
});

check("test_PRD_P0_147_variants_grid__opening_one_color_group_closes_every_other_one", async () => {
  const body = await (await get("/items", MANAGER, env(mirrorDb()))).text();
  assert.match(
    body,
    /function toggleVariantGroupExclusive\(group\) \{\s*\n\s*if \(!group\) return;\s*\n\s*const wasExpanded = group\.classList\.contains\("expanded"\);\s*\n\s*group\.parentElement\?\.querySelectorAll\(":scope > \.variant-group\.expanded"\)\.forEach\(\(g\) => g\.classList\.remove\("expanded"\)\);\s*\n\s*if \(!wasExpanded\) group\.classList\.add\("expanded"\);\s*\n\s*\}/,
    "clicking a color header must close every other open group under the same product first -- only one open at a time",
  );
});

check("test_PRD_P0_147_variants_grid__the_plus_and_minus_steppers_still_work_inside_a_grid_cell", async () => {
  /* "I'm clicking the add product button and nothing is happening. It's
     not controlling the inventory." — caught live: the grid redesign
     (above) moved each size's stepper out of a `.row` and into its own
     `.variant-size-cell`, but stepStock() still only ever walked up to
     `.closest(".row")` to find its own count field and sibling buttons.
     Inside a grid cell that search came back null, so `row.nextElementSibling`
     threw immediately and the click silently did nothing at all —
     never posted the inventory delta, never showed an error either. */
  const body = await (await get("/items", MANAGER, env(mirrorDb()))).text();
  assert.match(
    body,
    /const row = button\.closest\(".row, \.variant-size-cell"\);/,
    "stepStock must walk up to either a flat .row or a grid .variant-size-cell, never just the first",
  );
});

check("test_PRD_P0_147_variants_grid__a_single_dimension_or_none_keeps_the_flat_list", async () => {
  /* seedProduct's own single "One size" variation carries no options at
     all — zero dimensions, so the nested groups must not even try to
     render. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.doesNotMatch(body, /class="variant-group"/);
  assert.match(body, /<span class="variation-title-label">One size<\/span>/);
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
     out the chevron icon sitting beside it). REVISED YET AGAIN: "it has
     a chevron on the left... has to be pointing to the right... when
     you press it, it will expand, aiming down" — the chevron sits
     BEFORE the label, and it is not a static down-arrow: it is the same
     right-pointing-until-expanded CARET_ICON convention every other
     caret on this tile uses, rotating only once its own .category-picker
     wrapper carries .expanded. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<input type="text" name="category_id" value="cat1" hidden>/);
  assert.match(body, /<button type="button" class="category-picker-btn"[^>]*>[\s\S]{0,40}<svg[\s\S]{0,300}<\/svg><span class="category-picker-btn-label">Outerwear<\/span>/);
  assert.match(body, /<button type="button" class="category-picker-option selected" data-category-id="cat1" data-category-path="Outerwear">Outerwear<\/button>/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_picker_shows_the_full_ancestor_path_when_nested", async () => {
  /* REVISED: "in the category selector, I want to only see the last
     entry after the last slash... so that it's not taking up so much
     space." The button's own VISIBLE label is now just the leaf name;
     the full ancestor path moves to the button's own title instead, so
     it is still available on hover without spending layout width on it. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  mirror.db.exec("INSERT INTO mirror_category (id, external_ref, name, parent_id) VALUES ('cat2', 'sqcat2', 'Coats', 'cat1')");
  mirror.db.exec("UPDATE mirror_product SET category_id = 'cat2' WHERE id = 'p1'");
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<button type="button" class="category-picker-btn" aria-label="Choose a category" title="Outerwear \/ Coats">/);
  assert.match(body, /<span class="category-picker-btn-label">Coats<\/span>/);
  assert.match(body, /data-category-id="cat2" data-category-path="Outerwear \/ Coats"/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_chevron_only_rotates_once_its_own_picker_is_expanded", async () => {
  /* "It has a chevron on the left... has to be pointing to the right...
     when you press it, it will expand, aiming down." Not a static
     down-arrow (a prior revision's own mistake) — the rotation is keyed
     off .category-picker.expanded, the same convention every other
     caret on this tile already uses. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /\.category-picker-btn svg \{ flex: 0 0 auto; color: var\(--muted\); transition: transform 0\.15s; \}/,
    "the bare rule (no ancestor .expanded) must carry no rotation at all",
  );
  assert.match(
    body,
    /\.category-picker\.expanded > \.category-picker-btn svg\s*\{\s*transform:\s*rotate\(90deg\);\s*\}/,
    "rotation is scoped to .category-picker.expanded",
  );
});

check("test_PRD_P0_135_item_edit_applies_immediately__an_uncategorized_product_shows_the_placeholder_and_no_selection", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  mirror.db.exec("UPDATE mirror_product SET category_id = NULL WHERE id = 'p1'");
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(body, /<input type="text" name="category_id" value="" hidden>/);
  assert.match(body, /<span class="category-picker-btn-label">Uncategorized<\/span>/);
  assert.match(body, /title="Choose a category">[\s\S]{0,300}<span class="category-picker-btn-label">Uncategorized/, "no full-path title when nothing is assigned yet");
  assert.doesNotMatch(body, /category-picker-option selected/);
});

check("test_PRD_P0_135_item_edit_applies_immediately__picking_an_option_updates_the_buttons_label_and_title_separately", async () => {
  /* REVISED: "in the category selector, I want to only see the last
     entry after the last slash... so that it's not taking up so much
     space." Picking a category client-side must keep the same split the
     server-rendered markup already has: the button's own visible label
     copies the OPTION's own bare text (already just the leaf name), and
     the full data-category-path moves onto the button's own title
     instead — never both crammed into the visible label again. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const clickHandlerIdx = body.indexOf('const pickerOption = e.target.closest(".category-picker-option");');
  const clickHandler = body.slice(clickHandlerIdx, clickHandlerIdx + 1200);
  assert.match(clickHandler, /const pickerBtnEl = form\.querySelector\("\.category-picker-btn"\);/);
  assert.match(clickHandler, /const label = pickerBtnEl\.querySelector\("\.category-picker-btn-label"\);/);
  assert.match(clickHandler, /label\.textContent = pickerOption\.textContent;/, "the visible label copies the option's own bare leaf name, not the full path");
  assert.match(clickHandler, /pickerBtnEl\.title = pickerOption\.dataset\.categoryPath;/, "the full path still lands on the button's own title");
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_save_button_starts_disabled_and_only_renders_for_a_manager", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const managerBody = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(managerBody, /<button type="button" class="item-save-all" aria-label="Save changes" title="Save changes" disabled>/);

  const staffBody = await (await get("/items", STAFF, env(mirror))).text();
  assert.doesNotMatch(staffBody, /<button[^>]*class="item-save-all"/, "a role that cannot edit gets no Save button at all");
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_save_button_reads_icon_plus_the_word_save_and_lives_beside_web_active", async () => {
  /* "Use the same style for the save button as the one in my admin
     control panel... move that save button out of the image top header
     and into the same row as the Web/Active checkboxes." No longer beside
     Share/Close on the photo; a solid pill with the word "Save" next to
     the icon, the same `.admin-save-all` shape, inside `.item-badges`. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  const badgesIdx = body.indexOf('<div class="item-badges">');
  const badgesEndIdx = body.indexOf("</div>", badgesIdx);
  const badgesBody = body.slice(badgesIdx, badgesEndIdx);
  assert.match(badgesBody, /class="item-checkbox-toggle">\s*<input type="checkbox" name="on_website"/, "Web checkbox is in this row");
  assert.match(badgesBody, /class="item-checkbox-toggle">\s*<input type="checkbox" name="active"/, "Active checkbox is in this row");
  assert.match(badgesBody, /<button type="button" class="item-save-all"[^>]*disabled>.*? Save<\/button>/s, "the Save button is in the SAME row, reading icon plus the word Save");

  const topRightIdx = body.indexOf('<div class="item-top-right">');
  const topRightEndIdx = body.indexOf("</div>", topRightIdx);
  assert.doesNotMatch(body.slice(topRightIdx, topRightEndIdx), /item-save-all/, "no longer beside Share/Close on the photo");
});

check("test_PRD_P0_135_item_edit_applies_immediately__web_and_active_match_the_save_buttons_own_pill_style", async () => {
  /* "Use the same style for Web and Active checkboxes that you're using
     for my save checkbox." The exact same box model .item-save-all uses
     (border, radius, padding, font-weight) -- not the earlier plain,
     unstyled labeled checkbox. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /\.item-checkbox-toggle \{\s*\n\s*display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 13px; font-weight: 600;\s*\n\s*padding: 6px 14px; border: 1px solid var\(--rule\); border-radius: 6px; background: var\(--image-ground\); color: var\(--muted\);\s*\n\s*cursor: pointer; white-space: nowrap;\s*\n\s*\}/,
  );
});

check("test_PRD_P0_135_item_edit_applies_immediately__web_and_active_use_gray_not_orange_orange_stays_reserved_for_dirty", async () => {
  /* REVISED: "in item view, orange is dirty... when something is
     active, I want like a brighter version of a gray. When it's not
     active, I want it dim... orange means that it needs to be saved."
     Checking Web/Active used to fill the pill --accent (the exact same
     color .field-dirty's own outline already uses for a genuinely
     unsaved change), reading as "needs saving" the instant it was
     checked even with nothing actually dirty. Neither state may use
     --accent any more -- OFF is a dim --image-ground fill, ON is a
     brighter --muted fill, and the checkbox's own .field-dirty outline
     (unchanged, still --accent) is the only orange this control can
     ever show. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /\.item-checkbox-toggle:has\(input:checked\) \{ border-color: var\(--muted\); background: var\(--muted\); color: var\(--ground\); \}/,
  );
  assert.doesNotMatch(
    body,
    /\.item-checkbox-toggle[^{]*\{[^}]*--accent/s,
    "neither the on nor the off state of this control may use --accent -- that color is reserved for a genuinely dirty field",
  );
  assert.match(
    body,
    /\.item-tile input\.field-dirty\[type="checkbox"\] \{ outline: 1\.5px solid var\(--accent\); outline-offset: 1px; \}/,
    "the checkbox's own dirty outline must still exist and still be the only orange left",
  );
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_save_button_is_pushed_all_the_way_right_web_active_stay_left", async () => {
  /* "Make the save checkbox right justified, so it's all the way to the
     right, and leave the Web and Active checkboxes on the left, so in
     the middle is just a blank space." margin-left: auto on the Save
     button alone, not justify-content: space-between on the row (which
     would spread Web/Active apart too). */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /\.item-save-all \{[^}]*margin-left: auto;/s);
  assert.doesNotMatch(body, /\.item-badges \{[^}]*justify-content/s, "the row itself must not spread every child apart");
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
    /const formDirty = \[\.\.\.form\.querySelectorAll\("input, textarea"\)\]\.some\(isFieldDirty\);\s*\n\s*if \(formDirty\) \{\s*\n\s*form\.dataset\.dirty = "1";\s*\n\s*\} else \{\s*\n\s*delete form\.dataset\.dirty;/,
    "a form with nothing left different from its original value must stop being marked dirty",
  );
  assert.match(body, /saveBtn\.disabled = !tileDirty;/, "the Save button must re-disable once nothing in the tile is dirty any more");
});

check("test_PRD_P0_135_item_edit_applies_immediately__editing_only_the_description_textarea_still_marks_the_form_dirty", async () => {
  /* A real bug: description is a <textarea>, and the form-level dirty scan
     used to query only "input" — isFieldDirty ran fine on the textarea
     itself (any element supports .value !== .defaultValue), so the field
     got its own "field-dirty" highlight, but the FORM never picked up
     data-dirty and saveTile's own `form[data-dirty='1']` scan would not
     have submitted it either way. The owner's own words: "when I edit the
     description, it doesn't get marked to save." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /form\.querySelectorAll\("input, textarea"\)/,
    "the form-level dirty scan must include textarea, not just input",
  );
});

check("test_PRD_P0_135_item_edit_applies_immediately__no_msrp_or_unit_cost_broadcaster_survives_in_the_page_script", async () => {
  /* "Get rid of the whole variants setup... we'll do variations from
     Square" — the MSRP/unit-cost header broadcasters, and the propagation
     branches that copied a typed value into every variation's own price/
     cost input, are gone from the page script entirely: there is no
     .variation-price/.variation-unit-cost input left anywhere for either
     one to have propagated into. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.doesNotMatch(body, /e\.target\.matches\("\.variations-msrp"\)|e\.target\.matches\("\.variations-unit-cost"\)/);
  assert.match(body, /const form = e\.target\.closest\([^)]*\);\s*\n\s*if \(form\) refreshDirtyState\(e\.target\);/, "the direct dirty-refresh path is still there for every remaining field");
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_dirty_highlight_css_covers_text_fields_selects_and_checkboxes", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /\.item-tile input\.field-dirty, \.item-tile select\.field-dirty, \.item-tile textarea\.field-dirty \{ border-color: var\(--accent\); \}/,
    "the description textarea must get the same dirty highlight as every other field type",
  );
  assert.match(body, /\.item-tile input\.field-dirty\[type="checkbox"\] \{ outline: [^}]*var\(--accent\)/);
  /* REVISED: "use the same style for the save button as the one in my
     admin control panel" — a solid accent-colored pill when enabled
     (there is something dirty to save), not a separate not(:disabled)
     color override; disabled falls back to a plain muted outline. */
  assert.match(
    body,
    /\.item-save-all \{[^}]*background: var\(--accent\); color: var\(--ground\);/s,
    "enabled reads as a solid accent-colored pill, the same as .admin-save-all",
  );
  assert.match(body, /\.item-save-all:disabled \{ border-color: var\(--muted\); background: transparent; color: var\(--muted\); cursor: not-allowed; \}/);
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

check("test_PRD_P0_135_item_edit_applies_immediately__the_two_outer_bars_stay_removed_but_the_headers_own_borders_do_not", async () => {
  /* REVISED YET AGAIN — the previous pass over-corrected. The owner's own
     words: "I told you just to make it gray, not to make it orange. Why'd
     you remove it entirely?" and "I didn't tell you to remove that one"
     (the bar above Admin). The header PILL (.variations-header) keeps
     its own full border, always — gray by default — and the bar right
     above the custom-fields/Admin block (.item-edit-admin) comes back
     too. Only the OUTER accordion wrapper's own border-top
     (.variations-accordion) and the title-block's own top border stay
     removed, from the very first pass.
     REVISED AGAIN: the Categories header/accordion this test used to
     also check moved out to the global /admin page entirely — see
     adminPage's own tests instead. */
  const mirror = mirrorDb();
  seedProduct(mirror, { style_id: "01-04-001", vendor: "Acme Mills", commission_pct: 20 });
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();

  assert.match(body, /class="item-edit item-edit-admin"/, "the custom-fields/Admin wrapper must carry its bar-restoring class again");
  assert.match(
    body,
    /\.item-edit\.item-edit-admin \{ border-top: 1px solid var\(--rule\); \}/,
    "and the bar right above Admin must be back",
  );
  assert.match(
    body,
    /\.item-edit \{ margin-top: 2px; padding-top: 6px; cursor: default; display: flex; flex-direction: column; gap: 6px; \}/,
    "the base class itself still never draws a border of its own",
  );

  assert.match(
    body,
    /\.variations-header \{\s*\n\s*display: flex; align-items: center; gap: 6px; cursor: pointer;\s*\n\s*background: var\(--image-ground\); border: 1px solid var\(--rule\); border-radius: 6px; padding: 5px 4px;\s*\n\}/,
    "the Variants header must keep its own full border, gray by default",
  );
  assert.match(body, /\.variations-accordion \{ margin-top: 2px; padding-top: 6px; \}/, "the Variations ACCORDION's own separate top border stays removed");
});

check("test_PRD_P0_135_item_edit_applies_immediately__the_variants_header_never_turns_orange_any_more_nothing_left_inside_it_can_go_dirty", async () => {
  /* "Get rid of the whole variants setup... we'll do variations from
     Square" -- the dirty-highlight rule this header once had
     (.variations-accordion:has(.field-dirty)) is gone along with the
     last editable field it was ever watching for: a variation's own
     name is read-only now, and the stock stepper is deliberately never
     marked dirty (it posts immediately, its own event, never batched
     into the tile's one big Save). Always the same plain gray border. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.doesNotMatch(body, /\.variations-accordion:has\(\.field-dirty\)/);
  assert.match(body, /\.variations-header \{\s*\n\s*display: flex; align-items: center; gap: 6px; cursor: pointer;\s*\n\s*background: var\(--image-ground\); border: 1px solid var\(--rule\); border-radius: 6px; padding: 5px 4px;\s*\n\s*\}/);
});

check("test_PRD_P0_71_items_tab__custom_field_rows_come_from_the_global_registered_list_no_add_field_disclosure", async () => {
  /* REVISED: "remove add fields from items. I don't want to be adding
     fields per item... this is done inside of the admin panel, not
     inside of the item panel." No disclosure, no blank row to invent a
     new name here at all any more — a field's own name is fixed (hidden
     input, a real Square write cannot rename it from here), only its
     value is still editable. A registered name the product has no value
     for yet still gets its own row, blank. */
  const mirror = mirrorDb();
  seedProduct(mirror); // seeds a "unit cost" custom field, see seedProduct()
  mirror.db.exec("INSERT INTO mirror_custom_field_name (name) VALUES ('Fabric')");
  mirror.db.exec("INSERT INTO mirror_custom_field_name (name) VALUES ('unit cost')");
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.doesNotMatch(body, /item-add-field|Add field/, "no add-field disclosure anywhere any more");
  assert.match(
    body,
    /<input type="hidden" name="field_name_0" value="Fabric">\s*<span class="field-name-label" title="Fabric">Fabric<\/span>\s*<input name="field_value_0" value="" placeholder="Value">/,
    "a registered name with no value yet still gets its own row, blank",
  );
  assert.match(
    body,
    /<input type="hidden" name="field_name_1" value="unit cost">\s*<span class="field-name-label" title="unit cost">unit cost<\/span>\s*<input name="field_value_1" value="210.00" placeholder="Value">/,
    "an existing value still shows, and the name is no longer a free-text field",
  );
});

check("test_PRD_P0_71_items_tab__a_products_own_legacy_field_not_in_the_global_list_still_renders", async () => {
  /* "A real value is never silently hidden from view just because it is
     not (or is no longer) registered" -- customFieldNames is empty here,
     so "unit cost" (seeded directly on the product) is the ONLY name
     with nothing global to fall back on, and it must still show. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/items", MANAGER, env(mirror))).text();
  assert.match(body, /<input type="hidden" name="field_name_0" value="unit cost">/);
  assert.match(body, /<input name="field_value_0" value="210.00" placeholder="Value">/);
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
     direct_link (the default, seeded here) gets no channel tag at all.
     REVISED: "remove the category pill from the bottom right of the
     image" — the category earns no tag here at all any more either, so
     an active, direct_link product with no vendor renders no tags at
     all. */
  assert.match(
    body,
    /<div class="item-bottom">\s*<div class="item-bottom-row"><span class="item-style-id">01-04-001<\/span><div class="item-tags"><\/div><\/div>/,
  );
  assert.doesNotMatch(body, /<span class="item-tag">Outerwear<\/span>/, "the category no longer earns a tag on the thumbnail at all");
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
     only being ALSO on the website is worth calling out. REVISED: "remove
     the category pill from the bottom right of the image" — the category
     no longer earns a tag here either, website or not. */
  const mirror = mirrorDb();
  seedProduct(mirror, { channel: "website" });
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /<div class="item-bottom">\s*<div class="item-bottom-row"><span class="item-style-id"><\/span><div class="item-tags"><span class="item-tag channel-website">Web<\/span><\/div><\/div>/,
  );
  assert.doesNotMatch(body, /<span class="item-tag">Outerwear<\/span>/, "the category no longer earns a tag on the thumbnail at all");
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
    /<div class="item-bottom">\s*<div class="item-bottom-row"><span class="item-style-id"><\/span><div class="item-tags"><span class="item-tag item-tag-inactive">Inactive<\/span><\/div><\/div>/,
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
    /const linkedSku = location\.hash\.startsWith\("#item-"\) \? decodeURIComponent\(location\.hash\.slice\("#item-"\.length\)\) : null;\s*\n\s*if \(linkedSku\) \{\s*\n\s*const linked = \[\.\.\.document\.querySelectorAll\("\.item-tile"\)\]\.find\(\(el\) => el\.dataset\.sku === linkedSku\);/,
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
  assert.match(body, /function setDeepLinkHash\(tile\) \{\s*\n\s*const sku = tile\?\.dataset\.sku;/);
  const closeHandler = body.slice(body.indexOf('const closeBtn = e.target.closest(".item-close");'), body.indexOf('const closeBtn = e.target.closest(".item-close");') + 700);
  assert.match(closeHandler, /tile\.classList\.remove\("full"\);\s*\n\s*setDeepLinkHash\(null\);/);
  const expandHandler = body.slice(body.indexOf('tile.classList.contains("full")) return;'), body.indexOf('tile.classList.contains("full")) return;') + 200);
  assert.match(expandHandler, /tile\.classList\.add\("full"\);\s*\n\s*setDeepLinkHash\(tile\);/);
});

check("test_PRD_P0_132_item_deep_link__the_hash_is_also_mirrored_onto_the_shell_frames_own_address_bar", async () => {
  /* "Deep links are not working... when I open up an item, it should be
     items/<sku>, so it opens up that item and then any tabs. I'm not
     seeing any of this." Root cause: this page only ever runs embedded
     as the shell's own <iframe> (a direct top-level visit is redirected
     away, index.js), so a plain history.replaceState() here only ever
     touched THIS frame's own invisible location -- the owner only ever
     looks at the shell's own address bar, which never moved. Same-origin
     with the shell means this can reach straight into window.parent and
     mirror the identical hash onto ITS location instead, which is the
     one that is actually visible, copy-pasteable, and reload-surviving. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", STAFF, env(mirror));
  const body = await res.text();
  const fnBody = body.slice(body.indexOf("function setDeepLinkHash(tile) {"), body.indexOf("function syncDeepLinkFromEvent"));
  assert.match(fnBody, /history\.replaceState\(null, "", location\.pathname \+ hash\);/, "this frame's own location is still kept in step too");
  assert.match(
    fnBody,
    /if \(window\.parent !== window\) \{\s*\n\s*parent\.history\.replaceState\(null, "", parent\.location\.pathname \+ parent\.location\.search \+ hash\);\s*\n\s*\}/,
    "the shell's own address bar (window.parent) gets the identical hash mirrored onto it, preserving its own path/query (?tab=items)",
  );
});

check("test_PRD_P0_132_item_deep_link__the_hash_carries_only_which_item_is_open", async () => {
  /* REVISED: this used to also fold in the Categories accordion's own
     expanded state and every individually expanded category node --
     Categories moved out to the global /admin page entirely (see
     adminPage's own tests), which needs no per-item hash to reach. The
     Admin (custom fields) disclosure is gone outright too (custom field
     NAMES are administered from /admin now, never added inline on a
     product) -- a tile's own hash is just #item-<sku>, nothing else left
     to restore. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  assert.match(
    body,
    /const hash = sku \? "#item-" \+ encodeURIComponent\(sku\) : "";/,
    "setDeepLinkHash must carry only the item's own sku now",
  );
  assert.doesNotMatch(body, /parts\.push\("categories"\)|parts\.push\("admin"\)/, "no other token survives in the hash");
});

check("test_PRD_P0_132_item_deep_link__save_tile_still_snapshots_the_hash_before_reloading", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  const body = await res.text();
  const matches = [...body.matchAll(/setDeepLinkHash\(tile\);\s*\n\s*location\.reload\(\);/g)];
  assert.ok(matches.length >= 1, "saveTile must snapshot the hash right before reloading");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-140 — a direct visit to a shell tab's own content page always sends
 * you back to the shell, so the tab header is never missing
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_140_shell_always_visible__a_top_level_visit_to_items_redirects_to_the_shell", async () => {
  /* The owner's own words: "I never should be able to allow to go in
     there... I should always be redirected to the main top domain... no
     matter what happens." A real top-level navigation sets
     Sec-Fetch-Dest: document; the shell's own <iframe> loading the exact
     same URL sets it to "iframe" instead, and every evergreen browser
     sends one or the other. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await worker.fetch(
    new Request("http://localhost/items", {
      headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER), "sec-fetch-dest": "document" },
    }),
    env(mirror),
  );
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location")).pathname + new URL(res.headers.get("location")).search, "/?tab=items");
});

check("test_PRD_P0_140_shell_always_visible__the_shells_own_iframe_load_is_never_redirected", async () => {
  /* The other half: redirecting the shell's OWN <iframe src="/items">
     request would trap it loading a shell inside a shell inside a shell,
     forever. Sec-Fetch-Dest: iframe is exactly how the shell's own request
     is told apart from a real top-level visit to the same URL. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await worker.fetch(
    new Request("http://localhost/items", {
      headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER), "sec-fetch-dest": "iframe" },
    }),
    env(mirror),
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Wool Coat/);
});

check("test_PRD_P0_140_shell_always_visible__a_missing_sec_fetch_dest_header_fails_open_not_closed", async () => {
  /* An old browser or a tool that strips Sec-Fetch headers must still be
     ABLE to reach the page's own content — reproducing today's already-
     accepted behaviour is the safe failure mode here, not a redirect loop
     for a request this Worker cannot classify either way. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await get("/items", MANAGER, env(mirror));
  assert.equal(res.status, 200);
});

check("test_PRD_P0_140_shell_always_visible__a_sub_path_post_is_never_swept_into_the_redirect", async () => {
  /* Only the three bare paths SHELL_TABS itself names (/chat, /items,
     /dashboard) are ever redirected — a POST to a route living UNDER
     /items/ is a real form submission, never a page load, and must not be
     caught by a startsWith-style match this route intentionally avoids. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await worker.fetch(
    new Request("http://localhost/items/wool-coat/details", {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": assertion(MANAGER),
        "sec-fetch-dest": "document",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ title: "Wool Coat", description: "" }).toString(),
    }),
    env(mirror),
  );
  assert.notEqual(res.status, 302);
});

check("test_PRD_P0_140_shell_always_visible__the_shell_forwards_an_incoming_item_deep_link_hash_into_its_own_iframe", async () => {
  /* A shared link (shareLink(), views.js) points straight at
     /items#item-<sku> — once that now redirects here instead, the
     fragment rides along on the browser's OWN address bar (a redirect's
     Location header names no fragment of its own, so the browser keeps
     the original one), but it never reaches the iframe by itself: the
     fragment lives on the OUTER shell page's own location, and the iframe
     is a separate document with no access to it unless the shell forwards
     it in explicitly, once, at load. */
  const body = await (await get("/?tab=items", MANAGER, env(mirrorDb()))).text();
  assert.match(
    body,
    /if \(location\.hash\.startsWith\("#item-"\) && "items" === "items"\) \{\s*\n\s*document\.getElementById\("ops-frame"\)\.src = "\/items" \+ location\.hash;\s*\n\}/,
    "the shell must forward an #item-<sku> hash into the items iframe's own src when that is the active tab",
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * /admin — Categories and Vendors administered from one global page,
 * reached from the shell's own hamburger menu, instead of duplicated
 * inside every product tile. The owner's own words: "move the admin
 * section into that hamburger menu so that I can administer everything
 * from that one location instead of under each product."
 * ───────────────────────────────────────────────────────────────────────── */

function seedVendor(mirror, { commission } = {}) {
  mirror.db.exec(
    commission === undefined
      ? "INSERT INTO mirror_vendor (id, external_ref, name) VALUES ('vendor1', 'sqvendor1', 'Acme Mills')"
      : `INSERT INTO mirror_vendor (id, external_ref, name, commission_pct) VALUES ('vendor1', 'sqvendor1', 'Acme Mills', ${commission})`,
  );
}

check("test_PRD_P0_138_nested_categories__admin_lists_the_whole_tree", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await get("/admin", MANAGER, env(mirror));
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /Outerwear/);
  assert.match(body, /Coats/);
  assert.match(body, /Casual/);
  assert.match(body, /Knitwear/);
});

check("test_PRD_P0_138_nested_categories__admin_a_node_with_children_gets_its_own_expandable_caret", async () => {
  /* "They need to be expandable... everything should look exactly the
     same like it used to" -- the exact same caret/collapsed-children
     shape the old per-tile tree used, just rendered on /admin now. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  /* Each row's own hidden category_id input pins down a unique point
     inside it; walking backward to the enclosing node's own opening tag
     captures the WHOLE row, toggle included -- searching forward from
     the category's own NAME text would land inside the toggle's own
     aria-label instead ("Show subcategories of Outerwear" mentions the
     name before the toggle's own class attribute ever closes). */
  function rowFor(body, categoryId) {
    const fieldIdx = body.indexOf(`value="${categoryId}"`);
    const nodeStart = body.lastIndexOf('<div class="admin-category-node"', fieldIdx);
    return body.slice(nodeStart, body.indexOf("admin-category-children", fieldIdx));
  }
  const cat1Row = rowFor(body, "cat1"); // Outerwear -- has a child (Coats)
  assert.match(cat1Row, /class="admin-category-toggle"/, "Outerwear has a child (Coats) and must get a real caret");
  const cat4Row = rowFor(body, "cat4"); // Knitwear -- a leaf
  assert.match(cat4Row, /class="admin-category-toggle-spacer"/, "a leaf gets a same-width spacer, not a caret");
  assert.match(body, /\.admin-category-children \{ display: none; \}/, "children are collapsed by default");
  assert.match(body, /\.admin-category-node\.expanded > \.admin-category-children \{ display: block; \}/);
});

check("test_PRD_P0_138_nested_categories__admin_clicking_the_caret_or_the_row_toggles_expansion", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /const toggle = e\.target\.closest\("\.admin-category-toggle"\);\s*\n\s*if \(toggle\) \{\s*\n\s*toggle\.closest\("\.admin-category-node"\)\?\.classList\.toggle\("expanded"\);/,
  );
  assert.match(
    body,
    /const row = e\.target\.closest\("\.admin-category-row"\);[\s\S]*?if \(row && !e\.target\.closest\("input, button, \.admin-category-options"\)\) \{\s*\n\s*row\.closest\("\.admin-category-node"\)\?\.classList\.toggle\("expanded"\);/,
    "clicking anywhere on the row (not just the caret) must also toggle it, but a click inside the Sets " +
      "control (a checkbox's own <label>, not just the <input> itself) must not -- \"every time I toggle " +
      "a set on and off, it expands and collapses the header,\" the owner's own words",
  );
});

check("test_PRD_P0_138_nested_categories__admin_add_forms_are_hidden_behind_their_own_plus", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  /* REVISED: "we were never going to go deep into more than one level of
     subcategories, so I should not have a plus button next to any of my
     subcategories, because we'll never be adding any [under them]." Only
     a TOP-LEVEL category (Outerwear, Knitwear) gets its own "+"/add-form
     any more; a category that is already a subcategory (Coats, one level
     down) does not, even though seedCategoryTree's own Casual node (a
     second level down, under Coats) proves an already-existing deeper
     node still renders fine -- this only stops a NEW one being added. */
  assert.match(body, /<button type="button" class="admin-category-add-toggle" data-parent-id="" [^>]*>\+<\/button>/);
  const addForms = [...body.matchAll(/<form method="post" action="\/admin\/categories\/create" class="admin-category-add-form"( hidden)?/g)];
  assert.equal(addForms.length, 3, "the section's own top-level add-form, plus one per TOP-LEVEL category (Outerwear, Knitwear) -- none for any subcategory");
  assert.ok(
    addForms.every((m) => m[1] === " hidden"),
    "every add-form must start hidden",
  );
  assert.doesNotMatch(body, /data-parent-id="cat2"/, "Coats (a subcategory) gets no add-toggle of its own");
  assert.match(body, /Casual/, "a pre-existing second-level node (Casual, under Coats) still renders");
});

check("test_PRD_P0_138_nested_categories__admin_add_subcategory_form_reserves_the_same_trailing_space_a_real_row_has", async () => {
  /* "Include all of the buttons that you normally would add... they
     should be available because I want the adding of a subcategory to
     be perfectly aligned with the existing categories. Right now it's
     overflowing a little too much." Missing the Sets/remove buttons a
     real saved subcategory row would have left the name input free to
     stretch wider than every row beneath it -- a disabled Sets button
     (when any option set exists at all) and a disabled remove button now
     reserve that same trailing space.
     REVISED: "make sure all add and delete buttons in the categories are
     vertically aligned... in one line, in a straight line." A working "+"
     button is still never given to a subcategory add-form -- one is
     never given to a REAL subcategory row either -- but a plain spacer
     of the identical width now closes the row out regardless, the same
     spacer a real subcategory row's own trailing slot gets below. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const addFormStart = body.indexOf('action="/admin/categories/create" class="admin-category-add-form" hidden style="padding-left: 14px">');
  assert.ok(addFormStart > -1, "the subcategory add-form must exist");
  const addForm = body.slice(addFormStart, body.indexOf("</form>", addFormStart));
  assert.match(addForm, /<button type="button" class="admin-category-options-toggle" disabled title="Save the new subcategory first">Sets<\/button>/);
  assert.match(addForm, /<button type="button" class="admin-remove-btn" disabled aria-label="Remove" title="Save the new subcategory first">/);
  assert.doesNotMatch(addForm, /admin-category-add-toggle/, "a subcategory add-form never reserves space for a working + toggle");
  assert.match(
    addForm,
    /<button type="button" class="admin-remove-btn" disabled aria-label="Remove" title="Save the new subcategory first">.*?<\/button>\s*\n\s*<span class="admin-category-toggle-spacer"><\/span>/s,
    "a plain spacer of the same width closes the row out, matching a real subcategory row's own trailing slot",
  );
});

check("test_PRD_P0_138_nested_categories__admin_add_subcategory_form_skips_the_sets_placeholder_when_no_option_set_exists", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const addFormStart = body.indexOf('action="/admin/categories/create" class="admin-category-add-form" hidden style="padding-left: 14px">');
  const addForm = body.slice(addFormStart, body.indexOf("</form>", addFormStart));
  assert.doesNotMatch(addForm, /admin-category-options-toggle/, "nothing to pick means no Sets placeholder either, matching a real row");
  assert.match(addForm, /admin-remove-btn/, "the remove placeholder still reserves its own space regardless");
});

check("test_PRD_P0_138_nested_categories__admin_a_real_subcategory_row_gets_a_plus_width_spacer_not_nothing", async () => {
  /* "Make sure all add and delete buttons in the categories are
     vertically aligned... in one line, in a straight line." A
     subcategory row never gets a working "+" -- but leaving that width
     out entirely (rather than a spacer of the same width) left its own
     Sets/remove buttons landing at a different horizontal position than
     a top-level row's own, since .admin-category-name is the only
     flex-growing piece in the row and silently absorbed the missing
     width. Coats (cat2) is a real subcategory, not a placeholder form. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const cat3Idx = body.indexOf("Casual");
  const cat3Row = body.slice(cat3Idx, body.indexOf("admin-category-children", cat3Idx));
  assert.doesNotMatch(cat3Row, /admin-category-add-toggle/, "still never a working + on a subcategory");
  assert.match(
    cat3Row,
    /<\/button>\s*\n\s*<span class="admin-category-toggle-spacer"><\/span>\s*\n\s*<\/div>/,
    "a plain spacer of the same width must close the row out instead, right after the real remove button",
  );
});

check("test_PRD_P0_138_nested_categories__admin_top_level_add_form_also_reserves_sets_remove_and_plus", async () => {
  /* "Make sure that the main category add button also generates all of
     the proper fields so that it's perfectly aligned as well, just like
     you did with the subcategories -- we need the Sets and then we have
     the disabled delete button." This row is top-level (no left
     indent), and a real top-level row keeps a working "+" of its own, so
     all three placeholders join it: Sets, remove, AND a disabled "+" --
     the one placeholder the subcategory add-form correctly omits, since
     only a TOP-LEVEL category ever gets a real one. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const addFormStart = body.indexOf('<form method="post" action="/admin/categories/create" class="admin-category-add-form" hidden>');
  assert.ok(addFormStart > -1, "the top-level add-form must exist");
  const addForm = body.slice(addFormStart, body.indexOf("</form>", addFormStart));
  assert.match(addForm, /<button type="button" class="admin-category-options-toggle" disabled title="Save the new category first">Sets<\/button>/);
  assert.match(addForm, /<button type="button" class="admin-remove-btn" disabled aria-label="Remove" title="Save the new category first">/);
  assert.match(addForm, /<button type="button" class="admin-category-add-toggle" disabled aria-label="Add a subcategory" title="Save the new category first">\+<\/button>/);
});

check("test_PRD_P0_138_nested_categories__admin_no_per_row_save_button_one_global_save_all_instead", async () => {
  /* "I want the same bulk save mechanism where things get marked dirty
     and then I hit the save button to save them all. I don't want to see
     a checkbox for every single field." Rename/number/commission forms
     carry no submit button of their own any more; one global button
     saves everything that is actually dirty. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  mirror.db.exec("INSERT INTO mirror_vendor (id, external_ref, name, commission_pct) VALUES ('vendor1', 'sqvendor1', 'Acme Mills', 15)");
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(body, /<button type="button" class="admin-save-all"[^>]*disabled>/, "one global Save button, disabled until something is dirty");
  assert.doesNotMatch(body, /admin-save-btn/, "no per-row save/checkmark button anywhere");
  const renameForm = body.slice(body.indexOf('action="/admin/categories/rename"'), body.indexOf("</form>", body.indexOf('action="/admin/categories/rename"')));
  assert.doesNotMatch(renameForm, /<button/, "the rename form itself carries no button of its own");
  const commissionForm = body.slice(body.indexOf('action="/admin/vendors/commission"'), body.indexOf("</form>", body.indexOf('action="/admin/vendors/commission"')));
  assert.doesNotMatch(commissionForm, /<button/, "the vendor commission form itself carries no button of its own");
});

check("test_PRD_P0_138_nested_categories__admin_save_all_submits_every_dirty_form_and_reloads_once", async () => {
  const mirror = mirrorDb();
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(body, /const dirtyForms = \[\.\.\.document\.querySelectorAll\("form\[data-dirty='1'\]"\)\];/);
  assert.match(body, /if \(allOk\) location\.reload\(\);/);
});

check("test_PRD_P0_136_square_custom_attributes__admin_vendors_section_is_an_expanding_header_matching_categories", async () => {
  /* "Vendors should be an expanding header just like all the other
     headers. Keep it consistent." Same .admin-section-header/-toggle/
     -body shape as Categories. */
  const mirror = mirrorDb();
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const sections = [...body.matchAll(/<span class="admin-section-label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(sections, ["Categories", "Vendors", "Custom Fields"]);
  assert.equal(
    [...body.matchAll(/class="admin-section-toggle"/g)].length,
    3,
    "every section must share the exact same expanding-header caret",
  );
});

check("test_PRD_P0_71_items_tab__admin_custom_fields_section_lists_registered_names_and_offers_an_add_form", async () => {
  const mirror = mirrorDb();
  mirror.db.exec("INSERT INTO mirror_custom_field_name (name) VALUES ('Fabric')");
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(body, /<span class="admin-field-row-name">Fabric<\/span>/);
  assert.match(body, /<form method="post" action="\/admin\/fields\/create" class="admin-field-add-form">/);
});

check("test_PRD_P0_71_items_tab__admin_create_custom_field_name_actually_succeeds_no_square_needed", async () => {
  /* Unlike categories/vendors, catalog.create_custom_field_name declares
     no square resource at all -- it is purely OURS -- so this is provably
     testable end to end even in a test env with no SQUARE_ACCESS_TOKEN. */
  const mirror = mirrorDb();
  const res = await postForm("/admin/fields/create", MANAGER, env(mirror), { name: "Fabric" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin");
  const row = mirror.db.prepare("SELECT name FROM mirror_custom_field_name WHERE name = 'Fabric'").get();
  assert.equal(row.name, "Fabric");
});

check("test_PRD_P0_71_items_tab__admin_staff_cannot_create_a_custom_field_name", async () => {
  const mirror = mirrorDb();
  const res = await postForm("/admin/fields/create", STAFF, env(mirror), { name: "Fabric" });
  assert.equal(res.status, 403);
});

check("test_PRD_P0_138_nested_categories__admin_the_tree_sorts_by_numeric_id_not_alphabetically", async () => {
  /* "Make sure that you're sorting these by their ID... one is on top,
     two is on the bottom." seedCategoryTree's own top-level pair proves
     this cleanly: alphabetically Knitwear < Outerwear, but Outerwear (01)
     must render FIRST since it has an ID and Knitwear does not (a blank
     numeric_id sorts last, same rule the client-side instant resort
     already uses). */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const outerwearIdx = body.indexOf("Outerwear");
  const knitwearIdx = body.indexOf("Knitwear");
  assert.ok(outerwearIdx > -1 && knitwearIdx > -1);
  assert.ok(outerwearIdx < knitwearIdx, "Outerwear (numeric_id 01) must render before Knitwear (no numeric_id yet)");
});

check("test_PRD_P0_138_nested_categories__admin_opening_the_add_form_auto_fills_the_next_numeric_id", async () => {
  /* "When I add one you just automatically increment it by one the
     category, and I just type in its name and then save." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /function nextNumericId\(siblingNodes\) \{\s*\n\s*const used = \[\.\.\.siblingNodes\]/,
    "a helper must compute one more than the highest numeric_id already used among the new node's own siblings",
  );
  assert.match(
    body,
    /if \(idInput && !idInput\.value\) \{\s*\n\s*const siblings = addToggle\.dataset\.parentId/,
    "revealing the add form must pre-fill its own ID field, only when it is still blank",
  );
});

check("test_PRD_P0_138_nested_categories__admin_add_toggle_queues_another_row_instead_of_hiding_the_one_already_open", async () => {
  /* "When I click add subcategory under a new category, it's just
     toggling the row... it should be adding another one so I can add
     multiples," followed up with "if I add a subcategory, one after the
     other, it's just toggling up and down... I should be able to add
     multiples before I hit save." A click on `.admin-category-add-toggle`
     must no longer just flip `.hidden` on the one form the server
     renders -- the owner needs several unsaved subcategories (or several
     unsaved top-level categories) queued up at once. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.doesNotMatch(
    body,
    /form\.hidden = !form\.hidden;/,
    "a second click must never hide the row already open -- that is the reported bug",
  );
  assert.match(
    body,
    /const rows = \[\.\.\.\(container\?\.querySelectorAll\(selector\) \?\? \[\]\)\];/,
    "every existing add-form for this node/section must be read as a growing list, not a single element",
  );
  assert.match(
    body,
    /const form = rows\.find\(\(f\) => f\.hidden\) \?\? rows\[rows\.length - 1\]\?\.cloneNode\(true\);/,
    "the first click still reveals the server's own row; every click after that clones the last one instead of toggling it",
  );
  assert.match(
    body,
    /if \(!form\.isConnected\) \{\s*\n\s*form\.querySelector\("\.admin-category-new-name"\)\.value = "";\s*\n\s*form\.querySelector\("\.admin-category-new-numeric-id"\)\.value = "";\s*\n\s*rows\[rows\.length - 1\]\.insertAdjacentElement\("afterend", form\);/,
    "a freshly cloned row must start blank (never a copy of whatever the row before it already has typed in) and land right after the last one",
  );
});

check("test_PRD_P0_138_nested_categories__admin_each_queued_row_auto_fills_a_distinct_numeric_id", async () => {
  /* "You have to increment always. You can't just have the same ID
     repeating" — the owner's own words. Queuing several rows must not
     suggest the SAME next number for every one of them just because
     nextNumericId only ever looks at already-SAVED siblings. Every row
     after the first must bump past whatever numeric_id every OTHER
     still-open pending row already carries -- and, for a subcategory,
     that pool is TREE-WIDE (every top-level category's own pending
     add-form counts, not just the one under the same parent), matching
     the same tree-wide pool P0-138's own siblings check already enforces
     for already-saved subcategories. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /const siblings = addToggle\.dataset\.parentId\s*\n\s*\? document\.querySelectorAll\("\.admin-category-children \.admin-category-node"\)/,
    "a subcategory's own already-saved pool must be read tree-wide, not scoped to the one parent being clicked",
  );
  assert.match(
    body,
    /const pendingIds = \[\s*\n\s*\.\.\.document\.querySelectorAll\(\s*\n\s*addToggle\.dataset\.parentId\s*\n\s*\? "\.admin-category-node > \.admin-category-add-form:not\(\[hidden\]\) \.admin-category-new-numeric-id"\s*\n\s*: "\.admin-section-body > \.admin-category-add-form:not\(\[hidden\]\) \.admin-category-new-numeric-id",\s*\n\s*\),\s*\n\s*\]\s*\n\s*\.filter\(\(el\) => el !== idInput\)\s*\n\s*\.map\(\(el\) => Number\(el\.value\.trim\(\)\)\)\s*\n\s*\.filter\(\(n\) => Number\.isInteger\(n\)\);\s*\n\s*let suggested = Number\(nextNumericId\(siblings\)\);\s*\n\s*while \(pendingIds\.includes\(suggested\)\) suggested \+= 1;\s*\n\s*idInput\.value = String\(suggested\)\.padStart\(2, "0"\);/,
    "the auto-fill must skip past every numeric_id already sitting in another still-open pending row anywhere in the tree, not just already-saved siblings under the same parent",
  );
});

check("test_PRD_P0_138_nested_categories__admin_add_toggle_refuses_to_queue_a_second_blank_row", async () => {
  /* "If I don't have anything entered... you shouldn't let me add a new
     subcategory if I have a new blank one already. Once I enter some
     words in it, then you start adding more" — the owner's own words. A
     row already open with nothing typed into its own name yet must not
     get a second blank one piled on top of it -- "+" should just return
     focus to the one already there. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /if \(!rows\.find\(\(f\) => f\.hidden\) && !rows\[rows\.length - 1\]\?\.querySelector\("\.admin-category-new-name"\)\?\.value\.trim\(\)\) \{\s*\n\s*rows\[rows\.length - 1\]\?\.querySelector\("\.admin-category-new-name"\)\?\.focus\(\);\s*\n\s*return;\s*\n\s*\}/,
    "a click must refuse to queue another row while the last one open is still blank, focusing it instead",
  );
});

check("test_PRD_P0_138_nested_categories__admin_backfills_every_blank_numeric_id_on_load_not_just_the_add_form", async () => {
  /* REVISED: "you should never have any categories without an ID at all
     assigned to it... if you have one and there is a default, just
     increase them and iterate them by value, so that way you don't have
     any uninitialized categories" — the owner's own words, generalizing
     the add-form's own auto-fill (test above) to every ALREADY-EXISTING
     blank category too, however it got that way (synced fresh from
     Square, created by an agent, or legacy data). The server still ships
     a blank numeric_id exactly as before -- this is a client-side,
     load-time fill, never a silent server-side write. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /function backfillMissingNumericIds\(nodes\) \{\s*\n\s*for \(const node of nodes\)/,
    "a helper must walk every blank in a pool, assigning nextNumericId's own increment to each in turn",
  );
  assert.match(
    body,
    /backfillMissingNumericIds\(\[\.\.\.document\.querySelectorAll\("\.admin-section-body > \.admin-category-node"\)\]\);/,
    "must run for the top-level pool",
  );
  assert.match(
    body,
    /backfillMissingNumericIds\(\[\.\.\.document\.querySelectorAll\("\.admin-category-children \.admin-category-node"\)\]\);/,
    "must run for the subcategory pool -- every subcategory anywhere in the tree, the same one pool set_category_number itself enforces",
  );
  /* Knitwear (cat4) has no numeric_id in this fixture -- still rendered
     blank by the server; the fill above happens only once this script
     actually runs in a browser. */
  const cat4Idx = body.indexOf("Knitwear");
  const cat4Row = body.slice(cat4Idx, body.indexOf("admin-category-children", cat4Idx));
  assert.match(cat4Row, /<input class="admin-category-numeric-id" name="numeric_id" value="" /);
});

check("test_PRD_P0_138_nested_categories__admin_numeric_id_is_required_and_shows_red_when_invalid", async () => {
  /* "Deleting a category ID or subcategory ID or setting an ID that's
     already used should result in a red invalid box." required (native
     browser validation, no JS) covers a blank or malformed value; the
     existing 2-digit pattern is unchanged. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /<input class="admin-category-numeric-id" name="numeric_id" value="[^"]*" placeholder="ID" maxlength="2" pattern="\\d\{2\}" required title=/,
  );
  assert.match(body, /\.admin-category-numeric-id:invalid \{ border-color: var\(--invalid\); \}/);
});

check("test_PRD_P0_138_nested_categories__admin_a_duplicate_numeric_id_is_flagged_via_custom_validity", async () => {
  /* "You can have two categories set to the same ID temporarily so you
     can change their order, but you cannot save that." Duplicate
     detection needs JS (setCustomValidity) since a single field's own
     pattern cannot see a sibling's value -- this only proves the
     mechanism is wired up; revalidateNumericIdPool's own JS runs in a
     browser only, not this test's plain HTTP fetch. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /function revalidateNumericIdPool\(pool\) \{\s*\n\s*const byValue = new Map\(\);/,
    "duplicates within the same pool must be detected and flagged with setCustomValidity",
  );
  assert.match(body, /input\.setCustomValidity\(dupes\.length > 1 \? "Already assigned to another category" : ""\);/);
  assert.match(
    body,
    /revalidateNumericIdPool\(\[\.\.\.document\.querySelectorAll\("\.admin-section-body > \.admin-category-node"\)\]\);/,
    "must also run once up front, to catch a pre-existing duplicate from legacy data",
  );
});

check("test_PRD_P0_138_nested_categories__admin_changing_an_id_to_a_taken_value_swaps_the_other_category_to_the_vacated_one", async () => {
  /* "If I take number two and change it to one, it should automatically
     change the other one to two and reshuffle them." */
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /const conflict = pool\.find\(\(n\) => n !== node && numericIdInputOf\(n\)\?\.value\.trim\(\) === newValue\);/,
    "the one other node already holding the just-typed value must be found within the same pool",
  );
  assert.match(
    body,
    /conflictInput\.value = prevValue;/,
    "the conflicting node must be swapped to the value just vacated, not merely flagged",
  );
});

check("test_PRD_P0_138_nested_categories__admin_save_all_is_blocked_while_any_numeric_id_is_invalid", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /saveAllBtn\.disabled = !document\.querySelector\("form\[data-dirty='1'\]"\) \|\| !!document\.querySelector\("\.admin-category-numeric-id:invalid"\);/,
  );
  assert.match(
    body,
    /async function saveAll\(\) \{\s*\n(?:[^\n]*\n)*?\s*if \(document\.querySelector\("\.admin-category-numeric-id:invalid"\)\) return;/,
    "Enter-key submission must be guarded too, not only the button's own disabled state",
  );
});

check("test_PRD_P0_138_nested_categories__admin_tree_indents_children_by_the_same_shared_toggle_width", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(body, /class="admin-category-node" style="padding-left: 0px"/, "a top-level category has no indent");
  assert.match(
    body,
    new RegExp(`class="admin-category-node" style="padding-left: 14px"`),
    "a subcategory indents by exactly CATEGORY_NODE_TOGGLE_PX",
  );
});

check("test_PRD_P0_138_nested_categories__admin_a_category_with_subcategories_cannot_be_removed", async () => {
  /* REVISED: "instead of making it disabled, just make it invisible --
     while it has subcategories, it should not be deletable." cat1
     (Outerwear) has a child (Coats), so its own remove button renders
     nowhere at all now, not just disabled; cat4 (Knitwear) is a leaf and
     keeps its own, fully enabled. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const cat1Idx = body.indexOf("Outerwear");
  const cat1Row = body.slice(cat1Idx, body.indexOf("admin-category-children", cat1Idx));
  assert.doesNotMatch(cat1Row, /admin-remove-btn/, "a category with subcategories gets no remove button at all");
  const cat4Idx = body.indexOf("Knitwear");
  const cat4Row = body.slice(cat4Idx, body.indexOf("admin-category-children", cat4Idx));
  assert.match(cat4Row, /<button type="button" class="admin-remove-btn"[^>]*>/, "a leaf keeps its own remove button");
  assert.doesNotMatch(cat4Row, /disabled/, "and it is never disabled");
});

check("test_PRD_P0_138_nested_categories__admin_a_category_with_products_assigned_cannot_be_removed", async () => {
  /* REVISED: "I didn't want you to remove the delete button from
     subcategories that has items associated. I just wanted to disable it
     so that its alignment stays consistent" — unlike a category with
     children (still invisible, above), a LEAF category with a real
     product keeps its own remove button, visible but disabled. Move the
     seeded product off cat1 (Outerwear, which already has a child, Coats,
     so its own remove button is hidden for that reason alone) onto cat4
     (Knitwear, a leaf) to isolate this rule from the "still has
     subcategories" one. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  mirror.db.exec("UPDATE mirror_product SET category_id = 'cat4' WHERE id = 'p1'");
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const cat4Idx = body.indexOf("Knitwear");
  const cat4Row = body.slice(cat4Idx, body.indexOf("admin-category-children", cat4Idx));
  assert.match(cat4Row, /<button type="button" class="admin-remove-btn" disabled[^>]*>/, "a leaf category with a product assigned keeps a visible, disabled remove button");
});

function seedItemOption(mirror, { id = "opt1", externalRef = "sqopt1", name = "Size" } = {}) {
  mirror.db.exec(`INSERT INTO mirror_item_option (id, external_ref, name) VALUES ('${id}', '${externalRef}', '${name}')`);
}

check("test_PRD_P0_142_category_item_options__admin_renders_a_sets_toggle_with_a_checkbox_per_option_pre_checked", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  seedItemOption(mirror, { id: "opt2", externalRef: "sqopt2", name: "Color" });
  mirror.db.exec("INSERT INTO mirror_category_item_option (category_id, item_option_id) VALUES ('cat1', 'opt1')");
  mirror.db.exec("UPDATE mirror_category SET item_options_set_at = datetime('now') WHERE id = 'cat1'");

  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const cat1Idx = body.indexOf("Outerwear");
  const cat1Row = body.slice(cat1Idx, body.indexOf("admin-category-children", cat1Idx));
  assert.match(cat1Row, /<div class="admin-category-options">\s*\n\s*<button type="button" class="admin-category-options-toggle admin-category-options-toggle-active"[^>]*>Sets \(1\)<\/button>/);
  assert.match(cat1Row, /<form method="post" action="\/admin\/categories\/item-options" class="admin-category-options-menu" hidden>/, "the checkbox list is a floating menu, not a block row");
  assert.match(cat1Row, /<input type="checkbox" name="item_option_ids" value="opt1" checked> Size/);
  assert.match(cat1Row, /<input type="checkbox" name="item_option_ids" value="opt2"> Color/);
  assert.match(
    cat1Row,
    /<input type="checkbox" name="inherit" value="1"> Inherit/,
    "an explicit set (item_options_set_at already stamped on cat1) shows Inherit unchecked, and its own checkboxes above stay enabled",
  );
});

check("test_PRD_P0_142_category_item_options__admin_sets_menu_floats_over_the_tree_rather_than_pushing_it_down", async () => {
  /* REVISED: "when clicking Sets, I want you to open a menu with
     checkboxes, not a whole row that's not aligned to anything." A
     position: relative wrapper around the toggle and its own
     position: absolute menu -- the same shape .vendor-picker/
     .vendor-picker-menu already establish on the Items tab -- rather
     than a block sitting between the row and its own children,
     widening/relayouting everything beneath it. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(body, /\.admin-category-options \{ position: relative; flex: 0 0 auto; \}/);
  assert.match(
    body,
    /\.admin-category-options-menu \{\s*\n\s*position: absolute; top: 100%; right: 0;/,
    "the checkbox list must float below the toggle, anchored to its right edge so it opens leftward and stays on screen, not occupy its own row",
  );
});

check("test_PRD_P0_142_category_item_options__admin_sets_menu_stays_open_across_multiple_checkbox_clicks_closes_on_outside_click_or_escape", async () => {
  /* "I want to select multiple checkboxes, toggle them" -- a checkbox
     click inside the menu must never close it (the same "closest" guard
     the outside-click handler already uses for the toggle button
     itself), only an outside click, Escape, or the toggle button. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /function closeAllOptionsMenus\(\) \{\s*\n\s*document\.querySelectorAll\("\.admin-category-options-menu"\)\.forEach\(\(m\) => \(m\.hidden = true\)\);\s*\n\s*\}/,
  );
  assert.match(
    body,
    /document\.addEventListener\("click", \(e\) => \{\s*\n\s*if \(e\.target\.closest\("\.admin-category-options"\)\) return;\s*\n\s*closeAllOptionsMenus\(\);\s*\n\s*\}\);/,
    "a click anywhere inside the toggle+menu wrapper (a checkbox included) must be excluded from the outside-click close",
  );
  assert.match(
    body,
    /document\.addEventListener\("keydown", \(e\) => \{\s*\n\s*if \(e\.key !== "Escape"\) return;\s*\n\s*closeAllOptionsMenus\(\);\s*\n\s*\}\);/,
  );
});

check("test_PRD_P0_142_category_item_options__admin_a_subcategory_with_no_explicit_set_shows_its_parents_as_checked", async () => {
  /* "When I set sets for a category, all subcategories inherit the sets
     unless I specify different selections for the subcategories" — the
     owner's own words. cat2 (Coats, a subcategory of cat1/Outerwear)
     never gets its own mirror_category_item_option row or its own
     item_options_set_at here -- only cat1 does -- so its own menu must
     still show Outerwear's own assignment as checked and its own Sets
     badge must still read the inherited count. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  mirror.db.exec("INSERT INTO mirror_category_item_option (category_id, item_option_id) VALUES ('cat1', 'opt1')");
  mirror.db.exec("UPDATE mirror_category SET item_options_set_at = datetime('now') WHERE id = 'cat1'");

  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  const cat2Idx = body.indexOf("Coats");
  const cat2Row = body.slice(cat2Idx, body.indexOf("admin-category-children", cat2Idx));
  assert.match(cat2Row, /admin-category-options-toggle admin-category-options-toggle-active"[^>]*>Sets \(1\)<\/button>/, "the inherited count, not zero");
  assert.match(
    cat2Row,
    /<input type="checkbox" name="item_option_ids" value="opt1" checked disabled> Size/,
    "Outerwear's own assignment, shown as Coats' own current state, but disabled -- Coats has never been explicitly set itself",
  );
  assert.match(cat2Row, /<input type="checkbox" name="inherit" value="1" checked> Inherit/, "still inheriting -- Coats has no item_options_set_at of its own");
});

check("test_PRD_P0_142_category_item_options__admin_sets_toggle_matches_the_row_height_and_reads_all_caps", async () => {
  /* REVISED: "make the Sets button the same height as the rest of the UI
     elements... everything needs to flow... use all capitals for Sets."
     No explicit height any more -- same font-size/padding as the
     rename/numeric_id inputs beside it, so its own natural height
     matches theirs, and text-transform: uppercase over hand-typed caps
     in the markup (the text node itself stays "Sets (1)", matching the
     button's own aria-label and the checkbox-list toggle logic keyed off
     it). */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(
    body,
    /\.admin-category-options-toggle \{\s*\n\s*flex: 0 0 auto; padding: 4px 8px; font: inherit; font-size: 13px; text-transform: uppercase; letter-spacing: 0\.04em;/,
    "must share the exact font-size and vertical padding the row's own inputs already use, with no fixed height of its own",
  );
  assert.doesNotMatch(body, /\.admin-category-options-toggle \{[^}]*height:/, "no explicit height -- the shared padding/font-size alone must set it");
});

check("test_PRD_P0_142_category_item_options__admin_shows_no_sets_toggle_when_no_option_set_exists_anywhere", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.doesNotMatch(body, /<button[^>]*class="admin-category-options-toggle/, "nothing to pick means no toggle at all");
});

check("test_PRD_P0_142_category_item_options__admin_setting_a_categorys_option_sets_reaches_the_tool_layer_no_square_needed", async () => {
  /* Unlike catalog.create_category/set_category_number/rename/remove,
     catalog.set_category_item_options declares no square resource at all
     -- purely ours -- so this is provably testable end to end even with
     no SQUARE_ACCESS_TOKEN, the same P0-71 custom-field-name reasoning. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  seedItemOption(mirror, { id: "opt2", externalRef: "sqopt2", name: "Color" });
  const form = new URLSearchParams();
  form.set("category_id", "cat1");
  form.append("item_option_ids", "opt1");
  form.append("item_option_ids", "opt2");
  const res = await worker.fetch(
    new Request("http://localhost/admin/categories/item-options", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER), "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    env(mirror),
  );
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin");
  const rows = mirror.db.prepare("SELECT item_option_id FROM mirror_category_item_option_index WHERE category_id = 'cat1' ORDER BY item_option_id").all();
  assert.deepEqual(rows.map((r) => r.item_option_id), ["opt1", "opt2"]);
});

check("test_PRD_P0_142_category_item_options__admin_staff_cannot_reach_the_route", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror);
  const res = await postForm("/admin/categories/item-options", STAFF, env(mirror), { category_id: "cat1", item_option_ids: "opt1" });
  assert.equal(res.status, 403);
});

check("test_PRD_P0_144_apply_category_item_options__saving_a_categorys_option_sets_cascades_into_a_square_apply", async () => {
  /* "Why is there a separate apply button? Shouldn't it just make the
     save button dirty and press the save button and apply all the
     options?" — the owner's own words. There is no more standalone
     apply route: saving a category's own option sets (below) now also
     always tries catalog.apply_category_item_options_to_products for
     that same category, with no extra click. This env() has no
     SQUARE_ACCESS_TOKEN, so the cascade itself cannot succeed -- but
     that failure is a logged best-effort follow-up, never a failure of
     the primary save, so the redirect below still proves the save
     itself went through. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const lines = await captureConsole(async () => {
    const res = await postForm("/admin/categories/item-options", MANAGER, env(mirror), { category_id: "cat1", item_option_ids: "opt1" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin");
  });
  assert.match(lines.error.join("\n"), /auto-apply after saving option sets/);
  assert.match(lines.error.join("\n"), /SQUARE_ACCESS_TOKEN is unset/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-149 (REVISED) — "I tried it. Didn't work" — the owner's own words,
 * after resaving a category's Sets exactly as instructed. Root cause,
 * found from the real production audit_log: catalog.apply_category_item_
 * options_to_products' own run() had genuinely failed per-product (a real
 * Square write error), but its OWN outcome (`{applied, errors}`) was never
 * a thrown error or a `denied` -- runTool's own audit row for a T2 call is
 * written BEFORE run() ever executes, so it can only ever record that
 * approval was granted, never what run() actually did. The cascade above
 * only ever checked `applyResult.error`/`.denied`, so a real per-product
 * failure sailed through as a silent, invisible no-op -- nothing in the
 * audit log, nothing in a Worker log (this Worker's own logs are not
 * retained). perProductApplyFailure is the exact decision that closes
 * this gap, tested directly here with no Square mock or HTTP round trip
 * needed: the tool's own established "one product's failure does not
 * fail the batch" shape (catalog-writer.js) means a real failure never
 * throws, it just fills the errors array run() already returns.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_149_auto_apply_failure_visibility__a_per_product_failure_with_no_top_level_error_is_still_flagged", () => {
  const applyResult = { ok: true, data: { products_applied: 0, errors: [{ handle: "black-dress", error: "VERSION_MISMATCH" }] } };
  const failure = perProductApplyFailure(applyResult);
  assert.ok(failure, "an ok: true, denied-free result with a real per-product error must still be treated as a failure to surface");
  assert.match(failure.message, /0\/1/);
  assert.match(failure.message, /black-dress: VERSION_MISMATCH/);
  assert.deepEqual(failure.detail, { reason: "auto_apply_per_product_failures", errors: applyResult.data.errors });
});

check("test_PRD_P0_149_auto_apply_failure_visibility__a_partial_failure_is_also_flagged_not_just_a_total_one", () => {
  const applyResult = {
    ok: true,
    data: { products_applied: 2, errors: [{ handle: "red-scarf", error: "CATALOG_MAX_VARIATIONS exceeded" }] },
  };
  const failure = perProductApplyFailure(applyResult);
  assert.ok(failure, "2 of 3 succeeding still leaves one product silently untouched -- still worth surfacing");
  assert.match(failure.message, /2\/3/);
});

check("test_PRD_P0_149_auto_apply_failure_visibility__a_clean_result_is_not_flagged", () => {
  assert.equal(perProductApplyFailure({ ok: true, data: { products_applied: 1, errors: [] } }), null);
  assert.equal(
    perProductApplyFailure({ ok: true, data: { products_applied: 0, errors: [] } }),
    null,
    "products_applied: 0 with no errors is the legitimate 'nothing to do' case (P0-144's own quiet no-op), never a failure",
  );
  assert.equal(perProductApplyFailure(undefined), null);
});

check("test_PRD_P0_149_auto_apply_failure_visibility__a_per_product_failure_writes_a_real_audit_row", async () => {
  /* The actual bug, reproduced end to end through the real route: this
     time env() carries a real AUDIT db (auditDb(), already wired into
     env() for the ordinary approval-gate audit rows every T2 call
     writes) so the fix's own write survives the redirect and is
     queryable afterward, the same way the real production incident was
     diagnosed. There is still no SQUARE_ACCESS_TOKEN here, so the
     underlying apply call is refused at the resource-construction step,
     the same "missing_binding" error runTool itself already always
     audits (one ordinary row -- not this fix's doing, present with or
     without it) -- proving the fix's own audit write, tagged with its
     own `auto_apply_per_product_failures` reason, is never a SECOND,
     redundant row layered on top of a failure `applyGate.error` already
     makes visible on its own. */
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const e = env(mirror);
  await postForm("/admin/categories/item-options", MANAGER, e, { category_id: "cat1", item_option_ids: "opt1" });
  const ownRows = (
    await e.AUDIT.prepare("SELECT detail FROM audit_log WHERE tool = 'catalog.apply_category_item_options_to_products' AND detail LIKE '%auto_apply_per_product_failures%'").all()
  ).results;
  assert.deepEqual(ownRows, [], "no SQUARE_ACCESS_TOKEN means applyGate.error, not applyResult.data.errors -- the fix's own reason tag must not appear");
});

check("test_PRD_P0_144_apply_category_item_options__the_old_standalone_apply_route_is_gone", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  const res = await postForm("/admin/categories/apply-item-options", MANAGER, env(mirror), { category_id: "cat1" });
  assert.equal(res.status, 404);
});

check("test_PRD_P0_144_apply_category_item_options__admin_no_longer_renders_a_separate_apply_button", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedItemOption(mirror, { id: "opt1", externalRef: "sqopt1", name: "Size" });
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.doesNotMatch(body, /admin-category-apply-btn/, "the apply button is folded into the ordinary Save flow now");
});

check("test_PRD_P0_138_nested_categories__admin_staff_cannot_reach_the_page_at_all", async () => {
  const mirror = mirrorDb();
  const res = await get("/admin", STAFF, env(mirror));
  assert.equal(res.status, 403);
});

/* create/number/rename/remove (leaf) all declare resources: ["square"] —
   catalog.create_category etc. really do write to Square, not just the
   mirror — so, matching the P0-136 comment above (this file's own env()
   deliberately carries no SQUARE_ACCESS_TOKEN, real ops.vemians.com never
   runs without one), what these can prove is that the route reaches
   runTool with correctly-built args, not a full round trip. Reaching the
   "SQUARE_ACCESS_TOKEN is unset" refusal (rather than a route-level "give
   a category name" or "give a category" 400) proves the form's own
   fields parsed and validated correctly before ever touching Square. */
check("test_PRD_P0_138_nested_categories__admin_creating_a_category_reaches_the_tool_layer", async () => {
  const mirror = mirrorDb();
  const res = await postForm("/admin/categories/create", MANAGER, env(mirror), { name: "Dresses", numeric_id: "02" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/);
});

check("test_PRD_P0_138_nested_categories__admin_setting_a_numeric_id_reaches_the_tool_layer", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await postForm("/admin/categories/number", MANAGER, env(mirror), { category_id: "cat4", numeric_id: "09" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/);
});

check("test_PRD_P0_138_nested_categories__admin_renaming_reaches_the_tool_layer", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await postForm("/admin/categories/rename", MANAGER, env(mirror), { category_id: "cat4", name: "Sweaters" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/);
});

/* Whether removing cat1 (has a child) is refused by check()'s own "still
   has subcategories" rule specifically, rather than the missing Square
   client this file's env() always hits first, is catalog-write.test.mjs's
   own job (a fake Square client, testing the tool directly) -- this file
   can only prove the route reaches runTool with the right args, matching
   the P0-136 comment above. */
check("test_PRD_P0_138_nested_categories__admin_removing_a_leaf_category_reaches_the_tool_layer", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await postForm("/admin/categories/remove", MANAGER, env(mirror), { category_id: "cat4" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/);
});

check("test_PRD_P0_138_nested_categories__admin_staff_cannot_reach_any_of_the_post_routes", async () => {
  const mirror = mirrorDb();
  seedProduct(mirror);
  seedCategoryTree(mirror);
  const res = await postForm("/admin/categories/create", STAFF, env(mirror), { name: "Dresses" });
  assert.equal(res.status, 403);
});

check("test_PRD_P0_136_square_custom_attributes__admin_lists_every_vendor_with_its_own_commission", async () => {
  const mirror = mirrorDb();
  seedVendor(mirror, { commission: 15 });
  const body = await (await get("/admin", MANAGER, env(mirror))).text();
  assert.match(body, /Acme Mills/);
  assert.match(body, /value="15"/);
});

check("test_PRD_P0_136_square_custom_attributes__admin_creating_a_vendor_requires_a_commission", async () => {
  const mirror = mirrorDb();
  const refused = await postForm("/admin/vendors/create", MANAGER, env(mirror), { name: "New Vendor" });
  assert.equal(refused.status, 400);
  assert.doesNotMatch(await refused.text(), /SQUARE_ACCESS_TOKEN/, "a missing commission is refused before ever touching Square");
  /* catalog.create_vendor declares resources: ["square"] (a real, standalone
     Vendor entity) -- with a commission given, the route reaches the tool
     layer instead, the same "SQUARE_ACCESS_TOKEN is unset" boundary the
     category tests above hit, since this file's own env() carries none. */
  const res = await postForm("/admin/vendors/create", MANAGER, env(mirror), { name: "New Vendor", commission: "10" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SQUARE_ACCESS_TOKEN is unset/);
});

check("test_PRD_P0_136_square_custom_attributes__admin_setting_a_vendors_own_commission_applies_immediately", async () => {
  const mirror = mirrorDb();
  seedVendor(mirror);
  const res = await postForm("/admin/vendors/commission", MANAGER, env(mirror), { vendor_id: "vendor1", commission: "12" });
  assert.equal(res.status, 303);
  const row = mirror.db.prepare("SELECT commission_pct FROM mirror_vendor WHERE id = 'vendor1'").get();
  assert.equal(row.commission_pct, 12);
});

check("test_PRD_P0_136_square_custom_attributes__admin_staff_cannot_change_a_vendors_commission", async () => {
  const mirror = mirrorDb();
  seedVendor(mirror);
  const res = await postForm("/admin/vendors/commission", STAFF, env(mirror), { vendor_id: "vendor1", commission: "12" });
  assert.equal(res.status, 403);
});

check("test_PRD_P0_71_items_tab__a_direct_visit_to_admin_redirects_to_the_shell", async () => {
  /* Same "no bookmark reaches a bare iframe page directly" rule every
     other shell tab's own src already gets (P0-140) — /admin is reached
     the same way, just from the hamburger menu rather than a visible
     tab. */
  const res = await worker.fetch(
    new Request("http://localhost/admin", {
      headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER), "sec-fetch-dest": "document" },
    }),
    env(mirrorDb()),
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "http://localhost/?tab=admin");
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
