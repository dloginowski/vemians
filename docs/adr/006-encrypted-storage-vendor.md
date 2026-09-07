# ADR-006 — Where the encrypted customer store lives

**Status:** Proposed · **Date:** 2026-09-07 · **Extends:** ADR-004

## Decision

**Cloudflare D1 for the data, AWS KMS for the keys.** No managed PII vault yet.

## Why not a data privacy vault

Skyflow and similar vaults are the purpose-built product for this, and they are the right
answer at a certain size.
[Skyflow is quote-based with no free tier](https://www.saasworthy.com/product/skyflow-pii-data-privacy-vault/pricing) —
enterprise contracting for a store with a few thousand customers. Basis Theory publishes
pricing and is the more proportionate option of the two if we go managed.

But a vault mostly sells **outsourced compliance surface**, and we do not have the thing that
makes that worth paying for: we are not touching card data (checkout is rented — ADR-001), so
we are not in PCI scope. What we hold is contact details, birth year and fit measurements.
Envelope encryption covers that.

## What we are actually buying with KMS

Per ADR-004 the control that matters is **keys and data under different providers**, so neither
alone can read a record. AWS KMS delivers that for roughly the price of a coffee:

| Item | Cost |
|---|---|
| 1 KEK | $1 / month |
| Decrypt calls | $0.03 / 10,000 |
| Per-customer DEKs | free — wrapped, stored in D1 |

Call it **$1–5/month**, against a vault's quote-based contract. Unwrapped data keys are cached
in memory per request and never persisted, so KMS is not on the hot path for every read.

## Reconsider a managed vault when

- We take payments directly rather than through a provider's checkout (PCI scope arrives).
- A partner or auditor names one as a requirement.
- Customer count reaches a scale where key management is a job rather than a config file.

None of those is true today. Revisit rather than pre-buy.

## Non-negotiable before the first customer record

**KEK backup and rotation policy must exist first.** Losing the KEK loses every customer
identity irrecoverably — there is no support ticket that recovers it. `kek_id` on
`customer_identity` already tracks which KEK version wrapped each record, so rotation re-wraps
data keys without re-encrypting customer data.

## Anti-patterns

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Keys stored beside the data | One breach reads everything | Keys in a different provider |
| One shared key for all customers | Cannot crypto-shred a single person | Per-customer DEK, wrapped |
| KMS call on every field read | Cost and latency for nothing | Unwrap once per request, cache in memory |
| Buying a vault "for compliance" | Cost without a named requirement | Wait for the requirement |
| No KEK backup | Silent total loss, unrecoverable | Policy written before first write |
