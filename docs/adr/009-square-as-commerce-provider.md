# ADR-009 — Square replaces Shopify, and becomes authoritative for stock

**Status:** Proposed · **Date:** 2026-09-07 · **Amends:** ADR-001

## Decision

Square is the commerce provider. The Dawn theme and every Shopify assumption go.

And a reversal worth stating plainly: **Square becomes the system of record for inventory, and
for the commercial facts of the catalog.** Git keeps presentation. ADR-001 had our catalog
authoritative and projected *out* to the provider; with a physical POS in the loop that is no
longer tenable.

## Why the reversal

Shopify was a website. Square is a **till**. The moment someone rings a sale on the counter,
stock changes in Square without asking us. Two authoritative counts cannot both be right, and
the one that is wrong is ours — silently, and in the direction that oversells.

The same logic reaches the catalog: staff will add a product at the counter, because that is
where the product physically is. A design that requires a pull request before an item can be
sold will be worked around by lunchtime.

So the split moves:

| | Authoritative | Why |
|---|---|---|
| Stock counts | **Square** | The POS changes them without us |
| Product existence, price, SKU | **Square** | Created where the goods are |
| Editorial copy, imagery, ordering, collections | **Git** | Never touched by a till; benefits from review |
| Orders, customers, staff, finance, tickets, audit | **Ours (D1)** | Unchanged |

## What this does NOT concede

Portability was the whole point, and it survives:

- **The commerce port is unchanged.** `SquareAdapter` implements the same interface
  `ShopifyAdapter` did. That interface existing is why this is an afternoon and not a rewrite —
  the exact thing it was built for, arriving sooner than expected.
- **We still hold a full mirror.** Square's catalog and stock are mirrored into our stores on
  webhook and on a nightly reconcile. If Square goes away we keep the data; we lose the till.
- **Presentation stays ours.** The storefront, the design system and the editorial layer never
  entered Square, so no part of how the shop looks or reads is theirs to hold hostage.
- **Vendor ids stay in `external_ref`.** Square's `catalog_object_id` lives in one place.

The honest cost: leaving Square now means re-keying the catalog into whatever replaces it,
rather than projecting it back out. That is the price of the till being real.

## The fit is better than Shopify's was

Square's inventory model is **already a ledger** — `InventoryPhysicalCount` (provided) and
`InventoryCount` (computed), with adjustments between them. That is precisely the design in
ADR-008: append-only changes with a derived count. Our `inventory_adjustment` table becomes a
mirror of Square's changes rather than a competing ledger, and the semantics line up without
translation.

Catalog maps cleanly too: Square `ITEM` → our product, `ITEM_VARIATION` → our variant, with
stock tracked at the variation level, exactly where we track it.

## Checkout

**Payment Links API** — a Square-hosted checkout page. Same principle as before: checkout is
the one thing worth renting, card data never touches us, and PCI scope stays with Square.

The Web Payments SDK would let us embed the card fields for a smoother flow, and would pull us
into a wider PCI obligation for it. Not at this stage. Revisit when the hand-off is measurably
costing conversions, not before.

## Repository layout

```
store/     public storefront Worker      vemians.com
ops/       agentic staff Worker          ops.vemians.com
shared/    schemas, design tokens, commerce port
docs/
```

Two deployable packages over one shared core. The `SURFACE` split stays — Cloudflare Access
gates a whole Worker, so the surfaces cannot share a deployment.

## Anti-patterns

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Our own stock count beside Square's | The till changes stock without us; ours silently oversells | Square authoritative, we mirror |
| Editorial copy in Square item descriptions | Unreviewable, unversioned, lost on provider change | Copy in Git, keyed by Square id |
| Storefront reading Square live per request | Provider outage takes the shop down; rate limits | Read the mirror; Square only to mint checkout |
| Square ids as our primary keys | Reinstates exactly the lock-in this design avoids | Our uuids, Square id in `external_ref` |
| Embedding card fields to save a click | Buys a wider PCI obligation for a smoother flow | Hosted Payment Links until the cost is measured |

## Open questions

1. **Do staff manage the catalog in Square, or in Git?** This ADR assumes Square, because of
   the till. If products are actually curated centrally and never added at the counter, the
   ADR-001 direction was right and should stand.
2. **One location or several?** Square tracks stock per location; the storefront needs a rule
   for which location's count it sells against.
3. **Square Online** — if it is in use, it is a second storefront competing with this one.
