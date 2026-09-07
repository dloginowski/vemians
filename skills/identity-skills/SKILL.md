---
name: identity-skills
description: "Use when an agent tool touches the identity vault — HMAC lookup, the decrypt-and-reveal path, or crypto-shred erasure. The most sensitive domain on the platform: separate Access group, envelope encryption under an external KMS, and the only tool that legitimately destroys."
version: 1.0.0
tags: [identity, pii, encryption, kms, gdpr, erasure, audit, agents, tools]
---

# Identity skills — the vault, and the two tools allowed to open it

Inherits `agent-tool-contract`. Read that first. **This is the highest-risk domain here;
build it last.**

## Trigger

Use when:
- Building or reviewing `identity.lookup`, `identity.reveal` or `identity.erase`
- An agent needs to resolve an opaque customer id to a person
- Handling an erasure request
- Anyone proposes widening the identity binding to another tool

## Bindings

| Store | Kind | Holds |
|---|---|---|
| `identity` | D1, **its own Access group** | Name, email, phone as ciphertext; `email_hmac`, `phone_hmac`; wrapped data key, `kek_id` |
| KMS | External (AWS) | The KEK. Cloudflare never holds it |
| `audit` | D1, insert-only | Every call, including refusals |

**Neither provider alone can read a customer record.** Cloudflare holds ciphertext and
wrapped keys; AWS holds the key-encrypting key (ADR-004). That separation is the control —
do not move the keys next to the data to simplify anything.

## Operations

| Tool | Tier | Role | Notes |
|---|---|---|---|
| `identity.lookup` | T0 | Manager, owner | **HMAC exact match only.** Returns an opaque id, not a record |
| `identity.reveal` | **T2** | Manager, owner | Decrypts one record. Heavily audited — the most sensitive tool on the platform |
| `identity.erase` | **T2** | **Owner only** | Crypto-shred the data key, then cascade |

**Undo path — there is none for `erase`, by design.** Destroying the wrapped data key
renders the record unrecoverable; that is what makes it a valid erasure method for data that
has reached a backup. `reveal` has no undo either: a disclosure cannot be recalled, which is
why the gate is in front of it and the audit row is written before the plaintext exists.

## Rules

1. **One record per `reveal`.** No batch, no range, no "reveal the results of that search".
   A tool that reveals a list is an export tool wearing a disguise.
2. **Audit before decrypting**, with the stated reason attached. If the audit write fails,
   the decrypt does not happen.
3. **HMAC, never a bare hash.** A phone number has ~10^10 possible values; an unsalted
   digest of one is the phone number with extra steps. The key makes it resist enumeration.
4. **Unwrapped data keys live in request memory only.** Never persisted, never cached across
   requests, never logged.
5. **`erase` requires an open erasure request** and cascades: identity row, `customers`
   profile, fit, consent, `customer_version`. Orders survive, de-identified — tax retention
   and erasure pull in opposite directions and the split is what resolves it.
6. **Erasure is owner-only, and that is a Workspace group**, not a flag in the application.
7. **KEK backup and rotation policy must exist before the first customer record is
   written.** Losing the KEK loses every identity at once.
8. **Encrypted fields cannot be searched, sorted or fuzzy-matched.** Exact HMAC lookup is
   the only query. Do not add a plaintext column to make search work.

## Absent by design (T3)

| Absent | Why |
|---|---|
| Bulk or batch reveal | Mass disclosure behind a single approval |
| Reveal by search result set | Same thing, one indirection away |
| Any write to name / email / phone | Contact edits are a clienteling workflow, not an agent tool |
| Erasure without an open request | Removes the paper trail that justifies the destruction |
| Plaintext index or search column | Defeats the encryption entirely |
| Key export or unwrap-to-caller | Hands over the vault |

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Binding `identity` into a customer tool | Collapses the vault split | Separate tool, separate Access group |
| Decrypting then auditing | A crash loses the row that mattered most | Audit first, fail closed |
| Unkeyed hash for lookup | Low-entropy inputs enumerate in seconds | HMAC under a secret key |
| Caching unwrapped data keys | Turns a request-scoped secret into stored state | Memory, per request |
| `erase` for a manager "who needs it" | Irreversible destruction, wrong hands | Owner group only |
| Building this domain first | The audit and approval paths are unproven | Build it last |

## Conformance check

- [ ] `identity` sits behind its own Cloudflare Access policy, not the general staff one
- [ ] `reveal` takes exactly one id and a reason; both land in `audit` before the decrypt
- [ ] `erase` refuses without an open erasure request, and refuses for non-owners
- [ ] A test asserts the order table has no `email`, `phone`, `name` or `birth_year` column
- [ ] KEK rotation and backup are documented and exercised before first write
- [ ] No unwrapped key is written to any store or log
