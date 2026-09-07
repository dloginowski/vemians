# Agent skills

The tool surface employees reach through `ops.vemians.com`. Identity comes from Google
Workspace via Cloudflare Access (**R1.1**); the verified email is the `actor` on every audit
row (**R1.4**). Roles derive from Workspace groups (**R1.3**) — nothing is assigned in the
application.

**Status: specification.** No tool here is implemented yet. Build order is in
[`agent-tool-contract`](./agent-tool-contract/SKILL.md).

## Index

| Skill | Covers | Stores bound |
|---|---|---|
| [`agent-tool-contract`](./agent-tool-contract/SKILL.md) | Tiers T0–T3, audit-before-return, `actor` from Access, fail closed, caps in code, role matrix, build order. **Every other skill inherits it** | `audit` |
| [`catalog-skills`](./catalog-skills/SKILL.md) | Products, variants, prices, collections. PR-only edits; price and publish are double-gated | `catalog` (Git) + derived index |
| [`customer-skills`](./customer-skills/SKILL.md) | Profiles, fit, consent, history against an opaque id. **Never returns a name** | `customers`, `customer_fit`, `commerce` (read) |
| [`identity-skills`](./identity-skills/SKILL.md) | The vault: HMAC lookup, audited decrypt, owner-only crypto-shred erasure. Highest risk; built last | `identity` (own Access group), external KMS, `audit` |
| [`commerce-skills`](./commerce-skills/SKILL.md) | Orders and live inventory. Reconciliation only; refunds stay in the provider | `commerce`, `catalog` (read) |
| [`people-skills`](./people-skills/SKILL.md) | Schedules and swaps. Overlap refused by the database; manager publishes | `people` |
| [`finance-skills`](./finance-skills/SKILL.md) | Expenses, budgets, quarterly reports. Approved expenses are immutable | `finance`, R2, `reports/` (Git) |
| [`knowledge-skills`](./knowledge-skills/SKILL.md) | The reference library. Git is truth, Vectorize is a cache | `knowledge` (Git), Vectorize |

## Three rules underneath all of them

**Scope is a binding, not an instruction.** Each skill declares the stores it may reach and
the Worker binds only those. A knowledge tool *cannot* read finance because the binding does
not exist. Prompt-level scoping fails under adversarial input; binding-level scoping does not.

**Nothing destroys.** Every write is an append plus a pointer — a pull request, a version
row, a status transition, a reversing entry. There is no tool that deletes. The one exception
is `identity.erase`, which is its own gated workflow.

**Tiers decide what needs a human.** T0 reads run immediately and are audited. T1 produces a
diff a human merges. T2 executes only after in-session approval by someone holding the role.
T3 is not built, and each skill names its own absences so nobody builds them by accident.

## Convention

One skill per directory, `skills/<name>/SKILL.md`, where `<name>` is kebab-case and matches
the `name:` field in the file's YAML frontmatter exactly. Frontmatter carries `name`,
`description` (written as a "Use when…" trigger sentence), `version` and `tags`. The body
runs in a fixed order — **Trigger**, core principle, **Bindings**, **Operations** (tool, tier,
undo), **Rules**, **Absent by design (T3)**, **Anti-patterns (NEVER)**, **Conformance
check** — so a reader looking for a tier or an undo path knows where to look without reading
the file. Skills are grouped by domain rather than one file per tool: guidance that is
genuinely shared lives in one place, and `agent-tool-contract` holds everything shared by all
of them. If a rule belongs in two skills, it belongs in the contract instead.
