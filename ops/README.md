# ops — the agentic staff Worker

| Hostname | Surface | Gate |
|---|---|---|
| `ops.vemians.com/*` | Employee area, agent, `/mcp` | **Cloudflare Access** |

Deployed as the Worker `vemians-ops`. The public shop is a different package and
a different Worker: [`../store`](../store/README.md), `vemians-storefront`.

## Run it

Five steps from a fresh clone. Node 20+ (Node 22 for `npm test` — it uses
`node:sqlite`).

```sh
git clone https://github.com/dloginowski/vemians.git
cd vemians/ops
npm ci                    # wrangler + the MCP server, both pinned
npm run db:local          # load shared/db/*.sql into local D1
npm run dev               # http://127.0.0.1:8788/
```

`npm run dev` is `wrangler dev --local --port 8788 --inspector-port 9230`. The
inspector port is spelled out because wrangler defaults every Worker to 9229, and
the storefront in `../store` is usually running on it — two `wrangler dev`
processes on the default kill the second one with `Address already in use`.

`npm test` runs the tool-layer checks against the real schemas; `npx wrangler
deploy` publishes it once the zone is on Cloudflare and the Access application
exists — the dashboard click-path is
[`docs/deploy-cloudflare.md`](../docs/deploy-cloudflare.md).

Locally the Worker answers on `127.0.0.1:8788`, at `/` and at the `/ops` alias:

```sh
curl -i http://127.0.0.1:8788/                       # 401, no Access assertion
curl -i -H "Cf-Access-Jwt-Assertion: <a.jwt.token>" \
        http://127.0.0.1:8788/                       # ops page
curl    http://127.0.0.1:8788/healthz                # ok, ungated
```

The MCP endpoint (ADR-007):

```sh
curl -i -X POST http://127.0.0.1:8788/mcp            # 401 + WWW-Authenticate
curl -X POST http://127.0.0.1:8788/mcp \
     -H "Cf-Access-Jwt-Assertion: <a.jwt.token>" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

It lists only the tools the caller's Access groups allow, and a T2 write returns
a link to approve in a browser instead of performing the write.

## The gate

**Cloudflare Access is the security boundary. This application is not.**

The `@vemians.com` restriction is an **Access policy** — `Action: Allow`,
`Include: Emails ending in @vemians.com`, configured in the Zero Trust dashboard.
It is not application logic, and `src/access.js` contains no email-domain test on
purpose. An app-side domain check would be a decoration: it can only inspect an
identity that Access already decided to forward, and anything that reached the
Worker without passing through Access would be checking a claim nobody signed.

What the Worker does hold is **fail-closed**. No `Cf-Access-Jwt-Assertion` header,
no employee area — 401, every time, for pages, for the agent endpoint and for
`/mcp`. That is the one thing the application can defend by itself.

Two further details that are easy to get wrong:

- **Access attaches to a whole Worker.** That is why this is its own package and
  its own deployment: gating a Worker shared with the shop would put a login page
  in front of the shop. Put the Access application on `vemians-ops` and on no
  other Worker. `SURFACE=ops` in `wrangler.toml` still pins this deployment; with
  it unset the Worker falls back to `OPS_HOST` plus localhost, which is what
  `wrangler dev` uses.
- **Signature verification is off by default here.** Set `ACCESS_TEAM_DOMAIN` and
  `ACCESS_AUD` in `wrangler.toml` and `src/access.js` fetches the team JWKS and
  does a real RS256 verification plus `aud`, `exp`, `nbf` and `iss` checks. Leave
  them unset — the prototype default, so `npx wrangler dev` runs with no
  Cloudflare account — and it decodes the assertion **without checking the
  signature**, and prints a black banner across the top of the ops page saying
  exactly that. Fill both in before `ops.vemians.com` is reachable from the
  internet.

## Scope is a binding

The seven D1 stores are bound in this package's `wrangler.toml` and nowhere else
(Test-PRD-P0-24-binding_scoped_tools). Inside the Worker the scoping continues in
`src/tools/index.js`: a tool declares the stores it needs and `scopedStores()`
hands its `run` exactly those handles. `STORE_BINDINGS` has no `identity` entry,
so no tool in the registry can reach the vault even though `IDENTITY` is bound —
binding it is a deployment decision, reaching it is a registry decision, and both
have to be taken deliberately.

The same rule covers what is not a D1 store. A tool declares `resources` —
`square` (the catalog write path) or `media` (our R2 originals) — and
`scopedResources()` attaches only those. `catalog.draft_product` does not declare
`square`, so it holds no object that could write to Square; that is why "the draft
writes nothing" is a property of the registry rather than a promise about the
tool's body.

## Agentic catalog authoring

Staff create and edit products by talking to their own AI client. The flow is
`catalog.categories` → `catalog.upload_image` → `catalog.draft_product` (T1, a
diff) → `catalog.create_product` (T2, approved in a browser).

Two things about it are load-bearing:

- **The agent writes to SQUARE, never to our mirror.** Square is authoritative
  for the commercial facts of the catalog (ADR-009) and the till writes there
  too. Our `catalog_mirror` follows by sync; a second writer into it would
  diverge from Square silently, in the direction that oversells.
- **The category comes from a set that already exists.** Creating one is a
  separate T2, manager-only tool that refuses a near-duplicate. Without that
  split, a month of agentic authoring produces "Coats", "Outerwear", "Jackets"
  and "Coats & Jackets" and the storefront navigation stops meaning anything
  (Test-PRD-P0-40-closed_category_set).

## The scheduled mirror sync

`src/sync.js`, fired by the `[triggers] crons` in `wrangler.toml`
(Test-PRD-P0-48-scheduled_mirror_sync). It pulls Square's catalog and inventory
through the adapter in `../shared/commerce/square` and writes `catalog_mirror` —
which is the catalog the storefront renders, so **nothing running this is a shop
serving nothing**.

It lives on THIS Worker and not on the storefront because it holds the Square
credential and writes the stock ledger, and neither belongs on a Worker the
public can reach. It holds no mapping logic of its own: the first run is a full
`ListCatalog` (the only sweep that can archive on absence), every run after is a
search since the recorded cursor, and re-running is a no-op because the adapter's
upserts key on `external_ref`.

Failure says which failure it was — the credential is **unset**, the credential
was **rejected**, or Square was **unreachable** — because those are three
different repairs and "sync failed" distinguishes none of them. Every run,
failed ones included, lands in `mirror_sync`, so "it has not succeeded since
Tuesday" is a query. A failed run leaves the last good mirror standing.

```bash
npm run db:local                                  # includes catalog_mirror
npx wrangler dev --local --test-scheduled         # then, in another shell:
curl "http://localhost:8788/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"
```

With no `SQUARE_ACCESS_TOKEN` set that prints the unset-credential ERROR and
records the failed run, which is the intended behaviour rather than a crash.

The cron starts at every fifteen minutes so a wrong token or an unbound store is
found the same afternoon; `wrangler.toml` says to drop it to nightly once it is
trusted, which is the reconcile cadence ADR-009 actually describes.

**Photographs.** MCP tool arguments are JSON, so image bytes in an argument mean
base64 that the MODEL has to emit — roughly one to two million output tokens for
a 12 MP phone photo, which no model can produce at any price. So
`catalog.upload_image` caps the inline path at 192 KiB and otherwise mints our R2
key, signs it, and returns a link the human opens at `/media/upload`; the bytes
go browser → Worker → R2 and never enter a model's context. The original is ours
and authoritative; Square gets a copy so the item looks right on the till.
Needs the `MEDIA` R2 binding and the `MEDIA_SIGNING_KEY` secret — without the
secret the tool refuses to issue a link rather than issuing an unsigned one.

## What is here

```
src/index.js    routing, the fail-closed ops handler, and the scheduled() cron entry
src/sync.js     the scheduled mirror sync: Square -> catalog_mirror, on a cron
src/access.js   Cloudflare Access assertion: fail closed, then RS256 + aud + exp + iss
src/agent.js    the turn loop: tool selection, T2 approval, audit
src/mcp.js      POST /mcp — the ops tools over MCP, for staff AI clients (ADR-007)
src/tools/      the tool registry. Tiers, roles, caps, scoped stores, audit
                catalog-write.js  agentic authoring: draft, create, update, categories
                catalog-writer.js the Square write path and the mirror sync after it
                media.js          our R2 originals and the signed upload ticket
src/views.js    the ops page and the refusal page
src/seed.js     hardcoded customers and schedule. Ops-only; the catalog is shared
test/           PRD-labeled regression checks, run against the real schemas
migrations/     apply-local.sh — loads shared/db/*.sql plus the catalog mirror's
                schema into the local D1 state
```

and from [`../shared`](../shared):

```
shared/db/*.sql           the seven store schemas, and verify.py
shared/view/html.js       page shell, escaper, money format — both surfaces
shared/design/theme.css   the measured tokens from docs/design-direction.md §3
shared/seed/catalog.js    the seed products, read by the shop and by ops tools
shared/commerce/square/   the commerce adapter. images.js is the multipart
                          CreateCatalogImage the JSON client cannot carry
```

## Tests

```sh
npm test                        # node --test test/*.test.mjs
python3 ../shared/db/verify.py  # the store-level guarantees, same PRD labels
```

Both are PRD-labeled: every check enforces a numbered feature in
[`docs/PRD.md`](../docs/PRD.md), and each suite asserts its own labels exist there
(Test-PRD-P0-30-prd_traceability). Unlabeled checks are a process failure — read
the contract header at the top of `test/tools.test.mjs` before editing it.
