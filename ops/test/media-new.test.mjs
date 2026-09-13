/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * /media/new — a one-click way to add a photo that does not go through an
 * assistant at all. Driven the way ops-page.test.mjs drives the front page:
 * a real Worker fetch, a real-shaped Access assertion, and the actual
 * response read back rather than the code asked what it meant.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const worker = (await import("../src/index.js")).default;
const { verifyUploadTicket } = await import("../src/tools/media.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const STAFF_POLICY = "f6e1649c-0000-4000-8000-000000000002";
const SIGNING_KEY = "fixture-media-signing-key-not-a-real-one";

const ENV = {
  SURFACE: "ops",
  STAFF_POLICY_ID: STAFF_POLICY,
  MEDIA_SIGNING_KEY: SIGNING_KEY,
};

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

function clickAddPhoto(claims, env = ENV) {
  return worker.fetch(
    new Request("http://localhost/media/new", {
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims) },
      redirect: "manual",
    }),
    env,
  );
}

const STAFF = { email: "staff@example.test", policy_id: STAFF_POLICY };

check("test_PRD_P0_59_one_click_photo__a_click_mints_a_ticket_and_sends_the_browser_to_the_picker", async () => {
  const res = await clickAddPhoto(STAFF);
  assert.equal(res.status, 302, "no form to fill in first — straight to the picker");

  const dest = new URL(res.headers.get("Location"), "http://localhost/");
  assert.equal(dest.pathname, "/media/upload");

  const accepted = await verifyUploadTicket({
    secret: SIGNING_KEY,
    key: dest.searchParams.get("key"),
    actor: STAFF.email,
    expiresAt: dest.searchParams.get("exp"),
    signature: dest.searchParams.get("sig"),
  });
  assert.equal(accepted.ok, true, "the link the human is sent to must actually be spendable");
});

check("test_PRD_P0_59_one_click_photo__two_clicks_are_two_different_photos", async () => {
  const first = await clickAddPhoto(STAFF);
  const second = await clickAddPhoto(STAFF);
  const keyOf = (res) => new URL(res.headers.get("Location"), "http://localhost/").searchParams.get("key");
  assert.notEqual(keyOf(first), keyOf(second), "one photo per request, never a shared or reused slot");
});

check("test_PRD_P0_59_one_click_photo__no_role_no_link", async () => {
  const res = await clickAddPhoto({ email: "stranger@example.test", policy_id: "unmapped-policy" });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Location"), null, "a refusal must not also be a redirect");
});

check("test_PRD_P0_59_one_click_photo__unconfigured_deployment_says_so_not_a_broken_link", async () => {
  const res = await clickAddPhoto(STAFF, { ...ENV, MEDIA_SIGNING_KEY: undefined });
  assert.equal(res.status, 503);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
