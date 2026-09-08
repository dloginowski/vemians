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
import themeSource from "../design/theme.css";

/*
 * Comments belong in the repository, not on the wire.
 *
 * The design CSS is heavily commented — deliberately, because the tokens are
 * measurements and the motion values are assumptions and a later reader has to
 * be able to tell which is which. But this CSS is INLINED into every HTML
 * response, so every one of those comments is bytes on the critical path of a
 * page whose budget is a p75 LCP under 2.0s on 4G (PRD N1). Stripping them at
 * the boundary keeps both: the source stays explained, the response stays thin.
 *
 * Comments and indentation only. No selector rewriting, no property reordering,
 * no shortening — this is not a minifier, and nothing here can change what a
 * rule means. Run it ONCE per isolate at module scope, never per request.
 */
export const lean = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/[ \t]*\n[ \t\n]*/g, "\n")
    .trim();

const THEME = lean(themeSource);

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

/*
 * `script` is the URL of a progressive-enhancement script, or "" for a surface
 * that has none (ops has none). Passing one buys two things in <head>:
 *
 *   1. A `js` class on <html>, set by one inline statement BEFORE first paint.
 *      This is what lets a stylesheet lay an element out differently when a
 *      script is going to upgrade it — the storefront's filter form is a
 *      normal-flow <form> without it and an off-canvas panel with it — WITHOUT
 *      the layout being decided once and then changed. The class is set from
 *      the head, so there is never a frame in which the wrong one applies, and
 *      it is set by the browser that will run the script rather than guessed
 *      from a user agent.
 *
 *   2. The script itself, `defer`red: parsed in parallel, executed after the
 *      document and before DOMContentLoaded. It never blocks the render, and
 *      in particular never blocks the LCP image (PRD N1).
 */
export function page(title, body, extraCss = "", script = "") {
  const boot = script
    ? `<script>document.documentElement.className="js"</script>
<script src="${esc(script)}" defer></script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${THEME}${extraCss}</style>
${boot}
</head>
<body>
${body}
</body>
</html>`;
}

export function notFoundPage() {
  return page("Not found", `<main class="ops"><h2>404</h2><p>Nothing here.</p></main>`);
}
