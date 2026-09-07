---
name: customer-skills
description: "Use when an agent tool reads or updates a customer profile, fit data, consent or purchase history — the opaque-id model, the versioned non-destructive edit log, and the hard rule that these tools never return a name."
version: 1.0.0
tags: [customers, d1, privacy, gdpr, versioning, agents, tools]
---

# Customer skills — a profile without a person

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Building or reviewing a `customer.*` tool
- An agent needs sizes, consent, birth year or purchase history
- Someone asks a customer tool to "just also return the name"
- Undoing a customer edit

## Bindings

| Store | Kind | Holds |
|---|---|---|
| `customers` | D1 | Opaque id, birth year, consent, `customer_version` log |
| `customer_fit` | D1 table, **own binding** | Measurements — intimate data, separable |
| `commerce` | D1, read-only | History joined by `customer_id` |

**No `identity` binding. Ever.** That is the whole point of the split (ADR-004): most tools
read a profile without ever seeing who it is.

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `customer.profile` | T0 | Opaque id. **Returns no name** | — |
| `customer.fit` | T0 | Sizes; separate binding from contact details | — |
| `customer.history` | T0 | Joined from `commerce` by id | — |
| `customer.update_fit` | T1 | Versioned; revertible | `customer.revert` |
| `customer.revert` | T1 | Appends a compensating version row | Revert the revert |

**Undo path:** `customer_version` records every edit — field, old value, new value, actor,
timestamp — *before* it is applied. Reverting appends a compensating row whose `reverts`
points at the original. Nothing is overwritten, and the revert is itself history.

## Rules

1. **Never return a name, email or phone.** Resolving an id to a person is `identity`'s job,
   under its own Access group and its own audit trail. A customer tool that helpfully
   includes a name has silently merged the two stores.
2. **Record the version row before applying the change.** A trigger blocks updates to the
   log, so history cannot be quietly rewritten.
3. **Revert by appending, never by editing.** The compensating row is the undo; deleting the
   original would destroy the audit of what happened.
4. **`customer_version` rows are deletable only under an open erasure request** — otherwise
   old values outlive the record they belong to.
5. **Fit is its own binding.** A clienteling tool that needs contact details must not
   thereby acquire measurements, and vice versa.
6. **Treat `notes` as identifying.** Free text accumulates names. Either encrypt it or
   govern it as identity data — do not let a T0 tool return it raw.
7. **Profile data has a retention period too.** Pseudonymous is not anonymous: "£9,000 coat,
   size IT 42, born 1985" may identify one person.

## Absent by design (T3)

| Absent | Why |
|---|---|
| Name / email / phone in any response | Belongs to `identity`, with a different Access group |
| Profile deletion | Erasure is `identity.erase`, owner-gated, cascade-driven |
| In-place profile edit | Removes the undo path |
| Fuzzy customer search | Encrypted fields cannot be searched; exact HMAC only |
| Bulk export | An unbounded read of pseudonymous personal data |

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Joining `identity` "for convenience" | Collapses the vault split | Two tools, two Access groups |
| `UPDATE customer SET ...` | No version row, no undo | Append version, then apply |
| Deleting a version row to undo | Destroys the record of the change | Compensating row |
| Returning `notes` from a T0 tool | Free text carries names | Govern or encrypt it |
| Keeping profiles indefinitely | Pseudonymous data is still personal | Retention period on `customers` |

## Conformance check

- [ ] No customer tool holds an `identity` binding
- [ ] A test asserts no response schema contains `name`, `email` or `phone`
- [ ] Every write appends to `customer_version` before mutating
- [ ] Update on `customer_version` is refused by trigger
- [ ] Revert is verified end to end: edit, revert, both present in history
