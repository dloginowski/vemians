# ADR-001 — Catalog in Git, operational data in a database

**Status:** Proposed · **Date:** 2026-09-07

## Question

With a static storefront and all agentic interaction flowing through GitHub, do we need a
SQL database at all, or is JSON in the repo sufficient? Expected scale: ~1,000 SKUs,
retired SKUs deleted.

## Decision

**Split by data domain. Git/JSON for the catalog. A small database for operational data.**

It is not one decision, because the two halves have opposite characteristics: the catalog is
low-frequency, single-writer, and benefits from history; operational data is concurrent,
unbounded, and contains data we may be legally required to erase.

## Measured evidence

Generated 1,000 realistic products (5 variants, 4 media refs, external refs each):

| Measure | Result |
|---|---|
| JSON on disk | 4.0 MB |
| **Packed in Git** | **468 KB** |
| Parse all 1,000 at build | **53 ms** |
| 100 agent commits (5,000 product edits) | grows to 1.3 MB |
| Shallow clone for a build runner | 1.3 MB |

Git is not remotely stressed by this. At ~8 KB per agent commit, decades of churn stay
under typical repo sizes.

## Why Git is the *better* choice for the catalog

Not merely sufficient — better than SQL for this specific data:

- **The PR *is* the approval gate.** PRD **R4.5** requires human approval before agent
  writes. An agent that opens a pull request gets this from the platform, with a reviewable
  diff, rather than from code we write and maintain.
- **The history *is* the audit log** for catalog changes (**R4.6**): who, what, when, exact
  before/after, cryptographically chained, with rollback via revert.
- **Maximum portability.** JSON files in a repo we own is the most portable format
  available — more so than Postgres. This serves **G2** better than a database does.
- **No infrastructure** for the storefront read path. A static build reads files; there is
  no database to run, scale, back up or pay for.

## Why operational data cannot go in Git

**1. Git cannot delete — and "self-cleaning" is precisely what it will not do.**

Tested directly: deleting 300 SKUs and running `git gc --prune=now` left the working tree at
700 files while the repository **grew** from 468 KB to 536 KB, and the deleted content was
still retrievable from history.

For retired products that is harmless, even useful. For **customer records it is
disqualifying**: a deletion request under GDPR/CCPA cannot be honoured by deleting a file.
It would require rewriting history, which breaks every clone, and is impossible once the
repo is forked or mirrored. Customer PII must therefore never enter the repository.

**2. No concurrency control.** Two order webhooks landing together race on push. Git has no
transactions and no row-level locking.

**3. Constraints cannot be enforced.** The shift-overlap exclusion that stops the agent
double-booking someone (**R4.2**) is a database guarantee. In Git it becomes application
code with a race between read and commit.

**4. Unbounded growth.** Orders accumulate forever, and in Git nothing can ever be pruned.

## Allocation

| Data | Store | Rationale |
|---|---|---|
| Products, variants, prices | **Git JSON** | Versioned, reviewable, static-built |
| Collections, content, copy | **Git JSON** | Same |
| Design tokens, config | **Git** | Already code |
| `external_ref` mappings | **Git JSON** | Travels with the product |
| **Product media** | **R2** | Never Git — 1,000 SKUs × 4 images ≈ 2 GB, and every re-upload is kept forever |
| Orders | **Database** | Concurrent, unbounded, contains PII |
| Customers | **Database** | Must be erasable |
| Employees, shifts | **Database** | PII; needs the overlap constraint |
| Live inventory | **Database** | Changes faster than a rebuild cycle |
| Audit log (non-catalog) | **Database** | Append-only, queryable |

## Consequences

**The database shrinks to almost nothing.** With the catalog gone, it holds orders,
customers, employees, shifts and the audit log. At this scale **D1 becomes defensible** —
the portability argument that favoured Postgres was mostly about the catalog, and the
catalog is now in Git, which is more portable than either. Postgres remains the safer pick
if we want the shift-exclusion constraint enforced by the engine; D1 (SQLite) has no
equivalent to `EXCLUDE USING gist`.

**Publishing becomes a build cycle.** A price change goes live in minutes, not instantly.
Acceptable for catalog work; it rules out instant flash-sale repricing.

**Stock levels cannot be baked into static pages.** They will be stale the moment the build
finishes. Either omit stock from the page or fetch it client-side at request time —
otherwise we oversell.

**The Exit Test (PRD §7) gets easier.** Deleting a provider becomes removing an
`external_ref` key across JSON files; the catalog is plainly untouched.

## Changes required to the PRD

- **N7** ("standard PostgreSQL, portable to any host") — rewrite: the catalog is Git JSON;
  the database requirement narrows to operational data.
- **§8 architecture diagram** — the system of record is now Git *plus* a small database.
- **R3.4** (vendor ids in one mapping table) — becomes a mapping *field* in product JSON.
- **M0** — the schema in `shared/db/*.sql` should drop its catalog tables and keep
  orders, customers, employees, shifts and the audit log.

## Alternatives rejected

- **Everything in SQL.** Loses free approval gating and audit; adds infrastructure the
  storefront does not need.
- **Everything in Git.** Fails erasure obligations for customer data, and cannot enforce
  the scheduling constraint.
- **Git plus a JSON "database" for orders.** Same erasure problem, plus write races.
