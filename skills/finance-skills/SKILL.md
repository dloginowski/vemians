---
name: finance-skills
description: "Use when an agent tool submits or approves expenses, reads a budget, or writes a quarterly report — receipts kept alongside the row, approved expenses that become immutable, reversal instead of edit, and why the books of record are never ours."
version: 1.1.0
tags: [finance, expenses, budgets, reporting, d1, kv, agents, tools]
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
| `RECEIPT_FILES` | KV, `src/index.js` only — no tool holds this binding | Receipt photos, by key |
| `reports/` in Git | JSON shards, via PR | Quarterly reports, sharded by period |

Not R2: ADR-013 dropped this Worker's one R2 bucket, and KV (already live for `APPROVALS`
and the asset drop site's `ASSET_FILES`) does the same job for a receipt photo without
reopening that account-level wall. `RECEIPT_FILES` is its OWN KV namespace, separate from
`ASSET_FILES` — sharing the byte-store *shape* (`createKvByteStore`) is fine; sharing the
*namespace* would blur the blast-radius line between a working document and a financial
record.

No `people` binding: an expense holds `employee_id` plus a name snapshot, so an expense leak
does not expose staff records. External books of record (Xero / QuickBooks) are never
written by an agent tool — **never build a ledger.**

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `expense.submit` | T1 | Any employee; receipt key required. **Writes nothing** — see below | Withdraw before approval |
| `expense.approve` | **T2** | Manager. **Approved expenses become immutable** | Reversing entry only |
| `budget.status` | T0 | Spend against budget | — |
| `report.quarterly` | T1 | Writes a shard to `reports/` via PR | Revert the commit |

**`expense.submit` proposes; a human commits.** This file's own header is explicit:
`expense.approve` is the only tool here that mutates a store. The 'submitted' row a human
can later approve is written by `/expenses/new` -> `/expenses/confirm` in `src/index.js` —
someone photographs a receipt, Workers AI reads a best-effort vendor/date/total off it, and
the person confirms or corrects those fields before anything is stored. That confirm step
calls `expense.submit` for its validation (the amount cap, the budget currency match) and
inserts the row only once it returns `ok`. The same shape as a merged PR committing a
`catalog.draft_edit`: the tool validates and describes the write, a human action outside the
tool layer is what actually makes it real.

**Undo path splits by state.** Before approval, a submission is withdrawable. After
approval, the row is immutable and the only correction is a **reversing entry** — a second
row that cancels the first. Both survive; the pair is the audit trail.

## Rules

1. **Approval is a one-way door.** A trigger refuses in-place edits to an approved expense;
   `verify.py` asserts it. Correct by reversal, never by amendment.
2. **The receipt lands in its own store before the row is written.** An approved expense with
   a missing receipt is an unauditable payment.
3. **The submitter cannot be the approver.** The actor comes from Access on both calls;
   compare them in code and refuse.
4. **OCR prefills, it never files.** A vision model's read of a receipt photo is a best-effort
   guess at four fields, never a value trusted straight into the row — the same reason this
   codebase never lets a model write a price straight into Square. The confirm form shows what
   was read and asks the person to fix anything wrong; garbled OCR is a blank field to fill in,
   not a wrong number quietly filed.
5. **Budget reads are derived**, not a stored balance. A stored balance drifts from the rows
   that produced it and nobody notices until quarter end.
6. **Reports are Git shards by period.** `2026-Q3.json` conflicts with nothing, diffs
   cleanly, and reverts like any other commit.
7. **We are not the books of record.** Reconciliation exports to the accounting system; a
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
| Row written, receipt uploaded after | A crash leaves an unbacked approval | Receipt store first, then the row |
| Cached budget balance | Drifts silently from the rows | Derive on read |
| One report file for all periods | Conflicts on every write | One shard per period |
| OCR's read written straight to the row | A misread total is money, filed silently wrong | Prefill a form; a person confirms |

## Conformance check

- [ ] A trigger refuses updates to approved expenses, asserted in `verify.py`
- [ ] `expense.approve` refuses when the approver equals the submitter
- [ ] No expense row exists without its receipt key
- [ ] Budget figures are computed from rows on every read
- [ ] No finance tool holds a `people` binding, a `RECEIPT_FILES` binding, or writes to the
      accounting system
- [ ] OCR output reaches a human-editable form, never an INSERT, before it is filed
