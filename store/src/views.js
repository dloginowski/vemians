/*
 * The storefront's HTML. Template literals, no framework, no build step — see
 * README §Why no framework. The page shell, the escaper and the money format
 * are shared/view/html.js; the design tokens are shared/design/theme.css, the
 * grid is shared/design/catalog-grid.css and the behaviour layer is
 * shared/design/interaction.css, each imported verbatim as a text module rather
 * than pasted into a template and left to drift.
 *
 * Nothing in this file knows the ops surface exists. It is not in this Worker.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE SERVER OWES A BROWSER WITH JAVASCRIPT OFF
 * ─────────────────────────────────────────────────────────────────────────────
 * All of it. The markup below is the whole storefront, not a shell for a script
 * to fill in: the images are <img src> with explicit dimensions, the filter and
 * sort controls are a <form method="get">, and "show more" is an <a href> to
 * the same page with a larger `n`. shared/view/enhance.client.js upgrades those
 * in place — it never supplies them.
 *
 * The one exception is the wishlist heart, which cannot work without a script
 * and is therefore rendered as an aria-hidden GLYPH rather than as a control.
 * The script replaces the span with a real button. A button that silently does
 * nothing is worse than no button.
 *
 * PRD: Test-PRD-P0-26-owned_storefront, Test-PRD-P0-28-image_contract,
 *      Test-PRD-P0-42-progressive_storefront, Test-PRD-P0-45-stable_layout.
 */

import { esc, lean, money, page } from "../../shared/view/html.js";
import gridSource from "../../shared/design/catalog-grid.css";
import interactionSource from "../../shared/design/interaction.css";
import { href, PAGE, SORTS } from "./query.js";

/* Stripped of comments once per isolate, not once per request. See lean(). */
const CSS = lean(gridSource + "\n" + interactionSource);

/*
 * Placeholder imagery. SVG on the #EFF0F4 ground at the 8:9 contract ratio,
 * generated from the product's own tone value — deterministic, weightless and
 * ours. Real photography arrives from R2 via Cloudflare Images with a `srcset`
 * and a `sizes` attribute mirroring --card-min (design-direction.md §6, and the
 * comment at the foot of catalog-grid.css); nothing here hotlinks anybody
 * else's pictures.
 *
 * It is served from a URL rather than inlined into the markup because the
 * interaction layer needs images to BE images: something that loads, decodes,
 * fades in when it does, and can be preloaded on hover intent. An inline <svg>
 * has already arrived by the time the page exists and can do none of that.
 *
 * `variant` is the shot index. 0 is the product; 1 is the alternate view the
 * hover swap cross-fades to — a different crop and stance of the same object,
 * which is what the second shot is in this genre.
 */
export function shotSvg(product, variant = 0) {
  const alt = variant === 1;
  const w = (alt ? 250 : 320) + Math.round(product.tone * (alt ? 900 : 700));
  const h = (alt ? 620 : 520) + Math.round(product.tone * (alt ? 900 : 1200));
  const x = 400 - w / 2 + (alt ? 40 : 0);
  const y = 900 - h - (alt ? 20 : 60);
  const ink = Math.round((alt ? 196 : 210) - product.tone * 420);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 900" width="800" height="900" role="img" aria-label="${esc(product.name)}" preserveAspectRatio="xMidYMid slice">
  <rect width="800" height="900" fill="#EFF0F4"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${ink},${ink},${ink + 6})"/>
  <rect x="${x}" y="${y}" width="${w}" height="${Math.round(h * 0.18)}" fill="rgb(${ink + 14},${ink + 14},${ink + 20})"/>
</svg>`;
}

export const shotUrl = (product, variant = 0) => `/img/${product.handle}-${variant}.svg`;

/*
 * One card. `eager` is true for the first row's worth: those get
 * fetchpriority="high" and no lazy attribute, because they are the LCP
 * candidates (design-direction.md §6 / PRD N1). Everything after is lazy.
 *
 * The alternate shot's URL rides on data-alt as a STRING, not as a second
 * <img> and not as a <link rel=preload>. Nothing fetches it until a fine
 * pointer enters the card.
 */
function card(product, index) {
  const eager = index < 4;
  return `<article class="card" data-handle="${esc(product.handle)}">
  <div class="card-head"><span class="eyebrow">${esc(product.eyebrow)}</span><span class="heart" data-heart="${esc(product.handle)}" data-name="${esc(product.brand)} ${esc(product.name)}" aria-hidden="true">&#9825;</span></div>
  <div class="card-media" data-alt="${esc(shotUrl(product, 1))}">
    <img class="shot" src="${esc(shotUrl(product, 0))}" alt="${esc(product.brand)} &mdash; ${esc(product.name)}" width="800" height="900" decoding="async"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}>
  </div>
  <p class="brand">${esc(product.brand)}</p>
  <p class="name">${esc(product.name)}</p>
  <p class="price">${esc(money(product.minor, product.currency))}</p>
</article>`;
}

const cards = (products) => products.map(card).join("\n");

const said = (shown, total) =>
  `Showing ${shown} of ${total} ${total === 1 ? "product" : "products"}.`;

/*
 * The load-more control. An ordinary link to this same page with a larger `n`,
 * so with JavaScript off it is a navigation that keeps everything already on
 * screen and adds to it — not a pager that swaps one set for another and makes
 * you find your place again. The script intercepts it and appends instead.
 *
 * Rendered empty rather than omitted when the grid is complete, so the script
 * has a stable container to write the next link into.
 */
function moreRow(q, shown, total) {
  if (shown >= total) return "";
  return `<a class="btn more" href="${esc(href(q, { n: shown + PAGE }))}" rel="next">Show more</a>`;
}

/*
 * Filter and sort. A plain <form method="get"> pointed at "/", which is exactly
 * the URL contract in query.js. Every field is named and every input carries an
 * id unique to this page, so labels bind and the browser can restore state.
 *
 * `n` is deliberately NOT carried across a filter change: a new result set
 * starts at the first page. The submit button is inside the form so Enter works
 * from any field.
 */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function filterPanel(brands, q) {
  const brandBoxes = brands
    .map(
      (b) => `    <label for="f-brand-${esc(slug(b))}"><input type="checkbox" id="f-brand-${esc(slug(b))}" name="brand" value="${esc(b)}"${q.brands.includes(b) ? " checked" : ""}>${esc(b)}</label>`,
    )
    .join("\n");

  const sortRadios = Object.entries(SORTS)
    .map(
      ([value, label]) =>
        `    <label for="f-sort-${esc(value)}"><input type="radio" id="f-sort-${esc(value)}" name="sort" value="${esc(value)}"${q.sort === value ? " checked" : ""}>${esc(label)}</label>`,
    )
    .join("\n");

  return `<form class="panel" id="filters" method="get" action="/">
  <button class="btn btn-quiet panel-close" type="button">Close</button>
  <fieldset>
    <legend>Brand</legend>
${brandBoxes}
  </fieldset>
  <fieldset>
    <legend>Sort</legend>
${sortRadios}
  </fieldset>
  <button class="btn" type="submit">Apply</button>
  <a class="btn btn-quiet" href="/">Clear</a>
</form>`;
}

export function catalogPage(brands, q, picked) {
  return page(
    "Vemians",
    `<div class="bar">Complimentary shipping and returns on every order</div>
<header class="masthead" data-head="top">
  <p class="wordmark">Vemians</p>
  <nav class="nav">
    <a href="/">New in</a><span>|</span><a href="/">Clothing</a><span>|</span><a href="/">Shoes</a><span>|</span><a href="/">Bags</a><span>|</span><a href="/">Accessories</a><span>|</span><a href="/">Editorial</a>
  </nav>
</header>
<section class="edit">
  <h1>The autumn edit</h1>
  <p>Outerwear cut for weight rather than volume, and the knitwear that sits under it. Photographed flat, on the ground the whole catalog is built on.</p>
</section>
<div class="controls">
  <p class="count">${esc(said(picked.shown.length, picked.total))}</p>
  <button class="btn filter-open" type="button">Filter and sort</button>
</div>
${filterPanel(brands, q)}
<p class="sr" id="catalog-status" role="status" aria-live="polite">${esc(said(picked.shown.length, picked.total))}</p>
<main class="catalog" id="catalog">
${cards(picked.shown)}
</main>
<div class="more-row" id="more-row">${moreRow(q, picked.shown.length, picked.total)}</div>
<footer class="foot">Prototype &middot; seed data, no commerce provider attached</footer>`,
    CSS,
    "/s.js",
  );
}

/*
 * The load-more fragment. NOT a page: three labelled parts the script lifts out
 * of a DOMParser document — the cards to append, the link that replaces the one
 * just clicked (empty when the grid is complete), and the line to announce.
 * It is the same `card()` and the same `moreRow()` the full page uses, so an
 * appended card cannot render differently from a served one.
 */
export function catalogPartial(q, picked) {
  return `<div class="catalog-part">
${cards(picked.fresh)}
</div>
<div class="more-part">${moreRow(q, picked.shown.length, picked.total)}</div>
<p class="status-part">${esc(said(picked.shown.length, picked.total))}</p>`;
}
