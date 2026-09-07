# ADR-008 — Index the working set, archive the rest, delete nothing

**Status:** Proposed · **Date:** 2026-09-07 · **Extends:** ADR-003

## Decision

Every store exposes an **index** — the working set — and that is what a read returns by
default. Data leaves the index by acquiring an `archived_at` marker. **Nothing is deleted**,
and archived rows stay queryable through an explicit call.

Same shape either side of the Git/D1 line:

| Store kind | Index | Rolled off |
|---|---|---|
| Git (catalog, knowledge, reports) | `index.json`, derived at build from the shards | Shard stays in the tree; index omits it |
| D1 (schedule, tickets, orders, expenses) | A `*_index` view over unarchived rows | Row stays in the table; `archived_at` set |

## Why — the reason is cost, not tidiness

Bounding a read is normally a nicety. On an agentic surface it is a bill.

Every row a tool returns is pushed into a model's context. `schedule.view` answering
"what's on this week" by returning every shift ever recorded costs tokens on every turn,
adds latency to every turn, and buries the seven relevant rows in three years of noise —
which makes the answers worse, not just slower.

So the default read is the working set, and reaching further is a deliberate, separate act.
The number of rows an agent sees should be a function of the question, not of how long the
business has been running.

## Why a marker rather than a move

The obvious alternative is moving rolled-off rows to an `_archive` table.

Rejected: it doubles every schema, and a row that moves between tables loses its identity
for anything referencing it — a ticket linked to a shift would dangle the moment the shift
was archived. A marker keeps one row, one id, one lifetime, and reduces "archive" to a
timestamp. The index view carries the cost of `WHERE archived_at IS NULL`, which an index
on that column makes negligible.

## Only settled data may roll off

Archiving is refused by the database for anything still in play:

- a **future** shift, or a past one still `scheduled`/`confirmed` — complete or cancel it first
- an **open** ticket — resolve or close it first

Otherwise "archive" becomes a way to make an inconvenient item disappear from every view
while looking like housekeeping. Rolling off is for work that is finished, and the schema
decides what finished means rather than trusting the caller.

## What this is not

**Not deletion, and not a retention policy.** Erasure is a separate, narrow mechanism that
exists only where the law requires it — a customer's right to erasure (ADR-004) — and it is
owner-gated, evidenced, and crypto-shredded. Archiving is the opposite: it keeps everything
and merely narrows the default view. Do not let one grow into the other.

## Anti-patterns

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Tool reads the base table | Unbounded context cost per turn | Read the `*_index` view |
| Archiving an open item | Hides live work behind housekeeping | Refused by trigger; settle it first |
| Moving rows to an `_archive` table | Doubles the schema; breaks references | One row, one id, an `archived_at` marker |
| Committing a derived Git index | Every change rewrites it; concurrent PRs always conflict | Build it from the shards (ADR-003) |
| Deleting instead of archiving | Destroys evidence — payroll, attendance, audit | Nothing deletes; erasure is separate and narrow |
| Archiving to satisfy a retention rule | Retention means the data is gone; this keeps it | Use the erasure path, and mean it |

## Conformance check

- [ ] Every store with growth over time has an index view or a derived index file
- [ ] Every read tool reads the index, not the base table
- [ ] Rolling off is a marker, never a move or a delete
- [ ] The database, not the caller, decides what is settled enough to roll off
- [ ] Rolled-off data is reachable by an explicit call, and a test proves it survives
