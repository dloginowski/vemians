# ADR-003 — Index + shard layout, and where customer data lives

**Status:** Proposed · **Date:** 2026-09-07 · **Extends:** ADR-001, ADR-002

## 1. Index + shard layout — adopted for the Git stores

One file per entity, with an index. Correct, and for the reason given: a single large JSON
bloats, conflicts on every edit, and forces a full rewrite to change one field.

```
catalog/
  products/
    bone-tee.json          <- one product, one file, one PR diff
    shearling-jacket.json
  collections/
    new-season.json
knowledge/
  fitting/measuring-guide.md
reports/
  2026-Q3.json             <- quarterly reports shard naturally by period
```

**The index is derived, never committed.** This is the part that is easy to get wrong: if
`index.json` is a tracked file, every product change rewrites it, and two concurrent agent
PRs conflict *every single time*. Build it from the shards at build time instead. It is a
cache, not a source. At 1,000 SKUs it is roughly 150 KB and takes ~50 ms to assemble
(measured in ADR-001), so there is nothing to gain by storing it.

Rule: **one writer per file.** A field that two workflows both update does not belong in a
shard — it belongs in a database.

## 2. Customer data does not go in Git

The pattern above is right for products, knowledge and reports. It is wrong for customers,
and the reason is not stylistic.

**Deleting a shard does not delete the data.** Measured in ADR-001: removing 300 SKUs and
running `git gc --prune=now` left the repository *larger* (468 KB → 536 KB), with the removed
content still retrievable from history.

For a discontinued product that is harmless. For the fields proposed here — name, phone,
age, **body measurements**, purchase history — it means:

- **Erasure requests cannot be honoured.** GDPR Art. 17 and CCPA give a right to deletion.
  Removing the file does not remove the data, and rewriting history breaks every clone and
  is impossible once forked or mirrored.
- **Every clone is a complete copy**, including history — every laptop, CI runner and fork.
  Revoking repository access recalls none of them.
- **Access is all-or-nothing.** Repository access means every customer and every past
  version. There is no scoping to one store or one region.
- **A static build publishes the repository's contents.** Customer shards sitting beside
  product shards in the same pipeline is one misconfigured glob away from publication.

So: **customers get a D1 store, keeping the same one-record-per-entity shape.** Nothing about
the mental model changes; the deletes become real.

## 3. Why customers are separate from `commerce`

Erasure and tax retention pull in opposite directions. The profile must be destroyable on
request; the order record must be **retained** for tax regardless of that request.

Splitting them resolves it. Erasing a customer deletes the row in `customers`; orders keep a
`customer_id` that now points at nothing, and carry no PII of their own. The financial record
survives, de-identified.

Verified in `platform/db/verify.py`:

- erasing a profile cascades to fit data and consent,
- the order survives the erasure,
- the `order` table is asserted to contain no `email`, `phone`, `name` or `birth_year` column.

That last check is a test, so the guarantee cannot quietly rot when someone adds a column.

## 4. Data minimisation on the specific fields

| Proposed | Stored as | Why |
|---|---|---|
| Age | `birth_year` | Enough for segmentation, materially less identifying than a full DOB, and it does not go stale |
| Phone, name, email | As given | Contact. Necessary |
| Fitting sizes | Separate `customer_fit` table | Intimate data. Separable so tools can bind to contact details without it, and it can be dropped independently |
| Purchase history | **Not duplicated** — derived from `commerce` by `customer_id` | Two copies means two things to erase and two to disagree |
| Price history | **Already exists twice over** | Catalog price history is Git history; price *paid* is the `unit_price_minor` snapshot on the order line |

Consent is recorded per purpose with a timestamp and source (`customer_consent`), because
"we have their data" and "we may profile them with it" are different questions and a
regulator asks about the second.

If any customer may be under 16, parental-consent rules apply and `birth_year` is doing real
work — flagging this now rather than after collection begins.

## 5. POS integration

**No schema change required**, which is the commerce port (ADR-001) doing its job. A POS is
another sales channel: orders arrive as `channel = 'pos'` with an `external_id`, through a
`PosAdapter` implementing the same interface as Shopify. Verified in `verify.py`.

Two constraints when the POS is chosen:

- **Never store card data.** Take the POS's token and last four digits only. Storing a PAN
  puts the whole platform in PCI scope, and there is no reason to.
- **Match customers on a stable key** the POS actually returns — usually email or phone.
  Decide the matching rule before import, because retroactively merging duplicate customer
  records is genuinely unpleasant.

Worth asking any POS vendor before committing: does the API expose historical transactions,
or only a live feed from integration onward? That answer decides whether purchase history is
backfillable, and it is not always yes.

## 6. Resulting stores

| Store | Kind | Erasable | Holds |
|---|---|---|---|
| catalog | Git JSON | n/a | Products, collections, content |
| knowledge | Git MD | n/a | Reference library |
| reports | Git JSON | n/a | Quarterly reports, sharded by period |
| **customers** | **D1** | **yes** | Profile, contact, fit, consent |
| commerce | D1 | retained | Orders, lines, inventory — no PII |
| people | D1 | yes | Employees, shifts |
| finance | D1 | retained (tax) | Expenses, budgets |
| audit | D1 | never | Append-only agent record |
