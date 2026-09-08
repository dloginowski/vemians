# vemians

An owned commerce platform on Cloudflare: a public storefront, an Access-gated
staff area with an agent that has real tools, and seven small D1 stores that no
foreign key crosses. The design document is [`docs/PRD.md`](docs/PRD.md); the
decisions behind it are the ADRs in [`docs/adr/`](docs/adr).

## Two surfaces, two Workers

| Package | Worker | Hostname | Gate |
|---|---|---|---|
| [`store/`](store/README.md) | `vemians-storefront` | `vemians.com/*` | **None.** Anyone can view |
| [`ops/`](ops/README.md) | `vemians-ops` | `ops.vemians.com/*` | **Cloudflare Access** |

They are two deployments because **Cloudflare Access attaches to a whole Worker,
not to a route inside one**: gating a shared Worker would put a login page in
front of the shop. Each package carries its own `wrangler.toml`, its own
lockfile and its own bundle, so the employee area is not merely switched off on
the public host — its code is not there. `SURFACE` in each `wrangler.toml` still
pins the deployment, and each Worker refuses to serve if it is pinned to the
other surface.

The seven D1 bindings are declared in `ops/wrangler.toml` and nowhere else. The
storefront cannot read a customer profile by any code path, because it holds no
binding and no tool (`Test-PRD-P0-24-binding_scoped_tools`).

```
store/     the public storefront Worker
ops/       the agentic staff Worker — Access, agent, /mcp, the tool registry
shared/    what both use: db schemas, design tokens, the page shell, the
           commerce port, the seed catalog
docs/      PRD, ADRs, architecture, deploy runbooks, design direction
skills/    the reasoning behind the tool contract, per domain
tools/     one-off operator scripts (DNS preflight, data branches)
```

## Run it

Node 20+, or Node 22 to run the ops tests. Both Workers run with no Cloudflare
account and no env vars.

```sh
git clone https://github.com/dloginowski/vemians.git
cd vemians

( cd store && npm ci && npx wrangler dev --port 8787 )       # shop  :8787
( cd ops   && npm ci && npm run db:local && \
              npx wrangler dev --local --port 8788 )         # staff :8788
```

Then:

```sh
curl -i http://127.0.0.1:8787/       # 200, the catalog
curl -i http://127.0.0.1:8787/ops    # 404 — the employee area is not in this Worker
curl -i http://127.0.0.1:8788/       # 401 — no Cloudflare Access assertion
```

The per-package READMEs have the rest: [`store/README.md`](store/README.md),
[`ops/README.md`](ops/README.md).

## Checks

```sh
python3 shared/db/verify.py   # store-level guarantees, straight against the schemas
( cd ops && npm test )        # the agent tool layer, against those same schemas
```

Every check enforces a numbered feature in `docs/PRD.md` and carries its label
(`Test-PRD-P0-NN-short_id`); each suite asserts its own labels exist there, so an
invented or renamed one fails the run instead of drifting silently. Unlabeled
checks are a process failure — see the contract header at the top of either file.

## Deploy

Both Workers deploy from GitHub Actions with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in repository secrets — no local machine needed:

- `.github/workflows/deploy-workers.yml` — tests, schema checks, then both
  deploys. Runs on push to `main` touching `store/`, `ops/` or `shared/`.
- `.github/workflows/bootstrap-d1.yml` — one-time: create the seven D1
  databases, apply `shared/db/*.sql`, write the real ids into
  `ops/wrangler.toml`.

The dashboard click-path — zone move, Custom Domains, the Access application —
is [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md), and the Actions
route is [`docs/deploy-via-actions.md`](docs/deploy-via-actions.md).

## License

[MIT](LICENSE.md).
