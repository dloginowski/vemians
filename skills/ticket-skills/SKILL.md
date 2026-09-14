---
name: ticket-skills
description: "Use when opening, reading, commenting on, or moving the status of a ticket — the internal-messages surface staff use instead of email. Covers ticket.list / ticket.get / ticket.create / ticket.comment / ticket.set_status, why writes are proposals a browser route applies, and why every tool here stays at the staff role."
version: 1.0.0
tags: [tickets, messages, coordination, agents, tools]
---

# Ticket skills — company-wide issues, and the internal-messages surface

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Someone asks you to open, find, or check on a ticket
- Someone wants to leave a note or a comment for a coworker to see later — a ticket thread IS
  the internal message, not a lighter-weight thing beside it
- Deciding whether something is worth a ticket at all, versus just answering directly
- Building or reviewing a `ticket.*` tool

## Bindings

| Store | Kind | Why this one |
|---|---|---|
| `tickets` | D1 | `ticket`, `ticket_comment`, `ticket_link` (shared/db/tickets.sql) |

No customer, commerce, people or finance binding. A ticket may reference an order, a customer,
a product, a shift or an expense (`ticket_link`), but only by id plus a non-identifying label —
this domain cannot itself look up or read the thing being referenced.

## Why this is the messaging surface, not a separate one

The owner's own words, once a shared company email domain stopped being how staff reach each
other: "we will handle communication entirely through our website internal messages." A ticket
already is a message thread — a title plus an append-only comment log — with the
category/priority/status machinery already built for P0-32. Reach for `ticket.comment` on an
existing ticket, or `ticket.create` for a new one, rather than treating "leave someone a note"
as a different kind of task from "file an issue." They are the same tool.

**Staff-to-staff only, today.** A customer has no account or login on the storefront, so this
domain has no path from a customer to a thread yet. Do not invent one — say plainly that
customer-facing messaging is not built, rather than routing a customer's message through
`ticket.create` as a workaround.

## Writes are proposals — you will not see a ticket exist after calling ticket.create

`ticket.create`, `ticket.comment` and `ticket.set_status` are all T1: each validates and returns
the row it would insert or update, and writes nothing itself. A human's browser submission at
`/tickets/new`, `/tickets/<id>/comment` or `/tickets/<id>/status` (`ops/src/index.js`) is what
actually commits it — the same split `expense.submit` uses. Tell the person you are helping to
finish the action on the page, the same way you would for an expense or a draft product; do not
claim the ticket was filed, commented on, or moved until they confirm it.

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `ticket.list` | T0 | Working set (not archived), filterable by status/category/assignee | — |
| `ticket.get` | T0 | One ticket plus its full, ordered comment thread | — |
| `ticket.create` | T1 | Proposes a new ticket; category/priority default to other/normal | close it |
| `ticket.comment` | T1 | Proposes a comment; refused if the ticket does not exist | add another comment |
| `ticket.set_status` | T1 | Proposes a status move; resolving or closing needs a `note` | propose reopening |

## Rules

1. **No `minRole` above staff, anywhere in this domain.** A ticket carries no money and no
   employee record — this is coordination, not authorisation (`shared/db/tickets.sql`'s own
   line: "tickets are read and written by everyone"). Never suggest gating a ticket tool by
   role; if a change genuinely needs a manager's say-so, that belongs in the domain the ticket
   is ABOUT (finance, catalog, people), not here.
2. **Resolving or closing needs a reason.** `ticket.set_status` refuses `resolved`/`closed`
   without a `note` — it becomes the resolving comment. Ask what was actually done before
   proposing the move, rather than closing with an empty note and hoping it goes through.
3. **Nothing here is ever deleted.** `shared/db/tickets.sql`'s own triggers refuse a `DELETE` on
   either table outright. A mistake is corrected with a further comment or a status change, not
   erased.
4. **A ticket about a customer or an order links to it by id, never by copying their details
   in.** Use `ticket_link`'s shape (not yet exposed by a tool) as the model even before it has
   one: id plus a short, non-identifying label — "order #1183" — not a customer's name, email or
   full order contents pasted into the body.

## Absent by design (T3)

| Absent | Why |
|---|---|
| `ticket.delete` / `ticket.edit_comment` | Nothing in this codebase deletes; correct with another comment or a status move |
| `ticket.assign_to_customer` / any customer-facing ticket tool | No customer identity or login exists yet — a real decision to make deliberately, not a gap to route around |
| `ticket.bulk_close` | One approval covering an unbounded number of tickets is exactly the shape T2 exists to prevent, and this domain does not even reach T2 |

## Conformance check

- [ ] Every `ticket.*` tool declares `minRole: "staff"` — nothing here is manager- or owner-gated
- [ ] `ticket.create`, `ticket.comment` and `ticket.set_status` all return `{ applied: false,
      proposal }` and touch no store directly
- [ ] `ticket.set_status` refuses a `resolved`/`closed` move with no `note`
- [ ] No tool in this file declares a `customers`, `commerce`, `people` or `finance` binding
