/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * Test-PRD-P0-87-wire_safe_tool_names. The actual, confirmed cause of the
 * "still getting 400" report P0-86 made diagnosable: Anthropic requires a
 * tool name to match `^[a-zA-Z0-9_-]{1,128}$`, and every tool in this
 * registry is named `domain.verb` — the dot has never been legal. This is
 * the regression guard P0-76 (schema shape) didn't cover, because it never
 * looked at a tool's own NAME, only its input_schema — and the gap this file
 * closes by actually driving agentTurn() against a fake HTTP server shaped
 * like Anthropic, the same technique P0-86 introduced, extended here to
 * inspect the real REQUEST body rather than only a canned response.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { agentTurn, wireName, toolDefinitions } = await import("../src/agent.js");
const { TOOLS } = await import("../src/tools/index.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const ANTHROPIC_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const IDENTITY = { email: "ana@vemians.test", claims: { given_name: "Ana" } };

/* Anthropic's own tool naming grammar. This is not this codebase's own
   invention — it is what the live 400 actually named:
   "tools.2.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'" */
check("test_PRD_P0_87_wire_safe_tool_names__wirename_makes_every_registered_tool_name_legal", () => {
  for (const name of Object.keys(TOOLS)) {
    assert.match(wireName(name), ANTHROPIC_NAME_PATTERN, `${name} -> ${wireName(name)} is still illegal`);
  }
});

check("test_PRD_P0_87_wire_safe_tool_names__wirename_never_collides_two_different_tools", () => {
  const seen = new Map();
  for (const name of Object.keys(TOOLS)) {
    const w = wireName(name);
    assert.ok(!seen.has(w) || seen.get(w) === name, `${name} and ${seen.get(w)} both wire to "${w}"`);
    seen.set(w, name);
  }
});

check("test_PRD_P0_87_wire_safe_tool_names__tool_definitions_itself_keeps_the_dotted_names", () => {
  /* The fix lives ONLY at the API boundary. Every other caller in this
     codebase — tests, TOOLS lookups, the bindings footnote that used to
     exist — depends on toolDefinitions() still returning the real name. */
  const defs = toolDefinitions("owner");
  assert.ok(defs.some((d) => d.name === "catalog.create_product"), "toolDefinitions must still use dotted names");
});

/* ── driven against a fake Anthropic, the same technique as P0-86 ────────── */

function fakeAnthropic(handleRequest) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { status, response } = handleRequest(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function withFakeAnthropic(handleRequest, fn) {
  const server = await fakeAnthropic(handleRequest);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

check("test_PRD_P0_87_wire_safe_tool_names__the_actual_request_body_names_are_all_legal", async () => {
  /* THE REGRESSION ITSELF: assert what agentTurn() actually SENDS, the same
     lesson this repository's own /approvals/ 404 already taught it once —
     not what toolDefinitions() means before the wire-name step runs. */
  let seenTools = null;
  await withFakeAnthropic(
    (body) => {
      seenTools = body.tools;
      return { status: 200, response: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } };
    },
    async (base) => {
      await agentTurn({
        q: "how many black coats are in stock",
        identity: IDENTITY,
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
      });
    },
  );
  assert.ok(seenTools && seenTools.length > 0, "the request must actually carry tools");
  for (const t of seenTools) {
    assert.match(t.name, ANTHROPIC_NAME_PATTERN, `sent tool name "${t.name}" is not legal on the wire`);
  }
});

check("test_PRD_P0_87_wire_safe_tool_names__a_dotted_tool_called_by_its_wire_name_dispatches_and_reports_the_real_name", async () => {
  /* Claude echoes back exactly the name it was given in `tools` — so the
     tool_use block on the way back names the WIRE form ("catalog_categories"),
     never the dotted one. Translating it back is the other half of the fix:
     without it, dispatch() would refuse with "No such tool" even though the
     tool is real and allowed. */
  let round = 0;
  await withFakeAnthropic(
    () => {
      round += 1;
      if (round === 1) {
        return {
          status: 200,
          response: {
            content: [{ type: "tool_use", id: "toolu_1", name: "catalog_categories", input: {} }],
            stop_reason: "tool_use",
          },
        };
      }
      return { status: 200, response: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } };
    },
    async (base) => {
      const out = await agentTurn({
        q: "what categories exist",
        identity: IDENTITY,
        env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base },
      });
      assert.equal(out.steps.length, 1, "the one tool call must be recorded");
      assert.equal(out.steps[0].tool, "catalog.categories", "the step must record the real, dotted name");
      assert.notEqual(out.steps[0].tool, "catalog_categories", "not the wire form");
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
