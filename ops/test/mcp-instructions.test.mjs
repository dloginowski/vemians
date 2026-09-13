/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * buildInstructions() is the actual text a connecting agent reads before its
 * first reply — asserted on directly, the same lesson the /approvals/ 404
 * already taught this codebase (P0-35): reading the code and believing it
 * says the right thing is not the same as checking what it sends.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);
const { buildInstructions } = await import("../src/mcp.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRD = path.join(HERE, "..", "..", "docs", "PRD.md");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const VERIFIED = { actor: "ana@vemians.com", role: "staff", verified: true };

check("test_PRD_P0_62_onboarding_greeting__the_first_message_is_a_greeting_and_a_menu_not_an_explanation", () => {
  const text = buildInstructions(VERIFIED);
  assert.match(text, /greet them by their actual first name/i);
  assert.match(text, /menu/i);
  assert.match(text, /wait for.*their choice/i);
  assert.match(text, /do not explain tiers, tools or skills unless asked/i);
});

check("test_PRD_P0_62_onboarding_greeting__a_narrated_list_is_told_apart_from_a_spreadsheet", () => {
  const text = buildInstructions(VERIFIED);
  assert.match(text, /\/products\/batch/);
  assert.match(text, /\/customers\/batch/);
  assert.match(text, /draft and create one at a time/i);
  assert.match(text, /present every.*approval link together/i);
});

check("test_PRD_P0_62_onboarding_greeting__the_menu_is_exactly_these_four_choices_in_order", () => {
  /* A specific, named request — pin the exact wording and order rather than
     a loose "mentions a menu" check, so a future edit that drops or
     reorders one of the four is a failing test, not a surprise later. */
  const text = buildInstructions(VERIFIED);
  const order = ["Add Merchandise", "Add Customers", "Submit Expenses", "More Options"];
  let cursor = -1;
  for (const item of order) {
    const at = text.indexOf(item);
    assert.ok(at !== -1, `"${item}" is missing from the greeting menu`);
    assert.ok(at > cursor, `"${item}" is out of order in the greeting menu`);
    cursor = at;
  }
});

check("test_PRD_P0_66_expense_scanner__adding_an_expense_points_at_the_scanner_not_a_tool_call", () => {
  const text = buildInstructions(VERIFIED);
  assert.match(text, /submit expenses/i);
  assert.match(text, /\/expenses\/new/);
  /* The whole point: unlike products/customers, there is no second question
     and no tool to call — an agent that tries to draft or submit an expense
     itself missed the instruction. */
  assert.match(text, /there is no tool for it and no second/i);
});

check("test_PRD_P0_62_onboarding_greeting__the_actor_and_role_still_say_who_is_connected", () => {
  const text = buildInstructions(VERIFIED);
  assert.match(text, /ana@vemians\.com \(staff\)/);
});

check("test_PRD_P0_62_onboarding_greeting__an_unverified_assertion_still_carries_its_warning", () => {
  const text = buildInstructions({ ...VERIFIED, verified: false });
  assert.match(text, /NOT signature-verified/);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const prd = fs.readFileSync(PRD, "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
