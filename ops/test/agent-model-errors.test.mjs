/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * Test-PRD-P0-86-surfaced_model_errors. The owner reported a live 400 from
 * the model, twice, with nothing to go on beyond "I'm still getting 400" —
 * the actual Anthropic error detail (which tool, which argument, what shape
 * it expected) was reaching only a Worker log neither of us could tail live.
 * ANTHROPIC_BASE_URL is the real override this codebase already ships for
 * exactly this purpose (see callClaude's own comment): point it at a local
 * HTTP server that answers the way Anthropic's own error responses are
 * shaped, and assert the detail reaches the chat reply itself. No real
 * network call, no real API key — the fake server never inspects the
 * request body meaningfully, only returns a canned status and body.
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
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const IDENTITY = { email: "ana@vemians.test", claims: { given_name: "Ana" } };

/* A fake Anthropic. `respond` decides the status and body for every call;
   tests set it per case rather than branching inside one shared handler. */
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

check("test_PRD_P0_86_surfaced_model_errors__a_400_with_anthropics_own_error_shape_reaches_the_reply", async () => {
  await withFakeAnthropic(
    () => ({
      status: 400,
      body: JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "tools.26.custom.input_schema: extra fields not allowed" },
      }),
    }),
    async (base) => {
      const out = await agentTurn({
        q: "Add products",
        identity: IDENTITY,
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
      });
      assert.equal(out.mode, "model");
      assert.match(out.reply, /400/);
      assert.match(out.reply, /tools\.26\.custom\.input_schema/, "the actual field Anthropic named must reach the reply");
      assert.match(out.reply, /extra fields not allowed/);
    },
  );
});

check("test_PRD_P0_86_surfaced_model_errors__a_body_that_is_not_json_falls_back_to_the_raw_text", async () => {
  await withFakeAnthropic(
    () => ({ status: 502, body: "<html>upstream error</html>" }),
    async (base) => {
      const out = await agentTurn({
        q: "hello",
        identity: IDENTITY,
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
      });
      assert.match(out.reply, /502/);
      assert.match(out.reply, /upstream error/);
    },
  );
});

check("test_PRD_P0_86_surfaced_model_errors__the_detail_is_truncated_rather_than_flooding_the_chat", async () => {
  const huge = "x".repeat(5000);
  await withFakeAnthropic(
    () => ({ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: huge } }) }),
    async (base) => {
      const out = await agentTurn({
        q: "hello",
        identity: IDENTITY,
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
      });
      assert.ok(out.reply.length < 1000, `reply was ${out.reply.length} chars — a Worker log's job, not a chat bubble's`);
    },
  );
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
