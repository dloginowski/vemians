/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * The approval route, driven the way a browser drives it. The bug this exists
 * to prevent shipped once already: /approvals/<id> was the URL every T2 call
 * handed back, and there was no route, so every write died at a 404 that no
 * test noticed because no test asked for the URL the product actually emits.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { approvalPage } = await import("../src/views.js");
const mcp = await import("../src/mcp.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

check("test_PRD_P0_35_approval_never_in_band__the_url_a_t2_call_emits_has_a_route", async () => {
  /* THE REGRESSION. Take the URL parkForApproval actually produces and assert
     the router has somewhere to send it. Reading the code and believing the
     page exists is how this shipped broken. */
  const env = { OPS_HOST: "ops.vemians.com" };
  const { url } = await mcp.parkForApproval(env, {
    name: "catalog.create_product",
    args: { title: "A Coat" },
    actor: "d@vemians.com",
    role: "owner",
    tier: "t2",
  });

  const path = new URL(url).pathname;
  assert.match(path, /^\/approvals\/.+/, "the emitted link must be the shape the router handles");

  const src = await (await import("node:fs/promises")).readFile(
    new URL("../src/index.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /path\.startsWith\("\/approvals\/"\)/, "and the router must actually handle it");
});

check("test_PRD_P0_35_approval_never_in_band__the_page_shows_the_write_without_doing_it", () => {
  const html = approvalPage("abc123", {
    tool: "catalog.create_product",
    args: { title: "Wool Coat", price_minor: 48000 },
    actor: "d@vemians.com",
    role: "owner",
  });

  assert.match(html, /catalog\.create_product/, "it names the tool");
  assert.match(html, /Wool Coat/, "and shows what will happen");
  assert.match(html, /48000/);
  assert.match(html, /d@vemians\.com/, "and who proposed it");
  /* A form POST, not a fetch: the write is the human's request under their own
     identity, which is the whole of P0-35. */
  assert.match(html, /<form method="POST" action="\/approvals\/abc123"/);
  assert.match(html, /Nothing has been written yet/i);
});

check("test_PRD_P0_35_approval_never_in_band__a_missing_approval_says_so_without_leaking", () => {
  const html = approvalPage("nope", null, { durable: true });
  assert.match(html, /Nothing to approve/i);
  assert.doesNotMatch(html, /<form method="POST"/, "there must be nothing to submit");
});

check("test_PRD_P0_35_approval_never_in_band__a_non_durable_store_says_why_a_link_may_vanish", () => {
  /* "Expired" and "a different isolate held it" look identical from a browser
     and need different advice, so the page distinguishes them. */
  const html = approvalPage("nope", null, { durable: false });
  assert.match(html, /memory/i);
  assert.match(html, /KV/);
});

check("test_PRD_P0_35_approval_never_in_band__args_are_escaped_not_rendered", () => {
  const html = approvalPage("x", {
    tool: "catalog.create_product",
    args: { title: '<img src=x onerror="alert(1)">' },
    actor: '<b>d@vemians.com</b>',
    role: "owner",
  });
  assert.doesNotMatch(html, /<img src=x/, "a tool argument is data, and an agent supplies it");
  assert.doesNotMatch(html, /<b>d@vemians\.com<\/b>/);
  assert.match(html, /&lt;img/);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
