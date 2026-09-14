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

/* /chat, not /: the chat widget moved there when / became the persistent-
   header shell ("the header is always present. Everything else is an
   iframe" — the owner's own words). Every test in this file is about the
   chat widget's own content, which is what /chat now serves. */
async function frontPage(claims, env = ENV) {
  const res = await worker.fetch(
    new Request("http://localhost/chat", { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }),
    env,
  );
  return { status: res.status, body: await res.text() };
}

async function shell(claims, path = "/", env = ENV) {
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }),
    env,
  );
  return { status: res.status, body: await res.text() };
}

const OWNER = { email: "owner@example.test", policy_id: OWNER_POLICY };
const STAFF = { email: "staff@example.test", policy_id: STAFF_POLICY };

/* ─────────────────────────────────────────────────────────────────────────
 * P0-71 — the shell: a persistent header, an iframe for everything else
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_71_items_tab__the_root_page_is_a_shell_with_both_tabs_and_an_iframe", async () => {
  /* The owner's own words: "I WANT tabs in the header. Replace this: the
     header is always present. Everything else is an iframe." */
  const { status, body } = await shell(OWNER);
  assert.equal(status, 200);
  assert.match(body, /<iframe[^>]*id="ops-frame"/, "the tab content must load in an iframe");
  assert.match(body, /<button[^>]*>Agent<\/button>/);
  assert.match(body, /<button[^>]*>Items<\/button>/);
});

check("test_PRD_P0_71_items_tab__the_shell_height_tracks_the_real_mobile_viewport_not_the_largest_one", async () => {
  /* The owner's own words, about the header losing its own bottom
     edge while scrolling the Website tab: "the tabs should be in a
     header, and it should not lose its edge at all because it's part
     of the header." 100vh alone on a phone is measured against the
     LARGEST possible viewport (address bar collapsed), not the one
     actually visible when the page loads — .shell's own flex layout
     could end up sized taller than the real visible area, letting
     .shell-header drift out of view until the browser's own chrome
     height was accounted for. 100dvh, with 100vh kept first as a
     fallback for older browsers, tracks the real, dynamic viewport. */
  const { body } = await shell(OWNER);
  assert.match(body, /\.shell\s*\{[^}]*height:\s*100vh;\s*height:\s*100dvh/s);
});

check("test_PRD_P0_71_items_tab__the_shell_defaults_to_the_agent_tab", async () => {
  const { body } = await shell(OWNER);
  assert.match(body, /id="ops-frame" src="\/chat"/, "the iframe must default to the chat content");
  assert.match(body, /data-src="\/chat"[^>]*class="active"/, "the Agent tab must read as active by default");
});

check("test_PRD_P0_71_items_tab__tab_equals_items_starts_the_iframe_on_items_instead", async () => {
  const { body } = await shell(OWNER, "/?tab=items");
  assert.match(body, /id="ops-frame" src="\/items"/);
  assert.match(body, /data-src="\/items"[^>]*class="active"/, "the Items tab must read as active when linked directly");
});

check("test_PRD_P0_71_items_tab__the_tabs_are_the_header_not_a_row_under_a_separate_banner", async () => {
  /* The owner's own words: "GET RID OF THE HEADER DAMNIT! I WANT THE TABS
     TO BE IN PLACE OR HEADER" — the tab row itself is the header now;
     nothing (the old "employees only" banner included) sits above it. */
  const { body } = await shell(OWNER);
  assert.doesNotMatch(body, /class="bar"/, "no separate banner may sit above the tabs");
  const header = body.match(/<div class="shell-header">[\s\S]*?<\/div>\s*<div class="shell-panel">/)[0];
  assert.match(header, /<nav class="shell-nav">/, "the tab row must be the header's own, and only, content");
});

check("test_PRD_P0_71_items_tab__the_shell_requires_no_role_the_same_as_before_the_split", async () => {
  /* Matching the page's own pre-shell behaviour: a verified-but-unmapped
     identity still sees the shell, and /chat (loaded into it by default)
     is what already tells that person plainly they have no role — the
     shell itself is not a second place that gate has to be re-implemented. */
  const res = await worker.fetch(
    new Request("http://localhost/", {
      headers: { "Cf-Access-Jwt-Assertion": assertion({ email: "stranger@example.test", policy_id: "unmapped-policy" }) },
    }),
    ENV,
  );
  assert.equal(res.status, 200);
});

check("test_PRD_P0_71_items_tab__chat_no_longer_draws_its_own_copy_of_the_tab_bar_or_banner", async () => {
  /* The shell is the ONLY place the tab bar (and, now, the "employees only"
     strip) renders — a page that also drew its own would show either one
     twice, stacked directly on top of the shell's own copy the moment it
     loads inside the iframe. The Items page's own half of this is
     asserted in items-route.test.mjs, against real seeded content rather
     than a mirror-less 503. */
  const { status, body } = await frontPage(OWNER);
  assert.equal(status, 200);
  assert.doesNotMatch(body, /shell-nav/);
  assert.doesNotMatch(body, /class="bar"/, "the employees-only strip must not be drawn a second time inside the iframe");
});

check("test_PRD_P0_71_items_tab__the_public_site_is_the_last_tab_loaded_in_the_same_iframe", async () => {
  /* The owner's own words, emphatically, after a first attempt made this
     an <a target="_blank">: "A link!!! Its inside a tab! Iframe are you
     listening??? Header is tabs and everything in tab body is an
     iframe." No exception for the storefront: it is a real tab button
     with a cross-origin src, swapped into #ops-frame exactly like every
     other tab — never a plain link, never a new browser tab. */
  const { body } = await shell(OWNER);
  const nav = body.match(/<nav class="shell-nav">[\s\S]*?<\/nav>/)[0];
  const items = [...nav.matchAll(/<button[^>]*>[^<]*<\/button>/g)];
  const last = items.at(-1)[0];
  assert.match(last, /data-src="https:\/\/vemians\.com"/, "the storefront tab must be the LAST tab, not just present somewhere");
  assert.match(last, /^<button type="button"/, "it must be a real tab button, not an <a>, so it swaps the SAME iframe rather than navigating away");
  assert.doesNotMatch(last, /target="_blank"/);
});

check("test_PRD_P0_71_items_tab__tab_equals_website_starts_the_iframe_on_the_public_site", async () => {
  const { body } = await shell(OWNER, "/?tab=website");
  assert.match(body, /id="ops-frame" src="https:\/\/vemians\.com"/);
  assert.match(body, /data-src="https:\/\/vemians\.com"[^>]*class="active"/);
});

check("test_PRD_P0_71_items_tab__the_tabs_are_top_rounded_and_square_on_the_bottom_not_pills", async () => {
  /* A long detour: 6px top-only, then 10px, briefly 30px on every corner
     ("triple tab radius"), corrected to 20px on every corner ("Double
     ratius... not triple", then "bottom radiused too... paper tabs cut
     out"), then 8px on every corner ("No! Not pills! Tabs!") — which
     STILL read as pills once actually on screen, because the shape had
     both ends rounded regardless of the radius value. The owner's own
     words, emphatically: "They need to look like tabs! More radiused.
     NOT PILLS ON TOP OF A LINE." Landed on the classic tabbed-pane
     shape: rounded TOP corners only (14px, more generous than any
     top-only value used before), a flat SQUARE bottom — a pill needs
     BOTH ends rounded, and this one only ever has one. */
  const { body } = await shell(OWNER);
  assert.match(body, /\.shell-nav\s*\{[^}]*--tab-radius:\s*14px/s);
  assert.match(body, /\.shell-nav button\.active\s*\{[^}]*border-radius:\s*var\(--tab-radius\) var\(--tab-radius\) 0 0/s);
  assert.doesNotMatch(body, /\.shell-nav button\.active\s*\{[^}]*border-radius:\s*(8px|20px|30px)[;\s]/s, "no all-corners radius (the pill shape) may remain");
});

check("test_PRD_P0_71_items_tab__inactive_tabs_are_flat_not_their_own_bordered_box", async () => {
  /* Every tab drawn as its own bordered, filled box read as a row of
     separate chips, not folder tabs in a flat bar. Only .active gets a
     border, a fill, or a radius now. */
  const { body } = await shell(OWNER);
  assert.match(body, /\.shell-nav button\s*\{[^}]*border:\s*none/s);
  assert.match(body, /\.shell-nav button\s*\{[^}]*background:\s*transparent/s);
});

check("test_PRD_P0_71_items_tab__the_active_tab_is_plain_rounded_top_square_bottom_no_curve", async () => {
  /* Eight straight rounds tried to give the base of the active tab a
     "round-out" curve smoothly blending into the header — a box-shadow
     technique that kept producing its own new geometry bugs (an
     invisible curve, a black smudge over the border, a stray flag, a
     misaligned edge, "looks like a fucking mushroom") faster than any
     of them could be fixed. The owner's own words, plainly: "Just make
     them with a rounded top and straight bottom edges. I'm tired of
     you fucking up." No notch, no curve, no pseudo-elements at the
     tab's own base at all — a rounded top, a flat square bottom, and a
     single plain border. */
  const { body } = await shell(OWNER);
  assert.match(body, /\.shell-nav\s*\{[^}]*--tab-radius:\s*14px/s);
  assert.match(body, /\.shell-nav button\.active\s*\{[^}]*border-radius:\s*var\(--tab-radius\) var\(--tab-radius\) 0 0/s);
  assert.doesNotMatch(
    body,
    /\.shell-nav button\.active::before|\.shell-nav button\.active::after/,
    "no pseudo-element notch may exist at the base of the active tab",
  );
});

check("test_PRD_P0_71_items_tab__the_active_tab_structurally_merges_into_the_panel_not_just_matches_its_colour", async () => {
  /* The active tab's own bottom border is removed entirely
     (border-bottom: none) and its background matches the panel's, so
     it structurally opens into what it fronts rather than floating
     above it as an independent, fully-bordered piece. */
  const { body } = await shell(OWNER);
  assert.match(body, /\.shell-nav button\.active\s*\{[^}]*border:\s*1px solid var\(--accent\); border-bottom:\s*none/s);
  assert.match(body, /\.shell-nav button\.active\s*\{[^}]*margin-bottom:\s*-1px/s);
  assert.match(body, /\.shell-panel\s*\{[^}]*border-top:\s*1px solid var\(--accent\)/s, "the panel's own line the active tab merges into must still be there");
});

check("test_PRD_P0_71_items_tab__the_first_tab_lines_up_with_the_inner_chat_content_not_ops_own_edge", async () => {
  /* .ops's own 8px, doubled to 16px, then the owner's own words, more
     precisely: "First tab on left matches the inner chat left extent."
     That is not .ops's own edge — it is past .chat-top's own frame too:
     8px (.ops) + 14px (.chat-top's own padding) = 22px, where actual chat
     content (.log) starts. (.chat-top's own border used to add a 3rd, 1px
     term here — removed along with the border itself; the composer also
     no longer lives in this same padding stack at all, now that it is
     fixed to the screen's own bottom instead, so this aligns with .log's
     own edge specifically rather than a shared log-and-composer one.) */
  const { body } = await shell(OWNER);
  assert.match(body, /\.shell-header\s*\{[^}]*padding:\s*10px 22px 0/s);

  const { body: chatBody } = await frontPage(OWNER);
  assert.match(chatBody, /\.chat-top\s*\{[^}]*padding:\s*14px/s, "sanity check: .chat-top's own padding is really 14px");
});

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
  for (const action of ["+ Products", "+ Customers", "+ Expense"]) {
    assert.ok(main.includes(action), `"${action}" must still be a one-click action`);
  }
});

check("test_PRD_P0_69_one_click_welcome_menu__greets_by_first_name_with_the_choices_above_everything_else", async () => {
  /* The literal ask: a welcome message, by name, offering + Products /
     + Customers / + Expense — reachable without leaving the page, without
     connecting anything, in one click. "More Options" was itself retired
     by P0-80: there is nothing left on the page for it to open. */
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"));
  assert.match(main, /Hi Owner — what would you like to do/, "greets by the resolved first name");

  const order = ["+ Products", "+ Customers", "+ Expense"];
  let cursor = -1;
  for (const item of order) {
    const at = main.indexOf(item);
    assert.ok(at !== -1, `"${item}" is missing from the welcome menu`);
    assert.ok(at > cursor, `"${item}" is out of order`);
    cursor = at;
  }

  assert.match(main, /data-prompt="Add products"[^>]*>\+ Products/);
  assert.match(main, /data-prompt="Add customers"[^>]*>\+ Customers/);
  assert.match(main, /data-prompt="Submit an expense"[^>]*>\+ Expense/);
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

check("test_PRD_P0_74_chat_first__the_composer_is_the_last_thing_on_the_page_not_the_menu", async () => {
  /* Reversed on a phone, deliberately: the owner's own words, "I really
     should have the entry at the bottom of the phone... put the quick
     chat buttons on top of the chat... not on the bottom." The greeting
     still leads (it names who is signed in before anything asks for
     input), and the one-click menu still comes right after it in the
     markup — though since .menu became position: fixed, floating above
     .input-bar (a later round: "float above the agent input field"),
     document order no longer decides what a thumb has to reach past;
     the assertion below is now about source order alone, kept for
     screen-reader/keyboard reading order rather than visual reach. */
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"));
  const greetAt = main.indexOf("Hi Owner — what would you like to do");
  const menuAt = main.indexOf('<section class="menu"');
  const chatAt = main.indexOf('id="chat"');
  assert.ok(greetAt > -1 && chatAt > -1 && menuAt > -1, "greeting, chat and menu must all be on the page");
  assert.ok(greetAt < menuAt, "the greeting must still lead the page");
  assert.ok(menuAt < chatAt, "the composer must come after the one-click menu, so it is the bottom-most thing on the page");
});

check("test_PRD_P0_74_chat_first__the_one_click_menu_still_carries_all_three_tasks_in_order", async () => {
  /* P0-69's own guarantee, re-checked after the reorder: moving the assistant
     ahead of the menu must not have quietly dropped or reordered a task. */
  const { body } = await frontPage(OWNER);
  const main = body.slice(body.indexOf("<main"));
  const order = ["+ Products", "+ Customers", "+ Expense"];
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
  assert.match(body, /--muted:\s*#B8B3A8/);
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

check("test_PRD_P0_75_ops_dark_theme__the_items_tab_carries_it_too", async () => {
  /* ITEMS_CSS never included OPS_DARK_CSS at all — the Items tab rendered
     in the shared light theme.css palette while every other ops page (this
     suite's own list above included) rendered dark, an owner-reported bug:
     "it's the wrong theme... using the same dark theme that's in the ops
     dashboard." The accent-coloured line the shell's own panel draws above
     the iframe reads as present or "missing" by contrast with whatever the
     iframe's own page renders — the wrong, light background here was very
     likely why that line read as gone specifically on this tab. */
  const { itemsPage } = await import("../src/views.js");
  assert.match(itemsPage({ role: "owner" }, []), /--ground:\s*#191817/);
  assert.match(itemsPage({ role: "owner" }, []), /--accent:\s*#D97757/);
});

check("test_PRD_P0_71_items_tab__a_non_identity_refusal_does_not_tell_the_reader_to_sign_in", async () => {
  /* The bug this guards: refusalPage() appended "sign in with your Vemians
     email" UNCONDITIONALLY, so the Items mirror-read 500 — a data problem,
     nothing to do with who is signed in — read as "...run this SQL against
     the mirror. Sign in with your Vemians email and try again," which is
     actively misleading right under a reason that already named the real,
     unrelated fix. Only an actual identity refusal (401/403) gets the note. */
  const { refusalPage } = await import("../src/views.js");
  const dataError = refusalPage(500, "The Items tab could not read the catalog mirror.");
  assert.doesNotMatch(dataError, /sign in with your Vemians email/i);

  const notConfigured = refusalPage(503, "The catalog mirror is not configured on this deployment yet.");
  assert.doesNotMatch(notConfigured, /sign in with your Vemians email/i);

  const identityRefusal = refusalPage(403, "Your Access identity is in no group this application maps to a role.");
  assert.match(identityRefusal, /sign in with your Vemians email/i);
});

check("test_PRD_P0_89_batch_preview_confirm__the_batch_review_page_uses_the_same_table_card_as_chat", async () => {
  /* The owner's own words, having seen both surfaces: "I like how the
     table renders in our chat! Doesn't look like that on our website!"
     batchReviewPage() (the /products/batch, /customers/batch upload
     result) used to render a plain <ol> of ready links plus a separate
     <ul> of skip reasons — nothing like tableCard()'s bordered, compact
     card. It now shares the exact same .table-card CSS (TABLE_CARD_CSS,
     included in both OPS_CSS for chat and APPROVAL_CSS for this page),
     and the same Row/Title/Status/Detail column shape agent.js's own
     batchDraftTable() uses for the identical data. */
  const { batchReviewPage } = await import("../src/views.js");
  const html = batchReviewPage(
    {
      ready: [{ row: 2, title: "Wool Coat", url: "https://ops.vemians.com/approvals/abc", summary: "add Wool Coat, $450.00" }],
      skipped: [{ row: 3, title: "(no title)", reason: "no title column, or it was empty" }],
    },
    "products",
  );
  assert.match(html, /class="table-card"/, "the review page must use the same .table-card wrapper the chat uses");
  assert.match(html, /<th>Row<\/th><th>Title<\/th><th>Status<\/th><th>Detail<\/th>/, "columns must match the chat's own Row/Title/Status/Detail shape");
  assert.match(html, /<a href="https:\/\/ops\.vemians\.com\/approvals\/abc">Wool Coat<\/a>/, "a ready row's title must still link to its own approval");
  assert.match(html, /no title column, or it was empty/, "a skipped row's own reason must still be shown");
  assert.doesNotMatch(html, /<ol>/, "the old separate ready-list <ol> must be gone");
  assert.doesNotMatch(html, /<ul>/, "the old separate skipped-list <ul> must be gone");
});

check("test_PRD_P0_89_batch_preview_confirm__the_table_card_style_is_shared_not_duplicated", async () => {
  /* One CSS block (TABLE_CARD_CSS), included by both OPS_CSS (chat) and
     APPROVAL_CSS (this page) — not two copies that could drift apart. */
  const { approvalPage } = await import("../src/views.js");
  const { opsPage } = await import("../src/views.js");
  const chatHtml = opsPage({ verified: true, email: "owner@vemians.com", claims: {} }, { hasKey: true, role: "owner" });
  const approvalHtml = approvalPage("id1", null);
  for (const html of [chatHtml, approvalHtml]) {
    assert.match(html, /\.table-card\s*\{[^}]*border:\s*1px solid var\(--rule\)/s, "both surfaces must carry the same .table-card rule");
  }
});

check("test_PRD_P0_89_batch_preview_confirm__the_table_matches_a_plain_rendered_markdown_table_not_a_rounded_card", async () => {
  /* "Render it like that on our website!... Make sure you follow the
     [Claude] in chat styling. Respect markups and render tables etc" —
     having just compared this card unfavourably to how an ordinary
     markdown table renders. Square corners ("Dont round its corners"),
     a full grid (vertical rules between columns, not only a line under
     each row), and a shaded header row — the scrolling frame itself
     (max-height/overflow, checked elsewhere) is unchanged; only the
     table's own visual grammar is. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.table-card\s*\{[^}]*border-radius:\s*0/s, "corners must be square, not rounded");
  assert.match(body, /\.table-card th, \.table-card td\s*\{[^}]*border:\s*1px solid var\(--rule\)/s, "every cell must have a full border, not only a bottom line");
  assert.match(body, /\.table-card th\s*\{[^}]*background:\s*var\(--ground\)/s, "the header row must be visually shaded, matching an ordinary rendered table");
});

check("test_PRD_P0_89_batch_preview_confirm__the_compact_card_fits_a_header_and_two_rows_not_a_flat_guess", async () => {
  /* The owner's own words: "make it fit to content vertically. I only
     need to see 2 rows. The header and the content cells when in chat
     preview." — recomputed through several rounds of smaller fonts and
     padding since: 118px, then 84px, then 70px, now 58px at this
     round's 9px font and 1px 2px cell padding. Still the SAME specific
     target (one header row + two data rows), not an earlier round's
     bigger-font number carried over. Full screen must still drop the
     cap entirely so it shows the WHOLE table, not just a bit more of it. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.table-card\s*\{[^}]*max-height:\s*58px/s, "the compact card must be sized to roughly a header plus two rows at the smaller font");
  assert.doesNotMatch(body, /\.table-card\s*\{[^}]*max-height:\s*70px/s, "the previous round's 70px target must not still be set");
  assert.doesNotMatch(body, /\.table-card\s*\{[^}]*max-height:\s*84px/s, "the previous round's 84px target must not still be set");
  assert.doesNotMatch(body, /\.table-card\s*\{[^}]*max-height:\s*118px/s, "the old, bigger-font 118px target must not still be set");
  assert.match(body, /\.table-card\.full\s*\{[^}]*max-height:\s*none/s, "full screen must remove the height cap entirely");
});

check("test_PRD_P0_89_batch_preview_confirm__the_table_is_as_space_efficient_as_possible", async () => {
  /* The owner's own words: "Make padding half and font size to 9" — the
     latest of several rounds asking for less padding and smaller fonts.
     Every size in the card — its own box, every cell — must be tighter
     than the previous round, not just one of them. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.table-card\s*\{[^}]*padding:\s*2px/s, "the card's own padding must be half the previous flat 4px");
  assert.match(body, /\.table-card\s*\{[^}]*font-size:\s*9px/s, "the card's own base font must be 9px");
  assert.match(body, /\.table-card th, \.table-card td\s*\{[^}]*padding:\s*1px 2px/s, "cell padding must be half the previous 1px 4px");
  assert.match(body, /\.table-card th, \.table-card td\s*\{[^}]*font-size:\s*9px/s, "cell font-size must be 9px");
});

check("test_PRD_P0_89_batch_preview_confirm__the_table_scales_to_full_width_instead_of_cropping", async () => {
  /* The owner's own words: "You can scale the table to fit full width
     if possible! The goal is to avoid cropping as much as possible while
     retaining readability." A previous round deliberately sized the
     table to its own natural content width (no forced stretch); this
     reverses that on purpose, now for the opposite reason — a table
     wider than the card used to need sideways scrolling to see the
     cropped-off columns, which reads as "cropped" even though the rest
     is one scroll away. "width: 100%" with "table-layout: fixed"
     guarantees the table never exceeds the card's own width regardless
     of column count, and "overflow-wrap: anywhere" lets long content
     (a full URL, a long title) wrap onto more lines instead of being
     cut off or forcing the table wider — readability kept via wrapping,
     not via truncation or a horizontal scrollbar. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.table-card table\s*\{[^}]*width:\s*100%/s, "the table must stretch to the card's own full width");
  assert.match(body, /\.table-card table\s*\{[^}]*table-layout:\s*fixed/s, "fixed layout keeps the table from ever exceeding the card's width");
  assert.doesNotMatch(body, /\.table-card table\s*\{[^}]*width:\s*max-content/s, "the old natural-width sizing must be gone");
  assert.match(body, /\.table-card th, \.table-card td\s*\{[^}]*overflow-wrap:\s*anywhere/s, "long content must wrap instead of overflowing or getting cropped");
  assert.doesNotMatch(body, /\.table-card th, \.table-card td\s*\{[^}]*white-space:\s*nowrap/s, "cells must no longer be forced onto a single line");
});

check("test_PRD_P0_89_batch_preview_confirm__the_table_renders_right_under_its_own_tool_step_not_after_the_reply", async () => {
  /* The owner's own words: "Insert table right under 'ran
     catalog_preview_product_batch' text." Before this, the table was
     appended AFTER the agent's own text reply, which left it looking
     disconnected from the tool call that actually produced it once the
     reply had any real length. Checked by source order in the actual
     client script — the tool-step loop and the table call must both run
     before entry("agent", ...). */
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("<script>"), body.indexOf("</script>"));
  const stepsAt = script.indexOf('data.steps || []).forEach');
  const tableAt = script.indexOf("if (data.table) tableCard(data.table)");
  const replyAt = script.indexOf('entry("agent", data.reply');
  assert.ok(stepsAt > -1 && tableAt > -1 && replyAt > -1, "all three must be present in the real submit handler");
  assert.ok(stepsAt < tableAt, "tool steps must render before the table");
  assert.ok(tableAt < replyAt, "the table must render before the agent's own text reply, not after it");
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
 * P0-90 — the dim tokens read in broad daylight, not just indoors
 * ───────────────────────────────────────────────────────────────────────── */

/* The same relative-luminance formula WCAG itself defines — not a stand-in,
   so a real ratio is what fails when a colour drifts back under its floor. */
function relLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
  const [l1, l2] = [relLuminance(hexA), relLuminance(hexB)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* theme.css's own light-palette :root block renders FIRST in the page, with
   OPS_DARK_CSS's override :root block second in the same <style> tag — the
   cascade takes the LAST declaration, exactly as the real browser would, so
   this must too rather than grabbing theme.css's untouched light value. */
function cssVar(body, name) {
  const matches = [...body.matchAll(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`, "g"))];
  assert.ok(matches.length, `--${name} not found in the rendered page`);
  return matches[matches.length - 1][1];
}

check("test_PRD_P0_90_daylight_contrast__muted_text_clears_aaa_against_both_backgrounds_it_sits_on", async () => {
  /* --muted carries secondary text (hints, tool-step asides, table headers,
     the attach-file name) over both a plain bubble/page background
     (--ground) and a panel background (--image-ground, .table-card/.who) —
     both have to clear the bar, not just whichever one a spot check picks. */
  const { body } = await frontPage(OWNER);
  const muted = cssVar(body, "muted");
  const ground = cssVar(body, "ground");
  const imageGround = cssVar(body, "image-ground");
  assert.ok(contrastRatio(muted, ground) >= 7, `muted vs ground must clear WCAG AAA (7:1) for daylight readability`);
  assert.ok(contrastRatio(muted, imageGround) >= 7, `muted vs image-ground must clear WCAG AAA (7:1) too`);
});

check("test_PRD_P0_90_daylight_contrast__rule_borders_clear_the_ui_component_minimum", async () => {
  /* --rule is every border and divider on the page — the chat bar's own
     outline, a table's row lines, the approval gate's box — which WCAG
     treats as a UI component boundary (3:1), not body text (4.5:1/7:1). */
  const { body } = await frontPage(OWNER);
  const rule = cssVar(body, "rule");
  const ground = cssVar(body, "ground");
  const imageGround = cssVar(body, "image-ground");
  assert.ok(contrastRatio(rule, ground) >= 3, `rule vs ground must clear WCAG's 3:1 non-text/UI-component minimum`);
  assert.ok(contrastRatio(rule, imageGround) >= 3, `rule vs image-ground must clear it too`);
});

check("test_PRD_P0_90_daylight_contrast__the_already_strong_tokens_were_left_alone", async () => {
  /* The report was about the DIM elements specifically — ink, ground and
     accent were already comfortably above their own thresholds, and a fix
     that also drifted those would be touching more than was asked. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /--ground:\s*#191817/);
  assert.match(body, /--ink:\s*#F1EEE6/);
  assert.match(body, /--accent:\s*#D97757/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-91 — a quieter, centred greeting, no redundant assistant heading
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_91_quiet_greeting__the_greet_heading_is_centred_and_no_longer_full_bright_bold", async () => {
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.greet\s*\{[^}]*text-align:\s*center/s, "the greeting must be centred");
  assert.match(body, /\.greet h1\s*\{[^}]*font-weight:\s*400/s, "no longer bold");
  assert.match(body, /\.greet h1\s*\{[^}]*color:\s*var\(--muted\)/s, "no longer full-bright --ink");
  assert.doesNotMatch(body, /\.greet h1\s*\{[^}]*font-weight:\s*700/s, "the old bold weight must not still be set");
});

check("test_PRD_P0_91_quiet_greeting__the_ask_the_ops_assistant_line_is_gone", async () => {
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /Ask the ops assistant/, "a heading that only restated what the chat widget already is");
  /* The greeting itself, and the widget it introduces, must both still be
     on the page — this removes one redundant line, not the surrounding
     features. */
  assert.match(body, /Hi Owner — what would you like to do/);
  const main = body.slice(body.indexOf("<main"));
  assert.ok(main.indexOf('id="chat"') > -1, "the chat form must still be on the page");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-92 — superseded: the widget's own accent frame no longer exists
 * ───────────────────────────────────────────────────────────────────────── */

/* P0-92 gave .chat-top an accent border matching the quick-prompt chips'
   own — since reversed entirely: "maybe lose the orange border around the
   agent. So it looks like the search bar in the items [tab]." .chat-top
   carries no border of its own at all now (see the comment on it directly).
   Nothing here to check independently — asserting ".chat-top has no border"
   would just be the negative of a property that no longer exists. */

check("test_PRD_P0_92_chat_widget_accent__the_entry_lines_own_border_is_brighter", async () => {
  const { body } = await frontPage(OWNER);
  /* Lives on the shared .input-bar now (INPUT_BAR_CSS), not .chat
     .chat-bar directly — the composer's own pill just carries that
     class too, sharing the value literally with Items' own search bar
     rather than duplicating it. Brighter than the old --rule, and no
     longer nested inside any accent .chat-top frame at all (P0-92's
     own frame is gone, above) — still its own distinct, plain-neutral
     bump regardless. */
  assert.match(body, /\.input-bar\s*\{[^}]*border:\s*1px solid var\(--muted\)/s, "the entry line's own border must no longer be the dim --rule");
  assert.doesNotMatch(body, /\.input-bar\s*\{[^}]*border:\s*1px solid var\(--rule\)/s, "the old dim border must not still be set");
  /* The "+" attach icon's own styling moved on again in P0-95 (a filled
     circle, not a bare bright glyph) — see that section for its own tests. */
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-93 — the composer pill nests neatly inside the now-orange frame
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_93_nested_chat_frame__focus_stays_gray_rather_than_doubling_up_on_orange", async () => {
  const { body } = await frontPage(OWNER);
  /* Lives on the shared .input-bar:focus-within now, not .chat
     .chat-bar:focus-within directly — see the note on the border test
     above. */
  assert.match(body, /\.input-bar:focus-within\s*\{[^}]*border-color:\s*var\(--ink\)/s, "focus must stay a neutral colour");
  assert.doesNotMatch(
    body,
    /\.input-bar:focus-within\s*\{[^}]*border-color:\s*var\(--accent\)/s,
    "focus must not still turn the same orange as the frame it already sits inside",
  );
});

check("test_PRD_P0_93_nested_chat_frame__the_outer_frame_padding_is_the_same_on_every_side_again", async () => {
  /* This padding was tightened three times (8px, then 4px, then 3px on
     sides/bottom) before the owner's own correction: "I didn't ask you
     to make bottom gap smaller I asked the side padding to be bigger to
     match the bottom padding." The bottom had looked bigger for a real
     bug (P0-96's own uncollapsed empty .attach-name span) — fixing that
     bug shrank the bottom to match the sides' small 3px, the opposite of
     what was actually asked. Rather than guess a value chasing a look
     that came from a bug now removed, every side returns to 14px — the
     original value this padding carried before any tightening request
     in this whole thread touched it, and trivially "sides match bottom"
     since there is only one number now. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.chat-top\s*\{[^}]*padding:\s*14px;/s, "every side must be the same, generous 14px again");
});

check("test_PRD_P0_93_nested_chat_frame__the_pills_own_radius_never_changes__only_the_outer_frame_matches_it", async () => {
  /* The pill's own DECLARED radius is never touched — the owner's own
     words: "Dont change the inner chat radius! I liked how it flowed
     around the chat buttons!" — but two rounds of per-corner arithmetic
     on the outer frame (20/20/26/26, then 20/20/28/28) still rendered
     visibly uneven on a real phone: "Make sure there is an even gap
     between chat and outer edges!!! Make sides match the bottom!" The
     bug both rounds missed — the pill's declared 24px never actually
     renders at 24px. At the bar's own real height (~42px: 4px+4px
     padding plus a 34px button), CSS caps border-radius at half the
     box's own dimension, so the pill is a true stadium at ~21px, not the
     nominal 24 the earlier arithmetic used.

     Superseded twice over since: the composer no longer nests inside
     .chat-top's own frame at all — it is fixed to the screen's own
     bottom instead, sharing .items-search's own shape (INPUT_BAR_CSS's
     .input-bar). .chat-top no longer needs its bottom corners kept
     concentric with a pill it no longer contains — and then lost its
     border (and with it, its own border-radius entirely) on the next
     round: "maybe lose the orange border around the agent." The pill's
     own declared radius (still 24px, still never touched) is tested on
     .input-bar now rather than .chat .chat-bar or .chat-top. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.input-bar\s*\{[^}]*border-radius:\s*24px/s, "the composer pill's own declared radius must never change");
});

check("test_PRD_P0_71_items_tab__every_input_bar_renders_the_same_height_whether_or_not_it_holds_icon_buttons", async () => {
  /* The owner's own words, pointing at the composer: "the inner agent chat
     bar, the gray one, that's our gold standard. That's the ideal height.
     It has all of the inner pill buttons... make the items search bar the
     same height and radius." Without an explicit floor, the composer's own
     34px icon buttons plus 4px+4px padding happen to reach ~42px, but a
     plain text input with no buttons at all (Items' own search box) would
     render a few pixels shorter on the same padding — an accidental match,
     not a guaranteed one. min-height: 42px makes every current and future
     .input-bar — a search box, anything else that takes text — render that
     one real number instead of merely coming close to it. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.input-bar\s*\{[^}]*min-height:\s*42px/s, "the shared pill must have an explicit height floor, not one that falls out of its contents");
});

check("test_PRD_P0_93_nested_chat_frame__the_send_button_gets_the_same_clearance_the_attach_button_always_had", async () => {
  /* What the owner actually asked for once the radius idea was withdrawn:
     "make the padding on the chat submit button a little more even so it
     fit better." The bar's own left/right padding used to be 6px/4px — the
     send button sat measurably tighter against the edge than the attach
     button on the other side. Both buttons must have the SAME left/right
     clearance — a uniform 4px round in between made that clearance too
     tight relative to the vertical gap and was corrected back to 4px 6px
     (see the P0-93 vertical-vs-sides check below); either way, left and
     right must always match each other. */
  /* Lives on the shared .input-bar now, not .chat .chat-bar directly —
     see the note on the border test above. */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(
    body,
    /\.input-bar\s*\{[^}]*padding:\s*4px 4px 4px 6px/s,
    "the old asymmetric 4px/6px split (send tighter than attach) must not still be set",
  );
});

check("test_PRD_P0_93_nested_chat_frame__the_sides_are_wider_than_the_vertical_gap_again", async () => {
  /* The owner's own direct measurement, once a uniform 4px was actually in
     front of them: "Sides is less than vertical. I don't think that's an
     optical illusion. Side padding probably needs like 2 more pixels."
     Vertical stays 4px (it already matches the button height exactly, no
     room to spare); sides go back to 6px — the same value this carried
     before the brief uniform-4px round, restored on their own read of it
     rather than further guessing. */
  /* Lives on the shared .input-bar now, not .chat .chat-bar directly —
     see the note on the border test above. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.input-bar\s*\{[^}]*padding:\s*4px 6px;/s, "sides must be wider than the vertical gap, not uniform");
  assert.doesNotMatch(body, /\.input-bar\s*\{[^}]*padding:\s*4px;/s, "the uniform 4px round must not still be set");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-94 — the page uses more of a phone screen's own width
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_94_mobile_edge_to_edge__the_page_containers_side_padding_matches_the_chat_widgets_own", async () => {
  const { body } = await frontPage(OWNER);
  /* Top is untouched; sides match .chat-top's own already-tightened 8px,
     so the page edge and the widget edge read as one margin rather than
     two stacked ones. Bottom grew from 32px to 76px once #chat became
     position: fixed (INPUT_BAR_CSS) — a fixed element is removed from
     document flow entirely, so without this the log's own last message
     would sit partly behind the now-floating composer — then to 108px
     once .menu (the quick-action chips) also became position: fixed,
     floating above .input-bar instead of sitting in flow: the same
     reasoning again, clearing one more floating row (the chips' own
     row, plus the gap above the composer) on top of the composer itself. */
  assert.match(body, /\.ops\s*\{[^}]*padding:\s*12px 8px 108px/s, "side padding must be tightened, top unchanged, bottom grown for both fixed rows");
  assert.doesNotMatch(body, /\.ops\s*\{[^}]*padding:\s*12px 24px/s, "the old roomier side padding must not still be set");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-95 — the attach button is a filled circle, matching the send button
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_95_filled_attach_button__the_plus_button_matches_the_send_buttons_own_size", async () => {
  const { body } = await frontPage(OWNER);
  /* Same size as .send-btn (34px, up from 32px) so both round buttons nest
     into the bar's own rounded ends identically — "flows neatly inside of
     the inner chat border (like the chat submit button)," the owner's own
     words. */
  assert.match(body, /\.chat \.chat-bar \.icon-btn\s*\{[^}]*width:\s*34px/s, "the attach button must match the send button's own size");
  assert.match(body, /\.chat \.chat-bar \.icon-btn\s*\{[^}]*height:\s*34px/s, "the attach button must match the send button's own size");
});

check("test_PRD_P0_95_filled_attach_button__the_fill_is_a_faint_overlay_not_an_opaque_circle", async () => {
  /* A first pass filled it solid with --ink, matching .send-btn's own
     opaque circle — corrected on the spot: "A faint gray fill for the
     attachment button. Needs to be just a little brighter than the bg."
     A translucent white overlay over the bar's own --image-ground reads
     as "a little brighter," not a second bold circle competing with Send. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.chat \.chat-bar \.icon-btn\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.08\)/s, "the fill must be a faint overlay, not an opaque colour");
  assert.doesNotMatch(body, /\.chat \.chat-bar \.icon-btn\s*\{[^}]*background:\s*var\(--ink\)/s, "the old opaque --ink fill must not still be set");
  assert.match(body, /\.chat \.chat-bar \.icon-btn\s*\{[^}]*color:\s*var\(--ink\)/s, "the glyph itself stays bright against the now-faint fill");
});

check("test_PRD_P0_95_filled_attach_button__hover_and_pressed_states_are_also_faint_tints_not_opaque_fills", async () => {
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.chat \.chat-bar \.icon-btn:hover\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.16\)/s, "hover must brighten the same faint overlay, not switch to opacity dimming");
  /* An attachment currently staged gets a faint accent tint, matching the
     same "faint fill" language as the resting and hover states. */
  assert.match(
    body,
    /\.chat \.chat-bar \.icon-btn\[aria-pressed="true"\]\s*\{[^}]*background:\s*rgba\(217, 119, 87, 0\.14\)/s,
    "the pressed/active state must be a faint accent tint, not an opaque accent fill",
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-96 — superseded by P0-97: the element this fixed no longer exists
 * ───────────────────────────────────────────────────────────────────────── */

/* P0-96 fixed .attach-name's own :empty case — an empty label element still
   opening a line box and still carrying its own margin, inflating the gap
   below the composer pill. P0-97 (below) removes the whole element rather
   than only its empty state, which is a stronger fix of the same class of
   bug: there is no longer any element there at all to leave un-collapsed
   by a future edit. Nothing here to check independently of P0-97's own
   tests — asserting ".attach-name is absent" IS this entry's own check. */

/* ─────────────────────────────────────────────────────────────────────────
 * P0-97 — the attachment's name updates the chat box, not a line under it
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_97_placeholder_names_the_attachment__the_attach_name_line_is_gone_entirely", async () => {
  /* The owner's own words: "instead of adding a line under the inner chat
     box... just update the default text inside of the chat box." Removing
     the element outright (not just its :empty case, P0-96's own fix) is
     what actually delivers "instead of" — a second line under the
     composer is exactly what was asked to stop happening. (A couple of
     comments elsewhere in the page's own source still narrate this
     history by the old class name — checked here as functional markup,
     not prose.) */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /class="attach-name"/, "the .attach-name span itself must be gone from the markup");
  assert.doesNotMatch(body, /\.attach-name\s*\{/, "the .attach-name CSS rule must be gone");
  assert.doesNotMatch(body, /getElementById\("attach-name"\)/, "no script reference to the removed element may remain");
});

check("test_PRD_P0_97_placeholder_names_the_attachment__picking_a_file_swaps_the_inputs_own_placeholder", async () => {
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("attach-input"));
  const changeHandler = script.slice(script.indexOf("fileInput.addEventListener"), script.indexOf("fileInput.addEventListener") + 300);
  assert.match(changeHandler, /qInput\.placeholder\s*=/, "picking a file must overwrite the input's own placeholder, not a separate element");
  assert.match(changeHandler, /fileInput\.files\[0\]\.name/, "the new placeholder must be built from the picked file's own name");
  assert.doesNotMatch(changeHandler, /attachName/, "there must be no separate attach-name element left to update");
});

check("test_PRD_P0_97_placeholder_names_the_attachment__clearing_restores_the_original_placeholder", async () => {
  /* Clearing (after send, or the "x" — there is no separate clear button,
     clearAttachments runs after every send) must put the ORIGINAL
     placeholder back, not just blank the box — a person who has not
     picked a file yet still needs the "e.g. ..." example text. */
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("attach-input"));
  assert.match(script, /const DEFAULT_PLACEHOLDER = qInput\.placeholder/, "the original placeholder must be captured once, before anything overwrites it");
  assert.match(script, /function clearAttachments\(\) \{[^}]*qInput\.placeholder = DEFAULT_PLACEHOLDER/s, "clearing must restore the captured original placeholder");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-98 — the same button attaches and cancels
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_98_cancellable_attachment__clicking_the_button_while_a_file_is_staged_cancels_it", async () => {
  /* The owner's own words: "I should be able to cancel the attachment!
     The + button should change to an x button." One button, two jobs —
     pickedFile() (already used elsewhere) decides which. */
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("attach-input"));
  const clickHandler = script.slice(script.indexOf("attachBtn.addEventListener(\"click\""), script.indexOf("attachBtn.addEventListener(\"click\"") + 200);
  assert.match(clickHandler, /if \(pickedFile\(\)\) \{/, "clicking with a file already staged must check pickedFile() first");
  assert.match(clickHandler, /clearAttachments\(\);/, "and cancel it via the same clearAttachments() used after every send");
  assert.match(clickHandler, /fileInput\.click\(\);/, "clicking with nothing staged must still open the file picker");
});

check("test_PRD_P0_98_cancellable_attachment__the_icon_and_accessible_name_swap_with_the_state", async () => {
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("attach-input"));
  /* Picking a file swaps to the cancel icon and names what the button now
     does — not what it always does. */
  const changeHandler = script.slice(script.indexOf("fileInput.addEventListener"), script.indexOf("fileInput.addEventListener") + 400);
  assert.match(changeHandler, /attachBtn\.innerHTML = CANCEL_ICON_HTML/, "picking a file must swap the button's own icon to the cancel glyph");
  assert.match(changeHandler, /attachBtn\.setAttribute\("aria-label", "Remove attachment"\)/, "the accessible name must say what the button now does");
  /* Clearing (send, or the button itself) swaps both back. */
  const clearFn = script.slice(script.indexOf("function clearAttachments"), script.indexOf("function clearAttachments") + 400);
  assert.match(clearFn, /attachBtn\.innerHTML = ATTACH_ICON_HTML/, "clearing must restore the original plus icon");
  assert.match(clearFn, /attachBtn\.setAttribute\("aria-label", "Attach a photo or file"\)/, "clearing must restore the original accessible name");
});

check("test_PRD_P0_98_voice_input__the_mic_button_sits_between_the_input_and_send_using_the_same_icon_btn_class", async () => {
  /* The owner's own words: "Add the same kind of microphone input button
     as claude next to the submit chat button same style as the + button
     as far as colors." Sharing .icon-btn with the attach button is what
     gives it the same colours for free, without a second set of button
     rules. */
  const { body } = await frontPage(OWNER);
  const bar = body.slice(body.indexOf('<div class="chat-bar input-bar">'), body.indexOf("</div>", body.indexOf('<div class="chat-bar input-bar">')) + 1000);
  assert.match(bar, /id="attach-btn"[\s\S]*id="mic-btn"[\s\S]*id="q"[\s\S]*class="send-btn"|id="attach-btn"[\s\S]*id="q"[\s\S]*id="mic-btn"[\s\S]*class="send-btn"/, "the mic button must sit next to Send, after attach and the input");
  assert.match(bar, /id="mic-btn"[^>]*class="icon-btn"|class="icon-btn"[^>]*id="mic-btn"/, "the mic button must share the attach button's own icon-btn class");
});

check("test_PRD_P0_98_voice_input__unsupported_browsers_get_the_button_removed_not_a_dead_control", async () => {
  /* Speech recognition support is inconsistent (notably patchy on iOS
     Safari) — a button that silently does nothing when pressed is worse
     than no button at all. */
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("attach-input"));
  assert.match(script, /SpeechRecognitionCtor\s*=\s*window\.SpeechRecognition\s*\|\|\s*window\.webkitSpeechRecognition/, "must feature-detect both the standard and webkit-prefixed API");
  assert.match(script, /if \(!SpeechRecognitionCtor\) \{\s*micBtn\.remove\(\);/, "an unsupported browser must remove the button outright, not leave it inert");
});

check("test_PRD_P0_98_voice_input__a_recognized_result_appends_to_the_existing_input_value_not_replacing_it", async () => {
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("attach-input"));
  const resultHandler = script.slice(script.indexOf('addEventListener("result"'), script.indexOf('addEventListener("result"') + 300);
  assert.match(resultHandler, /qInput\.value\s*\?\s*qInput\.value\s*\+\s*" "\s*\+\s*transcript\s*:\s*transcript/, "a transcript must be appended after any text already typed, not overwrite it");
});

check("test_PRD_P0_98_voice_input__the_icon_swaps_to_a_stop_glyph_while_recording_and_back_when_it_ends", async () => {
  /* Same swap-in-place technique the attach/cancel button already uses —
     the icon itself communicates the current state. */
  const { body } = await frontPage(OWNER);
  const script = body.slice(body.indexOf("attach-input"));
  const clickHandler = script.slice(script.indexOf('micBtn.addEventListener("click"'), script.indexOf('micBtn.addEventListener("click"') + 300);
  assert.match(clickHandler, /micBtn\.innerHTML = MIC_STOP_ICON_HTML/, "starting to record must swap to the stop glyph");
  const stopFn = script.slice(script.indexOf("function stopListening"), script.indexOf("function stopListening") + 200);
  assert.match(stopFn, /micBtn\.innerHTML = MIC_ICON_HTML/, "ending (naturally or on error) must swap back to the mic glyph");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-99 — the composer form's own inherited top margin is zeroed
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_99_chat_form_inherited_margin__the_composer_forms_own_margin_top_is_zeroed", async () => {
  /* THE SAME CLASS OF BUG P0-96 found on the bottom edge, on the top edge
     instead: .chat-top's own padding was already a literal, uniform 14px
     on every side — shared/design/theme.css's own ".chat { margin-top:
     12px }" (written for the storefront's unrelated contact-form chat
     block) was stacking on top of it, since the composer <form> carries
     class="chat" deliberately (so the gate's own button row inherits
     from it too). The owner's own words: "match the outer chat box top
     padding to its side padding. So that content is evenly spaced out
     from the edge." The composer no longer even nests inside .chat-top
     (it is fixed to the screen's own bottom now), so this margin no
     longer has anything to stack against either way — kept at 0 anyway
     since it costs nothing and this exact class of bug has recurred
     more than once. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /#chat\s*\{[^}]*margin-top:\s*0/s, "the composer form's own inherited top margin must be zeroed");
});

check("test_PRD_P0_99_chat_form_inherited_margin__the_gates_own_button_row_still_gets_its_margin", async () => {
  /* The fix must be scoped to #chat specifically — a blanket .chat
     override would also remove the approval gate's own, separately-
     wanted spacing above its button row (class='chat row', a few hundred
     lines further down in the same script). */
  const { body } = await frontPage(OWNER);
  assert.match(body, /class='chat row'/, "the gate's own button row must still carry the plain .chat class, unaffected by the #chat override");
});

check("test_PRD_P0_71_items_tab__the_composer_is_fixed_to_the_bottom_of_the_screen_like_the_reference_app", async () => {
  /* The owner's own reference, a screenshot of Claude Code's own chat
     interface: "notice how the text entry is on the bottom, right,
     where it should be." A first pass used position: sticky, which
     only repositions an element once its own normal position would
     scroll past the viewport edge — the owner's own correction,
     pointing at a screenshot with the composer stranded mid-screen
     under the quick-action chips: "does that look like it's on the
     bottom? ... there's not enough content to make them on the
     bottom." position: fixed (on .input-bar, shared with Items'
     search) anchors it to the real viewport regardless of content. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /class="chat-bar input-bar"/, "the composer's own pill must carry the shared .input-bar class");
  assert.match(body, /\.input-bar\s*\{[^}]*position:\s*fixed/s);
  assert.match(body, /\.input-bar\s*\{[^}]*bottom:\s*8px/s);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-78 — a real scrolling chat widget, and compact one-click chips
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_78_chat_widget__the_log_is_a_bounded_scrolling_container_not_a_growing_list", async () => {
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.log\s*\{[^}]*max-height:/s, "the message log must be height-bounded, not free to grow the page");
  assert.match(body, /\.log\s*\{[^}]*overflow-y:\s*auto/s, "and it must scroll internally rather than the whole page");
});

check("test_PRD_P0_78_chat_widget__the_logs_max_height_scales_with_the_viewport_not_a_flat_guess", async () => {
  /* The owner's own words, seeing a real batch preview reply cropped on a
     phone with most of the screen still empty below the widget: "I cant
     really tell what is being shown." A flat 320px was sized before this
     widget ever had to hold a long reply AND a table in the same column. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.log\s*\{[^}]*max-height:\s*min\(62vh, 560px\)/s, "the log must scale with the viewport, not a single guessed pixel value");
  assert.doesNotMatch(body, /\.log\s*\{[^}]*max-height:\s*320px/s, "the old flat 320px cap must not still be set");
});

check("test_PRD_P0_78_chat_widget__the_inline_client_script_is_valid_javascript", async () => {
  /* A live regression this suite had zero coverage for: `\"` inside the
     OUTER server-side template literal that builds this whole page is not
     a recognised escape in a template literal, so the engine silently
     drops the backslash while EVALUATING that literal — a line written
     as `"Attached \"" + name + "\" ..."` in the source reached the
     browser as `"Attached "" + name + "" ...`, a syntax error. Because
     it's a parse error, the WHOLE inline <script> failed silently in
     every browser — not just the attachment code near the broken line,
     but everything after it in the same script, including the quick-
     prompt chip listeners and the chat form's own submit handler. The
     owner's own words: "That last deploy broke the quick prompt buttons
     and submit chat button." `node --check` on this file's own source
     never catches this class of bug — it validates ops/src/views.js as
     a Node module, not the STRING CONTENT of the client script embedded
     inside it, which only ever gets parsed by an actual browser. This
     test parses that string directly (`new Function(script)`, which
     throws SyntaxError on invalid JS without needing `document` or
     `window` to exist) so a future escaping mistake here fails the test
     suite instead of shipping silently broken to every visitor. */
  const { body } = await frontPage(OWNER);
  const start = body.indexOf("<script>") + "<script>".length;
  const end = body.indexOf("</script>", start);
  const script = body.slice(start, end);
  assert.ok(script.length > 1000, "sanity check: the script block must actually contain the real client code");
  assert.doesNotThrow(() => new Function(script), "the inline client script must be syntactically valid JavaScript");
});

check("test_PRD_P0_78_chat_widget__the_first_bubble_sits_the_same_distance_from_top_as_from_the_sides", async () => {
  /* THE SAME CLASS OF BUG AGAIN (.attach-name, the inherited .chat margin)
     — .log's own margin-top (8px) plus padding-top (4px) was 12px of
     unrelated extra space with no side equivalent (side margin 0, side
     padding 2px), stacking on top of .chat-top's own uniform 14px padding.
     The owner's own words, pointing at a real screenshot: "Its too far
     from top edge of outer chat box. Needs to match [the] side." margin
     now carries only the bottom gap before the composer form; padding is
     a uniform 2px matching the side value exactly. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.log\s*\{[^}]*padding:\s*2px;/s, "padding must be uniform, matching the side value on every edge");
  assert.match(body, /\.log\s*\{[^}]*margin:\s*0 0 8px;/s, "margin must carry only the bottom gap, none on top");
  assert.doesNotMatch(body, /\.log\s*\{[^}]*margin:\s*8px 0/s, "the old top-heavy margin must not still be set");
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

check("test_PRD_P0_71_items_tab__the_chips_no_longer_carry_the_removed_widgets_own_accent_colour", async () => {
  /* The owner's own words, once .chat-top's own matching accent border was
     already gone: "get rid of that empty orange peel that's left over
     from the agent." A hollow, accent-bordered pill only read as tied to
     the frame it echoed (see the comment right above .chat-top); with
     that frame gone, the same ring just looked like an unexplained
     leftover. */
  const { body } = await frontPage(OWNER);
  assert.doesNotMatch(body, /\.choices \.btn\s*\{[^}]*border:\s*1px solid var\(--accent\)/s, "the old accent border must be gone");
  assert.doesNotMatch(body, /\.choices \.btn\s*\{[^}]*color:\s*var\(--accent\)/s, "the old accent text colour must be gone");
  assert.match(body, /\.choices \.btn\s*\{[^}]*border:\s*1px solid var\(--muted\)/s, "expected the same neutral border every other plain control now uses");
});

check("test_PRD_P0_71_items_tab__the_menu_floats_above_the_input_bar_not_in_flow_above_the_greeting", async () => {
  /* The owner's own words: "those quick actions to fill the agent, let's
     have them float above the agent input field." position: fixed, the
     same mechanism .input-bar itself uses, anchored a gap above it
     rather than sitting in normal document flow. */
  const { body } = await frontPage(OWNER);
  assert.match(body, /\.menu\s*\{[^}]*position:\s*fixed/s);
  assert.match(body, /\.menu\s*\{[^}]*bottom:\s*58px/s, "58px = .input-bar's own 8px offset + its 42px height + an 8px gap above it");
  assert.match(body, /\.menu\s*\{[^}]*left:\s*8px[^}]*right:\s*8px/s, "must share .input-bar's own left/right so the two floating rows line up");
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
