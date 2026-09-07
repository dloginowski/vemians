---
name: catalog-skills
description: "Use when an agent tool reads or changes products, variants, prices, collections or catalog content — the Git-backed shard store, search against the derived index, PR-only edits, and the two-gate treatment of price and publish."
version: 1.0.0
tags: [catalog, git, products, pricing, agents, tools]
---

# Catalog skills — every edit is a pull request

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Building or reviewing a `catalog.*` tool
- An agent needs to change a price, a product, or a collection
- Something wants to write `index.json`
- Deciding whether a catalog change needs approval as well as review

## Bindings

| Store | Kind | Why this one |
|---|---|---|
| `catalog` | Git, JSON shards — one file per product | Diffs, review, revert for free (ADR-001, ADR-003) |
| derived index | Build artefact | Read path for search. **Never committed** |

No D1 bindings. Catalog tools cannot see orders, customers or finance.

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `catalog.search` | T0 | Reads the derived index | — |
| `catalog.get` | T0 | One product shard | — |
| `catalog.draft_edit` | T1 | Opens a PR against one shard | Close the PR |
| `catalog.set_price` | **T2** | PR **and** approval — prices are money | Revert the commit |
| `catalog.publish` | T2 | Flips status to `active` | Revert the commit |

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
6. **Shopify is a projection.** Catalog tools write to Git only. The push to the sales
   channel is a separate pipeline; a tool that writes to both has two sources of truth.

## Absent by design (T3)

| Absent | Why |
|---|---|
| Direct commit to `main` | Removes the review that is the entire safety model |
| Bulk / percentage price change | One approval covering unbounded money |
| Product deletion | Discontinue by status; Git keeps the history regardless |
| Index write | Derived data is not writable — rebuild it |
| Writing to the sales channel | Projection is one-way, and not the agent's job |

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| `catalog.set_price` at T1 | A merge is the whole action | PR + in-session approval |
| Editing several shards per PR | Unreviewable diff, coarse revert | One shard, one PR |
| Committing `index.json` | Guaranteed conflict on concurrent PRs | Build at deploy |
| Writing back from search results | Stale, provenance-free | Re-read the shard |
| A `catalog.delete` tool | No undo, and the data survives in history anyway | Status transition |

## Conformance check

- [ ] Every write tool opens a PR; none pushes to `main`
- [ ] `set_price` refuses without both a PR and an in-session approval by a manager or owner
- [ ] The index is `.gitignore`d and rebuilt in CI
- [ ] No catalog tool holds a D1 binding
- [ ] A revert of any agent PR restores the previous shard byte for byte
