/*
 * What the URL means. One module, so the full page, the load-more fragment and
 * the <form> that submits without JavaScript all agree about it.
 *
 * The whole filter/sort/paging contract is a GET query string and nothing else:
 *
 *   /?category=shoes&brand=Aurelien&brand=Vestra&sort=price-asc&n=16
 *
 * That is the point. The panel in the browser is an enhancement over this URL,
 * not a replacement for it — with JavaScript off the same form submits to the
 * same query and the Worker answers the same way, and with JavaScript on the
 * address bar is kept equal to it so a reload restores what you were looking
 * at. Nothing about the result set lives only in the client.
 *
 * PRD: Test-PRD-P0-42-progressive_storefront.
 */

/* How many cards a page starts with, and how many each "show more" adds. */
export const PAGE = 8;

export const SORTS = {
  featured: "Featured",
  "price-asc": "Price, low to high",
  "price-desc": "Price, high to low",
  name: "Name, A to Z",
};

const COMPARE = {
  /* Every price in the catalog is an integer minor amount in an explicit
     currency (PRD N4). These orderings are only meaningful within one
     currency, and the seed catalog is entirely USD; a multi-currency catalog
     needs a converted sort key rather than a comparison of raw minor units. */
  "price-asc": (a, b) => a.minor - b.minor,
  "price-desc": (a, b) => b.minor - a.minor,
  name: (a, b) => a.name.localeCompare(b.name, "en"),
};

/* Every distinct brand in the catalog, for the filter form. Derived, never
   listed: a brand cannot be missing from the filter because someone forgot to
   add it in a second place. */
export const brandsOf = (products) => [...new Set(products.map((p) => p.brand))].sort();

/* The closed set of categories, derived from the catalog rather than listed.
   A category cannot go missing from the nav because someone forgot to add it,
   and one cannot be navigated to that holds nothing. ADR-010 requires the
   agent to choose from an existing set; this is that set. */
export const categoriesOf = (products) =>
  [...new Set(products.map((p) => p.category).filter(Boolean))].sort();

export function parseQuery(url, known = null) {
  const params = url.searchParams;
  const sort = params.get("sort");
  const n = Number.parseInt(params.get("n") ?? "", 10);
  return {
    /* Unknown brands and unknown sorts are dropped rather than 400'd: a stale
       or hand-edited link should show the shop, not an error page. */
    /* An unknown category is DROPPED, not filtered on. A stale bookmark or a
       hand-typed link then shows the whole catalog rather than an empty grid
       with no explanation — which reads as a broken shop, not a bad link.
       Callers that pass the known set get this; ones that do not are trusted. */
    category: (() => {
      const c = params.get("category") || null;
      if (!c) return null;
      return !known || known.includes(c) ? c : null;
    })(),
    brands: params.getAll("brand").filter(Boolean),
    sort: Object.prototype.hasOwnProperty.call(SORTS, sort) ? sort : "featured",
    n: Number.isFinite(n) ? n : PAGE,
  };
}

/* `n` is clamped here rather than at parse time because the ceiling is the
   number of MATCHING products, which is not known until the filter has run.
   Applied to n - PAGE as well, which is what makes `fresh` right at the end of
   the catalog: asking for 16 of 12 shows 12 and only FOUR of them are new. */
const clamp = (n, total) => Math.min(Math.max(n, PAGE), Math.max(total, PAGE));

/* Query in, the slice to render out.
 *   shown  everything this URL displays — what the full page renders.
 *   fresh  only what the previous URL did not — what the load-more fragment
 *          renders, so an append adds each card exactly once.
 */
export function select(products, q) {
  let matched = products.slice();
  if (q.category) matched = matched.filter((p) => p.category === q.category);
  if (q.brands.length) matched = matched.filter((p) => q.brands.includes(p.brand));
  const cmp = COMPARE[q.sort];
  if (cmp) matched.sort(cmp);

  const total = matched.length;
  const n = clamp(q.n, total);
  const from = Math.min(clamp(q.n - PAGE, total), n);
  return { shown: matched.slice(0, n), fresh: matched.slice(from, n), total };
}

/* Build a URL for this query with some of it overridden. The single place a
   storefront link is spelled — the load-more href, the form's own action and
   the "clear" link all come through here, so they cannot disagree about how a
   brand or a sort is named. */
export function href(q, over = {}) {
  const merged = { ...q, ...over };
  const params = new URLSearchParams();
  merged.brands.forEach((b) => params.append("brand", b));
  if (merged.sort && merged.sort !== "featured") params.set("sort", merged.sort);
  if (merged.n && merged.n !== PAGE) params.set("n", String(merged.n));
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}
