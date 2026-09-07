# PRD — Vemians Platform

| | |
|---|---|
| **Status** | Draft for review |
| **Last updated** | 2026-09-07 |
| **Owner** | dimitri@handsome.la |

---

## 1. Problem

Running the business entirely inside Shopify means Shopify owns the catalog, the
customer relationship, the design system and the operational history. Leaving would
mean rebuilding all of it. Separately, day-to-day operations — scheduling, store
management, looking things up — are manual and spread across tools.

We want a storefront and an internal operations layer that we own outright, where a
commerce provider is a component we can unplug.

## 2. Goals

**G1 — Own the system of record.** Products, media, content, orders, customers,
employees and schedules live in our database. A commerce provider holds a *copy*.

**G2 — Provider independence, proven not promised.** Switching or removing a commerce
provider must not touch the database, the storefront, or the design. This is verified
by a repeatable drill (§7), not asserted.

**G3 — A beautiful storefront we control.** Design and front-end code are ours, with
no vendor theming layer.

**G4 — Agentic operations at `ops.vemians.com`.** Employees do scheduling, catalog and
store management through a conversational agent, behind Google Workspace SSO.

**G5 — Clean and efficient.** One database, one adapter interface, minimal moving parts.

## 3. Non-goals

- **Not building checkout or payments.** PCI scope, fraud and tax are deliberately
  rented from the commerce provider. This is the one accepted dependency.
- **Not building a ledger.** Books of record stay in Xero/QuickBooks.
- **Not building payroll.** Gusto/Deel. We hold scheduling, not compensation.
- **Not a Shopify theme.** The Dawn fork in this repo is superseded by G3.
- Not multi-tenant, not a public API, not a mobile app — for v1.

## 4. Users

| Persona | Needs | Access |
|---|---|---|
| **Customer** | Browse products, buy | Public storefront |
| **Staff** | View and swap own shifts, look up orders and stock | `ops`, staff role |
| **Manager** | Build schedules, edit catalog and pricing, approve agent writes | `ops`, manager role |
| **Owner** | Everything, plus finance views and audit history | `ops`, owner role |

Roles derive from **Google Workspace groups**. No role is assigned inside the app.

## 5. Functional requirements

### 5.1 Authentication — Google Workspace SSO

- **R1.1** All `ops.vemians.com` access authenticates via Google Workspace SSO, using
  Cloudflare Access with Google Workspace as the identity provider.
- **R1.2** The application never stores a password, and has no login form, no session
  cookie of its own, and no password-reset path. Access terminates identity before a
  request reaches application code.
- **R1.3** Authorisation derives from Google Workspace group membership, mapped to
  Access policies. Offboarding a person in Workspace revokes platform access with no
  application-side action.
- **R1.4** The verified Access identity (email) is the `actor` on every audit record.
- **R1.5** Employee PII and finance views sit behind a separate Access policy from
  general staff access.

### 5.2 Storefront — `vemians.com`

- **R2.1** Renders products, collections and content solely from our database. It must
  make **zero** calls to any commerce provider except to create a checkout URL.
- **R2.2** Product media is served from our own object storage, not a vendor CDN.
- **R2.3** URLs use our handles and remain stable across a provider switch.
- **R2.4** Checkout hands off to the active provider's hosted checkout.
- **R2.5** Design system — tokens, components, layout — lives in our repo with no
  vendor theming dependency. Direction in [`design-direction.md`](./design-direction.md).
- **R2.6** Product imagery is served as AVIF/WebP with responsive `srcset` cut to actual
  grid widths, and every image carries explicit dimensions. An image-weight budget is
  enforced in CI alongside the Exit Test — this design is image-led and N1 is not
  otherwise reachable.

### 5.3 Commerce provider integration

- **R3.1** All provider interaction passes through a single adapter interface
  (the *commerce port*). No vendor SDK or vendor identifier appears outside an adapter.
- **R3.2** Catalog and inventory are projected **outbound** to the provider. The
  provider is never authoritative for catalog data.
- **R3.3** Orders arrive inbound via verified webhook, are normalised on ingest, and
  the original payload is retained so ingest can be replayed after a mapping fix.
- **R3.4** Every vendor identifier is stored in one mapping table and nowhere else.
- **R3.5** Adding a second provider requires no schema migration.

### 5.4 Agentic workflow — `ops.vemians.com`

- **R4.1** Conversational interface; employees state intent in natural language.
- **R4.2** **Scheduling** — create, amend and publish shifts; the agent cannot produce
  an overlapping booking, enforced at the database, not by prompt instruction.
- **R4.3** **Database access** — read across catalog, orders, inventory and schedule,
  scoped to the caller's role.
- **R4.4** **Store management** — catalog edits, pricing, inventory, publish/unpublish,
  all through the commerce port.
- **R4.5** **Tool tiering.** Reads execute directly. Writes require explicit human
  approval in-session before execution.
- **R4.6** **Audit.** Every tool invocation — actor, tool, arguments, result, timestamp
  — is written to an append-only log that no application role can amend or delete.
- **R4.7** Write tools carry rate and monetary caps enforced in code, never in the prompt.
- **R4.8** The agent cannot refund, alter payroll, or delete records. Not gated — absent.

## 6. Non-functional requirements

- **N1** Storefront p75 LCP < 2.0s on 4G mobile.
- **N2** Storefront reads never block on a provider API.
- **N3** Provider outage degrades checkout only; browsing stays fully available.
- **N4** All money stored as integer minor units with explicit currency. No floats.
- **N5** Employee PII encrypted at rest.
- **N6** Infrastructure cost target < $50/month at launch scale, excluding model usage.
- **N7** Database is standard PostgreSQL, portable to any host.

## 7. The Exit Test — how G2 is verified

Provider independence is a claim that rots silently unless tested. It is therefore a
**CI check**, run on every change to the data layer and reviewed quarterly:

1. Load the schema into a scratch database and seed a product, variant and provider.
2. Delete the provider row.
3. **Assert:** catalog, media, orders and schedule are intact; every vendor identifier
   is gone; the storefront still builds and renders the catalog.

A failing Exit Test blocks merge. If we cannot delete the provider in CI, we cannot
delete it in production either.

An early version of this drill is implemented in `platform/db/verify.sql` and currently
passes against PostgreSQL 16.

## 8. Architecture summary

Full detail in `docs/cloudflare-architecture.md`.

```
  ┌─────────────┐  projection (catalog, stock)  ┌──────────────┐
  │  PostgreSQL │ ────────────────────────────► │   Provider   │
  │   (our SoR) │ ◄──────────────────────────── │  (Shopify…)  │
  └──────┬──────┘   webhooks (orders)           └──────────────┘
         │                                    checkout only ▲
         ├──► vemians.com      storefront, read-only ───────┘
         └──► ops.vemians.com  agent, behind Google SSO
```

Cloudflare Workers for both surfaces; Access for SSO; R2 for media; Queues and
Workflows for sync and multi-step processes; PostgreSQL via Hyperdrive.

**Why PostgreSQL over Cloudflare D1:** D1's API is Cloudflare-specific, which would
trade Shopify lock-in for Cloudflare lock-in. PostgreSQL satisfies N7 and G2 together.

## 9. Acceptance criteria for v1

- [ ] An employee signs in at `ops.vemians.com` with their Workspace account, with no
      app-specific credential.
- [ ] Removing that employee from Google Workspace revokes access, verified.
- [ ] A manager builds a week's schedule conversationally; a double-booking attempt is
      refused by the database.
- [ ] A manager changes a price conversationally; it requires approval, is written to
      our database, projects to the provider, and appears in the audit log.
- [ ] The storefront renders the full catalog with the provider API unreachable.
- [ ] A customer completes a purchase; the order lands in our database, normalised.
- [ ] The Exit Test passes in CI.

## 10. Milestones

| # | Milestone | Exit condition |
|---|---|---|
| M0 | Schema + Exit Test in CI | Exit Test green on every commit |
| M1 | Storefront reads from our DB | Catalog renders, provider unplugged |
| M2 | Provider adapter | Catalog projects out; orders ingest in |
| M3 | `ops` shell + Google SSO + audit log | Sign-in works; zero tools shipped |
| M4 | Read-only agent tools | Staff can query catalog, orders, stock |
| M5 | Scheduling | Managers build schedules conversationally |
| M6 | Gated write tools | Approval gate and caps enforced |
| M7 | Finance and payroll integrations | Read-only mirrors only |

M3 ships **before** any tool: the audit log must exist before the first action it records.

## 11. Open questions

1. **Domain** — is it `vemians.com`? Everything above assumes so.
2. **Existing data** — is there a live Shopify store with products and order history to
   migrate, or do we start clean?
3. **Shopify plan** — checkout customisation and some headless features vary by tier.
4. **Team size** — sets the Cloudflare Access tier and the scheduling model.
5. **Catalog scale** — hundreds of SKUs or tens of thousands? Changes the sync design.
6. **Launch date** — is there a date the storefront must be live?
7. **Provider intent** — is Shopify the launch provider, or is a switch already planned?
   Affects whether M2 builds one adapter or two.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Checkout dependency is real lock-in | Accepted and scoped. Catalog and customers stay ours |
| Projection drift between our DB and provider | Nightly reconciliation job; drift alerts |
| Agent takes a damaging action | Write gating, caps, append-only audit, destructive ops absent |
| Rebuilding storefront costs more than Dawn | Accepted: it is the price of G3 |
| Cloudflare lock-in replacing Shopify lock-in | PostgreSQL over D1; standard web framework |
