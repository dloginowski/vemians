---
name: people-skills
description: "Use when an agent tool reads or writes employee schedules and shift swaps — the tightest Access policy of the six stores, drafts that a manager publishes, and shift overlap refused by the database rather than by application logic."
version: 1.0.0
tags: [people, scheduling, shifts, d1, access-control, agents, tools]
---

# People skills — the database refuses the double-booking

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Building or reviewing a `schedule.*` or `shift.*` tool
- An agent is drafting or publishing a week
- Two shifts might overlap
- Someone asks why the agent cannot read staff records from a finance tool

## Bindings

| Store | Kind | Holds |
|---|---|---|
| `people` | D1, **tightest Access policy of the six** | Employees, shifts |

Reachable by the **owner and the individual employee** only (ADR-002). Finance holds an
`employee_id` plus a name snapshot — never a binding into this store, so an expense-data
leak does not expose staff records.

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `schedule.view` | T0 | Own shifts; managers see all | — |
| `schedule.draft` | T1 | Proposes a week; **overlap refused by the database** | Discard the draft |
| `schedule.publish` | **T2** | Manager only | Publish a corrected week |
| `shift.swap` | T1 | Both employees confirm | Cancel the swap |

**Undo path:** a shift row carries a status. Cancelling appends a status, which frees the
slot; nothing is deleted, so the record of who was scheduled and when survives.

## Rules

1. **Overlap is refused by a trigger, not by the tool.** D1 serialises writes to a single
   writer, which makes a trigger-based check race-free in a way an application-level
   read-then-write is not. An agent retrying a draft cannot double-book anyone.
2. **Back-to-back shifts are legal**; touching boundaries are not an overlap. Moving a shift
   *into* a conflict is rejected, and cancelling frees the slot. All four cases are asserted
   in `verify.py` — the guarantee is tested, not described.
3. **`schedule.view` is scoped by the actor**, taken from Access. Staff see their own week;
   the manager role widens the query, and the widening is in code.
4. **A draft is not a schedule.** Nothing is binding until a manager publishes, and publish
   is the tier boundary.
5. **A swap needs both confirmations.** One-sided swaps are how a shift silently loses its
   owner.
6. **Cancel, never delete.** A cancelled shift is evidence; a deleted one is a dispute.

## Absent by design (T3)

| Absent | Why |
|---|---|
| Payroll writes | Money owed to people, with no reverse entry available |
| Shift deletion | Cancellation carries the same effect and keeps the history |
| Editing another employee's shift without a swap | Bypasses the two-party confirmation |
| Publishing as anyone but a manager | The tier boundary *is* the control |
| Any finance or commerce binding | Staff records must not travel with expense or order data |

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Overlap checked in the Worker | Read-then-write races; retries slip through | Database trigger |
| Draft that writes published rows | Removes the manager gate | Draft status until publish |
| One-sided swap | A shift loses its owner quietly | Both employees confirm |
| Deleting a cancelled shift | Destroys the evidence of the change | Status row |
| A finance tool reading `people` | Widens the blast radius of an expense leak | `employee_id` plus name snapshot |

## Conformance check

- [ ] Overlap refusal is a database constraint, exercised end to end in `verify.py`
- [ ] Back-to-back shifts pass; a move into conflict is rejected; a cancel frees the slot
- [ ] `schedule.view` scopes by the Access actor, with the manager widening in code
- [ ] `schedule.publish` refuses for non-managers and audits the refusal
- [ ] No tool outside this domain holds a `people` binding
