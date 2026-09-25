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
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
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

check("test_PRD_P0_83_quick_prompts_route_through_chat__a_first_message_that_already_names_a_choice_skips_the_menu", () => {
  /* The front page's quick-prompt chips (P0-83) send exactly this text as
     the person's first message — a click already IS the choice, so
     re-presenting the greeting menu they just used would be the churn a
     one-click chip exists to avoid. */
  const text = systemPrompt("ana@vemians.com", "staff", [], { given_name: "Ana" });
  assert.match(text, /already names a choice/i);
  assert.match(text, /skip the greeting.*menu/i);
});

check("test_PRD_P0_83_quick_prompts_route_through_chat__the_skip_menu_reply_does_not_re_greet_by_name", () => {
  /* The owner's own words, once .greet's own "Hi {name}" heading (P0-90)
     started living on the page permanently: "you keep on adding 'Hi
     Dimitri' to all of your responses... they already have it at the
     top." The skip-the-menu clause used to tell the model to greet by name
     in that same reply; it no longer does, though the clause itself (the
     assertion above) still stands. */
  const text = systemPrompt("ana@vemians.com", "staff", [], { given_name: "Ana" });
  const clauseStart = text.search(/already names a choice/i);
  assert.ok(clauseStart !== -1);
  const clause = text.slice(clauseStart, clauseStart + 400);
  assert.doesNotMatch(clause, /greet them by name in that same reply/i);
  assert.match(clause, /do not greet them by name/i);
});

check("test_PRD_P0_156_ask_what_it_can_do__answering_it_never_lists_tool_names_at_any_point_in_the_conversation", () => {
  /* The help button (ops-page.test.mjs's own P0-156 test) sends this exact
     question at any point in a conversation, not only as the first
     message's own menu — the model must answer it the same short, plain
     way every time, and must never fall back to listing tool names,
     domains or schemas just because this arrived mid-conversation rather
     than as the "More Options" choice. */
  const text = systemPrompt("ana@vemians.com", "staff", [], { given_name: "Ana" });
  assert.match(text, /what can you do.*any point/i);
  assert.match(text, /never list tool names, domains, tiers or schemas/i);
});

check("test_PRD_P0_158_help_answer_scales_with_role__an_owners_own_rundown_is_told_to_mention_the_fuller_advanced_set", () => {
  /* A real transcript, reacting to P0-156's own help button: "these tools
     should only be visible by an admin or somebody with sufficient rights
     to actually run them... for an advanced user, obviously, this help
     chip would mention the more advanced tools that the user can do."
     Tool visibility is already structurally subtractive (P0-24) — an
     owner's own `defs` genuinely differ from a staff member's, so there is
     nothing here for a staff prompt to even describe — but the instruction
     itself has to say the rundown should scale UP for a role that can
     reach more, not flatten every role's own answer down to the same
     plain staff-level script. */
  const staffText = systemPrompt("ana@vemians.com", "staff", ["one"], { given_name: "Ana" });
  const ownerText = systemPrompt("dimitri@handsome.la", "owner", ["one", "two", "three"], { given_name: "Dimitri" });
  assert.match(staffText, /scales with what staff can actually reach/i);
  assert.match(ownerText, /scales with what owner can actually reach/i);
  assert.match(ownerText, /manager or owner.*mention the fuller, more advanced set/i);
  assert.match(ownerText, /never invent or hint at a capability outside the tools actually listed/i);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
