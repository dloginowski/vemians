---
name: agent-tool-contract
description: "Use when designing, reviewing or implementing any agent tool on ops.vemians.com — the tier system (T0 read / T1 propose / T2 approve / T3 absent), audit-before-return, actor taken from Cloudflare Access rather than a parameter, fail-closed behaviour, caps enforced in code, and scope enforced by binding instead of prompt."
version: 1.0.0
tags: [agents, tools, security, audit, access-control, cloudflare, contract]
---

# The agent tool contract — scope is a binding, not an instruction

## Trigger

Use when:
- Adding, changing or reviewing any tool the ops agent can call
- Deciding whether an operation needs a human in the loop
- A tool needs data from a second domain
- Someone proposes a "delete", "force", "override" or "raw query" tool
- Writing the domain skills: every one of them inherits this file

## First message to a person

Whoever connects to `ops.vemians.com/mcp` is a coworker opening a new tool, not a developer
reading an API — greet them like one, in your very first reply, before touching any other tool.

- **Greet by their ACTUAL first name, not a guess.** `skills_list`'s own response carries
  `you: { email, first_name, role }` — that `first_name` is what a real Access identity
  resolved to, sometimes from a `given_name` claim, sometimes derived from the email when no
  name claim was present. Use it. Guessing a name from the email yourself, when the real one
  is sitting right there in the response you already have, is the kind of shortcut that looks
  right until someone named differently than their email suggests notices it is wrong.
- **Offer a short menu, then wait.** Exactly these four choices, in this order: "Hi
  <first_name> — what can I help with? 1) Add Merchandise  2) Add Customers
  3) Submit Expenses  4) More Options." Do not explain tiers, tools or skills unless asked.
  If they pick "More Options," say plainly what else you can do (look something up, connect
  their own assistant, anything else this role reaches) rather than a second rigid menu.
- **Once they pick "Add Merchandise" or "Add Customers," ask one more short question first:**
  "Do you have a spreadsheet, or would you rather tell me about them here?" A spreadsheet goes
  to `/products/batch` or `/customers/batch` on `ops.vemians.com` — one file, one approval link
  per row. A narrated list is drafted and created one item at a time exactly as for a single
  one — there is no separate "batch" tool — then every resulting approval link is presented
  together at the end.
- **"Submit Expenses" is different: there is no tool for it and no second question.** Point
  them straight at `/expenses/new` on `ops.vemians.com` — they photograph the receipt there, a
  vision model takes a best-effort read of the vendor, date and total, and they confirm or
  correct every field before anything is filed. Do not attempt to draft or submit an expense
  yourself; there is nothing to call, and inventing an argument shape for it is worse than
  saying "photograph the receipt at this link."
- **The approval link is a real form, not a preview.** The person reviews what you proposed,
  fixes anything wrong right there (a typo'd title, a wrong price), and submits — all on that
  page. Do not ask them to confirm details in this chat; send them to the link for that. Never
  approve on the person's behalf; each link still needs its own "yes."

This section, not the transport-level `instructions` a server can offer at connect time, is the
one place every connecting agent is guaranteed to actually see the greeting protocol: some MCP
clients silently drop server `instructions` (confirmed for at least the ChatGPT and Claude.ai
web connectors — only Claude Code's own CLI reliably surfaces that field), but nothing drops
the words of a skill the person's own onboarding script just told the agent to read.

## Core principle

**Scope is enforced by binding, not by prompt instruction.** Each skill declares the
stores it may reach and the Worker binds only those. A knowledge tool *cannot* read
finance — not because the prompt forbids it, but because the binding does not exist.
Prompt-level scoping fails under adversarial input. Binding-level scoping does not.

## Tiers

| Tier | Means | Where it lives |
|---|---|---|
| **T0** read | Runs immediately. Audited | Lookups, search, status |
| **T1** propose | Produces a diff or pull request; a human merges | Catalog and knowledge edits, drafts, submissions — the busiest tier |
| **T2** approve | Executes only after in-session approval by someone holding the role | Prices, publishing, expense approval, identity reveal |
| **T3** absent | Not built, and named so nobody builds it by accident | Payroll writes, bulk deletion, raw SQL, disabling the audit log |

**T3 is a design output, not an omission.** Every domain skill states its own T3 list and
why. An absent tool that is not written down gets built by the next person.

## Nothing destroys

Every write is an **append plus a pointer**. There is no tool that deletes.

| Domain | Write mechanism | Undo |
|---|---|---|
| catalog, knowledge | Pull request | Revert the commit |
| customers | `customer_version` row, then apply | Append a compensating row |
| commerce, finance | Status transition | Reverse entry, never an edit |
| people | Shift row with status | Cancel, never delete |

The single exception is **erasure** (`identity.erase`), which is its own gated workflow
under an open erasure request — see `identity-skills`.

## Rules

1. **Write the `audit` row before returning** — including denials and errors. A tool that
   audits only its successes is a tool whose interesting cases are invisible.
2. **`actor` comes from the verified Access identity** (R1.4), never a parameter the agent
   can set. A tool signature that accepts an actor is a tool that can be impersonated.
3. **Fail closed.** If the audit store is unavailable, the write does not happen. Degrade to
   refusal, never to an unlogged action.
4. **Caps live in code, not in the prompt.** Page sizes, row limits, refund ceilings, batch
   sizes — enforced by the tool. A cap stated only in a prompt is a suggestion.
5. **Roles come from Google Workspace groups** (R1.3). Nothing is assigned in the
   application, and no tool grants itself a role.
6. **Cross-domain reads are joins in the caller, not a wider binding.** A tool needing two
   stores gets two explicit bindings or gets refused — never a general-purpose one.
7. **Build the riskiest tools last.** `identity.reveal` and `catalog.set_price` come after
   the audit path and the approval gate have been exercised by lower-risk tools.

## Role → tool matrix

| | Staff | Manager | Owner |
|---|---|---|---|
| catalog read / propose | ✅ | ✅ | ✅ |
| catalog price / publish | — | ✅ | ✅ |
| customer profile, fit | ✅ | ✅ | ✅ |
| `identity.reveal` | — | ✅ | ✅ |
| `identity.erase` | — | — | ✅ |
| own schedule | ✅ | ✅ | ✅ |
| publish schedules | — | ✅ | ✅ |
| submit expenses | ✅ | ✅ | ✅ |
| approve expenses | — | ✅ | ✅ |
| audit log | — | — | ✅ |

## Build order

1. Audit store and its write path — **before any tool.**
2. T0 reads across catalog, customers, commerce.
3. T1 proposals: catalog PRs, expense submission, fit updates.
4. Scheduling, including the overlap refusal end to end.
5. T2 gated writes.
6. `identity.reveal`, then `identity.erase`.

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| "The prompt says not to read finance" | Prompt scoping breaks under injection | Omit the binding |
| `actor` as a tool parameter | Impersonation by argument | Read it from Access |
| Audit written after the effect | Crashes lose the interesting rows | Audit, then act, then return |
| Audit store down → proceed anyway | Unlogged mutation | Fail closed |
| "Return at most 50 rows" in the prompt | Not a cap, a hope | `LIMIT` in the query |
| A `delete` tool "just for cleanup" | Undo path disappears | Append plus pointer |
| One tool bound to every store | Blast radius is the whole business | One domain per tool |
| Roles stored in the app | Two sources of truth for authz | Workspace groups only |

## Conformance check

- [ ] Every tool declares its tier, its stores, and its undo path
- [ ] Every tool writes an audit row before returning, on success and on refusal
- [ ] No tool signature accepts `actor`, `role`, or a store name
- [ ] Bindings in `wrangler.toml` match the declared stores exactly — no extras
- [ ] Caps are asserted in tests, not described in prose
- [ ] Each domain skill names its T3 absences and the reason for each
