# Storefront prototype

One Cloudflare Worker, two surfaces:

| Hostname | Surface | Gate |
|---|---|---|
| `vemians.com/*` | Public catalog | **None.** Anyone can view |
| `ops.vemians.com/*` | Employee area | **Cloudflare Access** |

It runs on hardcoded seed data in `src/seed.js`. No D1, no R2, no KMS, no commerce
provider. The six D1 bindings are written out and commented in `wrangler.toml` so the
wiring is visible; none of them is required to run this.

## Run it

Five steps from a fresh clone. Node 20+.

```sh
git clone https://github.com/dloginowski/vemians.git
cd vemians/platform/storefront
npm ci                                  # wrangler, pinned in package-lock.json
npx wrangler dev --port 8787            # http://127.0.0.1:8787/
npx wrangler deploy                     # when the zone is on Cloudflare
```

No env vars and no files are needed for step 4. Step 5 needs a Cloudflare account and the
zone already moved — the dashboard click-path is [`docs/deploy-cloudflare.md`](../../docs/deploy-cloudflare.md),
and the `[[routes]]` block in `wrangler.toml` stays commented out until the nameservers have
moved, otherwise the deploy fails trying to create a Custom Domain on a zone Cloudflare does
not hold.

Locally, both surfaces answer on `127.0.0.1:8787`, because there is no hostname to split on:

```sh
curl -i http://127.0.0.1:8787/                       # catalog, 200
curl -i http://127.0.0.1:8787/ops                    # 401, no Access assertion
curl -i -H "Cf-Access-Jwt-Assertion: <a.jwt.token>" \
        http://127.0.0.1:8787/ops                    # ops page
```

`/healthz` returns `ok` on both surfaces, ungated.

## The gate

**Cloudflare Access is the security boundary. This application is not.**

The `@vemians.com` restriction is an **Access policy** — `Action: Allow`, `Include: Emails
ending in @vemians.com`, configured in the Zero Trust dashboard. It is not application logic,
and `src/access.js` contains no email-domain test on purpose. An app-side domain check would
be a decoration: it can only inspect an identity that Access already decided to forward, and
anything that reached the Worker without passing through Access would be checking a claim
nobody signed.

What the Worker does hold is **fail-closed**. No `Cf-Access-Jwt-Assertion` header, no
employee area — 401, every time, for pages and for the agent endpoint. That is the one thing
the application can defend by itself.

Two further details that are easy to get wrong:

- **The split is by hostname, not by path.** An Access application covers a *hostname*. If
  `/ops` also answered on `vemians.com` it would be an unauthenticated copy of the employee
  area sitting outside the gate — so on the public host `/ops` is a 404. `/ops` works on
  `localhost` under `wrangler dev`, and the page says so on screen.
- **Signature verification is off by default here.** Set `ACCESS_TEAM_DOMAIN` and
  `ACCESS_AUD` in `wrangler.toml` and `src/access.js` fetches the team JWKS and does a real
  RS256 verification plus `aud`, `exp`, `nbf` and `iss` checks. Leave them unset — the
  prototype default, so `npx wrangler dev` runs with no Cloudflare account — and it decodes
  the assertion **without checking the signature**, and prints a black banner across the top
  of the ops page saying exactly that. Fill both in before `ops.vemians.com` is reachable
  from the internet.

## Why no framework

Plain JS, no build step, no dependency but `wrangler` itself. The prototype renders two
pages from template literals; Astro (PRD §3.8) earns its place when there are collections,
content, image pipelines and islands to manage, and adding it now would mean a build step
and a dependency tree in exchange for nothing this prototype does.

The one non-obvious mechanism is the `[[rules]]` block in `wrangler.toml`, which loads
`*.css` as text modules. That is what lets `src/views.js` import
`platform/design/catalog-grid.css` **verbatim** from where it is maintained, rather than
pasting a copy into a template and letting the two drift.

## What is here

```
src/index.js    hostname/path routing, and the fail-closed ops handler
src/access.js   Cloudflare Access assertion: fail closed, then RS256 + aud + exp + iss
src/seed.js     hardcoded catalog, customers and schedule. Money as integer minor units
src/views.js    HTML. Imports catalog-grid.css verbatim + theme.css
src/theme.css   the measured tokens from docs/design-direction.md §3
```

**Public catalog** — achromatic, `#EFF0F4` image ground, 8:9 imagery, ~16px flat type scale,
sentence case, black announcement bar, centred tracked-caps wordmark, card order
eyebrow → image → brand → name → price. Product imagery is **inline SVG generated per
product**: flat shapes on the ground colour at the 8:9 contract ratio. Nothing hotlinks
anybody else's photography. Real imagery arrives from R2 via Cloudflare Images with a `sizes`
attribute mirroring `--card-min` (design-direction.md §6).

**Employee area** — the identity Access forwarded; a customer list of **opaque ids only**
(birth year, fit, segment, consent — no name, email or phone, because per PRD
`Test-PRD-P0-08-customers_no_identifiers` the `customers` store holds none and this surface
binds nowhere near `identity`); a read-only week schedule; and an agent input box that POSTs
to `/ops/agent` and gets its own text echoed back. No model is wired and no tool is bound —
per PRD §11 the audit log ships before the first tool does.

## Not in this prototype

D1, R2, KMS, the commerce port, catalog reads from Git, real imagery, the audit log, any
agent tool, and any write path at all. It is a deployable shell for looking at the design and
proving the gate, nothing more.
