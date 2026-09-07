---
name: finance-skills
description: "Use when an agent tool submits or approves expenses, reads a budget, or writes a quarterly report — receipts to R2, approved expenses that become immutable, reversal instead of edit, and why the books of record are never ours."
version: 1.0.0
tags: [finance, expenses, budgets, reporting, d1, r2, agents, tools]
---

# Finance skills — an approved expense cannot be edited, only reversed

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Building or reviewing an `expense.*`, `budget.*` or `report.*` tool
- An approved expense turns out to be wrong
- A report needs to be written somewhere
- Someone proposes a ledger, or a payroll write

## Bindings

| Store | Kind | Holds |
|---|---|---|
| `finance` | D1, managers and owner | Expenses, budgets, vendors |
| R2 | Object storage | Receipt files |
| `reports/` in Git | JSON shards, via PR | Quarterly reports, sharded by period |

No `people` binding: an expense holds `employee_id` plus a name snapshot, so an expense leak
does not expose staff records. External books of record (Xero / QuickBooks) are never
written by an agent tool — **never build a ledger.**

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `expense.submit` | T1 | Any employee; receipt to R2 | Withdraw before approval |
| `expense.approve` | **T2** | Manager. **Approved expenses become immutable** | Reversing entry only |
| `budget.status` | T0 | Spend against budget | — |
| `report.quarterly` | T1 | Writes a shard to `reports/` via PR | Revert the commit |

**Undo path splits by state.** Before approval, a submission is withdrawable. After
approval, the row is immutable and the only correction is a **reversing entry** — a second
row that cancels the first. Both survive; the pair is the audit trail.

## Rules

1. **Approval is a one-way door.** A trigger refuses in-place edits to an approved expense;
   `verify.py` asserts it. Correct by reversal, never by amendment.
2. **The receipt lands in R2 before the row is written.** An approved expense with a missing
   receipt is an unauditable payment.
3. **The submitter cannot be the approver.** The actor comes from Access on both calls;
   compare them in code and refuse.
4. **Budget reads are derived**, not a stored balance. A stored balance drifts from the rows
   that produced it and nobody notices until quarter end.
5. **Reports are Git shards by period.** `2026-Q3.json` conflicts with nothing, diffs
   cleanly, and reverts like any other commit.
6. **We are not the books of record.** Reconciliation exports to the accounting system; a
   tool that writes back into it makes two systems both authoritative.

## Absent by design (T3)

| Absent | Why |
|---|---|
| Payroll writes | Money owed to people; no reverse entry and the tightest possible blast radius |
| Editing an approved expense | Immutability is the control, not an inconvenience |
| Expense deletion | Reversal keeps both rows and the reason |
| Bulk approval | One approval covering unbounded money |
| Writes to Xero / QuickBooks | They are the books of record; we export, we do not post |
| Raw SQL over `finance` | The tool surface *is* the constraint |

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| `UPDATE expense SET amount = ...` after approval | Rewrites a financial record | Reversing entry |
| Approving your own submission | No second pair of eyes | Compare Access actors, refuse |
| Row written, receipt uploaded after | A crash leaves an unbacked approval | R2 first, then the row |
| Cached budget balance | Drifts silently from the rows | Derive on read |
| One report file for all periods | Conflicts on every write | One shard per period |

## Conformance check

- [ ] A trigger refuses updates to approved expenses, asserted in `verify.py`
- [ ] `expense.approve` refuses when the approver equals the submitter
- [ ] No expense row exists without its R2 receipt object
- [ ] Budget figures are computed from rows on every read
- [ ] No finance tool holds a `people` binding or writes to the accounting system
