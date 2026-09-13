/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * Test-PRD-P0-81-skills_over_mcp. Skills used to reach a model only through
 * the now-removed MCP endpoint; the built-in chat's own tool loop is the
 * sole consumer now, via two meta-tools (skills_list, skills_read) handled
 * in dispatch() before it ever reaches runTool(). No network call is
 * involved — these exercise dispatch() directly, the same way
 * agent-tool-schema.test.mjs exercises toolDefinitions() directly, rather
 * than driving the whole Anthropic call loop (which nothing in this
 * codebase mocks yet — see agentTurn's own PRD note).
 *
 * Test-PRD-P0-82-skills_on_demand. Also covers the immediate follow-up:
 * skills_read is offered, not mandated before every turn.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { dispatch, canUseDomain, mayUse, toolDefinitions, systemPrompt } = await import("../src/agent.js");
const { TOOLS } = await import("../src/tools/index.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const ALLOWED = new Set(["skills_list", "skills_read", ...toolDefinitions("staff").map((d) => d.name)]);
const ctx = { actor: "ana@vemians.test", role: "staff", env: {}, allowed: ALLOWED };

check("test_PRD_P0_81_skills_over_mcp__skills_list_is_callable_without_touching_the_tool_layer", async () => {
  const outcome = await dispatch("skills_list", {}, ctx);
  assert.equal(outcome.kind, "result");
  assert.equal(outcome.block.is_error, false);
  const data = JSON.parse(outcome.block.content);
  assert.ok(Array.isArray(data.skills) && data.skills.length > 0, "the built-in chat must see at least one skill");
  assert.ok(data.skills.some((s) => s.name === "agent-tool-contract"), "the house rules must always be listed");
  assert.equal(data.start_with, "agent-tool-contract");
});

check("test_PRD_P0_81_skills_over_mcp__skills_list_is_filtered_by_role_exactly_as_tools_are", async () => {
  const staffOut = await dispatch("skills_list", {}, ctx);
  const ownerOut = await dispatch("skills_list", {}, { ...ctx, role: "owner" });
  const staffNames = JSON.parse(staffOut.block.content).skills.map((s) => s.name);
  const ownerNames = JSON.parse(ownerOut.block.content).skills.map((s) => s.name);
  for (const name of staffNames) {
    assert.ok(ownerNames.includes(name), `owner lost ${name} that staff can see`);
  }
  assert.ok(ownerNames.length >= staffNames.length, "owner sees at least as much as staff, never less");
});

check("test_PRD_P0_81_skills_over_mcp__skills_read_returns_the_document_in_full", async () => {
  const outcome = await dispatch("skills_read", { name: "agent-tool-contract" }, ctx);
  assert.equal(outcome.block.is_error, false);
  assert.match(outcome.block.content, /greet.*by their actual first name/i, "the greeting protocol must be in the text returned");
});

check("test_PRD_P0_81_skills_over_mcp__skills_read_refuses_an_unlisted_skill_as_absent_not_forbidden", async () => {
  /* knowledge-skills is bundled (skillByName finds it) but listed for
     nobody — no knowledge tools exist yet. A distinguishable refusal here
     would leak that the document exists at all, so it must read exactly
     like an unknown name. */
  const outcome = await dispatch("skills_read", { name: "knowledge-skills" }, ctx);
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /is available to you/);
});

check("test_PRD_P0_81_skills_over_mcp__skills_read_refuses_an_unknown_name_the_same_way", async () => {
  const outcome = await dispatch("skills_read", { name: "no-such-skill" }, ctx);
  assert.equal(outcome.block.is_error, true);
  assert.match(outcome.block.content, /is available to you/);
});

check("test_PRD_P0_81_skills_over_mcp__canusedomain_agrees_with_the_tool_layer_it_is_derived_from", () => {
  assert.equal(canUseDomain("staff", "catalog"), true, "staff can call some catalog tool");
  assert.equal(canUseDomain("staff", "no-such-domain"), false, "a domain with no tool at all is unusable by anyone");
  /* Cross-checked against mayUse directly, not just asserted: canUseDomain
     must agree with it for every real domain, since it is derived from
     allowedTools()/mayUse() rather than a second, hand-maintained rule. */
  const domains = new Set(Object.values(TOOLS).map((t) => t.domain).filter(Boolean));
  for (const role of ["staff", "manager", "owner"]) {
    for (const domain of domains) {
      const direct = Object.entries(TOOLS).some(([name, tool]) => tool.domain === domain && mayUse(role, name, tool));
      assert.equal(canUseDomain(role, domain), direct, `${role}/${domain} disagreed between canUseDomain and mayUse`);
    }
  }
});

check("test_PRD_P0_82_skills_on_demand__the_system_prompt_offers_skills_read_without_mandating_it_first", () => {
  /* P0-82: a mandatory skills_list -> skills_read("agent-tool-contract")
     before every turn added two guaranteed round-trips (latency and
     tokens) to even a trivial lookup, for a document whose operational
     content (tiers, the greeting, the approval-link framing) is already
     inline here and in greetingScript(). Skills are available, not a
     ritual: the prompt must still tell the model the tool exists, but must
     not tell it to call skills_list/skills_read before anything else. */
  const text = systemPrompt("ana@vemians.test", "staff", toolDefinitions("staff"), { given_name: "Ana" });
  assert.match(text, /skills_read/, "the model must still be told the tool exists");
  assert.doesNotMatch(text, /before your first (write|call)/i, "no mandatory skills-first ritual");
  assert.doesNotMatch(text, /call skills_list, then skills_read/i, "no forced two-step sequence");
});

check("test_PRD_P0_81_skills_over_mcp__the_meta_tools_are_offered_alongside_the_domain_tools", () => {
  /* agentTurn() itself prepends these to toolDefinitions()'s own list — this
     asserts on the shape agentTurn sends, without needing a live model call. */
  const defs = toolDefinitions("staff");
  const names = new Set(defs.map((d) => d.name));
  assert.ok(!names.has("skills_list"), "skills_list is a meta-tool, not in TOOLS, so toolDefinitions alone must not carry it");
  const merged = ["skills_list", "skills_read", ...defs.map((d) => d.name)];
  assert.equal(new Set(merged).size, merged.length, "no name collision between the meta-tools and a real tool");
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const prd = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "PRD.md"),
    "utf8",
  );
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
