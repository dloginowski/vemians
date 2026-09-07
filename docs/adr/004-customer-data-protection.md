# ADR-004 — Encryption, pseudonymisation, and reversible edits

**Status:** Proposed · **Date:** 2026-09-07 · **Extends:** ADR-003

## 1. The hash proposal — half right, and the wrong half matters

The instinct is sound and is now implemented: **direct identifiers live in one store, everything
else is keyed by an opaque id.** That is a recognised design (an identity vault), and it is the
right shape.

The mechanism does not work as proposed, for two reasons:

**Hashing is not anonymisation.** Under GDPR Recital 26, data that can be re-attributed using
additional information is still personal data. Since the entire point is that we keep the
mapping table, hashed records remain personal data and remain subject to erasure. Putting them
in immutable Git history therefore solves nothing.

**Hashes of low-entropy inputs are trivially reversed.** A phone number has ~10^10 possible
values — a laptop enumerates that in seconds. Names are far worse. An unsalted digest of a
phone number is not protection, it is the phone number with extra steps.

**So: encrypt, do not hash.** For fields that must still be *searchable* (matching a POS
customer by email), use an **HMAC under a secret key** rather than a bare digest. The keyed
construction resists dictionary attack; the unkeyed one does not.

## 2. What actually satisfies "reversible, non-destructive"

The requirement — employees can update freely, nothing is destroyed, changes revert like a
git commit — is a **property of the data model, not of the storage engine.**

Git gives reversibility by making history immutable, and that immutability is precisely what
forecloses erasure. An append-only change log gives the same reversibility *and* keeps deletion
possible:

- `customer_version` records every edit: field, old value, new value, actor, timestamp.
- Reverting appends a compensating row with `reverts` pointing at the original. Nothing is
  overwritten; the revert is itself part of the history.
- The log cannot be updated (trigger), so history cannot be quietly rewritten.
- It **can** be deleted, but only under an open erasure request — otherwise old values would
  survive the erasure of the record they belong to.

Verified in `verify.py`: an edit is recorded before it is applied, history cannot be rewritten,
a change reverts and the revert is recorded, deletion is refused without an erasure request and
permitted with one.

This is the answer to "I want git-like reversibility for customer data": you can have it,
without the immutability that makes erasure impossible.

## 3. Encryption and where to put it

### The recommendation

**Keep the data in D1. Move the keys to an external KMS.**

D1 already encrypts everything at rest with AES-256-GCM, but
[the keys are Cloudflare-managed with no customer-managed or external key option](https://developers.cloudflare.com/d1/reference/data-security/).
That protects against disk theft. It does not protect against a compromised Worker, an
over-broad query, a leaked backup, or a provider-side compromise.

What closes that gap is **application-level envelope encryption**:

```
  AWS KMS  ──wraps──►  per-customer data key  ──encrypts──►  name / email / phone
  (keys)                (stored wrapped in D1)                (ciphertext in D1)
```

Cloudflare holds ciphertext and wrapped keys. AWS holds the KEK. **Neither provider alone can
read a customer record.** Destroying a wrapped data key crypto-shreds that customer
irreversibly — a recognised erasure method, and the belt-and-braces answer for anything that
reached a backup.

### Why not simply move the database to AWS

Moving data to AWS while the keys travel with it buys much less than it appears to: one
provider still holds both halves. **Separating keys from data across a trust boundary is the
control that matters**, and it is cheaper than relocating the database.

Relocating also costs real things: a VPC and connection pooling for Workers to reach RDS,
cross-cloud latency on every read, and a second operational surface. For a store of this size
that is a poor trade.

| Option | Data | Keys | Neither-alone property | Complexity |
|---|---|---|---|---|
| D1 alone | Cloudflare | Cloudflare | No | Lowest |
| **D1 + AWS KMS (recommended)** | Cloudflare | **AWS** | **Yes** | Low |
| RDS + KMS | AWS | AWS | No | High |
| RDS + external HSM | AWS | Third party | Yes | Highest |

Start at row two. Row four is for when there is a compliance requirement naming it.

## 4. What the split buys, and its honest limit

`identity` holds name, email and phone as ciphertext. `customers` holds birth year, fit and
consent against an opaque id. `commerce`, `finance` and `people` hold no identifiers at all.

Most agent tools bind to `customers` and can read a profile **without ever seeing who it is**.
Only clienteling tools bind to `identity`. Erasure deletes one row and de-identifies the
customer everywhere at once.

**The limit, stated plainly:** deleting the identity row makes the remaining data
*pseudonymous*, not necessarily *anonymous*. At luxury scale, "bought this £9,000 coat on that
date, size IT 42, born 1985" may still identify one person. Do not treat the split as a licence
to retain profile data indefinitely — apply a retention period to `customers` as well.

Also: `customer.notes` is free text and will accumulate names if nobody stops it. Either treat
it as identifying data or encrypt it too.

## 5. Field-level decisions

| Field | Where | Protection |
|---|---|---|
| Name, email, phone | `identity` | Envelope-encrypted; HMAC handle for lookup |
| Birth year | `customers` | Plain — coarse by design (ADR-003) |
| Fit / measurements | `customers` | Plain, own table, own binding |
| Consent | `customers` | Plain — must be auditable |
| Purchase history | `commerce` | Derived by `customer_id`; never duplicated |
| Clienteling notes | `customers` | **Encrypt, or govern as identifying** |

## 6. Consequences

- A KMS dependency on the read path for identity lookups. Cache unwrapped data keys in memory
  per request; never persist them.
- Losing the KEK loses every customer identity. **KEK backup and rotation policy must exist
  before the first customer record is written.**
- Encrypted fields cannot be searched, sorted, or matched fuzzily. Exact-match lookup via HMAC
  is the only query available — which is why `email_hmac` and `phone_hmac` exist.
- Key rotation re-wraps data keys; it does not re-encrypt customer data. `kek_id` tracks which
  KEK version wrapped each record.
