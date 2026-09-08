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
curl -i http://127.0.0.1:8787/                        # catalog, 200
curl -i 'http://127.0.0.1:8787/?brand=Vestra&sort=price-asc'   # filtered, server-side
curl -i 'http://127.0.0.1:8787/?n=16&partial=1'       # the load-more fragment
curl -i http://127.0.0.1:8787/s.js                    # the enhancement script
curl -i http://127.0.0.1:8787/ops                     # 404 — the employee area is not here
curl    http://127.0.0.1:8787/healthz                 # ok
```

## The interaction layer

`shared/design/interaction.css` and `shared/view/enhance.client.js` add the
behaviour: a hover image swap, images fading in as they decode, a header that
hides on scroll down, a wishlist heart, a filter/sort dialog and a load-more
control. PRD §3.8.1 (`Test-PRD-P0-42` … `P0-46`) is what they answer to.

Two things are worth knowing before touching either file.

**Everything works with JavaScript off.** Filter, sort and page size are the
query string; the filter surface is a `<form method="get">` in normal flow;
"show more" is an `<a href>`; the images are `<img src>` with explicit
dimensions. The script upgrades those in place and supplies none of them. The
one control that cannot exist without a script — the wishlist — is not rendered
as a control without one. Check it by disabling JavaScript and using the shop.

**Nothing in there was observed.** The reference site is egress-blocked from
this environment and `docs/design-direction.md` §5 lists hover behaviour and the
filter/sort panels as unobserved outright. Every timing, direction and gesture is
genre convention, and is marked `INFERRED` at the rule that implements it. The
measured tokens in §3 are a different thing and are not touched here.

### Verifying it

`npm test` covers the contract — the markup being complete without a script,
every duration resolving from the one pair of tokens the reduced-motion rule
remaps, no hover rule escaping its `pointer: fine` gate, nothing parked at
`opacity: 0`. It cannot cover anything that needs a layout engine.

For that, drive the real Worker with a browser:

```sh
npx wrangler dev --local --port 8787
# then, from a Playwright script against Chromium:
#   getBoundingClientRect() on a card with images held and then released  -> 0px delta, CLS 0
#   getComputedStyle(.masthead).transform at each scroll direction        -> matrix(...,-129) / (...,0)
#   getComputedStyle(...).transitionDuration under reducedMotion: reduce  -> 0s everywhere
#   Escape on the open panel, then document.activeElement                 -> the trigger
#   a context with javaScriptEnabled: false                               -> the whole shop still works
```

A screenshot is not proof of any of those, and neither is reading the CSS.

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

The one non-obvious mechanism is the `[[rules]]` blocks in `wrangler.toml`, which
load `*.css` **and** `*.client.js` as text modules. That is what lets
`src/views.js` import `../shared/design/catalog-grid.css` **verbatim** from where
it is maintained, rather than pasting a copy into a template and letting the two
drift — and what lets the browser-side enhancement layer live as a real `.js`
file next to the markup that mounts it, served at `/s.js`, instead of as a string
inside a template. The `.client.js` extension is the point: a `**/*.js` glob
would swallow the Worker's own source.

Comments in the CSS are stripped once per isolate by `lean()` in
`shared/view/html.js` before the stylesheet is inlined. They are load-bearing in
the repository — they are what separates a measured token from an assumed one —
and dead weight on the critical path of a page whose budget is p75 LCP < 2.0s.

## What is here

```
src/index.js   routing: /, /?partial=1, /s.js, /img/<handle>-<n>.svg, /healthz
src/query.js   what the URL means: brand, sort and page size. One place
src/views.js   the catalog page, the load-more fragment, the placeholder art
test/          PRD-labeled checks; see the header of storefront.test.mjs first
```

and from [`../shared`](../shared):

```
shared/view/html.js         page shell, escaper, money format — both surfaces
shared/view/enhance.client.js   BROWSER code. Served at /s.js, never executed here
shared/design/theme.css     the measured tokens from docs/design-direction.md §3
shared/design/catalog-grid.css   the grid
shared/design/interaction.css    motion and interaction. Every value INFERRED
shared/seed/catalog.js      the seed products, read by the shop and by ops tools
```

**The design** — achromatic, `#EFF0F4` image ground, 8:9 imagery, ~16px flat type
scale, sentence case, black announcement bar, centred tracked-caps wordmark, card
order eyebrow → image → brand → name → price. Product imagery is **SVG generated
per product** and served from `/img/<handle>-<n>.svg`: flat shapes on the ground
colour at the 8:9 contract ratio. It is served from a URL rather than inlined
because the interaction layer needs images to *be* images — something that loads,
decodes, fades in when it does, and can be preloaded on hover intent. Nothing
hotlinks anybody else's photography. Real imagery arrives from R2 via Cloudflare
Images with a `srcset` and a `sizes` attribute mirroring `--card-min`
(design-direction.md §6).

## Not in this prototype

R2, real imagery, catalog reads from the versioned store, the commerce port, and
any write path at all. It is a deployable shell for looking at the design.
