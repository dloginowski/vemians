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

import { esc, money, page } from "../../shared/view/html.js";
import { addressLine, mapsSearchUrl, openDaysLabel } from "../../shared/site.js";
import { CSS, drawer, footer, header, label } from "./shell.js";
import { href, PAGE, SORTS } from "./query.js";

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
  /* Brand and eyebrow are the catalog's to have or not have. A mirrored product
     has neither — Square's ITEM carries no brand and no editorial eyebrow, and
     store/src/catalog.js refuses to invent them — so the elements are OMITTED
     rather than rendered empty: an empty <p class="brand"> is a blank line of
     reserved space above every name, and an alt text reading " — Silk dress"
     announces a dash to a screen reader. */
  const brand = product.brand || "";
  const eyebrow = product.eyebrow || "";
  const label = brand ? `${esc(brand)} &mdash; ${esc(product.name)}` : esc(product.name);
  return `<article class="card" data-handle="${esc(product.handle)}">
  <div class="card-head"><span class="eyebrow">${esc(eyebrow)}</span><span class="heart" data-heart="${esc(product.handle)}" data-name="${brand ? `${esc(brand)} ` : ""}${esc(product.name)}" aria-hidden="true">&#9825;</span></div>
  <div class="card-media" data-alt="${esc(shotUrl(product, 1))}">
    <img class="shot" src="${esc(shotUrl(product, 0))}" alt="${label}" width="800" height="900" decoding="async"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}>
  </div>
${brand ? `  <p class="brand">${esc(brand)}</p>\n` : ""}  <p class="name">${esc(product.name)}</p>
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

  /* No brands in the serving catalog (the mirror holds none) means no Brand
     fieldset — a legend over nothing is a control that looks broken. */
  const brandSet = brands.length
    ? `  <fieldset>
    <legend>Brand</legend>
${brandBoxes}
  </fieldset>
`
    : "";

  /* The category is carried ACROSS a filter submit, as a hidden field, because
     the form's action is "/" and a filter applied inside Shoes must stay inside
     Shoes. Without it, ticking a brand silently navigates out of the category
     the visitor is standing in. */
  const carried =
    (q.category ? `  <input type="hidden" name="category" value="${esc(q.category)}">\n` : "") +
    /* And the sub with it, for the same reason: a filter applied inside Dresses
       must stay inside Dresses rather than surfacing to the whole of Clothing. */
    (q.category && q.sub ? `  <input type="hidden" name="sub" value="${esc(q.sub)}">\n` : "");

  return `<form class="panel" id="filters" method="get" action="/">
  <button class="btn btn-quiet panel-close" type="button">Close</button>
${carried}${brandSet}  <fieldset>
    <legend>Sort</legend>
${sortRadios}
  </fieldset>
  <button class="btn" type="submit">Apply</button>
  <a class="btn btn-quiet" href="${esc(q.category ? `/?category=${encodeURIComponent(q.category)}` : "/")}">Clear</a>
</form>`;
}

/*
 * The category navigation moved into the drawer (src/shell.js), which builds it
 * from the same derived category list this page is handed and adds the second
 * level. It is still BUILT FROM THE CATALOG, not typed: every link goes
 * somewhere that holds something, and a new category appears without anyone
 * editing a template. That property is the whole of P0-47 and it did not move
 * when the markup did.
 */

/*
 * `source` is "mirror" or "seed" — which catalog actually served this render
 * (store/src/catalog.js, Test-PRD-P0-49-mirror_or_seed). It reaches exactly one
 * place, the footer line, because a prototype that says "seed data" while
 * serving the real mirror is a lie in the only place anyone looks to check.
 * It defaults to "seed" so a caller that has not resolved a source cannot
 * accidentally claim the mirror.
 */
export function catalogPage(brands, categories, q, picked, source = "seed", subsByCategory = {}) {
  /* The heading names where you are standing. A grid filtered to Dresses under
     a headline reading "The autumn edit" is a page that has quietly lost the
     visitor's place. */
  const heading = q.sub ? label(q.sub) : q.category ? label(q.category) : "The autumn edit";
  const standfirst = q.category
    ? "Everything here is in the shop now, in one room, on one rail."
    : "Outerwear cut for weight rather than volume, and the knitwear that sits under it. Photographed flat, on the ground the whole catalog is built on.";

  return page(
    "Vemians",
    `<div class="bar">${esc(openDaysLabel())} &middot; <a href="${esc(mapsSearchUrl())}" rel="noopener" target="_blank">${esc(addressLine())}</a></div>
${header()}
${drawer(categories, subsByCategory, q)}
<section class="edit">
  <h1>${esc(heading)}</h1>
  <p>${esc(standfirst)}</p>
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
${footer(source === "mirror" ? "Prototype · served from our catalog mirror" : "Prototype · seed data, no commerce provider attached")}`,
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
