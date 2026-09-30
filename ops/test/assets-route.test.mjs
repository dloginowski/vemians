/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * /assets/new, /assets/<id> and /assets driven the way batch-route.test.mjs
 * drives its routes: a real Worker fetch, a real-shaped Access assertion.
 * The tool-layer half (assets.list / assets.read, extraction) is covered in
 * tools.test.mjs; this file is the HTTP surface — the actual browser upload
 * and download a coworker's click hits, which is exactly the layer that hid
 * the P0-35 and P0-63 regressions from every earlier test that skipped it.
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
const MANAGER = { email: "mara@example.test", policy_id: MANAGER_POLICY };
const STAFF = { email: "ana@example.test", policy_id: STAFF_POLICY };
const STRANGER = { email: "stranger@example.test", policy_id: "unmapped-policy" };

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

/* The real schema, over node:sqlite — same discipline as tools.test.mjs: a
   check against a fake store proves nothing about the append-only triggers. */
function assetsDb() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "db", "assets.sql"), "utf8");
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

/* A KV binding is just get/put here — no expiry, no metadata, nothing the
   asset file store's put/bytes pair does not itself use. */
function fakeKv() {
  const store = new Map();
  return {
    async put(key, value) {
      store.set(key, value instanceof Uint8Array ? value.slice() : value);
    },
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (type === "arrayBuffer") return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      return v;
    },
    _store: store,
  };
}

function env() {
  return {
    SURFACE: "ops",
    MANAGER_POLICY_ID: MANAGER_POLICY,
    STAFF_POLICY_ID: STAFF_POLICY,
    ASSETS: assetsDb(),
    ASSET_FILES: fakeKv(),
  };
}

function get(path, claims, e) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }), e);
}

function postFile(path, claims, e, { filename = "notes.txt", content = "Ships net 30.", type = "text/plain" } = {}) {
  const form = new FormData();
  form.set("file", new File([content], filename, { type }));
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims) },
      body: form,
    }),
    e,
  );
}

check("test_PRD_P0_65_asset_drop_site__staff_not_just_managers_can_reach_the_upload_form", async () => {
  const res = await get("/assets/new", STAFF, env());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Drop a file/i);
});

check("test_PRD_P0_65_asset_drop_site__a_stranger_with_no_role_is_refused", async () => {
  const res = await get("/assets/new", STRANGER, env());
  assert.equal(res.status, 403);
});

check("test_PRD_P0_65_asset_drop_site__uploading_a_text_file_makes_it_downloadable_and_listed", async () => {
  const e = env();
  const up = await postFile("/assets/new", STAFF, e, { filename: "vendor-notes.txt", content: "Ships net 30." });
  assert.equal(up.status, 200);
  const body = await up.text();
  const link = /href="(\/assets\/[^"]+)"/.exec(body)?.[1];
  assert.ok(link, "the confirmation page links straight to the file");

  const down = await get(link, STAFF, e);
  assert.equal(down.status, 200);
  assert.equal(await down.text(), "Ships net 30.");
  assert.match(down.headers.get("content-type"), /text\/plain/);

  const list = await get("/assets", STAFF, e);
  assert.match(await list.text(), /vendor-notes\.txt/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-184 — "we should have separate file locations for chat files... if I
 * upload items spreadsheets, they should go into an items spreadsheets
 * folder... if I upload invoices or expenses, they should go into their own
 * separate folder so we don't mix" -- the owner's own words. Expenses
 * already have their own completely separate flow (receiptUploadPage, its
 * own FINANCE store) that never touches `asset` at all -- the real mixing
 * this addresses is narrower: a chat-dropped spreadsheet that turned out to
 * be a product or customer import sat in the exact same flat list as any
 * other random dropped file on /assets. `agent_last_preview` (Test-PRD-
 * P0-183-durable_batch_bookkeeping) already records, durably, the moment a
 * spreadsheet is actually previewed as one or the other -- /assets now
 * joins against it read-only (no new column, no edit to the append-only
 * `asset` table) and groups the page into three sections instead of one.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_184_grouped_asset_browsing__a_file_never_previewed_as_a_batch_lands_in_other_files", async () => {
  const e = env();
  await postFile("/assets/new", STAFF, e, { filename: "vendor-notes.txt", content: "Ships net 30." });

  const list = await get("/assets", STAFF, e);
  const body = await list.text();
  assert.match(body, /Other files/, "a plain dropped file gets the honest default group, never guessed into a spreadsheet category");
  assert.match(body, /vendor-notes\.txt/);
  assert.doesNotMatch(body, /Item spreadsheets[\s\S]*vendor-notes\.txt/, "must not appear under Item spreadsheets");
});

check("test_PRD_P0_184_grouped_asset_browsing__a_spreadsheet_previewed_as_a_product_batch_is_grouped_separately", async () => {
  const e = env();
  const up = await postFile("/assets/new", STAFF, e, { filename: "fall-collection.csv", content: "title,category,price\nCoat,Outerwear,100\n", type: "text/csv" });
  const link = /href="(\/assets\/[^"]+)"/.exec(await up.text())?.[1];
  const assetId = link.split("/").pop();

  /* Simulates the moment catalog_preview_add_product_batch actually
     previews this exact file (recordLastPreview, agent.js) -- this test is
     about /assets's own grouping, not about re-proving the preview
     mechanism itself (already covered by Test-PRD-P0-183). */
  await e.ASSETS.prepare("INSERT INTO agent_last_preview (actor, batch_kind, asset_id) VALUES (?, ?, ?)")
    .bind("ana@example.test", "products", assetId)
    .run();

  const list = await get("/assets", STAFF, e);
  const body = await list.text();
  assert.match(body, /Item spreadsheets[\s\S]*fall-collection\.csv/, "grouped under Item spreadsheets, not left in the general pile");
  assert.doesNotMatch(body, /Other files[\s\S]*fall-collection\.csv/);
});

check("test_PRD_P0_184_grouped_asset_browsing__a_customer_spreadsheet_and_a_product_spreadsheet_never_mix", async () => {
  const e = env();
  const productUp = await postFile("/assets/new", STAFF, e, { filename: "products.csv", content: "a", type: "text/csv" });
  const productId = /href="\/assets\/([^"]+)"/.exec(await productUp.text())[1];
  const customerUp = await postFile("/assets/new", STAFF, e, { filename: "customers.csv", content: "b", type: "text/csv" });
  const customerId = /href="\/assets\/([^"]+)"/.exec(await customerUp.text())[1];

  await e.ASSETS.prepare("INSERT INTO agent_last_preview (actor, batch_kind, asset_id) VALUES (?, 'products', ?)").bind("ana@example.test", productId).run();
  await e.ASSETS.prepare("INSERT INTO agent_last_preview (actor, batch_kind, asset_id) VALUES (?, 'customers', ?)").bind("ana@example.test", customerId).run();

  const body = await (await get("/assets", STAFF, e)).text();
  /* Each section's own slice, up to the NEXT <h2> or the end of the page --
     a plain [\s\S]* match here would happily "find" a later section's own
     text too, since nothing stops a greedy match at a section boundary. */
  const section = (title) => new RegExp(`${title}[\\s\\S]*?(?=<h2>|<p><a href="/assets/new")`).exec(body)?.[0] ?? "";
  assert.match(section("Item spreadsheets"), /products\.csv/);
  assert.doesNotMatch(section("Item spreadsheets"), /customers\.csv/, "a customer sheet must never appear grouped as an item sheet");
  assert.match(section("Customer spreadsheets"), /customers\.csv/);
  assert.doesNotMatch(section("Customer spreadsheets"), /products\.csv/, "an item sheet must never appear grouped as a customer sheet");
});

check("test_PRD_P0_184_grouped_asset_browsing__a_spreadsheet_attached_but_never_actually_previewed_still_lands_in_other_files", async () => {
  /* REVISED -- agent_last_preview now also carries an 'attached' row,
     recorded the moment a spreadsheet is dropped in chat (agent.js's own
     agentTurn), before it is ever actually previewed as a product or
     customer batch (Test-PRD-P0-183-durable_batch_bookkeeping, revised: the
     asset id now has to survive an intervening clarifying question, not
     just an intervening preview confirmation). A spreadsheet someone
     attached and then abandoned -- never previewed at all -- carries ONLY
     this 'attached' row, never a 'products'/'customers' one; it must still
     land in Other files, the same honest default a file with no
     agent_last_preview row at all already gets, never its own silent
     third bucket that vanishes from every rendered group. */
  const e = env();
  const up = await postFile("/assets/new", STAFF, e, { filename: "maybe-later.csv", content: "a", type: "text/csv" });
  const assetId = /href="\/assets\/([^"]+)"/.exec(await up.text())[1];
  await e.ASSETS.prepare("INSERT INTO agent_last_preview (actor, batch_kind, asset_id) VALUES (?, 'attached', ?)")
    .bind("ana@example.test", assetId)
    .run();

  const list = await get("/assets", STAFF, e);
  const body = await list.text();
  assert.match(body, /Other files[\s\S]*maybe-later\.csv/, "an attached-but-never-previewed file still shows up, grouped as Other");
  assert.doesNotMatch(body, /Item spreadsheets[\s\S]*maybe-later\.csv/);
  assert.doesNotMatch(body, /Customer spreadsheets[\s\S]*maybe-later\.csv/);
});

check("test_PRD_P0_184_grouped_asset_browsing__the_grouped_query_failing_falls_back_to_a_flat_list_not_a_500", async () => {
  /* A deployment that has not yet run Test-PRD-P0-183's own one-time schema
     addition has no agent_last_preview table at all -- the grouped query
     must fail closed to the plain list this page always showed, never a
     500 the whole page is unreachable behind. */
  const e = env();
  await postFile("/assets/new", STAFF, e, { filename: "vendor-notes.txt", content: "Ships net 30." });
  e.ASSETS._raw.exec("DROP TABLE agent_last_preview");

  const res = await get("/assets", STAFF, e);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /vendor-notes\.txt/);
  assert.match(body, /Other files/, "everything falls back into the one honest default group");
});

check("test_PRD_P0_65_asset_drop_site__an_unaccepted_file_type_is_refused_before_it_is_stored", async () => {
  const e = env();
  const res = await postFile("/assets/new", STAFF, e, { filename: "install.exe", content: "x", type: "application/octet-stream" });
  assert.equal(res.status, 415);
  assert.equal((await e.ASSETS.prepare("SELECT count(*) AS n FROM asset").first("n")), 0);
});

check("test_PRD_P0_65_asset_drop_site__a_file_over_the_byte_cap_is_refused_before_it_is_read", async () => {
  const { CAPS } = await import("../src/tools/caps.js");
  const res = await postFile("/assets/new", STAFF, env(), {
    filename: "big.txt",
    content: "a".repeat(CAPS.ASSET_MAX_BYTES + 1),
  });
  assert.equal(res.status, 413);
});

check("test_PRD_P0_65_asset_drop_site__no_file_attached_is_refused_plainly", async () => {
  const form = new FormData();
  const res = await worker.fetch(
    new Request("http://localhost/assets/new", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(STAFF) },
      body: form,
    }),
    env(),
  );
  assert.equal(res.status, 400);
});

check("test_PRD_P0_65_asset_drop_site__an_unknown_id_downloads_as_a_plain_404_not_a_crash", async () => {
  const res = await get("/assets/does-not-exist", STAFF, env());
  assert.equal(res.status, 404);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
