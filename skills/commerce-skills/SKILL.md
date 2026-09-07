---
name: commerce-skills
description: "Use when an agent tool reads orders or moves inventory — live stock reads that never come from the static build, reconciliation-only adjustments, and why refunds are deliberately not a tool."
version: 1.0.0
tags: [commerce, orders, inventory, d1, shopify, agents, tools]
---

# Commerce skills — read the orders, do not touch the money

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Building or reviewing an `order.*` or `inventory.*` tool
- An agent is asked to issue a refund or cancel an order
- Stock numbers disagree between us and the sales channel
- Deciding where an order status change is allowed to originate

## Bindings

| Store | Kind | Holds |
|---|---|---|
| `commerce` | D1 | Orders, order lines, inventory |
| `catalog` | Git, read-only | Product resolution by handle |

Order lines carry a **product snapshot**, not a foreign key — there are no joins across
stores, and the record stays readable when the catalog has moved on (ADR-002).

**No `identity` binding.** Orders hold a `customer_id` and no PII of their own.

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `order.search` | T0 | By id, date, status | — |
| `order.get` | T0 | One order, with lines | — |
| `inventory.check` | T0 | **Live.** Never served from the static build | — |
| `inventory.adjust` | **T2** | Reconciliation only, with a stated count | Reverse entry |
| `order.refund` | **T3** | **Absent.** Issue refunds in the provider | — |

**Undo path:** status transition and reverse entry. An order status moves forward and the
move is a row; a mistaken adjustment is corrected by a second adjustment, never by editing
the first.

## Rules

1. **`inventory.check` is live or it is wrong.** Serving stock from the static build shows a
   number that was true at deploy time and sells something that is gone.
2. **We are authoritative on inventory**; the sales channel's decrements are ingested. An
   adjustment reconciles our count to a physical one — it is not a way to move stock.
3. **Every adjustment carries the counted figure and the reason**, not just a delta. A delta
   with no observed count cannot be audited afterwards.
4. **Webhook ingest is idempotent.** Replay must not duplicate an order; that is asserted in
   `verify.py`, not assumed.
5. **Refunds happen in the payment provider.** Money movement lives where PCI scope lives —
   the one thing worth renting. An agent tool would put a refund path in a system that does
   not hold the payment.
6. **Never edit an order row.** Status transitions only; the history of the transition is the
   record.

## Absent by design (T3)

| Absent | Why |
|---|---|
| `order.refund` | Money movement belongs to the provider that holds the payment |
| Order cancellation | Same reason — the channel owns fulfilment state |
| Order or line deletion | Tax retention; the record survives even a customer erasure |
| Bulk inventory set | One approval covering the entire stock position |
| Writing inventory to the channel | Projection is a pipeline, not an agent action |

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Stock read from the static build | Sells what is not there | Live D1 read on every call |
| `inventory.adjust` as a movement tool | Reconciliation becomes an unlogged transfer | Counted figure plus reason |
| Editing an order row | Destroys the transition history | Append a status row |
| Adding a refund tool "with approval" | The gate is not the problem; the location is | Provider dashboard |
| Foreign key from order line to catalog | Cross-store FK that cannot exist | Snapshot on the line |

## Conformance check

- [ ] `inventory.check` has no static or cached path in production
- [ ] Adjustments require a counted figure and a reason, both audited
- [ ] Webhook replay is tested and cannot duplicate an order
- [ ] No refund, cancel or delete tool exists in the surface
- [ ] Order tables contain no direct identifiers
