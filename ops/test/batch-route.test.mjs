/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * /products/batch driven the way ops-page.test.mjs and media-new.test.mjs
 * drive their routes: a real Worker fetch, a real-shaped Access assertion.
 * What draftBatch() does with a valid file is covered against the real
 * Square/mirror fixture in catalog-write.test.mjs; this file is the HTTP
 * surface around it — who may open it, and what a malformed upload gets back.
 */
import assert from "node:assert/strict";
import test from "node:test";
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

const ENV = {
  SURFACE: "ops",
  MANAGER_POLICY_ID: MANAGER_POLICY,
  STAFF_POLICY_ID: STAFF_POLICY,
};

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

function get(path, claims, env = ENV) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }), env);
}

function postFile(path, claims, { filename = "products.csv", content = "title,category,price\n", size } = {}, env = ENV) {
  const body = size !== undefined ? "a".repeat(size) : content;
  const form = new FormData();
  form.set("file", new File([body], filename, { type: "text/csv" }));
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims) },
      body: form,
    }),
    env,
  );
}

const MANAGER = { email: "mara@example.test", policy_id: MANAGER_POLICY };
const STAFF = { email: "ana@example.test", policy_id: STAFF_POLICY };
const STRANGER = { email: "stranger@example.test", policy_id: "unmapped-policy" };

check("test_PRD_P0_60_spreadsheet_products__the_upload_page_names_the_required_columns", async () => {
  const res = await get("/products/batch", MANAGER);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /title/i);
  assert.match(body, /category/i);
  assert.match(body, /price/i);
});

check("test_PRD_P0_60_spreadsheet_products__staff_are_told_to_ask_a_manager_before_reading_the_file", async () => {
  const res = await get("/products/batch", STAFF);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_60_spreadsheet_products__an_unmapped_identity_cannot_reach_the_upload_form", async () => {
  const res = await get("/products/batch", STRANGER);
  assert.equal(res.status, 403);
});

check("test_PRD_P0_60_spreadsheet_products__the_customer_upload_page_names_squares_own_field_names", async () => {
  const res = await get("/customers/batch", MANAGER);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /given_name/);
  assert.match(body, /email_address/);
  assert.match(body, /phone_number/);
});

check("test_PRD_P0_60_spreadsheet_products__staff_cannot_reach_the_customer_upload_form_either", async () => {
  const res = await get("/customers/batch", STAFF);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /manager/i);
});

check("test_PRD_P0_60_spreadsheet_products__posting_with_no_file_attached_is_refused_plainly", async () => {
  const form = new FormData();
  const res = await worker.fetch(
    new Request("http://localhost/products/batch", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER) },
      body: form,
    }),
    ENV,
  );
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no file/i);
});

check("test_PRD_P0_60_spreadsheet_products__a_file_over_the_byte_cap_is_refused_before_it_is_read", async () => {
  const { CAPS } = await import("../src/tools/caps.js");
  const res = await postFile("/products/batch", MANAGER, { size: CAPS.BATCH_MAX_BYTES + 1 });
  assert.equal(res.status, 413);
});

check("test_PRD_P0_60_spreadsheet_products__a_get_only_shows_the_form_a_post_only_reads_a_file", async () => {
  const res = await worker.fetch(
    new Request("http://localhost/products/batch", {
      method: "DELETE",
      headers: { "Cf-Access-Jwt-Assertion": assertion(MANAGER) },
    }),
    ENV,
  );
  assert.equal(res.status, 405);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
