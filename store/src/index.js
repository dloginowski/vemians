/*
 * Vemians storefront — the public surface, and only the public surface.
 *
 *   vemians.com/*   public catalog. No Cloudflare Access. Anyone can view.
 *
 * The employee area is a SEPARATE WORKER in ../ops. Cloudflare Access applies
 * to a whole Worker, not to a route within one, so a single Worker serving both
 * surfaces cannot be gated on one and open on the other — turning Access on
 * would put a login page in front of the shop. That is why there are two
 * deployments, and why this package holds no ops code at all: `/ops` is not a
 * route that is switched off here, it is a route that does not exist, because
 * access.js, agent.js, mcp.js and tools/ are not in this bundle.
 *
 *   wrangler deploy   ->  vemians-storefront, SURFACE=public, no Access
 *
 * SURFACE stays as the pin it always was. It is set to "public" in
 * wrangler.toml, and this Worker refuses to serve anything if it is ever handed
 * SURFACE=ops — a build meant for the employee area must not answer as the shop
 * on the strength of a wrong var.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROUTE TABLE, AND WHY EVERY ONE OF THEM IS A PLAIN GET
 * ─────────────────────────────────────────────────────────────────────────────
 *   /              the catalog. Filter, sort and page size are the query
 *                  string (query.js) — so the filter form, the load-more link
 *                  and a pasted URL are the same mechanism, and every one of
 *                  them works with JavaScript switched off.
 *   /?partial=1    the load-more FRAGMENT: only the cards the previous URL did
 *                  not have, plus the next link. Same renderer as the page.
 *   /s.js          the enhancement script, served verbatim from
 *                  shared/view/enhance.client.js.
 *   /img/<h>-<v>.svg  placeholder photography, one shot per URL, so images can
 *                  actually load, decode and be preloaded on hover intent.
 *   /bag           the bag. Held on the viewer's device, never here.
 *   /visit         hours, directions, how to reach a person, how to join the list.
 *   /collaborations  editorial.
 *   /healthz       liveness.
 *
 * No POST, no cookie, no session. Nothing on this Worker writes — to D1 or to
 * anything else — and nothing leaves it: there is no call to fetch in this
 * bundle at all, which is what makes "the shop cannot read the provider live"
 * a property of the import list rather than a promise
 * (Test-PRD-P0-37-mirror_is_ours).
 *
 * A CONTACT FORM WOULD BREAK THAT, and so it is not here yet. Delivering a
 * message means one outbound request, and where that request goes is a decision
 * about where a stranger's name and email address land — not something to pick
 * by default. The visit page carries the phone number and the address instead,
 * both of which work today.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE BINDING, AND WHY THE INVARIANT CHANGED
 * ─────────────────────────────────────────────────────────────────────────────
 * This Worker used to carry NO D1 binding at all, and the test asserted zero.
 * That stated the mechanism where it meant the intent: the shop must not be
 * able to reach customer data. It now binds `CATALOG_MIRROR` — READ ONLY, and
 * nothing else — because that store holds products, prices and categories,
 * which are the page. ADR-009 requires exactly this: the storefront reads OUR
 * MIRROR of Square, never Square per request, so a provider outage costs
 * checkout and not browsing. src/catalog.js is the whole of that read and holds
 * no HTTP client, no token and no Square identifier.
 *
 * The invariant is now an ALLOW-LIST: `catalog_mirror` and nothing else, with
 * customers, identity, commerce, people, finance, audit and tickets named
 * explicitly in the check, so adding one here fails the suite
 * (Test-PRD-P0-24-binding_scoped_tools).
 *
 * With no mirror bound, or an empty one, the shop serves the seed catalog and
 * says which at INFO (Test-PRD-P0-49-mirror_or_seed) — a failed sync must not
 * blank the shop, and `wrangler dev --local` must work with no Square account.
 *
 * PRD: Test-PRD-P0-26-owned_storefront, Test-PRD-P0-27-adaptive_grid,
 *      Test-PRD-P0-28-image_contract, Test-PRD-P0-37-mirror_is_ours,
 *      Test-PRD-P0-42-progressive_storefront, Test-PRD-P0-46-viewer_local_wishlist,
 *      Test-PRD-P0-47-category_navigation, Test-PRD-P0-49-mirror_or_seed.
 */

import { notFoundPage } from "../../shared/view/html.js";
import script from "../../shared/view/enhance.client.js";
import { loadCatalog } from "./catalog.js";
import { brandsOf, categoriesOf, parseQuery, select, subsOf } from "./query.js";
import { bagPage, collaborationsPage, visitPage } from "./pages.js";
import { catalogPage, catalogPartial, shotSvg } from "./views.js";

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/* Placeholder art and the enhancement script are immutable for a given URL and
   cheap to regenerate; an hour is long enough to matter on a repeat view and
   short enough that a deploy is not stuck behind it. */
const asset = (body, type) =>
  new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=3600" } });

/* /img/<handle>-<variant>.svg. The handle must be one we actually ship: the
   URL is not a template that renders whatever it is handed. */
const SHOT = /^\/img\/(.+)-(\d+)\.svg$/;

/* The second level of the nav, per category, derived exactly as the first is.
   One shape, built once per request and handed to every page, so the drawer is
   the same drawer everywhere. */
function subsFor(products, categories) {
  const out = {};
  for (const c of categories) out[c] = subsOf(products, c);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

    /* Pinned to the wrong surface: serve nothing rather than the wrong thing. */
    if (env.SURFACE === "ops") {
      console.error("ERROR store: SURFACE=ops on the storefront Worker — refusing every request");
      return html(notFoundPage(), 404);
    }

    if (url.pathname === "/s.js") return asset(script, "text/javascript; charset=utf-8");

    /* Both remaining routes render the catalog, so both resolve it the same
       way — the shot for a mirrored product must exist for the card that
       points at it, which it cannot if the two paths read different sources. */
    const shot = SHOT.exec(url.pathname);
    if (shot) {
      const { products } = await loadCatalog(env);
      const product = products.find((p) => p.handle === shot[1]);
      const variant = Number(shot[2]);
      if (!product || variant > 1) return html(notFoundPage(), 404);
      return asset(shotSvg(product, variant), "image/svg+xml; charset=utf-8");
    }

    /*
     * The pages that are not the catalog. Each is handed the derived taxonomy
     * because each renders the same drawer — a menu that lists different
     * categories depending on which page you opened it from would be a bug
     * nobody would think to look for.
     */
    if (url.pathname === "/bag" || url.pathname === "/visit" || url.pathname === "/collaborations") {
      const { products } = await loadCatalog(env);
      const categories = categoriesOf(products);
      const subs = subsFor(products, categories);
      if (url.pathname === "/bag") return html(bagPage(categories, subs));
      if (url.pathname === "/collaborations") return html(collaborationsPage(categories, subs));
      return html(visitPage(categories, subs));
    }

    if (url.pathname === "/") {
      const { products, source } = await loadCatalog(env);
      /* Categories are whatever the SERVED catalog holds — Square's taxonomy
         when the mirror is serving, the seed's when it is not. Derived, never
         listed, so the nav rebuilds from a re-categorised catalog with no code
         change at all (Test-PRD-P0-47-category_navigation). */
      const categories = categoriesOf(products);
      const q = parseQuery(url, categories);
      const picked = select(products, q);
      /* The fragment and the page are the same selection rendered two ways.
         There is no second query path for the enhanced client. */
      return url.searchParams.get("partial") === "1"
        ? html(catalogPartial(q, picked))
        : html(catalogPage(brandsOf(products), categories, q, picked, source, subsFor(products, categories)));
    }

    /* Including /ops. The employee area has no unauthenticated twin on this
       host because it has no code on this host. */
    return html(notFoundPage(), 404);
  },
};
