# Vemians — platform architecture

> Requirements and scope live in [`PRD.md`](./PRD.md), which is authoritative.
> This document covers the technical design only.

**Thesis:** we own the catalog, the storefront and the database. Shopify is a *plugged-in
sales channel* — it can be switched off without losing products, content, orders, media or
operational history.

This inverts the usual Shopify setup, where Shopify is the system of record and everything
else is a projection of it. Here it is the other way round.

---

## 1. Ownership map

| Thing | Owner | Notes |
|---|---|---|
| Product catalog, variants, prices | **Us** (Postgres) | Pushed *out* to channels |
| Product media | **Us** (R2) | Never only in a vendor CDN |
| Storefront + design | **Us** (Astro on Workers) | The beautiful part |
| Content / copy | **Us** (Postgres) | |
| Orders, customers | **Us** (ingested) | Shopify webhooks land here |
| Employees, schedule | **Us** (Postgres) | |
| **Checkout + payments + PCI** | **Shopify** | The one thing worth renting |
| Books of record | Xero / QuickBooks | Never build a ledger |

The honest boundary: **checkout is the expensive thing to own**, because it drags in PCI
scope, fraud, tax calculation and payment-provider relationships. Renting it is the right
call. Everything upstream of checkout is ours, and that is what makes the vendor swappable.

## 2. Sync direction

```
   catalog          ┌──────────────┐   push (projection)   ┌─────────┐
   inventory  ─────►│   Postgres   │──────────────────────►│ Shopify │
   media            │  (our SoR)   │◄──────────────────────│         │
                    └──────────────┘   webhooks (orders)   └─────────┘
                           │
                           ├──► ops.vemians.com   (agentic control plane)
                           └──► vemians.com       (storefront, reads only)
```

- **Catalog → Shopify** is a one-way projection. Shopify holds a *copy* so its checkout works.
- **Orders → us** via webhook, normalised on ingest into our own order tables.
- **Inventory** is bidirectional but **we are authoritative**; Shopify decrements are ingested.

Switching commerce provider means writing a second adapter and re-projecting. The catalog,
the storefront, the media, the order history and the ops data never move.

## 3. DNS

Because the storefront is **ours**, the apex is no longer Shopify — so it can be proxied
normally and we get the full Cloudflare feature set on it.

| Type | Name | Target | Proxy |
|---|---|---|---|
| — | `@` / `www` | Storefront Worker (Custom Domain) | **Proxied** |
| — | `ops` | Control-plane Worker (Custom Domain) | **Proxied** |

Shopify needs **no DNS records at all** in this design — its checkout lives on
`<store>.myshopify.com`. Customers cross to it only at the checkout step.

> Superseded: an earlier draft of this document put the Shopify storefront at the apex and
> required those records to be DNS-only, because **Shopify does not support Cloudflare's
> proxy**. That constraint still holds — it just no longer applies to us, since we are not
> pointing a domain at a Shopify storefront. If a Shopify-hosted storefront is ever
> reintroduced, its records must be grey-cloud (`A @ 23.227.38.65`,
> `CNAME www shops.myshopify.com`).

## 4. Stack

**Storefront — `vemians.com`**
Astro, server-rendered on Workers. Content-first, islands architecture, ships almost no JS
by default. Chosen over Next.js for weight and over Shopify's Hydrogen deliberately —
Hydrogen is Shopify-coupled, which is the exact thing we are avoiding.

**Control plane — `ops.vemians.com`**
Worker behind **Cloudflare Access** (Zero Trust), with **Google Workspace as the identity
provider**. Access terminates identity before a request reaches our code: no login form, no
session cookie of ours, no password reset path. Roles come from Google Workspace groups
mapped to Access policies, so offboarding someone in Workspace revokes platform access with
no application-side action — and the verified email becomes the `actor` on every audit row.

Agents SDK for stateful sessions; tools exposed via `createMcpHandler` (the current pattern —
the older Durable-Object-backed `McpAgent` is deprecated and feature-frozen).

**Database — Postgres (Neon) via Hyperdrive**
Not D1. D1 is cheaper and simpler, but its API is Cloudflare-specific, and the entire point
of this project is portability. Postgres runs anywhere — Neon, RDS, Supabase, a box — so
leaving Cloudflare costs a connection string, not a rewrite. Hyperdrive gives Workers pooled,
low-latency access. Take D1 only if the cost of Neon is genuinely blocking.

**Media — R2 + Cloudflare Images.** Originals in R2 under our own keys; Images for
transforms. Product photography living only in a vendor's CDN is a quiet lock-in vector.

**Async — Queues** (channel sync, webhook fan-out), **Workflows** (durable multi-step:
onboarding, month-end close), **Cron** (nightly reconcile).

## 5. The portability mechanism

Two rules, and one table, are what actually deliver the promise:

1. **Vendor IDs are never primary keys.** Our IDs are UUIDs we mint.
2. **Vendor types never leak past the adapter.** The storefront and the agent speak our
   vocabulary only.
3. **`external_ref`** maps `(entity_type, entity_id, channel, external_id)`. Every vendor
   identifier in the system lives in that one table. Dropping a channel is a `DELETE` on one
   table, not a schema migration.

See `platform/db/schema.sql` for the model and `platform/commerce-port.ts` for the interface.

## 6. Guardrails

Before any agent write tool is enabled:

- **Two-tier tools.** Reads run automatically; writes — price changes, refunds, publishing,
  anything touching payroll — pass a human approval gate.
- **Append-only `audit_log`.** Actor, tool, arguments, result, timestamp, for every action.
  Build it before the first tool, not after.
- **Scoped credentials.** Separate Shopify tokens for read and write, in Workers Secrets.
- **Caps** on write tools, enforced in the tool layer — never trusted to the prompt.

Employment records are sensitive PII: encrypt at rest and gate behind a dedicated Access
group, not the general employee login.

## 7. This repository

`vemians` is currently a fork of Shopify's **Dawn** theme. In this design the Dawn theme is
**not used** — the storefront is ours. Dawn stays in place for now as a fallback and is safe
to delete once the Astro storefront is live. New work lives under `platform/`.

Note that `.github/workflows/ci.yml` is Dawn's inherited CI (Lighthouse + theme-check
against a Shopify store) and will need replacing when the theme goes.

## 8. Order of work

1. **Schema + `external_ref`** — the portable core. *(done)*
2. **Commerce port interface** — the adapter boundary. *(done)*
3. Provision Neon + Hyperdrive; run migrations.
4. Storefront skeleton on Workers, reading products from Postgres.
5. Shopify adapter: catalog projection out, order webhooks in.
6. Control plane: Worker + Access, no tools. Audit log first.
7. Read-only agent tools, then scheduling, then gated write tools.
8. Finance and payroll integrations last — most risk, least novelty.

## References

- [Cloudflare Agents SDK](https://github.com/cloudflare/agents)
- [Cloudflare — the next generation of MCP](https://blog.cloudflare.com/mcp-v2/)
- [Shopify — domain troubleshooting](https://help.shopify.com/en/manual/domains/troubleshoot-issues-with-domains)
- [Shopify/hydrogen — Cloudflare proxy unsupported](https://github.com/Shopify/hydrogen/discussions/1180)
