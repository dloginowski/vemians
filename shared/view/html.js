/*
 * The HTML both surfaces are built out of.
 *
 * `store/` and `ops/` are separate Workers with separate bundles, and this is
 * the one place either of them gets a page shell, an escaper or a money format
 * from — so a change to the document head, or to how a price is written, is one
 * edit in one file rather than the same edit made twice and drifted once.
 *
 * The design tokens come in here too, from shared/design/theme.css, imported as
 * a text module (the `[[rules]]` block in each wrangler.toml). Per-surface CSS
 * is passed in as `extraCss`: the catalog grid for the storefront, the agent
 * layout for ops. Neither surface pastes a copy of the tokens into a template.
 */
import theme from "../design/theme.css";

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* Integer minor units + explicit currency in, "$ 5,600" out. No floats.
   PRD N4 / Test-PRD-P0-15-money_minor_units. */
const SYMBOL = { USD: "$", GBP: "£", EUR: "€" };
export function money(minor, currency) {
  const major = minor / 100;
  const body = Number.isInteger(major)
    ? major.toLocaleString("en-US")
    : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOL[currency] || currency} ${body}`;
}

export function page(title, body, extraCss = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${theme}${extraCss}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function notFoundPage() {
  return page("Not found", `<main class="ops"><h2>404</h2><p>Nothing here.</p></main>`);
}
