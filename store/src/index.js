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
 *   /healthz       liveness.
 *
 * No POST, no cookie, no session, no D1. Nothing on this Worker writes.
 *
 * PRD: Test-PRD-P0-26-owned_storefront, Test-PRD-P0-27-adaptive_grid,
 *      Test-PRD-P0-28-image_contract, Test-PRD-P0-42-progressive_storefront,
 *      Test-PRD-P0-46-viewer_local_wishlist.
 */

import { notFoundPage } from "../../shared/view/html.js";
import { products } from "../../shared/seed/catalog.js";
import script from "../../shared/view/enhance.client.js";
import { brandsOf, categoriesOf, parseQuery, select } from "./query.js";
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

    const shot = SHOT.exec(url.pathname);
    if (shot) {
      const product = products.find((p) => p.handle === shot[1]);
      const variant = Number(shot[2]);
      if (!product || variant > 1) return html(notFoundPage(), 404);
      return asset(shotSvg(product, variant), "image/svg+xml; charset=utf-8");
    }

    if (url.pathname === "/") {
      const q = parseQuery(url, categoriesOf(products));
      const picked = select(products, q);
      /* The fragment and the page are the same selection rendered two ways.
         There is no second query path for the enhanced client. */
      return url.searchParams.get("partial") === "1"
        ? html(catalogPartial(q, picked))
        : html(catalogPage(brandsOf(products), categoriesOf(products), q, picked));
    }

    /* Including /ops. The employee area has no unauthenticated twin on this
       host because it has no code on this host. */
    return html(notFoundPage(), 404);
  },
};
