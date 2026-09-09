/*
 * The parts of every page that are not the page: the header, the navigation
 * drawer and the footer.
 *
 * Split out of views.js because three pages now share them, and a header that
 * exists in three template literals is a header that will differ in two of them
 * by the end of the month.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DRAWER, WITH JAVASCRIPT OFF
 * ─────────────────────────────────────────────────────────────────────────────
 * It is a <nav> full of nested <ul>s, in normal flow, at the top of the
 * document: the whole taxonomy, every link real, nothing hidden. That is a
 * worse experience than the drawer and it is a WORKING one, which is the deal
 * this storefront makes everywhere else (Test-PRD-P0-42-progressive_storefront).
 *
 * WITH JAVASCRIPT the .js class — set in <head> before first paint — reads the
 * same markup as an off-canvas dialog that slides in from the left over a
 * scrim, with the sub-lists as panes that slide in from the right and a back
 * control that returns. No markup moves. The drill-down is CSS state on one
 * attribute, so a pane cannot be half-open or two panes open at once.
 *
 * The trigger is rendered `hidden` and revealed by `.js`, for the same reason
 * the wishlist heart is a glyph until a script upgrades it: a control that
 * cannot work must not be on the page.
 */

import { esc, lean } from "../../shared/view/html.js";
import gridSource from "../../shared/design/catalog-grid.css";
import interactionSource from "../../shared/design/interaction.css";
import { FOOTER, SITE, addressLine, mapsDirectionsUrl } from "../../shared/site.js";

/*
 * The stylesheet every page on this Worker is served with, stripped of comments
 * once per isolate rather than once per request (see lean()).
 *
 * It lives HERE, next to the header and the drawer, because those are what it
 * mostly styles and because every page needs it. It used to live in views.js,
 * which meant the catalog got it and the three pages added later did not — the
 * visit page rendered as unstyled markup with a fully expanded nav, which is
 * exactly what "the drawer is progressive enhancement" looks like when the
 * enhancement half never arrives.
 */
export const CSS = lean(gridSource + "\n" + interactionSource);

/* Category and sub names arrive lowercase from the catalog. Presented in
   sentence case, never upper — design-direction.md §3 reserves tracked caps for
   the wordmark alone. */
export const label = (c) => String(c).charAt(0).toUpperCase() + String(c).slice(1);

const catHref = (c) => `/?category=${encodeURIComponent(c)}`;
const subHref = (c, s) => `${catHref(c)}&sub=${encodeURIComponent(s)}`;

/*
 * One category row. A category with sub-categories gets TWO controls: the name,
 * which is a link straight to the category, and a chevron, which is a button
 * that opens the pane. They are separate on purpose — a row that only drills in
 * makes "show me everything in Clothing" a two-tap operation, and a row that
 * only navigates hides the sub-categories entirely.
 */
function menuRow(category, subs, q) {
  const on = q && q.category === category && !q.sub;
  const link = `<a href="${esc(catHref(category))}"${on ? ' aria-current="page"' : ""}>${esc(label(category))}</a>`;
  if (!subs.length) return `      <li>${link}</li>`;

  const id = `menu-sub-${esc(category)}`;
  const items = [
    `        <li><a href="${esc(catHref(category))}">View all</a></li>`,
    ...subs.map(
      (s) =>
        `        <li><a href="${esc(subHref(category, s))}"${
          q && q.category === category && q.sub === s ? ' aria-current="page"' : ""
        }>${esc(label(s))}</a></li>`,
    ),
  ].join("\n");

  return `      <li class="has-sub">
        ${link}
        <button class="menu-into" type="button" aria-controls="${id}" aria-expanded="false" aria-label="${esc(label(category))} categories">&rsaquo;</button>
        <ul class="menu-sub" id="${id}" data-sub="${esc(category)}">
          <li class="menu-back"><button class="menu-out" type="button">&lsaquo; ${esc(label(category))}</button></li>
${items}
        </ul>
      </li>`;
}

export function drawer(categories, subsByCategory, q) {
  const rows = categories.map((c) => menuRow(c, subsByCategory[c] || [], q)).join("\n");
  return `<nav class="menu" id="menu" aria-label="Main">
  <div class="menu-head">
    <p class="menu-title">Shop</p>
    <button class="panel-close menu-close" type="button" aria-label="Close menu">&times;</button>
  </div>
  <ul class="menu-root">
      <li><a href="/"${q && !q.category ? ' aria-current="page"' : ""}>New in</a></li>
${rows}
  </ul>
  <ul class="menu-root menu-rest">
    <li><a href="/collaborations">Collaborations</a></li>
    <li><a href="/visit">Visit the store</a></li>
    <li><a href="/visit#appointments">Book an appointment</a></li>
  </ul>
</nav>`;
}

/*
 * The header. Menu on the left, wordmark centred, bag on the right — the
 * arrangement the genre has settled on, and the one the reference uses.
 *
 * There is no search control, because there is no search. An icon that opens
 * nothing is the same lie as a nav link that goes nowhere, and this file
 * deleted six of those once already.
 *
 * The bag count is written by the script from the viewer's own device. The
 * server renders the element empty and it stays empty with JavaScript off,
 * which is correct: this Worker holds no cart and sets no cookie.
 */
export function header() {
  return `<header class="masthead" data-head="top">
  <button class="menu-open" type="button" aria-controls="menu" aria-expanded="false" aria-label="Open menu">
    <span class="bars" aria-hidden="true"></span>
  </button>
  <a class="wordmark-link" href="/"><p class="wordmark">${esc(SITE.name)}</p></a>
  <a class="bag-link" href="/bag" aria-label="Your bag">
    <span class="bag-glyph" aria-hidden="true"></span><span class="bag-count" data-bag-count></span>
  </a>
</header>`;
}

const socialRow = () =>
  SITE.social
    .map((s) => `<a href="${esc(s.href)}" rel="me noopener" target="_blank">${esc(s.name)}</a>`)
    .join("");

export function footer(note = "") {
  const columns = FOOTER.map(
    (col) => `    <div class="foot-col">
      <h2>${esc(col.heading)}</h2>
      <ul>
${col.links.map((l) => `        <li><a href="${esc(l.href)}">${esc(l.text)}</a></li>`).join("\n")}
      </ul>
    </div>`,
  ).join("\n");

  return `<footer class="foot">
  <div class="foot-cols">
${columns}
    <div class="foot-col">
      <h2>Find us</h2>
      <p><a href="${esc(mapsDirectionsUrl())}" rel="noopener" target="_blank">${esc(addressLine())}</a></p>
      <p><a href="tel:${esc(SITE.phone.replace(/[^+\d]/g, ""))}">${esc(SITE.phone)}</a></p>
      <p><a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a></p>
    </div>
  </div>
  <div class="foot-social">
    <h2>Follow us on</h2>
    <div class="social">${socialRow()}</div>
  </div>
  ${note ? `<p class="foot-note">${esc(note)}</p>` : ""}
</footer>`;
}
