/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * /expenses/new and /expenses/confirm driven the way assets-route.test.mjs
 * and batch-route.test.mjs drive their routes: a real Worker fetch, a
 * real-shaped Access assertion. The OCR text-parsing half is covered in
 * tools.test.mjs; this file is the HTTP surface — the actual scan-then-file
 * loop a coworker's browser hits, including the one thing no lower-level
 * test can see: that a confirmed submission really inserts a row, since
 * expense.submit itself (by design) writes nothing at all.
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
const { CAPS } = await import("../src/tools/caps.js");

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
  };
}

/* No real Workers AI call in a test — a canned reply stands in for the
   model, same discipline as fakeSquare() elsewhere: this file proves the
   ROUTE handles a reply correctly, not that the model produces a good one. */
function fakeAi(reply = "VENDOR: Acme Hardware\nDATE: 2026-09-10\nTOTAL: 42.50\nCURRENCY: USD") {
  return { run: async () => ({ description: reply }) };
}

function env({ ai = fakeAi() } = {}) {
  return {
    SURFACE: "ops",
    MANAGER_POLICY_ID: MANAGER_POLICY,
    STAFF_POLICY_ID: STAFF_POLICY,
    FINANCE: sqliteDb("finance"),
    AUDIT: sqliteDb("audit"),
    RECEIPT_FILES: fakeKv(),
    AI: ai,
  };
}

function get(p, claims, e) {
  return worker.fetch(new Request(`http://localhost${p}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }), e);
}

function postPhoto(p, claims, e, { filename = "receipt.jpg", content = "not really a jpeg", type = "image/jpeg" } = {}) {
  const form = new FormData();
  form.set("file", new File([content], filename, { type }));
  return worker.fetch(
    new Request(`http://localhost${p}`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion(claims) }, body: form }),
    e,
  );
}

function postConfirm(claims, e, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return worker.fetch(
    new Request("http://localhost/expenses/confirm", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims) },
      body: form,
    }),
    e,
  );
}

check("test_PRD_P0_66_expense_scanner__any_staff_role_can_reach_the_scanner", async () => {
  const res = await get("/expenses/new", STAFF, env());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Scan a receipt/i);
});

check("test_PRD_P0_66_expense_scanner__a_stranger_with_no_role_is_refused", async () => {
  const res = await get("/expenses/new", STRANGER, env());
  assert.equal(res.status, 403);
});

check("test_PRD_P0_66_expense_scanner__a_scanned_photo_returns_a_prefilled_confirm_page", async () => {
  const res = await postPhoto("/expenses/new", STAFF, env());
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Acme Hardware/);
  assert.match(body, /value="42\.50"/);
  assert.match(body, /value="USD"/);
  assert.match(body, /value="2026-09-10"/);
  assert.match(body, /name="receipt_key" value="receipts\//);
});

check("test_PRD_P0_66_expense_scanner__when_ocr_reads_nothing_the_form_is_blank_not_broken", async () => {
  const res = await postPhoto("/expenses/new", STAFF, env({ ai: fakeAi("I cannot read this image") }));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Nothing could be read off this photo/i);
});

check("test_PRD_P0_66_expense_scanner__an_unaccepted_file_type_is_refused_before_it_is_stored", async () => {
  const res = await postPhoto("/expenses/new", STAFF, env(), { filename: "receipt.txt", content: "x", type: "text/plain" });
  assert.equal(res.status, 415);
});

check("test_PRD_P0_66_expense_scanner__a_photo_over_the_byte_cap_is_refused_before_it_is_read", async () => {
  const res = await postPhoto("/expenses/new", STAFF, env(), { content: "a".repeat(CAPS.RECEIPT_MAX_BYTES + 1) });
  assert.equal(res.status, 413);
});

check("test_PRD_P0_66_expense_scanner__confirming_actually_files_the_expense_under_the_uploaders_name", async () => {
  const e = env();
  const res = await postConfirm(STAFF, e, {
    receipt_key: "receipts/abc",
    description: "Hardware for the window display",
    amount: "42.50",
    currency: "USD",
    incurred_on: "2026-09-10",
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Hardware for the window display/);

  const row = e.FINANCE._raw.prepare("SELECT * FROM expense").get();
  assert.equal(row.employee_id, STAFF.email);
  assert.equal(row.employee_name, STAFF.email);
  assert.equal(row.amount_minor, 4250);
  assert.equal(row.currency, "USD");
  assert.equal(row.status, "submitted");
  assert.equal(row.receipt_key, "receipts/abc");
});

check("test_PRD_P0_66_expense_scanner__an_unparseable_amount_is_refused_and_nothing_is_filed", async () => {
  const e = env();
  const res = await postConfirm(STAFF, e, {
    receipt_key: "receipts/abc",
    description: "Hardware",
    amount: "a lot",
    currency: "USD",
    incurred_on: "2026-09-10",
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not a plain amount/i);
  assert.equal(e.FINANCE._raw.prepare("SELECT count(*) AS n FROM expense").get().n, 0);
});

check("test_PRD_P0_66_expense_scanner__an_amount_over_the_submission_cap_is_refused_and_nothing_is_filed", async () => {
  const e = env();
  const over = (CAPS.EXPENSE_SUBMIT_MAX_MINOR + 100) / 100;
  const res = await postConfirm(STAFF, e, {
    receipt_key: "receipts/abc",
    description: "Way too much",
    amount: String(over),
    currency: "USD",
    incurred_on: "2026-09-10",
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /exceeds the submission cap/i);
  assert.equal(e.FINANCE._raw.prepare("SELECT count(*) AS n FROM expense").get().n, 0);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
