# ADR-002 — Decomposed data domains

**Status:** Proposed · **Date:** 2026-09-07 · **Extends:** ADR-001

## Decision

Six stores, none of them central. Your three, plus the three your list left homeless.

| Store | Kind | Holds |
|---|---|---|
| **catalog** | Git JSON | Products, variants, prices, collections, content, vendor id mappings |
| **knowledge** | Git Markdown + Vectorize | The reference library |
| **commerce** | D1 | Orders, customers, inventory |
| **people** | D1 | Employees, shifts |
| **finance** | D1 | Expenses, budgets, vendors |
| **audit** | D1 | Append-only record of every agent action |

## The boundary rule

Draw the line at **blast radius and retention**, not at topic. Two datasets belong apart when:

- a leak of one must not expose the other,
- they have different retention or erasure obligations, or
- different people should be able to reach them.

They belong **together** when you need a join or a transaction across them. That is the real
cost, and it is why the answer is six rather than sixteen.

## What your three missed

**Orders and customers** have to go somewhere, and they cannot go with products: the catalog
is in Git (ADR-001) and customer records must be erasable. They get their own store.

**Employees** are referenced by both scheduling and expenses. Putting them in `finance` would
mean a leak of expense data exposes staff records; putting them in `commerce` mixes staff with
customers. They get their own store, with the tightest Access policy of the six.

## Why `knowledge` is not a database

Same reasoning as the catalog in ADR-001: documents, low write frequency, no PII, and
versioning is a feature rather than overhead. Markdown in Git gives review-by-PR, diffs and
rollback for free.

Semantic search is a **derived index**, not a second source of truth: embed on commit into
Vectorize, rebuild from Git at any time. If the index is lost, it is regenerated; if it
disagrees with Git, Git wins.

This is the *"development database"* you described — it just does not need to be a database.

## Why D1 rather than Postgres

This revises ADR-001, which favoured Postgres for portability. Two things changed:

1. The catalog left for Git, so the remaining stores are small and operational. Postgres was
   mostly protecting catalog portability, which Git now protects better.
2. Six stores is exactly what D1 is good at — six bindings in `wrangler.toml`, near-zero
   cost. Six Neon projects is a different proposition operationally and financially.

The one thing given up is `EXCLUDE USING gist` for shift overlap. Recovered with a trigger:
**D1 serialises writes to a single writer**, so a trigger-based overlap check is race-free in
a way an application-level read-then-write is not. Verified — see below.

## The cost, stated plainly

**No joins or foreign keys across stores.** An expense referencing an employee holds
`employee_id` plus an `employee_name` snapshot. This is the same pattern order lines already
use for the Git catalog, and it has a real benefit: records stay readable when the other
store is unavailable or the referenced row has changed.

**No transactions across stores.** Any operation spanning two must be idempotent and
retryable, not atomic. In practice this affects little — the natural operations sit inside
one store.

**Migrations and backups are per-store.** Six of each.

## Access model

Each store is a separate Cloudflare Access policy and a separate D1 binding, so an agent tool
reaches only its own domain. A knowledge-base tool structurally *cannot* read finance — that
is enforced by binding, not by prompt.

| Store | Who reaches it |
|---|---|
| catalog, knowledge | All staff (via PR review) |
| commerce | Staff (read), managers (write) |
| finance | Managers and owner |
| **people** | Owner and the individual employee |
| audit | Owner (read); application is insert-only |

## Verification

`shared/db/verify.py` loads each schema into SQLite and asserts the guarantees. All 15 pass:

- **commerce** — webhook replay cannot duplicate an order; order lines survive with no catalog FK.
- **people** — the agent cannot double-book; back-to-back shifts are legal; moving a shift into
  a conflict is rejected; cancelling frees the slot.
- **finance** — an approved expense cannot be edited in place, only reversed.
- **audit** — rows cannot be updated or deleted; unknown domains rejected.

## Consequences for the PRD

- **N7** — rewrite: no single database; per-domain stores, catalog and knowledge in Git.
- **§8 diagram** — six stores, not one.
- **R4.3** ("read across catalog, orders, inventory and schedule, scoped to the caller's role")
  — scoping is now structural via bindings rather than query-level.
- **M0** — becomes "six schemas + verify.py in CI" rather than one schema.
