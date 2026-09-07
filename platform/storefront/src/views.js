/*
 * HTML. Template literals, no framework, no build step — see README §Why no
 * framework. Design tokens and card anatomy come from docs/design-direction.md;
 * the grid is platform/design/catalog-grid.css, imported verbatim.
 */

import grid from "../../design/catalog-grid.css";
import theme from "./theme.css";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* Integer minor units + explicit currency in, "$ 5,600" out. No floats. */
const SYMBOL = { USD: "$", GBP: "£", EUR: "€" };
export function money(minor, currency) {
  const major = minor / 100;
  const body = Number.isInteger(major)
    ? major.toLocaleString("en-US")
    : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOL[currency] || currency} ${body}`;
}

function page(title, body, extraCss = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${theme}${grid}${extraCss}</style>
</head>
<body>
${body}
</body>
</html>`;
}

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
  );
}

function opsShifts(week) {
  return week.days
    .map((d, i) => {
      const shifts = week.shifts
        .filter((s) => s.day === i)
        .map((s) => `<div class="shift">${esc(s.from)}&ndash;${esc(s.to)}<br>${esc(s.who)}<br>${esc(s.role)}</div>`)
        .join("");
      return `<div class="day"><h3>${esc(d)}</h3>${shifts}</div>`;
    })
    .join("");
}

export function opsPage(identity, { customers, week }) {
  const banner = identity.verified
    ? `<div class="who">Signed in via Cloudflare Access as <strong>${esc(identity.email)}</strong> &middot; assertion signature verified against the team JWKS.</div>`
    : `<div class="warn">Assertion accepted <strong>without signature verification</strong> — ACCESS_TEAM_DOMAIN and ACCESS_AUD are unset, so this is prototype mode. Set both in wrangler.toml before this is reachable from the internet. Claimed identity: ${esc(identity.email)}</div>`;

  return page(
    "Vemians ops",
    `<div class="bar">ops.vemians.com &middot; employees only</div>
${banner}
<main class="ops">
  <h2>Customers</h2>
  <p class="note">Opaque ids only. Name, email and phone live in the <code>identity</code> store as ciphertext and this surface holds no binding to it, so these records cannot be attributed to a person from here.</p>
  <table>
    <thead><tr><th>Customer id</th><th>Birth year</th><th>Fit</th><th>Segment</th><th>Orders</th><th>Lifetime</th><th>Consent</th></tr></thead>
    <tbody>
${customers
  .map(
    (c) => `      <tr><td>${esc(c.id)}</td><td>${esc(c.birthYear)}</td><td>${esc(c.fit)}</td><td>${esc(c.segment)}</td><td>${esc(c.orders)}</td><td>${esc(money(c.lifetimeMinor, c.currency))}</td><td>${esc(c.consent.join(", ") || "none")}</td></tr>`,
  )
  .join("\n")}
    </tbody>
  </table>

  <h2>Week of ${esc(week.starting)}</h2>
  <div class="week">${opsShifts(week)}</div>
  <p class="note">Read-only. Overlapping shifts are refused by a database trigger, not by this view.</p>

  <h2>Agent</h2>
  <p class="note">Stub. Posts to <code>/ops/agent</code> and echoes; no model is wired, no tool is bound.</p>
  <form class="chat" id="chat" method="post" action="/ops/agent">
    <input name="q" id="q" placeholder="Ask about the catalog, orders, stock or the schedule" autocomplete="off">
    <button type="submit">Send</button>
  </form>
  <div class="log" id="log"></div>
</main>
<script>
document.getElementById("chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = document.getElementById("q");
  const q = box.value.trim();
  if (!q) return;
  const log = document.getElementById("log");
  log.insertAdjacentHTML("beforeend", "<p></p>");
  log.lastElementChild.textContent = q;
  box.value = "";
  try {
    const res = await fetch("/ops/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q }),
    });
    const data = await res.json();
    log.insertAdjacentHTML("beforeend", '<p class="agent"></p>');
    log.lastElementChild.textContent = data.reply;
  } catch (err) {
    console.error("agent request failed", err);
    log.insertAdjacentHTML("beforeend", '<p class="agent"></p>');
    log.lastElementChild.textContent = "Request failed: " + err.message;
  }
});
</script>`,
  );
}

export function refusalPage(status, reason) {
  return page(
    "Refused",
    `<div class="bar">ops.vemians.com</div>
<main class="ops">
  <h2>${status} &mdash; refused</h2>
  <p>${esc(reason)}</p>
  <p class="note">This surface is served only behind Cloudflare Access. The Worker fails closed when no verified Access assertion is present.</p>
</main>`,
  );
}

export function notFoundPage() {
  return page("Not found", `<main class="ops"><h2>404</h2><p>Nothing here.</p></main>`);
}
