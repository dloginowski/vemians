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
 * PRD: Test-PRD-P0-26-owned_storefront, Test-PRD-P0-27-adaptive_grid,
 *      Test-PRD-P0-28-image_contract.
 */

import { notFoundPage } from "../../shared/view/html.js";
import { products } from "../../shared/seed/catalog.js";
import { catalogPage } from "./views.js";

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

    /* Pinned to the wrong surface: serve nothing rather than the wrong thing. */
    if (env.SURFACE === "ops") {
      console.error("ERROR store: SURFACE=ops on the storefront Worker — refusing every request");
      return html(notFoundPage(), 404);
    }

    if (url.pathname === "/") return html(catalogPage(products));

    /* Including /ops. The employee area has no unauthenticated twin on this
       host because it has no code on this host. */
    return html(notFoundPage(), 404);
  },
};
