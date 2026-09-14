---
name: catalog-skills
description: "Use when an agent tool reads or changes products, variants, prices, collections or catalog content — the Git-backed editorial shards, the provider-authoritative commercial facts, agentic authoring from a photo and a sentence, the closed category set, and the two-gate treatment of price and publish."
version: 1.1.0
tags: [catalog, git, products, pricing, agents, tools]
---

# Catalog skills — every edit is a pull request

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Building or reviewing a `catalog.*` tool
- An agent needs to change a price, a product, or a collection
- Staff want to create a product by describing it and sending photographs
- Anything wants to create a CATEGORY
- Something wants to write `index.json`
- Deciding whether a catalog change needs approval as well as review

## Bindings

| Store | Kind | Why this one |
|---|---|---|
| `catalog` | Git, JSON shards — one file per product | Editorial copy: diffs, review, revert for free (ADR-001, ADR-003) |
| derived index | Build artefact | Read path for search. **Never committed** |
| `catalog_mirror` | D1, **read only, with one named exception** | Our copy of the provider's authoritative catalog (ADR-009): the closed category set, the price band, a product by handle. The exception is `channel` — see Rule 6 |
| `media` | R2 | Photographic originals. **Ours**, authoritative; the provider gets a copy |
| the provider | Square, **write** | Where a commercial fact is written. Declared as a resource, not a store |

No customer, order, people or finance binding. A catalog tool cannot see any of them.

**The mirror is READ.** A catalog write goes to the provider and the mirror follows by sync
and webhook, because the till writes there too — two writers into one copy diverge silently,
and ours is the copy that is wrong.

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `catalog.search` | T0 | Reads the derived index | — |
| `catalog.get` | T0 | One product shard | — |
| `catalog.draft_edit` | T1 | Opens a PR against one shard | Close the PR |
| `catalog.set_price` | **T2** | PR **and** approval — prices are money | Revert the commit |
| `catalog.publish` | T2 | Flips status to `active` | Revert the commit |
| `catalog.categories` | T0 | The categories that **already exist**. A closed set | — |
| `catalog.upload_image` | T1 | An original into R2; returns our key. Inline base64 is capped — a phone photo needs the signed upload link | Never referenced until a T2 attaches it |
| `catalog.draft_product` | T1 | A complete proposal and a diff, from a description and photographs. Writes nothing | — |
| `catalog.create_product` | **T2** | ITEM + ITEM_VARIATIONs at the provider, images, then the mirror sync | Withdraw at the provider; nothing is deleted |
| `catalog.update_product` | **T2** | The same path for an edit | Another edit |
| `catalog.create_category` | **T2** | Rarely right. Refuses a near-duplicate | Withdraw at the provider |
| `catalog.set_channel` | **T2** | Whether a product is ALSO browsable in the grid — `website` or `direct_link` (every product already has a working page). **Ours, not the provider's**: writes `catalog_mirror` directly and calls the provider for nothing, because the provider has no notion of our storefront to diverge from | Another `catalog.set_channel` call |
| `catalog.product` | T0 | Read one real product from the mirror by handle — title, variations, channel, and `custom_fields`. The read path a person's ordinary question ("what's the cost on X?") and `catalog.set_custom_fields` alike depend on | — |
| `catalog.set_custom_fields` | **T2** | Add, update or remove OUR OWN extra fields on a product by handle — whatever we track that the provider has no field for at all (unit cost, a vendor, anything else). A patch: a key set to `""` removes it, every key not mentioned is untouched. **Ours, not the provider's**, same as `set_channel` | Another `catalog.set_custom_fields` call, patching the previous values back |

**Undo path:** revert the commit. Nothing in this domain is overwritten in place, so the
previous state is always one `git revert` away, and the revert is itself reviewable.

## Rules

1. **One shard per PR.** A tool that edits two products in one branch produces a diff no
   reviewer reads and a revert that takes both back.
2. **The index is derived, never committed.** If it were tracked, every product change would
   rewrite it and two concurrent agent PRs would conflict every single time. Build it from
   the shards; it is a cache, not a source.
3. **One writer per file.** A field two workflows both update does not belong in a shard —
   it belongs in a database.
4. **Price is the exception that earns both gates.** `set_price` is a proposal *and* an
   approval, because a merged PR and a wrong number are the same event.
5. **Search reads the index; writes read the shard.** Never edit from an index record — it
   may be stale, and it carries no provenance.
6. **Editorial in Git, commercial facts at the provider.** ADR-009 reversed the original
   direction, and only for the second half: copy, imagery selection, ordering and collections
   stay in Git and stay reviewable, while price, SKU, variations and existence are written to
   the provider, because the till writes them without asking us. An agent tool that wrote a
   product row into our own mirror would be the second writer into one copy of that — **for a
   fact the provider has.** `channel` (whether a product is ALSO browsable on the storefront:
   `website` / `direct_link`) is not one — the provider has no notion of our storefront at all,
   so there is no second writer for `catalog.set_channel` to diverge from. Neither is `custom_fields` (unit
   cost, a vendor, anything else "we need more data tracking than the provider offers" — the
   owner's own words): the provider has no field for a fact we invented, so `catalog.
   set_custom_fields` and `catalog.create_product`'s own optional `custom_fields` argument write
   it directly too. Both are the named exceptions, and the sync job itself never names either
   column in its own writes, on purpose, so a value set here survives every future sync untouched.
7. **The category comes from a closed set.** Authoring picks from the categories that already
   exist, and the pick arrives as a suggestion with its reasoning rather than as a silent
   assignment. Creating a category is a separate, gated action. A model that may mint one will
   mint one, and a month of that leaves "Coats", "Outerwear", "Jackets" and "Coats & Jackets"
   side by side with no human having decided it (Test-PRD-P0-40-closed_category_set).
8. **Refuse before the provider does.** A zero or absurd price, a missing variation, an empty
   or 300-character title — refused here, with a message that says what to do instead.
   Forwarding a bad write so the provider can bounce it turns our validation into their error
   string, and the refusal arrives after the approval was already spent.
9. **The original is ours, when we hold a copy at all.** With an R2 bucket bound, photographs
   go there under our key first and the provider gets a copy so the item looks right on the
   till, and a format the provider will not take is still stored — losing the provider must not
   lose our photography. **ADR-013 changed the default**: with no bucket bound, there is no R2
   leg at all and the provider holds the only copy of the photograph — `mediaStoreFor(env)`
   (`ops/src/tools/index.js`) picks between the two stores and announces which at INFO, and the
   exit plan is to export from the provider before leaving rather than to keep a mirror as you
   go.
10. **Ask only what is genuinely a choice** (Test-PRD-P0-84-efficient_drafting). What it is, the
    price, and — only if the item truly has them — its sizes or colors. Everything else is
    either fixed or the model's own job to produce: `currency` is always `"USD"` (this shop has
    no other), a product with no real size/color options still needs one `variation` object
    (conventionally titled "One size"), and a `description` is written by the model from the
    title, category and photo rather than dictated by the person. This is enforced where it
    actually reaches the model on every call — `catalog.draft_product`'s and
    `catalog.create_product`'s own `describe` text — not only documented here, because P0-82
    made reading this skill on-demand rather than mandatory: a confident model may never open it.

## Absent by design (T3)

| Absent | Why |
|---|---|
| Direct commit to `main` | Removes the review that is the entire safety model |
| Bulk / percentage price change | One approval covering unbounded money |
| Product deletion | Discontinue by status; Git keeps the history regardless |
| Index write | Derived data is not writable — rebuild it |
| Writing a **provider-sourced** fact into `catalog_mirror` (price, SKU, title, existence, …) | Two writers into one copy of the provider's catalog; the till wins and we are silently wrong. `channel` and `custom_fields` are the named exceptions — see Rule 6 |
| Category creation as a side effect of authoring | How a navigation dies: forty near-duplicates and no decision behind any of them |
| Bulk product creation | One approval covering an unbounded number of new commercial facts |
| Deleting a stored original | A photograph is evidence of what was sold; withdraw the product instead |

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| `catalog.set_price` at T1 | A merge is the whole action | PR + in-session approval |
| Editing several shards per PR | Unreviewable diff, coarse revert | One shard, one PR |
| Committing `index.json` | Guaranteed conflict on concurrent PRs | Build at deploy |
| Writing back from search results | Stale, provenance-free | Re-read the shard |
| A `catalog.delete` tool | No undo, and the data survives in history anyway | Status transition |
| An agent writing a provider-sourced fact into the mirror directly | Diverges from the provider silently, in the direction that oversells | Write the provider; the mirror follows by sync |
| Creating a category because none quite fits | Navigation stops meaning anything, one reasonable-looking decision at a time | Choose the nearest existing one, or ask a manager |
| Base64 bytes as a tool argument for a real photograph | The model would have to emit one to two million output tokens of it | Signed upload link the human opens |
| Storing an original only at the provider | Losing the provider loses the photography | R2 first, provider second |

## Conformance check

- [ ] Every write tool opens a PR; none pushes to `main`
- [ ] `set_price` refuses without both a PR and an in-session approval by a manager or owner
- [ ] The index is `.gitignore`d and rebuilt in CI
- [ ] No catalog tool holds a customer, order, people or finance binding
- [ ] No `INSERT`/`UPDATE` against a `mirror_*` table exists anywhere in the tool layer, for any
      column the provider itself supplies — `catalog.set_channel`'s `UPDATE mirror_product SET
      channel = ...` and `catalog.set_custom_fields`'/`catalog.create_product`'s own `UPDATE
      mirror_product SET custom_fields = ...` are the named exceptions and touch nothing else
- [ ] `create_product` refuses a category id outside the set the mirror holds
- [ ] Every stored original exists in R2 before the provider is called
- [ ] A revert of any agent PR restores the previous shard byte for byte
