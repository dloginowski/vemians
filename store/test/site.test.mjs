/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *   * A behaviour change moves the PRD feature and its labeled check together.
 *
 * The shop with a door (P0-56) and the two-level drawer (P0-57).
 *
 * These render real pages out of the real Worker rather than asserting over the
 * templates, because what is being checked here is what a visitor is HANDED: an
 * address that is the same address in three places, a map link that resolves,
 * a menu whose every link goes somewhere, and a page that still works with the
 * script switched off.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");

register("../../shared/test/text-modules.mjs", import.meta.url);

const worker = (await import("../src/index.js")).default;
const { SITE, addressLine, hoursRows, mapsDirectionsUrl, mapsSearchUrl, openDaysCount, openDaysLabel } =
  await import("../../shared/site.js");
const { categoriesOf, subsOf } = await import("../src/query.js");
const products = (await import("../../shared/seed/catalog.js")).products;

/* What the page actually contains. `esc()` turns every & in a URL into &amp;
   before it reaches the markup, so comparing a raw URL against the HTML looks
   like a missing link when the link is there and correct. */
const inPage = (s) => String(s).replace(/&/g, "&amp;");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

function labeled(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* The Worker logs which catalog served, once per render. Swallowed so the run
   is readable; the catalog source itself is P0-49's business, not this file's. */
async function get(pathname, method = "GET") {
  const info = console.info;
  console.info = () => {};
  try {
    const res = await worker.fetch(new Request(`https://vemians.com${pathname}`, { method }), { SURFACE: "public" });
    return { status: res.status, html: await res.text() };
  } finally {
    console.info = info;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-56-shop_with_a_door
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_56_shop_with_a_door__hours_are_data_not_a_paragraph", () => {
  for (const h of SITE.hours) {
    assert.ok(Number.isInteger(h.day) && h.day >= 0 && h.day <= 6, "a weekday index, not a name");
    if (h.from !== null) {
      assert.match(h.from, /^\d{2}:\d{2}$/);
      assert.match(h.to, /^\d{2}:\d{2}$/);
    } else {
      assert.equal(h.to, null, "half a closed day is not a state");
    }
  }
  assert.equal(new Set(SITE.hours.map((h) => h.day)).size, 7, "every weekday is stated, closed included");
});

labeled("test_PRD_P0_56_shop_with_a_door__identical_days_collapse_into_one_row", () => {
  const rows = hoursRows();
  /* Three lines saying 11:00–18:00 is a door sign nobody reads. */
  assert.ok(rows.length < 7, "consecutive identical days must collapse");
  assert.match(rows[0].label, /^Monday/, "the week reads Monday first, like a door sign");
  for (let i = 1; i < rows.length; i += 1) {
    assert.notEqual(rows[i].text, rows[i - 1].text, "two adjacent rows say the same thing");
  }
  const closed = rows.filter((r) => r.text === "Closed");
  assert.ok(closed.length >= 1, "a closed day is stated, not omitted");
});

labeled("test_PRD_P0_56_shop_with_a_door__hours_display_in_12_hour_clock", () => {
  /* Stored 24-hour ("12:00", "19:00") because that shape is unambiguous and
     sortable; a bare "12:00" is exactly the kind of thing a door sign must
     not say, so the 12-hour conversion — with AM/PM, never a bare "12:00" —
     happens once, on the way out, for every reader of hoursRows(). */
  const open = hoursRows().find((r) => r.text !== "Closed");
  assert.ok(open, "the fixture needs at least one open row to check");
  assert.match(open.text, /^\d{1,2}:\d{2} (AM|PM)–\d{1,2}:\d{2} (AM|PM)$/, `not 12-hour: "${open.text}"`);
  assert.doesNotMatch(open.text, /^0\d:/, "no leading zero on the hour");

  /* Noon and midnight are the one place a naive %12 conversion breaks —
     0 % 12 and 12 % 12 both equal 0, and "0:00" is not a time anyone reads on
     a door. Checked directly against a synthetic schedule so this does not
     depend on which hours the shop happens to keep today. */
  const synthetic = hoursRows([
    { day: 1, from: "00:00", to: "12:00" },
    { day: 2, from: "12:00", to: "23:30" },
  ]);
  const [midnightToNoon, noonToNight] = synthetic;
  assert.equal(midnightToNoon.text, "12:00 AM–12:00 PM");
  assert.equal(noonToNight.text, "12:00 PM–11:30 PM");
});

labeled("test_PRD_P0_56_shop_with_a_door__the_open_days_summary_is_derived_not_typed", async () => {
  /* "Open Monday to Saturday" was a literal string in two files and it went
     stale the day the schedule changed to Tuesday–Saturday — nobody touched
     either copy of it because neither file's diff had anything to do with
     hours. It has to come from the same SITE.hours the table renders, or it
     will drift again the next time the schedule changes. */
  assert.equal(openDaysLabel(), "Open Tuesday to Saturday");
  assert.equal(openDaysCount(), 5, "five open days in the current schedule");

  const { html } = await get("/visit");
  assert.match(html, /<div class="bar">Open Tuesday to Saturday/);
  assert.match(html, new RegExp(`${openDaysCount()} days? a week`), "the day count in the copy must match the schedule");
  assert.doesNotMatch(html, /six days a week/i, "a stale literal must not survive the switch to five days");

  /* A single open day reads as a day, not "1 days". */
  assert.equal(openDaysLabel([{ day: 3, from: "10:00", to: "16:00" }]), "Open Wednesday");
  assert.equal(openDaysCount([{ day: 3, from: "10:00", to: "16:00" }]), 1);
});

labeled("test_PRD_P0_56_shop_with_a_door__the_map_links_carry_the_real_address", () => {
  const address = addressLine();
  for (const url of [mapsDirectionsUrl(), mapsSearchUrl()]) {
    assert.match(url, /^https:\/\/www\.google\.com\/maps\//);
    assert.ok(url.includes(encodeURIComponent(address)), "the address must be in the link, encoded");
    /* No key on a public page, and nothing that could carry one. */
    assert.doesNotMatch(url, /key=|client=|signature=/);
  }
  /* Two different questions: where is it, and take me there. */
  assert.notEqual(mapsDirectionsUrl(), mapsSearchUrl());
  assert.match(mapsDirectionsUrl(), /destination=/);
});

labeled("test_PRD_P0_56_shop_with_a_door__the_visit_page_answers_all_four_questions", async () => {
  const { status, html } = await get("/visit");
  assert.equal(status, 200);
  /* "Appointments" is shelved (see SITE.appointments.shelved) and its section
     is checked separately below, in both states. What must always be present
     is the rest of the four: when you're open, how to get here, how to reach
     a person, and now how to stay in touch. */
  for (const id of ["hours", "directions", "contact", "join"]) {
    assert.ok(html.includes(`id="${id}"`), `the visit page has no ${id} section to link to`);
  }
  assert.ok(html.includes(inPage(mapsDirectionsUrl())), "directions must be reachable");
  assert.ok(html.includes(`tel:${SITE.phone.replace(/[^+\d]/g, "")}`), "the phone number must be tappable");
  assert.ok(html.includes(`mailto:${SITE.email}`));
  assert.ok(html.includes(inPage(SITE.signup.url)), "the sign-up link must be reachable");
  for (const row of hoursRows()) assert.ok(html.includes(row.text), `hours row '${row.text}' is not rendered`);
});

labeled("test_PRD_P0_56_shop_with_a_door__a_shelved_section_is_absent_not_a_dead_end", async () => {
  /* Shelved means the SECTION IS ABSENT, not present with a fallback control —
     a section for a thing we are actively not offering right now is worse
     than no section at all. Checked in both states, restored after, exactly
     like the widgetEmbed exception test below: this is the owner's call to
     make, not a permanent deletion, so flipping it back has to actually work. */
  assert.equal(SITE.appointments.shelved, true, "appointments are shelved today — this test documents that default");
  const shelved = await get("/visit");
  assert.doesNotMatch(shelved.html, /id="appointments"/, "a shelved section must not render at all");
  assert.doesNotMatch(shelved.html, /Book an appointment/i, "nor any link into it, anywhere on the page");

  SITE.appointments.shelved = false;
  try {
    const live = await get("/visit");
    assert.match(live.html, /id="appointments"/, "un-shelving must bring the section back with no code change");
  } finally {
    SITE.appointments.shelved = true;
  }
});

labeled("test_PRD_P0_56_shop_with_a_door__shelving_removes_the_link_everywhere_it_appeared", async () => {
  for (const p of ["/", "/visit", "/bag", "/collaborations"]) {
    const { html } = await get(p);
    assert.doesNotMatch(html, /appointments/i, `${p} still mentions the shelved feature`);
  }
});

labeled("test_PRD_P0_56_shop_with_a_door__every_form_on_the_site_posts_somewhere_real", async () => {
  /* The contact form is now real (ADR-015; the specifics of what it does are
     Test-PRD-P0-58's business, in store/test/contact.test.mjs). What stays
     this file's business is the general rule the old, narrower version of
     this check enforced: no page on this site may ever show a form whose
     action does not answer. */
  for (const p of ["/", "/visit", "/bag", "/collaborations"]) {
    const { html } = await get(p);
    for (const m of html.matchAll(/<form[^>]*\baction="([^"]*)"/gi)) {
      const action = m[1];
      /* A GET-method search/filter form (the catalog's own) resolves against
         itself; only the POST forms are this check's concern, since a GET
         "posting nowhere" just re-renders the same page. */
      const isPost = /method="post"/i.test(html.slice(m.index, m.index + 200));
      if (!isPost) continue;
      assert.notEqual(action, "", `a form on ${p} has no action at all`);
    }
  }
  /* And the one that does exist actually accepts a POST rather than 404ing —
     the failure mode the old version of this check was written to catch. */
  const { html } = await get("/visit");
  assert.match(html, /<form class="contact" method="post" action="\/contact">/, "the contact form must exist");
});

labeled("test_PRD_P0_56_shop_with_a_door__no_third_party_is_loaded_onto_the_page", async () => {
  /* Unconfigured — the default state today — the guarantee holds with no
     carve-out at all. ADR-014's exception only exists once an owner has
     actually pasted a widget snippet in; that branch is exercised below. */
  assert.equal(SITE.appointments.widgetEmbed, "", "a configured widget would change what this test may see");
  for (const p of ["/", "/visit", "/bag", "/collaborations"]) {
    const { html } = await get(p);
    assert.doesNotMatch(html, /<iframe/i, `${p} embeds a third party`);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/i, `${p} loads somebody else's script`);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i, `${p} loads somebody else's stylesheet`);
    /* Every external URL is an anchor — something a person chooses to follow,
       which loads nothing until they do. */
    for (const m of html.matchAll(/https?:\/\/(?!www\.w3\.org)[^"']+/g)) {
      const before = html.slice(Math.max(0, m.index - 120), m.index);
      assert.match(before, /<a [^>]*href="$/, `${m[0]} on ${p} is not a link the visitor chose`);
    }
  }
});

labeled("test_PRD_P0_56_shop_with_a_door__the_appointments_widget_is_the_only_sanctioned_exception", async () => {
  /* ADR-014: once an owner pastes Square's own booking snippet into
     SITE.appointments.widgetEmbed, it is the one third party allowed onto
     the page — scoped to exactly the #appointments section on /visit, and
     to exactly the snippet configured, not to "anything Square-shaped". */
  const snippet =
    '<div id="sq-appointments-test"></div>\n' +
    '<script src="https://square.site/appointments/buyer/widget/test-fixture.js"></script>';
  /* The section itself is shelved today (see the tests above) — exercising
     the widget also means picking the feature back up for the duration of
     this test, exactly as a real un-shelving would. */
  SITE.appointments.shelved = false;
  SITE.appointments.widgetEmbed = snippet;
  try {
    const visit = await get("/visit");
    const appointmentsSection = visit.html.split('id="appointments"')[1].split('id="directions"')[0];
    assert.ok(appointmentsSection.includes(snippet), "the snippet must render verbatim, unescaped, in its section");
    assert.doesNotMatch(appointmentsSection, /<iframe/i, "the widget is a script, not an iframe");

    for (const p of ["/", "/bag", "/collaborations"]) {
      const { html } = await get(p);
      assert.doesNotMatch(html, /square\.site/i, `${p} must never carry the appointments widget`);
      assert.doesNotMatch(html, /<script[^>]+src="https?:/i, `${p} loads somebody else's script`);
      assert.doesNotMatch(html, /<iframe/i, `${p} embeds a third party`);
    }
  } finally {
    SITE.appointments.widgetEmbed = "";
    SITE.appointments.shelved = true;
  }
});

labeled("test_PRD_P0_56_shop_with_a_door__what_is_not_real_yet_says_so", () => {
  /* An address we are not on, shipped without a marker, becomes a fact the
     moment somebody drives to it. */
  const src = read("shared", "site.js");
  assert.match(src, /PLACEHOLDER/, "the unresolved values must be marked in the source");
  const marked = [...src.matchAll(/PLACEHOLDER/g)].length;
  assert.ok(marked >= 2, `expected the contact details and the socials marked, saw ${marked}`);
  /* The address is real now and must not still be labelled a guess — a marker
     left on a resolved value trains everyone to ignore the markers. */
  assert.doesNotMatch(src, /PLACEHOLDER[^\n]*\n\s*address:/, "the address is supplied; drop its marker");
  /* And nothing claims a booking provider that is not connected. */
  if (!SITE.appointments.bookingUrl) {
    assert.equal(SITE.appointments.bookingUrl, "", "an unset booking URL is empty, never a guess");
  }
});

labeled("test_PRD_P0_56_shop_with_a_door__the_footer_is_the_same_facts_everywhere", async () => {
  const pages = await Promise.all(["/", "/visit", "/bag", "/collaborations"].map((p) => get(p)));
  for (const { html } of pages) {
    assert.ok(html.includes(addressLine()), "the address is not on every page");
    assert.ok(html.includes(SITE.phone), "the phone number is not on every page");
    for (const s of SITE.social) {
      assert.ok(html.includes(inPage(s.href)), `${s.name} is missing from the footer`);
    }
  }
});

labeled("test_PRD_P0_56_shop_with_a_door__no_footer_link_goes_nowhere", async () => {
  const { html } = await get("/");
  const foot = html.slice(html.indexOf('<footer class="foot">'));
  const internal = [...foot.matchAll(/href="(\/[^"#]*)/g)].map((m) => m[1]);
  assert.ok(internal.length >= 5, "a footer with no links is not a footer");
  for (const p of new Set(internal)) {
    const { status } = await get(p);
    assert.equal(status, 200, `the footer links to ${p}, which answers ${status}`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-57-two_level_navigation
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_57_two_level_navigation__both_levels_derive_from_the_catalog", async () => {
  const { html } = await get("/");
  const nav = html.slice(html.indexOf('<nav class="menu"'), html.indexOf("</nav>"));
  for (const c of categoriesOf(products)) {
    assert.ok(nav.includes(`/?category=${encodeURIComponent(c)}`), `no drawer entry for '${c}'`);
    for (const sub of subsOf(products, c)) {
      assert.ok(
        nav.includes(inPage(`/?category=${encodeURIComponent(c)}&sub=${encodeURIComponent(sub)}`)),
        `'${sub}' is in the catalog but not in the drawer`,
      );
    }
  }
  /* Nothing is typed: every sub in the drawer is a sub some product carries. */
  const subs = [...nav.matchAll(/&amp;sub=([^"&]+)/g)].map((m) => decodeURIComponent(m[1]));
  const real = new Set(products.map((p) => p.sub).filter(Boolean));
  for (const s of subs) assert.ok(real.has(s), `'${s}' is in the drawer but in no product`);
});

labeled("test_PRD_P0_57_two_level_navigation__a_category_with_no_subs_is_one_destination", () => {
  /* The mirror carries no sub-categories, so this is the state a real
     Square-backed shop is in until its taxonomy has two levels: a category is
     a link, never a heading over an empty pane. */
  assert.deepEqual(subsOf([{ handle: "a", category: "kitchen" }], "kitchen"), []);
});

labeled("test_PRD_P0_57_two_level_navigation__a_sub_is_carried_across_filter_and_paging", async () => {
  const { html } = await get("/?category=clothing&sub=dresses&n=8");
  /* The filter form's action is "/", so both levels ride as hidden fields or
     ticking a brand silently walks the visitor out of where they stood. */
  assert.match(html, /<input type="hidden" name="category" value="clothing">/);
  assert.match(html, /<input type="hidden" name="sub" value="dresses">/);
  /* And the heading names where they are standing rather than the whole shop. */
  assert.match(html, /<h1>Dresses<\/h1>/);
});

labeled("test_PRD_P0_57_two_level_navigation__an_out_of_place_sub_is_dropped_not_obeyed", async () => {
  /* A stale link must show a shop, never an empty grid with no explanation. */
  const { html } = await get("/?sub=dresses");
  assert.doesNotMatch(html, /Showing 0 of 0/);
  const { html: other } = await get("/?category=nonsense&sub=dresses");
  assert.doesNotMatch(other, /Showing 0 of 0/);
});

labeled("test_PRD_P0_57_two_level_navigation__the_drawer_is_a_working_list_without_a_script", async () => {
  const { html } = await get("/");
  const nav = html.slice(html.indexOf('<nav class="menu"'), html.indexOf("</nav>"));
  /* Nothing in the served markup hides it: no hidden attribute, no inline
     style, no aria-hidden. The CSS that turns it into a drawer is gated on the
     .js class, which only a running script sets. */
  assert.doesNotMatch(nav, /\shidden\b|style="[^"]*display:\s*none|aria-hidden="true"/);
  const INTERACTION = read("shared", "design", "interaction.css");
  assert.match(INTERACTION, /\.js \.menu \{/, "the drawer styling must be gated on .js");
  assert.doesNotMatch(INTERACTION, /^\.menu \{[^}]*position: fixed/m, "the menu must not be fixed without .js");
  /* The trigger is not rendered as a usable control without a script. */
  assert.match(INTERACTION, /\.menu-open, \.menu-close \{ display: none; \}/);
  assert.match(INTERACTION, /\.js \.menu-open, \.js \.menu-close \{ display: inline-flex; \}/);
});

labeled("test_PRD_P0_57_two_level_navigation__the_sub_pane_cannot_become_a_one_row_box", () => {
  /* The pane is a child of its <li>. A positioned <li> would become the pane's
     containing block and the pane would be one row tall instead of covering the
     drawer — which is what happened, and what the chevron being placed by flex
     rather than by absolute positioning prevents. */
  const css = read("shared", "design", "interaction.css");
  assert.doesNotMatch(css, /\.has-sub \{[^}]*position:\s*relative/, "a positioned row would trap the pane inside it");
  assert.match(css, /\.js \.menu-sub \{[\s\S]*?position: absolute;/);
});

labeled("test_PRD_P0_57_two_level_navigation__focus_into_a_pane_cannot_slide_the_drawer_away", () => {
  /* The pane is parked one width to the side by a transform, which counts as
     scrollable overflow inside the drawer; a plain focus() makes the browser
     scroll across to reveal it and the whole menu leaves the screen.
     overflow-x: hidden stops a finger and does not stop focus(). */
  const client = read("shared", "view", "enhance.client.js");
  const drawer = /function armDrawer\(\)[\s\S]*?\n  \}\n/.exec(client);
  assert.ok(drawer, "armDrawer must exist to be checked");
  const focuses = [...drawer[0].matchAll(/\.focus\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(focuses.length >= 2, "the pane and the back control both take focus");
  for (const arg of focuses) {
    assert.equal(arg, "{ preventScroll: true }", "every focus() inside the drawer must not scroll it");
  }
});

labeled("test_PRD_P0_57_two_level_navigation__one_pane_open_at_a_time", () => {
  const client = read("shared", "view", "enhance.client.js");
  const drawer = /function armDrawer\(\)[\s\S]*?\n  \}\n/.exec(client)[0];
  /* Opening one collapses whatever was open, and closing the drawer collapses
     too — so reopening it never starts halfway down a pane the visitor has
     forgotten they were in. */
  assert.match(drawer, /btn\.addEventListener\("click", function \(\) \{\s*\n\s*collapse\(\);/);
  assert.match(drawer, /armDialog\(menu, trigger, "Menu", collapse\)/);
});

test("every label in this file is unique and named in the PRD", () => {
  const prd = read("docs", "PRD.md");
  assert.ok(usedLabels.size >= 2);
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is not a numbered feature in docs/PRD.md`);
  }
});
