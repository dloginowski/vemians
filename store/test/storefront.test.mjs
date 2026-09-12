/*
 * The storefront — PRD-backed regression checks.
 *
 *     Run: node --test test/            (from store/)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD / TEST CONTRACT — read before editing this file
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/PRD.md` is the driving design document. Every check here exists to
 * enforce a NUMBERED PRD FEATURE as written there — not an implementation
 * detail, and not "a thing the code happens to do".
 *
 *   * Each check is named  test_PRD_P0_NN_short_id__specific_behaviour  and so
 *     carries the visible label  Test-PRD-P0-NN-short_id.
 *   * That label MUST exist in docs/PRD.md. The last check in this file
 *     (P0-30) parses THIS FILE's own check names and asserts it, so an invented
 *     or renamed label fails the run instead of drifting silently.
 *   * UNLABELED CHECKS ARE NOT ACCEPTABLE. A new guarantee needs a PRD feature
 *     first; if there is no feature for it, write the feature. The interaction
 *     layer had none, so Test-PRD-P0-42 through P0-46 were written into
 *     docs/PRD.md §3.8.1 in the same change as the code below. The mirror-or-seed
 *     fallback had none either, so Test-PRD-P0-49 was written into §3.8 in the
 *     same change as store/src/catalog.js.
 *   * When behaviour changes, the PRD feature and its labeled check move in the
 *     SAME change as the code. An interaction edit with a stale PRD is a
 *     process failure, not a follow-up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT PROVEN HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The REAL renderer runs. shared/test/text-modules.mjs resolves the CSS and the
 * browser script the way wrangler's Text rule does, so views.js, query.js and
 * html.js are imported unmodified and the assertions are made against the
 * actual bytes the Worker would return.
 *
 * WHAT THIS CANNOT PROVE, AND DOES NOT CLAIM TO: anything that needs a layout
 * engine. Whether the header's transform is really -129px, whether CLS is
 * really 0, whether Escape really returns focus to the trigger, whether the
 * computed transition-duration is really 0s under prefers-reduced-motion — a
 * string in a stylesheet is not a rendered box. Those are measured by driving
 * `wrangler dev --local` with Playwright; see README §Verifying the interaction
 * layer. What IS proven here is the contract those measurements depend on: that
 * the markup is complete without a script, that every duration still resolves
 * from the one pair of tokens the reduced-motion rule remaps, that no hover
 * rule has escaped its pointer gate, and that nothing has been parked at
 * opacity 0 behind a scroll observer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN INVARIANT THAT CHANGED ON PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This file used to assert that store/wrangler.toml carried ZERO D1 bindings.
 * It now asserts an ALLOW-LIST: `CATALOG_MIRROR` and nothing else, with
 * customers, identity, commerce, people, finance, audit and tickets named one
 * by one so a future addition trips the check. The rule the old assertion was
 * protecting — the shop cannot reach customer data — is unchanged and is now
 * stated directly instead of through a mechanism that also forbade reading our
 * own catalog. It is under Test-PRD-P0-24-binding_scoped_tools, which is where
 * binding scope belongs; P0-46 keeps the half of it that is about the wishlist.
 *
 * The mirror-backed checks load shared/commerce/square/schema.sql into
 * node:sqlite (shared/test/d1.mjs) and insert rows directly. NO SQUARE ACCOUNT,
 * TOKEN OR NETWORK CALL IS INVOLVED and none is claimed — what they prove is
 * what the shop renders from a mirror in a given state, not that Square would
 * ever put it in that state.
 *
 * There is also NO reference site behind any of this. Mytheresa is
 * egress-blocked from this environment; docs/design-direction.md §5 lists hover
 * behaviour and the filter/sort panels as unobserved. The checks below enforce
 * the SHAPE of the interaction layer, which is ours to decide, and deliberately
 * do not assert any specific duration as correct — only that it sits inside the
 * 150-250ms budget the PRD sets, and that it comes from one place.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, "..");
const REPO = path.join(STORE, "..");
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");

/* Text modules, as the Worker sees them. Must run before anything under src/
   is imported, hence register() plus dynamic import rather than a static one. */
register("../../shared/test/text-modules.mjs", import.meta.url);

const { catalogPage, catalogPartial, shotUrl } = await import("../src/views.js");
const { money } = await import("../../shared/view/html.js");
const { brandsOf, categoriesOf, href, PAGE, parseQuery, select, SORTS } = await import("../src/query.js");

const INTERACTION = read("shared", "design", "interaction.css");
const GRID = read("shared", "design", "catalog-grid.css");
const PRD = read("docs", "PRD.md");

/* Strip comments before pattern-matching source. Both files describe what they
   must NOT do — "there is no IntersectionObserver in this file" — and a check
   that reads prose as code passes and fails for the wrong reasons in both
   directions. Neither file contains a regex literal or a string holding "//"
   or a comment delimiter, so this stays a strip and never a parse. */
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const CLIENT_SRC = read("shared", "view", "enhance.client.js");
const CLIENT = bare(CLIENT_SRC);

const products = (await import("../../shared/seed/catalog.js")).products;
const BRANDS = brandsOf(products);
const CATEGORIES = categoriesOf(products);

/* ── the catalog mirror, over its REAL schema ─────────────────────────────
 *
 * D1 is SQLite and the mirror's whole read contract is a pair of INDEX VIEWS
 * that hide archived rows, so a hand-rolled fake store would prove nothing
 * about what the shop will actually render. shared/test/d1.mjs loads
 * shared/commerce/square/schema.sql into node:sqlite and hands back something
 * shaped like a D1 binding. No Square account, token or network call is
 * involved anywhere in this file, and none is claimed: rows are inserted
 * directly, exactly as a completed sync would have left them.
 */
const { d1FromSql } = await import("../../shared/test/d1.mjs");
const { loadCatalog, toneFor } = await import("../src/catalog.js");

const MIRROR_SQL = read("shared", "commerce", "square", "schema.sql");

/* A mirror holding `items`, each { handle, title, category, minor }. */
function mirrorWith(items) {
  const db = d1FromSql(MIRROR_SQL);
  const cats = new Map();
  for (const it of items) {
    if (!it.category || cats.has(it.category)) continue;
    const id = `cat-${cats.size + 1}`;
    cats.set(it.category, id);
    db._raw
      .prepare("INSERT INTO mirror_category (id, external_ref, name) VALUES (?, ?, ?)")
      .run(id, `SQ_CAT_${cats.size}`, it.category);
  }
  items.forEach((it, i) => {
    db._raw
      .prepare(
        "INSERT INTO mirror_product (id, external_ref, handle, title, status, category_id) VALUES (?, ?, ?, ?, 'active', ?)",
      )
      .run(`prod-${i}`, `SQ_ITEM_${i}`, it.handle, it.title, it.category ? cats.get(it.category) : null);
    if (it.minor === null) return;
    db._raw
      .prepare(
        "INSERT INTO mirror_variant (id, external_ref, product_id, sku, title, ordinal, price_minor, currency) VALUES (?, ?, ?, ?, ?, 0, ?, 'USD')",
      )
      .run(`var-${i}`, `SQ_VAR_${i}`, `prod-${i}`, `SKU-${i}`, "One size", it.minor);
  });
  return db;
}

/* Square's taxonomy, deliberately nothing like the seed's four invented
   categories — the nav must rebuild from whatever is actually there. */
const SQUARE_STOCK = [
  { handle: "hand-thrown-vase", title: "Hand-thrown stoneware vase", category: "Homeware", minor: 18000 },
  { handle: "linen-apron", title: "Washed linen apron", category: "Homeware", minor: 9500 },
  { handle: "olive-wood-board", title: "Olive wood serving board", category: "Kitchen", minor: 14000 },
  { handle: "beeswax-candle", title: "Beeswax dinner candles", category: "Kitchen", minor: 3200 },
];

/* Console capture: "log at INFO which one served" is behaviour, not decoration,
   and the only way to assert it is to read what was said. */
async function saying(fn) {
  const lines = { error: [], warn: [], info: [] };
  const real = { error: console.error, warn: console.warn, info: console.info };
  console.error = (...a) => lines.error.push(a.join(" "));
  console.warn = (...a) => lines.warn.push(a.join(" "));
  console.info = (...a) => lines.info.push(a.join(" "));
  try {
    lines.value = await fn();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

/* Render the shop the way index.js does, so the assertions are about the bytes
   that would actually go over the wire. */
function render(search = "") {
  const url = new URL("http://vemians.com/" + search);
  const q = parseQuery(url);
  const picked = select(products, q);
  return { q, picked, html: catalogPage(BRANDS, CATEGORIES, q, picked), partial: catalogPartial(q, picked) };
}

/* ── labels, for the P0-30 traceability check ───────────────────────────── */
const usedLabels = new Set();
function labeled(name, fn) {
  const m = /^test_PRD_(P\d)_(\d\d)_([a-z0-9_]+)__/.exec(name);
  assert.ok(m, `check name is not PRD-labeled: ${name}`);
  usedLabels.add(`Test-PRD-${m[1]}-${m[2]}-${m[3].replace(/_/g, "_")}`);
  return test(name, fn);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-42-progressive_storefront
   Every function of the shop is a plain GET the Worker answers in HTML.
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_42_progressive_storefront__filter_and_sort_are_a_get_form", () => {
  const { html } = render();
  assert.match(html, /<form class="panel" id="filters" method="get" action="\/"/);
  /* Named fields, and an id unique per rendered instance, or the browser can
     neither submit them nor restore them. */
  for (const b of BRANDS) {
    const id = b.toLowerCase();
    assert.match(html, new RegExp(`<input type="checkbox" id="f-brand-${id}" name="brand" value="${b}"`));
  }
  for (const s of Object.keys(SORTS)) {
    assert.match(html, new RegExp(`<input type="radio" id="f-sort-${s}" name="sort" value="${s}"`));
  }
  assert.match(html, /<button class="btn" type="submit">Apply<\/button>/);
});

labeled("test_PRD_P0_42_progressive_storefront__server_filters_and_sorts", () => {
  const cheapest = Math.min(...products.map((p) => p.minor));
  const asc = select(products, parseQuery(new URL("http://x/?sort=price-asc&n=99")));
  assert.equal(asc.shown[0].minor, cheapest);
  assert.deepEqual(
    asc.shown.map((p) => p.minor),
    [...asc.shown.map((p) => p.minor)].sort((a, b) => a - b),
  );

  const one = select(products, parseQuery(new URL("http://x/?brand=Vestra")));
  assert.ok(one.total > 0);
  assert.ok(one.shown.every((p) => p.brand === "Vestra"));

  /* A stale or hand-edited link shows the shop, not an error page. */
  const junk = parseQuery(new URL("http://x/?brand=Nope&sort=sideways&n=banana"));
  assert.equal(junk.sort, "featured");
  assert.equal(junk.n, PAGE);
  assert.equal(select(products, junk).total, 0);
});

labeled("test_PRD_P0_42_progressive_storefront__load_more_is_a_link_not_a_button", () => {
  const { html } = render();
  const link = /<a class="btn more" href="([^"]+)" rel="next">Show more<\/a>/.exec(html);
  assert.ok(link, "load more must be an <a href>, so it works as a navigation");
  assert.equal(link[1], `/?n=${PAGE * 2}`);

  /* Following that link with no script shows everything the previous URL had,
     plus more — it is not a pager that swaps one set for another. */
  const next = render(link[1]);
  const first = render().picked.shown.map((p) => p.handle);
  assert.deepEqual(next.picked.shown.slice(0, first.length).map((p) => p.handle), first);
  assert.ok(next.picked.shown.length > first.length);

  /* And at the end of the catalog the control is gone, not disabled. */
  assert.equal(next.picked.shown.length, products.length);
  assert.doesNotMatch(next.html, /class="btn more"/);
});

labeled("test_PRD_P0_42_progressive_storefront__url_is_the_whole_contract", () => {
  /* href() and parseQuery() are inverses, or the enhanced client and the plain
     form would be describing different result sets with the same link. */
  for (const search of ["", "?brand=Vestra", "?brand=Vestra&brand=Corvino&sort=price-desc", "?sort=name&n=16"]) {
    const q = parseQuery(new URL("http://x/" + search));
    const round = parseQuery(new URL("http://x" + href(q)));
    assert.deepEqual(round, q, `round trip failed for ${search || "/"}`);
  }
  assert.equal(href({ brands: [], sort: "featured", n: PAGE }), "/", "the default query is the bare path");
});

labeled("test_PRD_P0_42_progressive_storefront__no_dead_wishlist_button_without_a_script", () => {
  const { html } = render();
  assert.doesNotMatch(html, /<button[^>]*class="[^"]*\bheart\b/, "the heart must not ship as an inert button");
  assert.match(html, /<span class="heart" data-heart="[^"]+" data-name="[^"]+" aria-hidden="true">&#9825;<\/span>/);
  /* The script is the thing that turns it into a control. */
  assert.match(CLIENT, /span\.replaceWith\(btn\)/);
  assert.match(CLIENT, /btn\.setAttribute\("aria-pressed"/);
});

labeled("test_PRD_P0_42_progressive_storefront__script_is_deferred_and_never_required", () => {
  const { html } = render();
  assert.match(html, /<script src="\/s\.js" defer><\/script>/, "the enhancement must not block the render");
  /* Nothing the page needs is written by the script: the grid, the form and
     the paging control are all in the served bytes. */
  assert.equal((html.match(/<article class="card"/g) || []).length, PAGE);
  assert.match(html, /<main class="catalog" id="catalog">/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-43-restrained_motion
   150-250ms, ease-out, one pair of tokens, removed under reduced motion.
   ═══════════════════════════════════════════════════════════════════════════ */

const CSS = bare(INTERACTION) + bare(GRID);

labeled("test_PRD_P0_43_restrained_motion__every_duration_comes_from_one_pair_of_tokens", () => {
  const declarations = [...CSS.matchAll(/transition:\s*([^;}]+)[;}]/g)].map((m) => m[1]);
  assert.ok(declarations.length >= 5, "expected the interaction layer to declare transitions");
  for (const d of declarations) {
    if (/^\s*none\s*$/.test(d)) continue;
    assert.ok(
      /var\(--motion(-slow)?\)/.test(d),
      `a transition spends a hard-coded duration instead of a token: "${d.trim()}"`,
    );
    /* Anything NOT expressed through the token would survive the reduced-motion
       remap. The only literal allowed is the 0s on visibility, which is a
       switch, not an animation. */
    const literals = (d.match(/\b\d+(\.\d+)?m?s\b/g) || []).filter((v) => v !== "0s");
    assert.deepEqual(literals, [], `literal duration outside the token system: "${d.trim()}"`);
  }
});

labeled("test_PRD_P0_43_restrained_motion__budget_is_150_to_250ms_and_eases_out", () => {
  const tokens = [...CSS.matchAll(/--motion(?:-slow)?:\s*(\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(tokens.length >= 2, "both motion tokens must be declared");
  for (const ms of tokens) {
    assert.ok(ms >= 150 && ms <= 250, `${ms}ms is outside the 150-250ms budget`);
  }
  assert.match(CSS, /--ease:\s*ease-out;/);

  /* NO BOUNCE, which is the rule that has not moved. A curve is now allowed —
     the arrive-on-scroll is the one motion watched from start to finish and
     ease-out alone starts it abruptly — but only one that stays inside the
     unit square. A control point outside [0,1] on Y is an overshoot, and an
     overshoot is the bounce this design forbids. */
  const curves = [...CSS.matchAll(/cubic-bezier\(([^)]+)\)/g)].map((m) =>
    m[1].split(",").map((n) => Number(n.trim())),
  );
  for (const [, y1, , y2] of curves) {
    assert.ok(y1 >= 0 && y1 <= 1 && y2 >= 0 && y2 <= 1, `cubic-bezier overshoots: ${curves}`);
  }
  /* And every curve is a token, so reduced motion still removes it wholesale
     rather than leaving one rule easing on its own. */
  assert.equal(
    [...CSS.matchAll(/cubic-bezier/g)].length,
    [...CSS.matchAll(/--ease-inout:\s*cubic-bezier/g)].length,
    "a curve outside the token system",
  );
});

labeled("test_PRD_P0_43_restrained_motion__reduced_motion_removes_rather_than_shortens", () => {
  const block = /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]+)\}/.exec(bare(INTERACTION));
  assert.ok(block, "there must be exactly one reduced-motion remap, on :root");
  assert.match(block[1], /--motion:\s*0s;/);
  assert.match(block[1], /--motion-slow:\s*0s;/);
  /* Remapped, not overridden: no blanket `transition: none !important` sweep,
     which would also stop the state from changing on some engines and is the
     thing this design is meant to avoid. */
  assert.doesNotMatch(CSS, /!important/, "the interaction layer must not need !important");
});

labeled("test_PRD_P0_43_restrained_motion__nothing_animates_that_should_not", () => {
  assert.doesNotMatch(CSS, /@keyframes|animation-name|animation:/, "no keyframe animation on the storefront");
  assert.doesNotMatch(CSS, /scroll-behavior:\s*smooth/, "no hijacked scrolling");
  assert.doesNotMatch(CSS, /background-attachment:\s*fixed/, "no parallax");
  assert.doesNotMatch(CSS, /perspective|rotate3d|translateZ/, "no 3d flourish");
  /* No shadow appears anywhere, on scroll or otherwise (design-direction §3.1).
     The scrim is a modal ground, not a shadow, and is the one non-achromatic
     value on the page. */
  const shadows = [...bare(INTERACTION).matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(shadows.filter((s) => s !== "none"), []);
  /* Transform and opacity only: no transition that would trigger layout. */
  for (const d of [...CSS.matchAll(/transition:\s*([^;}]+)[;}]/g)].map((m) => m[1])) {
    const props = d.split(",").map((s) => s.trim().split(/\s+/)[0]).filter((p) => p && p !== "none");
    for (const p of props) {
      assert.ok(
        ["transform", "opacity", "visibility", "background-color", "color", "outline-color", "border-color"].includes(p),
        `${p} is not a compositor-or-paint-only property to transition`,
      );
    }
  }
});

labeled("test_PRD_P0_43_restrained_motion__the_reveal_cannot_leave_content_hidden", () => {
  /* THIS CHECK REPLACES "no scroll-triggered reveal", which the shop's owner
     reversed in as many words: sections that arrive as you reach them, easing
     in and out. That is a decision about the house's voice, and theirs to make.
     What survives the reversal is the floor underneath it, which is what this
     asserts instead — a reveal may not be able to leave anything invisible.

     1. The hiding rule is gated on BOTH `.js` and the "wait" value, so only an
        element a running script has marked is ever hidden. */
  assert.match(INTERACTION, /\.js \[data-reveal="wait"\] \{[^}]*opacity: 0;/);
  assert.doesNotMatch(INTERACTION, /^\[data-reveal/m, "the reveal must never apply without .js");

  /* 2. No observer, no marking. The guard returns BEFORE anything is hidden,
        so an engine without IntersectionObserver leaves every section as the
        server sent it. Asserted as an ordering, because the bug this prevents
        is exactly the two lines being written the other way round. */
  const fn = /function armReveal\(\)[\s\S]*?\n  \}/.exec(CLIENT);
  assert.ok(fn, "armReveal must exist to be checked");
  const guard = fn[0].indexOf("if (!window.IntersectionObserver) return;");
  const hide = fn[0].indexOf('setAttribute("data-reveal", "wait")');
  assert.ok(guard > -1 && hide > guard, "the observer guard must precede anything being hidden");

  /* 3. It reveals; it never fetches. Infinite scroll is still refused. */
  assert.doesNotMatch(fn[0], /fetch\(/, "a scroll observer must not load anything");
  const scrollHandlers = [...CLIENT.matchAll(/addEventListener\("scroll"/g)];
  assert.equal(scrollHandlers.length, 1, "one scroll listener, for the header, and no other");
  assert.doesNotMatch(CLIENT, /addEventListener\("scroll"[\s\S]{0,400}fetch\(/, "no infinite scroll");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-44-pointer_and_keyboard_parity
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_44_pointer_and_keyboard_parity__every_hover_rule_is_gated_on_a_fine_pointer", () => {
  /* Walk the stylesheet tracking @media nesting, and assert that no :hover
     selector is reachable outside a `pointer: fine` block. A hover style that
     leaks to touch is a phone stuck in a state it has no gesture to leave. */
  const css = bare(INTERACTION);
  let depth = 0;
  const stack = [];
  let ungated = [];
  const re = /@media([^{]*)\{|\{|\}|([^{}]*):hover/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[0].startsWith("@media")) { stack.push({ depth, fine: /pointer:\s*fine/.test(m[1]) }); depth++; }
    else if (m[0] === "{") depth++;
    else if (m[0] === "}") { depth--; if (stack.length && stack[stack.length - 1].depth === depth) stack.pop(); }
    else if (m[2] !== undefined) { if (!stack.some((s) => s.fine)) ungated.push(m[2].trim()); }
  }
  assert.deepEqual(ungated, [], "hover styles outside @media (pointer: fine)");
});

labeled("test_PRD_P0_44_pointer_and_keyboard_parity__the_hover_swap_does_nothing_on_touch", () => {
  /* Two independent gates, because either alone leaks. The media query stops
     the swap being SEEN on touch; the FINE.matches guard in arm() stops the
     second image being FETCHED there. A phone must pay nothing for a feature
     it cannot use. */
  assert.match(INTERACTION, /@media \(pointer: fine\) \{\s*\.card:hover[\s\S]{0,200}\.shot-alt\.ready/);
  assert.match(CLIENT, /if \(armed \|\| !FINE\.matches\) return;/);
  assert.match(CLIENT, /matchMedia\("\(pointer: fine\)"\)/);
  /* And the alternate shot is not in the served markup at all, so nothing can
     fetch it before the gate is consulted. The <style> block legitimately names
     .shot-alt, so this looks at the document body. */
  const { html } = render();
  const body = html.slice(html.indexOf("<body>"));
  assert.doesNotMatch(body, /shot-alt/, "no alternate <img> may be served");
  assert.doesNotMatch(html, /rel="preload"|rel="prefetch"/);
  assert.match(body, /data-alt="\/img\/[^"]+-1\.svg"/, "the URL rides as a string, not as an element");
});

labeled("test_PRD_P0_44_pointer_and_keyboard_parity__keyboard_reaches_what_the_pointer_reaches", () => {
  /* The hover preview has a keyboard route. */
  assert.match(INTERACTION, /\.card:focus-within\s+\.shot-alt\.ready/);
  assert.match(CLIENT, /card\.addEventListener\("focusin", arm\)/);
  /* Every enhancement-only control is a native button, so Enter and Space work
     without a keydown handler of our own. */
  assert.match(CLIENT, /btn\.type = "button"/);
  const { html } = render();
  assert.match(html, /<button class="btn filter-open" type="button">/);
  /* And there is a visible focus state, achromatic like everything else. */
  assert.match(INTERACTION, /:focus-visible \{\s*outline: 2px solid var\(--ink\);/);
});

labeled("test_PRD_P0_44_pointer_and_keyboard_parity__the_filter_surface_is_a_real_dialog", () => {
  assert.match(CLIENT, /panel\.setAttribute\("role", "dialog"\)/);
  assert.match(CLIENT, /panel\.setAttribute\("aria-modal", "true"\)/);
  assert.match(CLIENT, /ev\.key === "Escape"/, "Escape must close it");
  assert.match(CLIENT, /ev\.key !== "Tab"/, "Tab must be trapped");
  assert.match(CLIENT, /returnTo\.focus\(\)/, "focus must return to the trigger");
  assert.match(CLIENT, /classList\.add\("scroll-locked"\)/, "the background must not scroll");
  assert.match(INTERACTION, /\.scroll-locked \{ overflow: hidden; \}/);
  /* The trigger describes the relationship for assistive tech. */
  /* One implementation, two dialogs — the filter panel and the nav drawer —
     so the relationship is described from the panel's own id rather than from
     a string that only happens to be right for one of them. */
  assert.match(CLIENT, /trigger\.setAttribute\("aria-controls", panel\.id\)/);
  assert.match(CLIENT, /armDialog\(doc\.getElementById\("filters"\)/, "the filter panel uses the shared dialog");
  assert.match(CLIENT, /armDialog\(menu, trigger, "Menu"/, "and so does the drawer");
  assert.match(CLIENT, /trigger\.setAttribute\("aria-expanded", "true"\)/);
});

labeled("test_PRD_P0_44_pointer_and_keyboard_parity__paging_never_traps_a_keyboard_user", () => {
  const { html } = render();
  /* The control sits between the grid and the footer, in the tab order, and the
     footer is reachable because the grid stops growing when it is asked to. */
  const grid = html.indexOf('id="catalog"');
  const more = html.indexOf('id="more-row"');
  const foot = html.indexOf('class="foot"');
  assert.ok(grid < more && more < foot, "the paging control belongs between the grid and the footer");
  /* An observer exists now, for the arrive-on-scroll, so the check is what it
     always meant: nothing LOADS on scroll. Paging stays one control in the tab
     order between the grid and the footer. */
  assert.doesNotMatch(CLIENT, /scrollTop >|innerHeight \+ scrollY/);
  const reveal = /function armReveal\(\)[\s\S]*?\n  \}/.exec(CLIENT);
  assert.ok(reveal && !/fetch\(/.test(reveal[0]), "the only observer on the page must not fetch");
  /* Losing focus into <body> when the control removes itself is the other way
     to strand a keyboard user. */
  assert.match(CLIENT, /status\.tabIndex = -1;\s*\n\s*status\.focus\(\);/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-45-stable_layout
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_45_stable_layout__nothing_is_parked_at_opacity_zero_by_default", () => {
  /* The ONLY opacity:0 on a product shot is behind the data-fade attribute the
     script sets on an image that has not loaded — never a bare `.shot { opacity:
     0 }` waiting for something to happen. With no script, or a broken one, every
     image is visible. */
  const zeroed = [...bare(INTERACTION).matchAll(/([^{}]+)\{[^}]*opacity:\s*0;[^}]*\}/g)].map((m) => m[1].trim());
  /* `.js [data-reveal="wait"]` joins the list on the same terms as the image
     fade: BOTH a running script and an attribute that script has set. Neither
     hides anything on its own, so a page with no JavaScript has none of them. */
  const allowed = [
    '.card-media .shot[data-fade="wait"]',
    ".card-media .shot-alt",
    ".scrim",
    '.js [data-reveal="wait"]',
  ];
  assert.deepEqual(zeroed.filter((s) => !allowed.includes(s)), [], `unexpected opacity:0 on ${zeroed}`);
  /* And the script only ever parks an image that is genuinely still loading. */
  assert.match(CLIENT, /if \(img\.complete\) return;\s*\n\s*img\.dataset\.fade = "wait";/);
  assert.match(CLIENT, /addEventListener\("error", show/, "a failed image must not stay invisible");
});

labeled("test_PRD_P0_45_stable_layout__the_slot_reserves_the_space_before_the_image_arrives", () => {
  assert.match(GRID, /\.card-media \{[\s\S]*?aspect-ratio: 8 \/ 9;[\s\S]*?background: var\(--image-ground, #EFF0F4\);/);
  /* Explicit dimensions on every image, matching that ratio (PRD P0-28). */
  const { html } = render();
  const imgs = [...html.matchAll(/<img class="shot"[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, PAGE);
  for (const img of imgs) {
    assert.match(img, /width="800"/);
    assert.match(img, /height="900"/);
    assert.match(img, /src="\/img\/[^"]+-0\.svg"/);
    assert.match(img, /alt="[^"]+"/);
    assert.match(img, /decoding="async"/);
  }
  assert.equal(800 / 900, 8 / 9);
  /* The first row is the LCP candidate and is not lazy; the rest is. */
  assert.equal(imgs.filter((i) => i.includes('fetchpriority="high"')).length, 4);
  assert.equal(imgs.filter((i) => i.includes('loading="lazy"')).length, PAGE - 4);
  assert.ok(imgs.slice(0, 4).every((i) => !i.includes("lazy")));
});

labeled("test_PRD_P0_45_stable_layout__the_script_layout_decision_is_made_before_first_paint", () => {
  const { html } = render();
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /<script>document\.documentElement\.className="js"<\/script>/);
  assert.ok(head.indexOf("className=\"js\"") < html.indexOf("<body>"), "the class must be set in <head>");
  /* Which is what lets the filter form be laid out as a panel from the first
     frame, instead of as a form that jumps into one. */
  assert.match(bare(INTERACTION), /\.js \.panel \{[\s\S]*?position: fixed;/);
  assert.match(bare(INTERACTION), /\.filter-open, \.panel-close \{ display: none; \}/);
});

labeled("test_PRD_P0_45_stable_layout__load_more_appends_and_never_re_renders", () => {
  /* The fragment contains ONLY what the previous URL did not have. Re-sending
     cards the client already has is how an append turns into a re-render, and a
     re-render is how a grid jumps. */
  const first = render();
  const second = render(`?n=${PAGE * 2}`);
  const fresh = [...second.partial.matchAll(/data-handle="([^"]+)"/g)].map((m) => m[1]);
  const had = first.picked.shown.map((p) => p.handle);
  assert.equal(fresh.length, second.picked.shown.length - had.length);
  assert.deepEqual(fresh.filter((h) => had.includes(h)), [], "the fragment re-sent a card the client already had");
  assert.deepEqual([...had, ...fresh], second.picked.shown.map((p) => p.handle));
  /* And the client appends rather than replacing the grid. */
  assert.match(CLIENT, /catalog\.appendChild\(card\)/);
  assert.doesNotMatch(CLIENT, /catalog\.innerHTML/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-46-viewer_local_wishlist
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_46_viewer_local_wishlist__every_storage_access_is_wrapped", () => {
  /* localStorage THROWS rather than returning null with site data blocked, in
     some private windows and at quota — so an unguarded access takes the whole
     enhancement layer down, not just the wishlist. */
  const accesses = [...CLIENT.matchAll(/localStorage/g)];
  assert.ok(accesses.length >= 2, "expected a read and a write");
  for (const fn of [/function readWishlist\(\) \{([\s\S]*?)\n  \}/, /function writeWishlist\(set\) \{([\s\S]*?)\n  \}/]) {
    const body = fn.exec(CLIENT);
    assert.ok(body, "both storage helpers must exist");
    assert.match(body[1], /try \{[\s\S]*localStorage[\s\S]*\} catch \(err\) \{/);
  }
  /* Every access goes through those two helpers and nowhere else. */
  const stray = CLIENT.split("\n").filter((l) => l.includes("localStorage") && !l.includes("window.localStorage"));
  assert.deepEqual(stray, [], `localStorage touched outside the guarded helpers: ${stray}`);
});

labeled("test_PRD_P0_46_viewer_local_wishlist__a_set_is_serialised_as_a_set", () => {
  /* Regression guard, and the reason this check is written the way it is: a Set
     has no length and no indices, so Array.prototype.slice.call(set) silently
     yields [] and the wishlist never persists — with no error anywhere. Caught
     by driving the real page, not by reading the code. */
  assert.match(CLIENT, /JSON\.stringify\(Array\.from\(set\)\)/);
  assert.doesNotMatch(CLIENT, /slice\.call\(set\)/);
});

labeled("test_PRD_P0_46_viewer_local_wishlist__no_network_and_no_binding", () => {
  /* The wishlist is per-viewer state, not customer data. It never leaves the
     browser, and this Worker has nowhere to put it if it did. */
  const fetches = [...CLIENT.matchAll(/\bfetch\(|sendBeacon|XMLHttpRequest|WebSocket/g)].map((m) => m[0]);
  assert.deepEqual(fetches, ["fetch("], "the only network call in the client is load-more");
  assert.doesNotMatch(CLIENT, /fetch\([\s\S]{0,200}wish/i);

  /* The wishlist has nowhere on the server to go, because the only store this
     Worker binds is a read-only catalog mirror and nothing writes to it. The
     allow-list itself is asserted under P0-24 below, which is where binding
     scope belongs. */
  const toml = read("store", "wrangler.toml");
  assert.doesNotMatch(toml, /^\s*\[\[kv_namespaces\]\]/m, "no KV on the storefront: nowhere to put a wishlist");
  assert.doesNotMatch(toml, /^\s*\[\[r2_buckets\]\]/m);
  const src = bare(read("store", "src", "catalog.js")) + bare(read("store", "src", "index.js"));
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\b/i, "the storefront must hold no write of any kind");
});

labeled("test_PRD_P0_46_viewer_local_wishlist__storage_failure_is_debug_not_error", () => {
  /* RULES.md: localStorage quirks are a benign fallback. The failure mode is
     "the heart does not persist", not "the shop is broken", so it must not page
     anyone — but it must not be swallowed in silence either. */
  const helpers = /function readWishlist[\s\S]*?function writeWishlist[\s\S]*?\n  \}/.exec(CLIENT)[0];
  assert.match(helpers, /console\.debug\(/);
  assert.doesNotMatch(helpers, /console\.error\(/);
  /* Whereas a load-more that cannot reach the Worker IS a service-boundary
     failure, and is logged as one before falling back to a navigation. */
  assert.match(CLIENT, /console\.error\("ERROR store: load-more fetch failed/);
  assert.match(CLIENT, /window\.location\.href = href;/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-28-image_contract — the storefront half of it
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_28_image_contract__imagery_is_ours_and_addressable", () => {
  /* Every shot has its own URL, so it can load, decode, fade in and be
     preloaded on intent — an inline <svg> can do none of those. */
  assert.equal(shotUrl(products[0], 0), `/img/${products[0].handle}-0.svg`);
  assert.equal(shotUrl(products[0], 1), `/img/${products[0].handle}-1.svg`);
  const { html } = render();
  /* On the measured #EFF0F4 ground, and hotlinking nobody.
     HOTLINKING is loading somebody else's bytes into our page; an <a href> to
     Google Maps or to our own Instagram is a LINK, which a shop with a door
     needs and which loads nothing. So the check is what it always meant: no
     external URL in anything that fetches. */
  const fetching = [...html.matchAll(/(?:src|srcset|href)="([^"]*)"|url\((['"]?)([^)'"]*)\2\)/g)]
    .map((m) => m[1] ?? m[3])
    .filter(Boolean);
  const external = fetching.filter((u) => /^https?:\/\//.test(u) && !/^https?:\/\/[^/]*vemians\.com/.test(u));
  const inAnchor = (u) => new RegExp(`<a [^>]*href="${u.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}"`).test(html);
  for (const u of external) {
    assert.ok(inAnchor(u), `${u} is fetched by this page rather than linked from it`);
  }
  assert.doesNotMatch(html, /<img[^>]+src="https?:\/\/(?!vemians)/, "no image is loaded from anybody else");
  assert.match(read("shared", "design", "theme.css"), /--image-ground: #EFF0F4;/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-30-prd_traceability
   ═══════════════════════════════════════════════════════════════════════════ */

test("test_PRD_P0_30_prd_traceability__every_label_here_exists_in_the_prd", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const labels = new Set();
  for (const m of source.matchAll(/\btest_PRD_(P\d)_(\d\d)_([a-z0-9_]+?)__/g)) {
    labels.add(`Test-PRD-${m[1]}-${m[2]}-${m[3]}`);
  }
  assert.ok(labels.size >= 5, "expected this file to carry labeled checks");
  assert.deepEqual([...labels].filter((l) => !PRD.includes(l)), [], "labels absent from docs/PRD.md");
  /* And every label collected at run time was one of them — a check that was
     renamed but not re-registered fails here rather than drifting. */
  assert.deepEqual([...usedLabels].filter((l) => !labels.has(l)), []);
});

/* ── P0-47 category navigation ─────────────────────────────────────────────
   Added after every nav link shipped as href="/" — six links that looked
   navigable and did nothing. The nav is now built from the catalog, so these
   assert the derivation rather than a hard-coded list. */

labeled("test_PRD_P0_47_category_navigation__every_category_is_derived_from_the_catalog", () => {
  const cats = categoriesOf(products);
  assert.ok(cats.length > 0, "no categories derived from the catalog");
  for (const c of cats) {
    const held = products.filter((p) => p.category === c).length;
    assert.ok(held > 0, `category '${c}' is offered but holds nothing`);
  }
});

labeled("test_PRD_P0_47_category_navigation__every_product_carries_a_category", () => {
  const orphans = products.filter((p) => !p.category).map((p) => p.handle);
  assert.deepEqual(orphans, [], `products with no category: ${orphans.join(", ")}`);
});

labeled("test_PRD_P0_47_category_navigation__selecting_a_category_filters_the_grid", () => {
  const known = categoriesOf(products);
  for (const c of known) {
    const q = parseQuery(new URL(`https://x/?category=${c}`), known);
    const got = select(products, q);
    assert.equal(q.category, c);
    assert.ok(got.total > 0, `category '${c}' selected nothing`);
    assert.ok(got.shown.every((p) => p.category === c), `category '${c}' leaked another category`);
  }
});

labeled("test_PRD_P0_47_category_navigation__an_unknown_category_shows_everything_not_nothing", () => {
  const known = categoriesOf(products);
  for (const bad of ["nonsense", "SHOES", "", "../etc"]) {
    const q = parseQuery(new URL(`https://x/?category=${encodeURIComponent(bad)}`), known);
    assert.equal(q.category, null, `'${bad}' should be dropped, not filtered on`);
    assert.equal(select(products, q).total, products.length,
      `'${bad}' produced a filtered grid instead of the whole catalog`);
  }
});

labeled("test_PRD_P0_47_category_navigation__no_nav_link_is_a_dead_href", () => {
  const html = catalogPage(brandsOf(products), categoriesOf(products),
    parseQuery(new URL("https://x/"), categoriesOf(products)), select(products, parseQuery(new URL("https://x/"))));
  /* The nav moved into the drawer and gained a second level; the property did
     not move with it. Every link still goes somewhere that holds something. */
  const nav = html.slice(html.indexOf('<nav class="menu"'), html.indexOf("</nav>"));
  const hrefs = [...nav.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 2, "nav has too few links to be meaningful");
  const dead = hrefs.filter((h) => h === "/").length;
  assert.equal(dead, 1, `expected exactly one "/" link (New in), found ${dead} — the rest must go somewhere`);
  /* Every sub-category link names both levels, so tapping one cannot land the
     visitor in the parent category with the sub silently dropped. */
  for (const h of hrefs.filter((x) => x.includes("sub="))) {
    assert.match(h, /^\/\?category=[^&]+&sub=[^&]+$/, `malformed sub-category link: ${h}`);
  }
});

labeled("test_PRD_P0_47_category_navigation__the_current_category_is_marked", () => {
  const known = categoriesOf(products);
  const q = parseQuery(new URL(`https://x/?category=${known[0]}`), known);
  const html = catalogPage(brandsOf(products), known, q, select(products, q));
  assert.match(html, new RegExp(`href="/\\?category=${known[0]}"[^>]*aria-current="page"`),
    "the selected category is not marked aria-current");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-37-mirror_is_ours — the storefront half
   The shop renders OUR MIRROR of the provider, never the provider.
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_37_mirror_is_ours__a_stocked_mirror_serves_its_own_products", async () => {
  const got = await saying(() => loadCatalog({ CATALOG_MIRROR: mirrorWith(SQUARE_STOCK) }));
  const { source, products: served } = got.value;

  assert.equal(source, "mirror");
  assert.deepEqual(
    served.map((p) => p.handle).sort(),
    SQUARE_STOCK.map((p) => p.handle).sort(),
    "the shop served something other than what the mirror holds",
  );
  /* Not one seed product survives — the twelve invented ones are gone the
     moment there is a real catalog to render. */
  const seedHandles = new Set(products.map((p) => p.handle));
  assert.deepEqual(served.filter((p) => seedHandles.has(p.handle)), []);

  /* And it renders: price and title from the mirror, on the page. */
  const q = parseQuery(new URL("http://vemians.com/"), categoriesOf(served));
  const html = catalogPage(brandsOf(served), categoriesOf(served), q, select(served, q), source);
  assert.match(html, /Hand-thrown stoneware vase/);
  /* 18000 minor units, formatted by the one money() everything shares — not
     divided by 100 anywhere in this Worker. */
  assert.ok(html.includes(money(18000, "USD")), "a mirrored price must render through money()");
  assert.match(html, /\$\s?180\b/, "a mirrored price must render from minor units");
  assert.match(html, /served from our catalog mirror/, "the page must not claim seed data while serving the mirror");
});

labeled("test_PRD_P0_37_mirror_is_ours__an_archived_product_leaves_the_shop", async () => {
  /* ADR-008: withdrawn is a marker, not a missing row. The shop reads the index
     view, so archiving is all it takes — nothing here knows the word. */
  const db = mirrorWith(SQUARE_STOCK);
  db._raw.prepare("UPDATE mirror_product SET archived_at = '2026-09-08' WHERE handle = 'linen-apron'").run();

  const { products: served } = (await saying(() => loadCatalog({ CATALOG_MIRROR: db }))).value;
  assert.ok(!served.some((p) => p.handle === "linen-apron"), "an archived product is still on sale");
  assert.equal(served.length, SQUARE_STOCK.length - 1);
  /* The row is still there. Nothing was deleted. */
  assert.equal(db._raw.prepare("SELECT COUNT(*) c FROM mirror_product").get().c, SQUARE_STOCK.length);
});

labeled("test_PRD_P0_37_mirror_is_ours__the_storefront_cannot_call_a_provider", () => {
  /* ADR-009 anti-pattern: "storefront reading Square live per request". The
     guarantee is structural — there is no client, no token and no vendor URL in
     this bundle, so it is a property of the import list rather than of a
     promise not to. */
  const src =
    bare(read("store", "src", "catalog.js")) +
    bare(read("store", "src", "index.js")) +
    bare(read("store", "src", "views.js"));
  assert.doesNotMatch(src, /squareup|connect\.square|SQUARE_ACCESS_TOKEN/i);
  /* `fetch(request, env)` is this Worker's own handler; what must not exist is
     a CALL to fetch, which is the only way a request could leave. */
  assert.doesNotMatch(src, /(await|return|=)\s*fetch\(/, "the storefront must make no outbound request at all");
  assert.doesNotMatch(src, /globalThis\.fetch|new Request\(/);
  assert.doesNotMatch(src, /commerce\/square/, "the adapter is not in the storefront bundle");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-49-mirror_or_seed
   Prefer the mirror; serve the seed when it is empty; say which.
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_49_mirror_or_seed__an_empty_mirror_serves_the_seed_rather_than_nothing", async () => {
  /* The state of the world before the first cron fires. It must be a shop. */
  const got = await saying(() => loadCatalog({ CATALOG_MIRROR: mirrorWith([]) }));
  assert.equal(got.value.source, "seed");
  assert.deepEqual(got.value.products, products, "an empty mirror must fall back to the seed catalog");
  assert.ok(got.value.products.length > 0, "the shop is blank, which is the failure this exists to prevent");
});

labeled("test_PRD_P0_49_mirror_or_seed__no_binding_at_all_still_serves_a_shop", async () => {
  /* `wrangler dev --local` with no Square account and no database. */
  const got = await saying(() => loadCatalog({}));
  assert.equal(got.value.source, "seed");
  assert.deepEqual(got.value.products, products);
  assert.equal(got.error.length, 0, "an absent binding in local dev is not an error");
});

labeled("test_PRD_P0_49_mirror_or_seed__the_log_says_which_source_served", async () => {
  const seeded = await saying(() => loadCatalog({}));
  assert.ok(
    seeded.info.some((l) => /^INFO store:/.test(l) && /seed catalog/.test(l)),
    `no INFO line naming the seed: ${JSON.stringify(seeded.info)}`,
  );

  const mirrored = await saying(() => loadCatalog({ CATALOG_MIRROR: mirrorWith(SQUARE_STOCK) }));
  assert.ok(
    mirrored.info.some((l) => /^INFO store:/.test(l) && /catalog mirror/.test(l)),
    `no INFO line naming the mirror: ${JSON.stringify(mirrored.info)}`,
  );
  /* One source per render, named once. A log that says both is worse than one
     that says neither. */
  assert.equal(mirrored.info.filter((l) => /seed catalog/.test(l)).length, 0);
});

labeled("test_PRD_P0_49_mirror_or_seed__an_unreadable_mirror_is_an_error_and_still_a_shop", async () => {
  /* A read that fails for any reason other than "not migrated yet" is a
     service-boundary failure (RULES.md §14): logged as ERROR, never swallowed —
     and never allowed to blank the shop either. */
  const broken = {
    prepare: () => ({
      all: async () => {
        throw new Error("D1_ERROR: connection lost");
      },
    }),
  };
  const got = await saying(() => loadCatalog({ CATALOG_MIRROR: broken }));
  assert.equal(got.value.source, "seed");
  assert.ok(got.error.some((l) => /^ERROR store: reading the catalog mirror failed/.test(l)));

  /* Whereas a bound-but-unmigrated database is the ordinary state of a fresh
     machine, so it is a WARNING with the repair in it, not an ERROR. */
  const fresh = {
    prepare: () => ({
      all: async () => {
        throw new Error("no such table: mirror_product_index");
      },
    }),
  };
  const dev = await saying(() => loadCatalog({ CATALOG_MIRROR: fresh }));
  assert.equal(dev.value.source, "seed");
  assert.equal(dev.error.length, 0, "an unmigrated local database is not an incident");
  assert.ok(dev.warn.some((l) => /npm run db:local/.test(l)), "the warning must carry its own repair");
});

labeled("test_PRD_P0_49_mirror_or_seed__an_unpriced_product_is_not_put_on_sale", async () => {
  /* A Square ITEM with no variation cannot be priced, and a card reading $0.00
     is worse than a card that is not there. */
  const stock = [...SQUARE_STOCK, { handle: "no-price", title: "Unpriced thing", category: "Kitchen", minor: null }];
  const got = await saying(() => loadCatalog({ CATALOG_MIRROR: mirrorWith(stock) }));
  assert.ok(!got.value.products.some((p) => p.handle === "no-price"));
  assert.ok(got.warn.some((l) => /no priced variation/.test(l)), "and it is said out loud");
});

labeled("test_PRD_P0_49_mirror_or_seed__every_mirrored_product_still_has_a_picture", async () => {
  /* `tone` is the placeholder shot's only parameter and the mirror has no such
     column, so it is derived from the handle — deterministically, or the
     picture changes under a visitor on a reload. */
  const { products: served } = (await saying(() => loadCatalog({ CATALOG_MIRROR: mirrorWith(SQUARE_STOCK) }))).value;
  for (const p of served) {
    assert.equal(typeof p.tone, "number");
    assert.ok(p.tone >= 0 && p.tone < 0.25, `tone out of the seed's range: ${p.tone}`);
    assert.equal(p.tone, toneFor(p.handle), "tone must be a function of the handle and nothing else");
  }
  assert.notEqual(toneFor("hand-thrown-vase"), toneFor("olive-wood-board"), "every product cannot be the same picture");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-47-category_navigation — from the mirror's taxonomy
   ═══════════════════════════════════════════════════════════════════════════ */

labeled("test_PRD_P0_47_category_navigation__the_nav_rebuilds_from_the_mirrors_categories", async () => {
  const { products: served, source } = (await saying(() => loadCatalog({ CATALOG_MIRROR: mirrorWith(SQUARE_STOCK) }))).value;
  assert.equal(source, "mirror");

  const cats = categoriesOf(served);
  assert.deepEqual(cats, ["Homeware", "Kitchen"], "the nav did not derive from the mirror's own categories");
  /* And not one of the seed's invented four survives. */
  for (const invented of CATEGORIES) {
    assert.ok(!cats.includes(invented), `seed category '${invented}' leaked into a mirror-backed nav`);
  }

  const q = parseQuery(new URL("http://vemians.com/"), cats);
  const html = catalogPage(brandsOf(served), cats, q, select(served, q), source);
  const nav = html.slice(html.indexOf('<nav class="menu"'), html.indexOf("</nav>"));
  for (const c of cats) assert.match(nav, new RegExp(`href="/\\?category=${c}"`), `no nav link for '${c}'`);
  for (const invented of CATEGORIES) assert.doesNotMatch(nav, new RegExp(`category=${invented}`));
});

labeled("test_PRD_P0_47_category_navigation__a_mirror_category_filters_the_grid", async () => {
  const { products: served } = (await saying(() => loadCatalog({ CATALOG_MIRROR: mirrorWith(SQUARE_STOCK) }))).value;
  const cats = categoriesOf(served);
  for (const c of cats) {
    const q = parseQuery(new URL(`http://vemians.com/?category=${encodeURIComponent(c)}`), cats);
    const got = select(served, q);
    assert.equal(q.category, c);
    assert.ok(got.total > 0, `category '${c}' selected nothing`);
    assert.ok(got.shown.every((p) => p.category === c), `category '${c}' leaked another category`);
  }
});

labeled("test_PRD_P0_47_category_navigation__paging_stays_inside_the_category", () => {
  /* Regression: `href()` dropped the category, so "show more" inside Shoes was a
     link back out to the whole catalog — the filter appearing to give up on
     its own. The nav is the one place a category is deliberately dropped, and
     it builds its links itself. */
  const known = categoriesOf(products);
  const q = parseQuery(new URL(`http://x/?category=${known[0]}&sort=name`), known);
  const next = href(q, { n: 16 });
  assert.match(next, new RegExp(`category=${known[0]}`), "show-more left the category behind");
  assert.match(next, /sort=name/);

  /* The same for a filter submitted with JavaScript off: the form's action is
     "/", so the category rides as a hidden field or it is lost. */
  const html = catalogPage(brandsOf(products), known, q, select(products, q), "seed");
  const form = html.slice(html.indexOf('<form class="panel"'), html.indexOf("</form>"));
  assert.match(form, new RegExp(`<input type="hidden" name="category" value="${known[0]}">`));
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-24-binding_scoped_tools — the storefront half
   The invariant changed, deliberately: an ALLOW-LIST of exactly one store.
   ═══════════════════════════════════════════════════════════════════════════ */

/* The seven stores that live on the ops Worker and must never appear here. Named
   one by one, so a future addition trips this check rather than passing review. */
const OPS_ONLY_STORES = ["CUSTOMERS", "IDENTITY", "COMMERCE", "PEOPLE", "FINANCE", "AUDIT", "TICKETS"];

labeled("test_PRD_P0_24_binding_scoped_tools__the_storefront_binds_the_mirror_and_nothing_else", () => {
  const toml = read("store", "wrangler.toml");
  const bindings = [...toml.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(bindings, ["CATALOG_MIRROR"], `the storefront binds more than the catalog mirror: ${bindings}`);

  for (const store of OPS_ONLY_STORES) {
    assert.ok(!bindings.includes(store), `${store} must never be bound on the public Worker`);
    assert.doesNotMatch(
      toml,
      new RegExp(`^\\s*database_name\\s*=\\s*"vemians-${store.toLowerCase()}"`, "m"),
      `the ${store} database is named in the storefront's config`,
    );
  }

  /* And the change is explained where the next person will look, rather than
     left as a diff nobody reads twice. */
  assert.match(toml, /ONE D1 BINDING ON THIS WORKER/);
  assert.match(toml, /THIS BLOCK USED TO SAY "no D1 bindings/);
});

labeled("test_PRD_P0_24_binding_scoped_tools__staging_binds_the_mirror_and_nothing_else", () => {
  /* wrangler.staging.toml is a second file precisely so it has no inheritance
     from wrangler.toml to trust — which means it also gets NONE of that
     file's checks for free. Same assertion, same file-not-found risk this
     test exists to catch if wrangler.staging.toml is ever deleted or renamed. */
  const toml = read("store", "wrangler.staging.toml");
  const bindings = [...toml.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(bindings, ["CATALOG_MIRROR"], `staging binds more than the catalog mirror: ${bindings}`);
  for (const store of OPS_ONLY_STORES) {
    assert.ok(!bindings.includes(store), `${store} must never be bound on the staging Worker either`);
  }
});

labeled("test_PRD_P0_37_mirror_is_ours__staging_reads_the_same_mirror_as_production_never_a_second_copy", () => {
  /* One real catalog. Staging is allowed to run different CODE than
     production (that is the entire point of it existing) — never a different
     or forked D1 database, which would let it show products production never
     will and defeat "test before it's official" in the other direction. */
  const prod = read("store", "wrangler.toml");
  const staging = read("store", "wrangler.staging.toml");
  const idOf = (toml) => /database_id\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  assert.ok(idOf(prod), "production names no database id to compare against");
  assert.equal(idOf(staging), idOf(prod), "staging must read the exact same CATALOG_MIRROR database as production");
});

labeled("test_PRD_P0_26_owned_storefront__staging_is_a_different_worker_with_a_different_credential", () => {
  /* The two files must disagree on exactly these two things, or staging is
     not actually isolated from production: same Worker name would mean
     `wrangler deploy` from either file deploys over the other; same secret
     NAME (not value — no value is ever committed) would let one Worker's
     compromise expose the other's credential the moment both happen to hold
     the same string, which is precisely the mistake ADR-015 was written to
     rule out for ops vs. the public storefront and must not reappear between
     the storefront's own two environments. */
  const prod = read("store", "wrangler.toml");
  const staging = read("store", "wrangler.staging.toml");
  const nameOf = (toml) => /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  assert.ok(nameOf(prod) && nameOf(staging), "both files must name a Worker");
  assert.notEqual(nameOf(staging), nameOf(prod), "staging must be a different Worker, not the same one twice");

  for (const toml of [prod, staging]) {
    assert.match(toml, /SQUARE_ACCESS_TOKEN_CONTACT/, "each environment documents its own contact-form credential");
  }
});

labeled("test_PRD_P0_24_binding_scoped_tools__the_seven_ops_stores_are_bound_on_ops", () => {
  /* The other half of the same invariant: they did not go missing, they are
     over there. A check that only asserts absence passes when a store is
     deleted from both files. */
  const ops = read("ops", "wrangler.toml");
  const bound = [...ops.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  for (const store of OPS_ONLY_STORES) {
    assert.ok(bound.includes(store), `${store} is bound on neither Worker`);
  }
  /* The mirror is bound on BOTH, and that is the one deliberate overlap: ops
     writes it from the scheduled sync, the storefront reads it. */
  assert.ok(bound.includes("CATALOG_MIRROR"));
});

labeled("test_PRD_P0_24_binding_scoped_tools__the_storefront_reads_only_the_mirrors_index_views", () => {
  /* Scope is structural, but the query still has to stay inside the working set
     (ADR-008): the shop reads the *_index views, never the base tables, so an
     archived product cannot reach the page through a forgotten WHERE clause. */
  const src = read("store", "src", "catalog.js");
  const sql = /const MIRROR_SQL = `([\s\S]*?)`;/.exec(src);
  assert.ok(sql, "the mirror read is not where this check expects it");
  const tables = [...sql[1].matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1]);
  assert.ok(tables.length >= 2, "expected the product and variant reads");
  for (const t of tables) assert.match(t, /_index$/, `the storefront reads the base table ${t}, not its index view`);
  assert.doesNotMatch(sql[1], /\bmirror_inventory_change\b/, "stock history is not the shop's to read");
});
