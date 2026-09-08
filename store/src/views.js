/*
 * The storefront's HTML. Template literals, no framework, no build step — see
 * README §Why no framework. The page shell, the escaper and the money format
 * are shared/view/html.js; the design tokens are shared/design/theme.css and
 * the grid is shared/design/catalog-grid.css, imported verbatim as a text
 * module rather than pasted into a template and left to drift.
 *
 * Nothing in this file knows the ops surface exists. It is not in this Worker.
 */

import { esc, money, page } from "../../shared/view/html.js";
import grid from "../../shared/design/catalog-grid.css";

/*
 * Placeholder imagery. Inline SVG on the #EFF0F4 ground at the 8:9 contract
 * ratio, generated from the product's own tone value — deterministic, weightless
 * and ours. Real photography arrives from R2 via Cloudflare Images with a
 * `sizes` attribute mirroring --card-min (design-direction.md §6); nothing here
 * hotlinks anybody else's pictures.
 */
function placeholder(p) {
  const w = 320 + Math.round(p.tone * 700);
  const h = 520 + Math.round(p.tone * 1200);
  const x = 400 - w / 2;
  const y = 900 - h - 60;
  const ink = Math.round(210 - p.tone * 420);
  return `<svg viewBox="0 0 800 900" width="800" height="900" role="img" aria-label="${esc(p.name)}" preserveAspectRatio="xMidYMid slice">
  <rect width="800" height="900" fill="#EFF0F4"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${ink},${ink},${ink + 6})"/>
  <rect x="${x}" y="${y}" width="${w}" height="${Math.round(h * 0.18)}" fill="rgb(${ink + 14},${ink + 14},${ink + 20})"/>
</svg>`;
}

function card(p) {
  return `<article class="card">
  <div class="card-head"><span class="eyebrow">${esc(p.eyebrow)}</span><span class="heart" aria-hidden="true">&#9825;</span></div>
  <div class="card-media">${placeholder(p)}</div>
  <p class="brand">${esc(p.brand)}</p>
  <p class="name">${esc(p.name)}</p>
  <p class="price">${esc(money(p.minor, p.currency))}</p>
</article>`;
}

export function catalogPage(products) {
  return page(
    "Vemians",
    `<div class="bar">Complimentary shipping and returns on every order</div>
<header class="masthead">
  <p class="wordmark">Vemians</p>
  <nav class="nav">
    <a href="/">New in</a><span>|</span><a href="/">Clothing</a><span>|</span><a href="/">Shoes</a><span>|</span><a href="/">Bags</a><span>|</span><a href="/">Accessories</a><span>|</span><a href="/">Editorial</a>
  </nav>
</header>
<section class="edit">
  <h1>The autumn edit</h1>
  <p>Outerwear cut for weight rather than volume, and the knitwear that sits under it. Photographed flat, on the ground the whole catalog is built on.</p>
</section>
<main class="catalog" id="catalog">
${products.map(card).join("\n")}
</main>
<footer class="foot">Prototype &middot; seed data, no commerce provider attached</footer>`,
    grid,
  );
}
