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
