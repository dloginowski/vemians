# store — the public storefront Worker

| Hostname | Surface | Gate |
|---|---|---|
| `vemians.com/*` | Public catalog | **None.** Anyone can view |

Deployed as the Worker `vemians-storefront`. The employee area is a different
package and a different Worker: [`../ops`](../ops/README.md), `vemians-ops`.

## Run it

Four steps from a fresh clone. Node 20+.

```sh
git clone https://github.com/dloginowski/vemians.git
cd vemians/store
npm ci                                  # wrangler, pinned in package-lock.json
npx wrangler dev --port 8787            # http://127.0.0.1:8787/
```

No env vars and no files are needed. `npx wrangler deploy` publishes it, once the
zone is on Cloudflare — the dashboard click-path is
[`docs/deploy-cloudflare.md`](../docs/deploy-cloudflare.md), and the `[[routes]]`
block in `wrangler.toml` stays commented out until the nameservers have moved,
otherwise the deploy fails trying to create a Custom Domain on a zone Cloudflare
does not hold.

```sh
curl -i http://127.0.0.1:8787/          # catalog, 200
curl -i http://127.0.0.1:8787/ops       # 404 — the employee area is not here
curl    http://127.0.0.1:8787/healthz   # ok
```

## Why the split is structural

**Cloudflare Access attaches to a whole Worker, not to a route inside one.** So
the two surfaces cannot share a deployment: gating a shared Worker would put a
login page in front of the shop.

They used to share a directory, deployed twice with a `SURFACE` var picking the
surface at runtime. `SURFACE` is still here and still pins this deployment to
`public`, but it is no longer what makes `/ops` unreachable. What makes `/ops`
unreachable is that `access.js`, `agent.js`, `mcp.js` and `tools/` are not in
this package, so they are not in this bundle. Scope is structural, not a
condition — the same argument `wrangler.toml` makes about the D1 bindings.

This Worker holds **no D1 binding, and none is coming**. The seven stores
(PRD §3.1) are bound in `../ops/wrangler.toml` and nowhere else
(Test-PRD-P0-24-binding_scoped_tools).

## Why no framework

Plain JS, no build step, no dependency but `wrangler` itself. The prototype
renders one page from template literals; Astro (PRD §3.8) earns its place when
there are collections, content, image pipelines and islands to manage, and
adding it now would mean a build step and a dependency tree in exchange for
nothing this prototype does.

The one non-obvious mechanism is the `[[rules]]` block in `wrangler.toml`, which
loads `*.css` as text modules. That is what lets `src/views.js` import
`../shared/design/catalog-grid.css` **verbatim** from where it is maintained,
rather than pasting a copy into a template and letting the two drift.

## What is here

```
src/index.js   routing: / is the catalog, everything else is 404
src/views.js   the catalog page. Imports shared/design/catalog-grid.css verbatim
```

and from [`../shared`](../shared):

```
shared/view/html.js       page shell, escaper, money format — both surfaces
shared/design/theme.css   the measured tokens from docs/design-direction.md §3
shared/design/catalog-grid.css   the grid
shared/seed/catalog.js    the seed products, read by the shop and by ops tools
```

**The design** — achromatic, `#EFF0F4` image ground, 8:9 imagery, ~16px flat type
scale, sentence case, black announcement bar, centred tracked-caps wordmark, card
order eyebrow → image → brand → name → price. Product imagery is **inline SVG
generated per product**: flat shapes on the ground colour at the 8:9 contract
ratio. Nothing hotlinks anybody else's photography. Real imagery arrives from R2
via Cloudflare Images with a `sizes` attribute mirroring `--card-min`
(design-direction.md §6).

## Not in this prototype

R2, real imagery, catalog reads from the versioned store, the commerce port, and
any write path at all. It is a deployable shell for looking at the design.
