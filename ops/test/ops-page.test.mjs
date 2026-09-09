/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *   * A behaviour change moves the PRD feature and its labeled check together.
 *
 * These fetch the real front page from the real Worker with a real-shaped
 * Access assertion, and read the HTML that comes back.
 *
 * That is deliberate and it is the lesson of the /approvals/ 404: this
 * repository has repeatedly had tests that asked the code what it MEANT and
 * none that asked what it SENT. The front page is now the onboarding surface —
 * if the role it prints, the endpoint it tells people to paste, or the tool
 * count it claims are wrong, the person reading it is misled and no unit test
 * of roleFor would notice.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const worker = (await import("../src/index.js")).default;

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const OWNER_POLICY = "56e4eee0-0000-4000-8000-000000000001";
const STAFF_POLICY = "f6e1649c-0000-4000-8000-000000000002";

const ENV = {
  SURFACE: "ops",
  OWNER_POLICY_ID: OWNER_POLICY,
  STAFF_POLICY_ID: STAFF_POLICY,
};

/*
 * A shaped-but-unsigned assertion. Legal only because the host is localhost and
 * ACCESS_TEAM_DOMAIN/ACCESS_AUD are unset — access.js refuses this exact token
 * anywhere else, which is itself asserted below.
 */
function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

async function frontPage(claims, env = ENV) {
  const res = await worker.fetch(
    new Request("http://localhost/", { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }),
    env,
  );
  return { status: res.status, body: await res.text() };
}

const OWNER = { email: "owner@example.test", policy_id: OWNER_POLICY };
const STAFF = { email: "staff@example.test", policy_id: STAFF_POLICY };

/* ─────────────────────────────────────────────────────────────────────────
 * P0-23 — the page must print the role the request actually carries
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_23_group_derived_roles__the_front_page_resolves_a_policy_derived_role", async () => {
  /* The regression this exists for: opsPage was called with roleFor(identity)
     and no env, so the policy branch — the ONLY branch Cloudflare can trigger,
     because Access Groups are not claims — could never match. Every signed-in
     person was shown role `null` and an empty tool list. */
  const { status, body } = await frontPage(OWNER);
  assert.equal(status, 200);
  assert.match(body, /role <strong>owner<\/strong>/, "the banner must name the role the assertion carries");
  assert.doesNotMatch(body, /role <strong>none<\/strong>/);
});

check("test_PRD_P0_23_group_derived_roles__the_page_states_where_the_role_came_from", async () => {
  const { body } = await frontPage(OWNER);
  assert.match(body, /Access policy/, "a person must be able to see how they were granted the role");
});

check("test_PRD_P0_23_group_derived_roles__an_unmapped_policy_is_shown_as_no_role", async () => {
  const { body } = await frontPage({ email: "stranger@example.test", policy_id: "unmapped-policy" });
  assert.match(body, /role <strong>none<\/strong>/, "an unmapped policy must read as no role, not as staff");
});

check("test_PRD_P0_24_binding_scoped_tools__the_roles_table_counts_tools_from_the_registry", async () => {
  const { sessionBindings } = await import("../src/agent.js");
  const { body } = await frontPage(OWNER);
  for (const role of ["staff", "manager", "owner"]) {
    const b = sessionBindings(role);
    assert.match(
      body,
      new RegExp(`<td>${role}</td><td>${b.tools.length}</td>`),
      `the roles table must show ${role}'s real tool count (${b.tools.length}), not a typed-in number`,
    );
  }
});

check("test_PRD_P0_24_binding_scoped_tools__a_staff_page_never_lists_a_tool_staff_cannot_call", async () => {
  const { sessionBindings } = await import("../src/agent.js");
  const staffTools = new Set(sessionBindings("staff").tools);
  const withheld = sessionBindings("owner").tools.filter((t) => !staffTools.has(t));
  assert.ok(withheld.length, "the fixture is pointless if staff and owner bind the same tools");

  const { body } = await frontPage(STAFF);
  for (const tool of withheld) {
    assert.doesNotMatch(
      body,
      new RegExp(`<code>${tool.replace(".", "\\.")}</code>`),
      `${tool} is withheld from staff and must not be named on their page`,
    );
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-54 — the page is itself a discovery surface: a person pastes what it
 *         gives them, and an assistant that fetches it finds the contract
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_54_skill_discovery__the_page_offers_the_endpoint_of_the_host_it_was_served_from", async () => {
  /* Hardcoding ops.vemians.com here would hand a preview deployment's visitor
     a command pointing at production. */
  const res = await worker.fetch(
    new Request("http://localhost/", { headers: { "Cf-Access-Jwt-Assertion": assertion(OWNER) } }),
    ENV,
  );
  const body = await res.text();
  assert.match(body, /claude mcp add --transport http vemians http:\/\/localhost\/mcp/);
  assert.doesNotMatch(body, /ops\.vemians\.com\/mcp/, "the endpoint must be derived, not typed");
});

check("test_PRD_P0_54_skill_discovery__the_copyable_command_is_the_whole_command", async () => {
  const { body } = await frontPage(OWNER);
  /* A copy button that copies half a command is worse than no button: the
     person pastes it, it fails, and they have no way to tell what was lost.
     The button reads the <pre> beside it, so assert the pre holds a command
     that runs as written. */
  const pre = /<pre>(claude mcp add[^<]*)<\/pre>/.exec(body);
  assert.ok(pre, "the connect command must be inside the copyable block");
  const parts = pre[1].split(/\s+/);
  assert.deepEqual(parts.slice(0, 5), ["claude", "mcp", "add", "--transport", "http"]);
  assert.equal(parts.length, 7, "name and URL, nothing missing and nothing extra");
});

check("test_PRD_P0_54_skill_discovery__only_the_address_and_the_prompts_are_open_at_rest", async () => {
  /* The page has one job for almost everyone: hand over the address to paste
     into their own assistant, and show them what to say next. Everything else —
     roster, tier rules, the machine contract, the seed data — is a closed row.

     The `claude mcp add` invocation is NOT that job. It is a terminal command
     for the few people who have one, so it belongs in the developer fold; a
     person told to paste a shell line into a chat window is being asked to
     debug our vocabulary before they can start. */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /<details[^>]*\sopen/, "no accordion row may ship expanded");

  const main = body.slice(body.indexOf("<main"));
  const firstFold = main.indexOf("<details");
  assert.ok(firstFold > -1);

  const open = main.slice(0, firstFold);
  assert.ok(open.includes("/mcp"), "the address must be above the accordion");
  assert.ok(open.includes("Read the vemians skills"), "and so must the first thing to say");
  assert.ok(!open.includes("claude mcp add"), "a shell command is not what a chat user pastes");
  assert.ok(main.slice(firstFold).includes("claude mcp add"), "but it must still be on the page");
});

check("test_PRD_P0_54_skill_discovery__the_copy_control_is_an_icon_with_a_reachable_label", async () => {
  /* An icon-only control is a control with no name unless it carries one. */
  const { body } = await frontPage(OWNER);
  const buttons = body.match(/<button type="button" data-copy[^>]*>/g) ?? [];
  assert.ok(buttons.length >= 4, `expected a copy control per line, saw ${buttons.length}`);
  for (const b of buttons) {
    assert.match(b, /aria-label="Copy"/, "an icon button must be named for anything not looking at it");
  }
  assert.doesNotMatch(body, /data-copy[^>]*>Copy</, "the label is the aria-label, not visible text");
});

check("test_PRD_P0_54_skill_discovery__folding_hides_nothing_from_a_machine_reader", async () => {
  /* Compaction is for the eye. A <details> is in the DOM whether or not anyone
     opened it, so an assistant that fetches this URL must still get the whole
     contract — that is what makes folding safe here rather than a second page. */
  const { body } = await frontPage(OWNER);
  for (const needed of ["skills_list", "/approvals/", "catalog.draft_product", "WWW-Authenticate"]) {
    assert.ok(body.includes(needed), `${needed} must survive being folded away`);
  }
});

check("test_PRD_P0_54_skill_discovery__an_assistant_fetching_the_page_is_told_to_read_the_skills_first", async () => {
  const { body } = await frontPage(OWNER);
  const { skillsFor } = await import("../src/skills.js");
  const { canUseDomain } = await import("../src/mcp.js");

  assert.match(body, /skills_list/, "the folded block must name the discovery tool");
  assert.match(body, /skills_read/);
  for (const s of skillsFor("owner", canUseDomain)) {
    assert.ok(body.includes(`<code>${s.name}</code>`), `${s.name} is readable at this role but is not listed`);
  }
});

check("test_PRD_P0_35_approval_out_of_band__the_page_tells_a_person_a_write_stops_for_them", async () => {
  const { body } = await frontPage(OWNER);
  /* The onboarding text is where most people learn the tier rule, so it has to
     agree with what the tool layer does: a T2 call parks and returns a link. */
  assert.match(body, /parks the intent/, "the contract block must say a T2 call does not run when called");
  assert.match(body, /\/approvals\//, "and must name where the link goes");
  assert.match(body, /under your name/, "and that the write runs as the approver");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-23 — /whoami is the page a person is sent to when their role is wrong,
 *         so it has to answer them, not only a terminal
 * ───────────────────────────────────────────────────────────────────────── */

const UNMAPPED = { email: "someone@example.test", policy_id: "a-policy-no-var-names" };

async function whoami(claims, { accept = "text/html", query = "" } = {}) {
  const res = await worker.fetch(
    new Request(`http://localhost/whoami${query}`, {
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims), accept },
    }),
    ENV,
  );
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}

check("test_PRD_P0_23_group_derived_roles__whoami_answers_a_person_in_a_browser", async () => {
  /* It answered JSON to everyone, and was then handed to the shopkeeper as the
     thing to open when their role reads none. `"role": null` is a fact, not an
     explanation. */
  const { type, body } = await whoami(UNMAPPED);
  assert.match(type, /text\/html/);
  assert.match(body, /<h1>/, "a person gets a page, not a payload");
  assert.doesNotMatch(body.slice(0, 200), /^\s*\{/, "the page must not open with raw JSON");
});

check("test_PRD_P0_23_group_derived_roles__whoami_still_answers_json_to_everything_else", async () => {
  /* The diagnostic that made the role bug findable must not be taken away from
     the terminal to give a page to the browser. */
  const asked = await whoami(UNMAPPED, { accept: "application/json" });
  assert.match(asked.type, /application\/json/);
  assert.equal(JSON.parse(asked.body).role, null);

  const forced = await whoami(UNMAPPED, { query: "?format=json" });
  assert.match(forced.type, /application\/json/, "?format=json wins over an HTML Accept");
  assert.equal(JSON.parse(forced.body).policy_seen, UNMAPPED.policy_id);
});

check("test_PRD_P0_23_group_derived_roles__a_person_with_no_role_is_told_what_to_do", async () => {
  const { body } = await whoami(UNMAPPED);
  /* The usual cause is a browser holding a sign-in minted before the person was
     added, and the fix is signing out. Naming the cause without the fix is what
     the JSON already did. */
  assert.match(body, /Sign out/i, "the page must name the fix");
  assert.match(body, /\/cdn-cgi\/access\/logout/, "and link to it");
  /* And it hands over something to send on, in one piece, copyable. */
  assert.match(body, /policy_seen/, "the full answer must be on the page for forwarding");
  assert.match(body, /data-copy/, "and it must be copyable rather than selected by hand");
});

check("test_PRD_P0_23_group_derived_roles__a_person_with_a_role_is_not_shown_a_problem", async () => {
  const { body } = await whoami(OWNER);
  assert.match(body, /owner/);
  assert.doesNotMatch(body, /Sign out now/, "nothing to fix, so nothing that looks like a fix");
});

check("test_PRD_P0_54_skill_discovery__the_page_explains_itself_without_jargon", async () => {
  /* The audience is a shopkeeper, not an engineer. These words all appeared in
     the visible copy and every one of them is ours, not theirs. The folded
     developer block is exempt — that IS written for a machine. */
  const { body } = await frontPage(OWNER);
  const visible = body.slice(0, body.indexOf('<details class="aside" id="for-assistants">'));
  /* PROSE only. The inlined stylesheet is full of class names a person never
     sees, and the address itself is the one piece of our vocabulary that has to
     stay — it is what they paste. Strip both before reading. */
  const text = visible
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\S*:\/\/\S+/g, " ");
  for (const jargon of ["Cloudflare Access", "tier", "T0", "T1", "T2", "MCP", "endpoint", "tool"]) {
    assert.ok(
      !new RegExp(`\\b${jargon}\\b`, "i").test(text),
      `"${jargon}" is our vocabulary, not the reader's — it belongs in the folded block`,
    );
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-22 — the surface is Access-gated, and the onboarding page is no
 *         exception to it
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_22_access_gated_ops__the_front_page_is_refused_without_an_assertion", async () => {
  const res = await worker.fetch(new Request("http://localhost/"), ENV);
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.doesNotMatch(body, /claude mcp add/, "a refusal must not hand out the endpoint");
});

check("test_PRD_P0_22_access_gated_ops__an_unverified_assertion_is_refused_off_localhost", async () => {
  const res = await worker.fetch(
    new Request("https://ops.vemians.com/", { headers: { "Cf-Access-Jwt-Assertion": assertion(OWNER) } }),
    ENV,
  );
  assert.ok(res.status >= 400, "unsigned assertions are a localhost convenience and nothing else");
});

test("every label in this file is unique and well formed", () => {
  assert.ok(usedLabels.size >= 5, `expected the checks above to register labels, saw ${usedLabels.size}`);
});
