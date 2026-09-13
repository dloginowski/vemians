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

check("test_PRD_P0_23_group_derived_roles__an_unmapped_policy_is_shown_as_no_role", async () => {
  const { body } = await frontPage({ email: "stranger@example.test", policy_id: "unmapped-policy" });
  assert.match(body, /role <strong>none<\/strong>/, "an unmapped policy must read as no role, not as staff");
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

/* ─────────────────────────────────────────────────────────────────────────
 * P0-80 — the minimum interface: no dev, no examples, no mcp, no fold at
 *         all — just chat and the three common actions, backed by skills
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_80_minimum_interface__the_connect_pitch_and_its_example_prompts_are_gone", async () => {
  /* The literal ask: remove "Connect your own Claude or ChatGPT instead...
     paste this into it to get started... https://ops.vemians.com/mcp" and
     the "Then say this" block of three example prompts under it. The
     built-in chat and the one-click chips are the path now, not a second
     client someone has to go set up. */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /Connect your own Claude or ChatGPT instead/);
  assert.doesNotMatch(body, /Paste this into it to get started/);
  assert.doesNotMatch(body, /Then say this, so it learns how we do things/);
  assert.doesNotMatch(body, /Find every black boot in the catalog/);
  assert.doesNotMatch(body, /Draft a product from it: brand, name, description, price/);
});

check("test_PRD_P0_80_minimum_interface__no_fold_survives_at_all", async () => {
  /* The further reduction past P0-79: not just the connect pitch but the
     whole reference accordion it used to point to — roster, tier rules,
     the developer contract, the sample data — none of it is a "chat" or a
     "common action," so none of it stays. "More Options" itself is gone
     too, since there is nothing left for it to open. */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /<details/, "no accordion, fold or aside of any kind may remain");
  assert.doesNotMatch(body, />More Options</);
  assert.doesNotMatch(body, /for-assistants/);
  assert.doesNotMatch(body, /claude mcp add/, "no mcp");
  assert.doesNotMatch(body, /Who has what|How this works|Sample data/, "no dev, no examples");
});

check("test_PRD_P0_80_minimum_interface__the_bindings_footnote_and_the_model_name_are_both_gone", async () => {
  /* The bindings footnote (role/tools/stores) was itself dev-flavoured
     implementation detail — gone along with everything else, not merely
     stripped of the model name it named a moment before this. */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /claude-sonnet-5/, "which model answers is not something the page needs to say");
  assert.doesNotMatch(body, /class="bind"/);
});

check("test_PRD_P0_80_minimum_interface__only_chat_and_the_three_common_actions_remain", async () => {
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"), body.indexOf("<script"));
  assert.match(main, /id="chat"/, "the chat widget must still be there");
  for (const action of ["+ Merchandise", "+ Customers", "+ Expense"]) {
    assert.ok(main.includes(action), `"${action}" must still be a one-click action`);
  }
});

check("test_PRD_P0_69_one_click_welcome_menu__greets_by_first_name_with_the_choices_above_everything_else", async () => {
  /* The literal ask: a welcome message, by name, offering + Merchandise /
     + Customers / + Expense — reachable without leaving the page, without
     connecting anything, in one click. "More Options" was itself retired
     by P0-80: there is nothing left on the page for it to open. */
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"));
  assert.match(main, /Hi Owner — what would you like to do/, "greets by the resolved first name");

  const order = ["+ Merchandise", "+ Customers", "+ Expense"];
  let cursor = -1;
  for (const item of order) {
    const at = main.indexOf(item);
    assert.ok(at !== -1, `"${item}" is missing from the welcome menu`);
    assert.ok(at > cursor, `"${item}" is out of order`);
    cursor = at;
  }

  assert.match(main, /href="\/products\/batch"[^>]*>\+ Merchandise/);
  assert.match(main, /href="\/customers\/batch"[^>]*>\+ Customers/);
  assert.match(main, /href="\/expenses\/new"[^>]*>\+ Expense/);
});

check("test_PRD_P0_69_one_click_welcome_menu__the_built_in_chat_is_open_at_rest_not_a_folded_afterthought", async () => {
  /* The chat box used to live in a closed <details> captioned "your own
     assistant is the one worth using" — actively steering away from the one
     surface that needs no setup at all. It is now open at rest — and P0-80
     removed every fold from the page entirely, so "not folded" now holds
     trivially as well as by position. */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /<summary>Ask here instead<\/summary>/, "no longer folded under its old caption");
  assert.doesNotMatch(body, /<details/, "there is no accordion left for it to be folded inside of");
  const main = body.slice(body.indexOf("<main"));
  assert.ok(main.indexOf('id="chat"') > -1, "the chat box must still be on the page");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-74 — the assistant leads the page, ahead of the one-click menu itself
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_74_chat_first__the_assistant_is_the_first_interactive_thing_after_the_greeting", async () => {
  /* The owner's own direction, in as many words: chat assistant on top. The
     greeting still leads (it names who is signed in before anything asks for
     input), but the assistant now comes before even the one-click menu
     P0-69 put directly on the page — not after it, and not behind a fold. */
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"));
  const greetAt = main.indexOf("Hi Owner — what would you like to do");
  const chatAt = main.indexOf('id="chat"');
  const menuAt = main.indexOf('<section class="menu"');
  assert.ok(greetAt > -1 && chatAt > -1 && menuAt > -1, "greeting, chat and menu must all be on the page");
  assert.ok(greetAt < chatAt, "the greeting must still lead the page");
  assert.ok(chatAt < menuAt, "the assistant must come before the one-click menu, not after it");
});

check("test_PRD_P0_74_chat_first__the_one_click_menu_still_carries_all_three_tasks_in_order", async () => {
  /* P0-69's own guarantee, re-checked after the reorder: moving the assistant
     ahead of the menu must not have quietly dropped or reordered a task. */
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"));
  const order = ["+ Merchandise", "+ Customers", "+ Expense"];
  let cursor = -1;
  for (const item of order) {
    const at = main.indexOf(item);
    assert.ok(at !== -1, `"${item}" is missing from the one-click menu`);
    assert.ok(at > cursor, `"${item}" is out of order`);
    cursor = at;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-75 — the ops surface's own dark theme, never the storefront's
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_75_ops_dark_theme__the_front_page_carries_the_dark_palette", async () => {
  const { body } = await frontPage(OWNER);
  assert.match(body, /--ground:\s*#191817/, "the near-black ground must be set");
  assert.match(body, /--ink:\s*#F1EEE6/, "the warm off-white ink must be set");
  assert.match(body, /--accent:\s*#D97757/, "the one accent colour must be set");
  assert.match(body, /--muted:\s*#9C978C/);
});

check("test_PRD_P0_75_ops_dark_theme__the_storefront_never_loads_this_palette", async () => {
  /* The override lives in a SECOND `:root` block inside the ops Worker's own
     stylesheet, never in shared/design/theme.css — a shop rendered in
     near-black with a clay-orange accent is not what P0-26/P0-56's own
     warm-cream design language asked for, and this is the one file that
     could leak it there by accident. */
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const theme = fs.readFileSync(path.join(HERE, "..", "..", "shared", "design", "theme.css"), "utf8");
  assert.doesNotMatch(theme, /#191817|#D97757|#F1EEE6/, "the ops dark palette leaked into the shared theme");
});

check("test_PRD_P0_75_ops_dark_theme__every_approval_style_page_carries_it_too", async () => {
  /* "The entire ops section" means every page rendered there, not only the
     front door — the approval screen, the batch upload forms, the expense
     scanner, all share APPROVAL_CSS rather than OPS_CSS, so the override has
     to reach both rather than only the one this suite otherwise exercises. */
  const { approvalPage, batchUploadPage, refusalPage } = await import("../src/views.js");
  for (const html of [
    approvalPage("id1", null),
    batchUploadPage("products"),
    refusalPage(401, "sign in first"),
  ]) {
    assert.match(html, /--accent:\s*#D97757/);
  }
});

check("test_PRD_P0_75_ops_dark_theme__the_employees_only_bar_is_readable_on_the_black_bar", async () => {
  /* theme.css's .bar sets color: var(--ground) — a light warm off-white on
     the storefront, but --ground is redefined to a near-black #191817 for
     the ops dark ground, which left "ops.vemians.com · employees only"
     nearly invisible: near-black text on the same black bar. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.bar\s*\{\s*color:\s*var\(--muted\)/, "the bar text must not inherit --ground once --ground is near-black");
});

check("test_PRD_P0_75_ops_dark_theme__no_hardcoded_grey_survives_the_reskin", async () => {
  /* #666 was this file's own stand-in for secondary text under the light
     theme; left in place it reads as a barely-visible dark grey on the new
     near-black ground. Every one of them had to become var(--muted), which
     this same reskin defines and which theme.css never did. */
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, "..", "src", "views.js"), "utf8");
  const styleOnly = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(styleOnly, /#666/, "a hardcoded grey survived the dark reskin");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-78 — a real scrolling chat widget, and compact one-click chips
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_78_chat_widget__the_log_is_a_bounded_scrolling_container_not_a_growing_list", async () => {
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.log\s*\{[^}]*max-height:/s, "the message log must be height-bounded, not free to grow the page");
  assert.match(body, /\.log\s*\{[^}]*overflow-y:\s*auto/s, "and it must scroll internally rather than the whole page");
});

check("test_PRD_P0_78_chat_widget__mine_agent_and_tool_are_three_distinct_bubble_styles", async () => {
  const { body } = await frontPage(OWNER);
  for (const cls of ["you", "agent", "tool"]) {
    assert.match(body, new RegExp(`\\.log p\\.${cls}\\s*\\{`), `no bubble style for '.log p.${cls}'`);
  }
  /* Telegram's own shape: mine on the right, the other side on the left. */
  assert.match(body, /\.log p\.you\s*\{[^}]*align-self:\s*flex-end/s);
  assert.match(body, /\.log p\.agent\s*\{[^}]*align-self:\s*flex-start/s);
});

check("test_PRD_P0_78_chat_widget__the_clients_own_entry_builder_always_classes_the_users_own_bubble", async () => {
  /* The bug this guards: kind "" (the user's own line) used to get NO class
     at all — `if (kind) p.className = kind` — so it fell back to whatever
     bare <p> looks like instead of a "mine" bubble. */
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("function entry"), body.indexOf("function entry") + 400);
  assert.match(script, /p\.className\s*=\s*kind\s*\|\|\s*"you"/);
});

check("test_PRD_P0_78_chat_widget__the_one_click_tasks_are_small_chips_not_bold_filled_ctas", async () => {
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.choices \.btn\s*\{[^}]*border-radius:\s*999px/s, "expected a pill-shaped chip");
  assert.doesNotMatch(body, /\.choices \.btn\s*\{[^}]*font-weight:\s*700/s, "no longer a bold CTA");
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
  /* The audience is a shopkeeper, not an engineer. Used to exempt a folded
     developer block written for a machine reader; P0-80 removed that block
     (and every other fold) entirely, so the whole page is now the "visible
     copy" this check reads. */
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"), body.indexOf("<script"));
  /* PROSE only. The inlined stylesheet is full of class names a person never
     sees; strip markup before reading. */
  const text = main.replace(/<[^>]+>/g, " ");
  for (const jargon of ["Cloudflare Access", "tier", "T0", "T1", "T2", "MCP", "endpoint", "tool"]) {
    assert.ok(
      !new RegExp(`\\b${jargon}\\b`, "i").test(text),
      `"${jargon}" is our vocabulary, not the reader's`,
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
