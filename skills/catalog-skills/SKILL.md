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
| `catalog_mirror` | D1, **read only** | Our copy of the provider's authoritative catalog (ADR-009): the closed category set, the price band, a product by handle |
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
   product row into our own mirror would be the second writer into one copy of that.
7. **The category comes from a closed set.** Authoring picks from the categories that already
   exist, and the pick arrives as a suggestion with its reasoning rather than as a silent
   assignment. Creating a category is a separate, gated action. A model that may mint one will
   mint one, and a month of that leaves "Coats", "Outerwear", "Jackets" and "Coats & Jackets"
   side by side with no human having decided it (Test-PRD-P0-40-closed_category_set).
8. **Refuse before the provider does.** A zero or absurd price, a missing variation, an empty
   or 300-character title — refused here, with a message that says what to do instead.
   Forwarding a bad write so the provider can bounce it turns our validation into their error
   string, and the refusal arrives after the approval was already spent.
9. **The original is ours.** Photographs go to R2 under our key first; the provider gets a
   copy so the item looks right on the till. A format the provider will not take is still
   stored — losing the provider must not lose our photography.

## Absent by design (T3)

| Absent | Why |
|---|---|
| Direct commit to `main` | Removes the review that is the entire safety model |
| Bulk / percentage price change | One approval covering unbounded money |
| Product deletion | Discontinue by status; Git keeps the history regardless |
| Index write | Derived data is not writable — rebuild it |
| Writing a product row into `catalog_mirror` | Two writers into one copy of the provider's catalog; the till wins and we are silently wrong |
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
| An agent writing the mirror directly | Diverges from the provider silently, in the direction that oversells | Write the provider; the mirror follows by sync |
| Creating a category because none quite fits | Navigation stops meaning anything, one reasonable-looking decision at a time | Choose the nearest existing one, or ask a manager |
| Base64 bytes as a tool argument for a real photograph | The model would have to emit one to two million output tokens of it | Signed upload link the human opens |
| Storing an original only at the provider | Losing the provider loses the photography | R2 first, provider second |

## Conformance check

- [ ] Every write tool opens a PR; none pushes to `main`
- [ ] `set_price` refuses without both a PR and an in-session approval by a manager or owner
- [ ] The index is `.gitignore`d and rebuilt in CI
- [ ] No catalog tool holds a customer, order, people or finance binding
- [ ] No `INSERT`/`UPDATE` against a `mirror_*` table exists anywhere in the tool layer
- [ ] `create_product` refuses a category id outside the set the mirror holds
- [ ] Every stored original exists in R2 before the provider is called
- [ ] A revert of any agent PR restores the previous shard byte for byte
