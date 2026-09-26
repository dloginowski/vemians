/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * Test-PRD-P0-159-choice_pills. A real transcript: "I want you to give me
 * balloon pop-ups, you know, those little pill, like full width... instead
 * of like the text, I don't like that text stuff." agent.js's own
 * systemPrompt now teaches the model to end a reply offering a short set of
 * choices with one "CHOICE: <label>" line per option instead of a numbered
 * list in prose; extractSuggestions (agent.js, not exported — exercised
 * here only through agentTurn's own real return shape, the same way this
 * codebase already tests table/checklist) strips those lines out of the
 * visible reply and returns them as a plain `suggestions` array instead.
 *
 * Same fakeAnthropic-over-HTTP pattern as agent-history.test.mjs.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { agentTurn } = await import("../src/agent.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const IDENTITY = { email: "ana@vemians.test", claims: { given_name: "Ana" } };

function textReplyBody(text) {
  return JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  });
}

function fakeAnthropic(respond) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const { status, body } = respond();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function withFakeAnthropic(respond, fn) {
  const server = await fakeAnthropic(respond);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

check("test_PRD_P0_159_choice_pills__choice_lines_are_pulled_out_of_the_reply_into_a_plain_suggestions_array", async () => {
  await withFakeAnthropic(
    () => ({
      status: 200,
      body: textReplyBody("Hi Ana — what would you like to do?\nCHOICE: Add Merchandise\nCHOICE: Add Customers\nCHOICE: Submit Expenses\nCHOICE: More Options"),
    }),
    async (base) => {
      const out = await agentTurn({ q: "hi", identity: IDENTITY, env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base } });
      assert.equal(out.reply, "Hi Ana — what would you like to do?", "CHOICE lines never reach the visible reply text");
      assert.deepEqual(out.suggestions, ["Add Merchandise", "Add Customers", "Submit Expenses", "More Options"]);
    },
  );
});

check("test_PRD_P0_159_choice_pills__a_reply_with_no_choice_lines_carries_no_suggestions_at_all", async () => {
  await withFakeAnthropic(
    () => ({ status: 200, body: textReplyBody("The red dress is $49 and in stock.") }),
    async (base) => {
      const out = await agentTurn({ q: "how much is the red dress", identity: IDENTITY, env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base } });
      assert.equal(out.reply, "The red dress is $49 and in stock.");
      assert.equal(out.suggestions, undefined, "no CHOICE lines means no suggestions key at all, not an empty array");
    },
  );
});

check("test_PRD_P0_159_choice_pills__more_than_six_choices_is_capped_rather_than_flooding_the_chat", async () => {
  const lines = Array.from({ length: 9 }, (_, i) => `CHOICE: Option ${i + 1}`).join("\n");
  await withFakeAnthropic(
    () => ({ status: 200, body: textReplyBody(`Pick one:\n${lines}`) }),
    async (base) => {
      const out = await agentTurn({ q: "hi", identity: IDENTITY, env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base } });
      assert.equal(out.suggestions.length, 6);
      assert.deepEqual(out.suggestions, ["Option 1", "Option 2", "Option 3", "Option 4", "Option 5", "Option 6"]);
    },
  );
});

check("test_PRD_P0_159_choice_pills__prose_lines_around_choice_lines_are_kept_in_order", async () => {
  await withFakeAnthropic(
    () => ({
      status: 200,
      body: textReplyBody("Here is what I can do:\nCHOICE: Look up an item\nOne more thing before you pick:\nCHOICE: Something else"),
    }),
    async (base) => {
      const out = await agentTurn({ q: "what can you do", identity: IDENTITY, env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base } });
      assert.equal(out.reply, "Here is what I can do:\nOne more thing before you pick:");
      assert.deepEqual(out.suggestions, ["Look up an item", "Something else"]);
    },
  );
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
