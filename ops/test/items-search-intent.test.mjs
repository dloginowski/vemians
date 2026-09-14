/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * Test-PRD-P0-103-voice_search_fills_the_search_box. searchIntent() (agent.js)
 * is a single, non-agentic model call — never a tool call, never a chat turn
 * — that turns a spoken description into a search string for Items' own
 * client-side filter. Driven both directly (agent.js's own export, the same
 * way agent-model-errors.test.mjs drives agentTurn against a fake Anthropic
 * over ANTHROPIC_BASE_URL) and over the real Worker route it sits behind.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { searchIntent } = await import("../src/agent.js");
const worker = (await import("../src/index.js")).default;

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* A fake Anthropic, same shape agent-model-errors.test.mjs already uses:
   `respond` decides the status and body for every call. */
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

function textMessage(text) {
  return JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" });
}

check("test_PRD_P0_103_voice_search_fills_the_search_box__no_api_key_falls_back_to_the_literal_transcript", async () => {
  /* The same benign, configured fallback agentTurn() gives with no key —
     voice search still does something (the literal utterance becomes the
     search) rather than nothing at all. */
  const out = await searchIntent({ q: "wool coats", env: {}, categories: ["Outerwear"] });
  assert.deepEqual(out, { mode: "stub", query: "wool coats" });
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__an_empty_utterance_is_a_no_op", async () => {
  const out = await searchIntent({ q: "   ", env: { ANTHROPIC_API_KEY: "test-key" }, categories: [] });
  assert.deepEqual(out, { mode: "stub", query: "" });
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__the_models_own_answer_becomes_the_query_quotes_stripped", async () => {
  await withFakeAnthropic(
    () => ({ status: 200, body: textMessage('"Outerwear"') }),
    async (base) => {
      const out = await searchIntent({
        q: "show me the coats",
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
        categories: ["Outerwear", "Footwear"],
      });
      assert.equal(out.mode, "model");
      assert.equal(out.query, "Outerwear", "surrounding quotes the model added must not leak into the search box");
    },
  );
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__a_model_error_is_reported_not_silently_swallowed", async () => {
  await withFakeAnthropic(
    () => ({ status: 500, body: JSON.stringify({ type: "error", error: { type: "api_error", message: "overloaded" } }) }),
    async (base) => {
      const out = await searchIntent({
        q: "wool coats",
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
        categories: [],
      });
      assert.equal(out.mode, "model");
      assert.match(out.error, /500/);
      assert.match(out.error, /overloaded/);
    },
  );
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__never_calls_a_tool_this_is_one_completion_not_a_turn", async () => {
  /* The owner's own words: "it's not an agentic chat per se... I don't
     want to have a chat inside of the items view." Asserted at the wire
     level: the request Anthropic actually receives carries no `tools`
     array at all, unlike agentTurn's own request shape. */
  let capturedBody = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(textMessage("Outerwear"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await searchIntent({ q: "coats", env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base }, categories: [] });
    assert.ok(capturedBody, "the fake Anthropic must have received a request");
    assert.equal(capturedBody.tools, undefined, "a single completion must not offer any tools at all");
    assert.ok(capturedBody.max_tokens < 100, "a short search string needs no large token budget");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ---- the route itself --------------------------------------------------- */

const MANAGER_POLICY = "56e4eee0-0000-4000-8000-000000000003";
const STAFF_POLICY = "f6e1649c-0000-4000-8000-000000000002";
const STAFF = { email: "ana@example.test", policy_id: STAFF_POLICY };
const STRANGER = { email: "stranger@example.test", policy_id: "unmapped-policy" };

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

function routeEnv(extra = {}) {
  return { SURFACE: "ops", MANAGER_POLICY_ID: MANAGER_POLICY, STAFF_POLICY_ID: STAFF_POLICY, ...extra };
}

function postJson(path, claims, e, data) {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims), "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
    e,
  );
}

check("test_PRD_P0_103_voice_search_fills_the_search_box__the_route_is_post_only", async () => {
  const res = await worker.fetch(
    new Request("http://localhost/items/search-intent", { headers: { "Cf-Access-Jwt-Assertion": assertion(STAFF) } }),
    routeEnv(),
  );
  assert.equal(res.status, 405);
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__a_role_this_app_does_not_map_is_refused", async () => {
  const res = await postJson("/items/search-intent", STRANGER, routeEnv(), { q: "coats", categories: [] });
  assert.equal(res.status, 403);
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__an_unreadable_body_is_a_clean_400_not_a_worker_exception", async () => {
  const res = await worker.fetch(
    new Request("http://localhost/items/search-intent", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(STAFF), "content-type": "application/json" },
      body: "{not json",
    }),
    routeEnv(),
  );
  assert.equal(res.status, 400);
});

check("test_PRD_P0_103_voice_search_fills_the_search_box__a_signed_in_staff_member_gets_a_query_back", async () => {
  await withFakeAnthropic(
    () => ({ status: 200, body: textMessage("Outerwear") }),
    async (base) => {
      const res = await postJson("/items/search-intent", STAFF, routeEnv({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base }), {
        q: "show me the coats",
        categories: ["Outerwear"],
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.mode, "model");
      assert.equal(data.query, "Outerwear");
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
