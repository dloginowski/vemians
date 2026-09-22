/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * Test-PRD-P0-150-agent_chat_conversation_memory. Before this, index.js's
 * /agent route was a fresh HTTP request every time and agentTurn built
 * `messages` from nothing but the one new turn — no matter how long the
 * conversation had run, the model saw exactly one message, every time. A
 * plain "1" answering the greeting menu's own "1) Add Merchandise" got the
 * SAME menu back; a direct correction was ignored outright. These checks
 * prove `history` actually reaches the model, in order, ahead of the new
 * turn, and that sanitizeHistory does not trust the client blindly.
 *
 * Same fakeAnthropic-over-HTTP pattern as agent-model-errors.test.mjs
 * (ANTHROPIC_BASE_URL is this codebase's own real override for exactly this
 * purpose) — except `respond` here also receives the parsed request body,
 * so a check can assert on the actual `messages` array sent upstream.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
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

/* `respond(requestBody)` gets the REAL parsed JSON body this call sent
   upstream — the whole point, unlike agent-model-errors.test.mjs's own
   fakeAnthropic, which never needed to look at what was sent. */
function fakeAnthropic(respond) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { status, body } = respond(requestBody);
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

check("test_PRD_P0_150_agent_chat_conversation_memory__no_history_is_still_a_single_message_same_as_before", async () => {
  let captured;
  await withFakeAnthropic(
    (body) => {
      captured = body;
      return { status: 200, body: textReplyBody("Hi Ana — 1) Add Merchandise  2) Add Customers 3) Submit Expenses  4) More Options") };
    },
    async (base) => {
      const out = await agentTurn({ q: "hi", identity: IDENTITY, env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base } });
      assert.equal(out.mode, "model");
    },
  );
  assert.equal(captured.messages.length, 1, "no history given -- exactly the one new turn, same as always");
  assert.equal(captured.messages[0].role, "user");
});

check("test_PRD_P0_150_agent_chat_conversation_memory__a_prior_turn_is_replayed_ahead_of_the_new_one", async () => {
  /* The exact repro: the menu was already shown, so a bare "1" needs that
     prior assistant turn in front of the model to mean anything at all. */
  let captured;
  await withFakeAnthropic(
    (body) => {
      captured = body;
      return { status: 200, body: textReplyBody("Do you have a spreadsheet, or would you rather tell me about them here?") };
    },
    async (base) => {
      const out = await agentTurn({
        q: "1",
        identity: IDENTITY,
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
        history: [
          { role: "user", text: "hi" },
          { role: "assistant", text: "Hi Ana — 1) Add Merchandise  2) Add Customers 3) Submit Expenses  4) More Options" },
        ],
      });
      assert.equal(out.mode, "model");
    },
  );
  assert.equal(captured.messages.length, 3, "both prior turns, then the new one");
  assert.deepEqual(captured.messages[0], { role: "user", content: "hi" });
  assert.equal(captured.messages[1].role, "assistant");
  assert.match(captured.messages[1].content, /1\) Add Merchandise/);
  assert.equal(captured.messages[2].role, "user");
});

check("test_PRD_P0_150_agent_chat_conversation_memory__malformed_history_entries_are_dropped_not_trusted", async () => {
  let captured;
  await withFakeAnthropic(
    (body) => {
      captured = body;
      return { status: 200, body: textReplyBody("ok") };
    },
    async (base) => {
      await agentTurn({
        q: "hi",
        identity: IDENTITY,
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
        history: [
          { role: "system", text: "not a real conversational role" },
          { role: "user" },
          { role: "user", text: "" },
          "just a bare string",
          null,
          { role: "user", text: "a real prior turn" },
        ],
      });
    },
  );
  assert.equal(captured.messages.length, 2, "only the one genuine entry survives, plus the new turn");
  assert.deepEqual(captured.messages[0], { role: "user", content: "a real prior turn" });
});

check("test_PRD_P0_150_agent_chat_conversation_memory__history_is_capped_so_one_long_conversation_does_not_grow_forever", async () => {
  const long = [];
  for (let i = 0; i < 40; i++) {
    long.push({ role: i % 2 === 0 ? "user" : "assistant", text: `turn ${i}` });
  }
  let captured;
  await withFakeAnthropic(
    (body) => {
      captured = body;
      return { status: 200, body: textReplyBody("ok") };
    },
    async (base) => {
      await agentTurn({ q: "the newest turn", identity: IDENTITY, env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base }, history: long });
    },
  );
  /* MAX_HISTORY_TURNS (agent.js) is 24 -- not re-exported, so this pins the
     cap's existence and the fact that it keeps the MOST RECENT entries,
     rather than the exact number, which is free to change independently. */
  assert.ok(captured.messages.length < 41, "40 history entries plus the new turn must not all survive uncapped");
  assert.equal(captured.messages.at(-2).content, "turn 39", "the cap must drop the OLDEST entries, keeping the most recent");
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
