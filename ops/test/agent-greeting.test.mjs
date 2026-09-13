/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * The built-in browser chat (/agent, agent.js) is the "one click from ops"
 * path — no connector setup, no external app. It has to open with the same
 * greeting-and-menu protocol as the MCP endpoint (P0-62), or "one click"
 * quietly means a second, worse assistant instead of the primary one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { systemPrompt } = await import("../src/agent.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

check("test_PRD_P0_68_one_click_ops_chat__greets_by_first_name_with_the_same_four_choices", () => {
  const text = systemPrompt("ana@vemians.com", "staff", [], { given_name: "Ana", email: "ana@vemians.com" });
  assert.match(text, /first name Ana/);
  const order = ["Add Merchandise", "Add Customers", "Submit Expenses", "More Options"];
  let cursor = -1;
  for (const item of order) {
    const at = text.indexOf(item);
    assert.ok(at !== -1, `"${item}" is missing from the built-in chat's greeting menu`);
    assert.ok(at > cursor, `"${item}" is out of order`);
    cursor = at;
  }
});

check("test_PRD_P0_68_one_click_ops_chat__submit_expenses_points_at_the_scanner_not_a_tool_call", () => {
  const text = systemPrompt("ana@vemians.com", "staff", [], { email: "ana@vemians.com" });
  assert.match(text, /submit expenses.*is different/i);
  assert.match(text, /\/expenses\/new/);
});

check("test_PRD_P0_68_one_click_ops_chat__falls_back_to_a_name_derived_from_the_email", () => {
  const text = systemPrompt("dimitri@handsome.la", "owner", [], {});
  assert.match(text, /Hi Dimitri —/);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
