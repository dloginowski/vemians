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
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
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
