# ADR-005 — One branch per Git data domain, one commit per agent session

**Status:** Proposed · **Date:** 2026-09-07 · **Extends:** ADR-001, ADR-002, ADR-003

## Decision

**The three non-personal Git domains each get an orphan branch, written one commit per agent
session, with bounded retention.** `data/catalog`, `data/knowledge`, `data/reports`. Nothing
else. Writes go through `tools/data-branch.sh`, never through a bare `git push --force`.

| | |
|---|---|
| Branches | `data/catalog`, `data/knowledge`, `data/reports` |
| Shape | Orphan — no merge base with `main`, no code, no history in common |
| Write unit | **One commit per agent session per branch** (not one per edit, not one total) |
| Retention | Reroot past **200 commits or 180 days**, whichever comes first |
| Push | `--force-with-lease` against the value *this clone fetched*. Never `--force` |
| Not branched | customers, identity, commerce, finance, people, audit — D1, per ADR-003 |

## 1. Which domains get a branch

Only the three that hold no personal data. The authority is not architectural taste, it is
**RULES.md, Data & Privacy: "No customer data, credentials, or internal-only info in any
committed file."** A branch is a committed file by another name.

The reason that rule is absolute here is the ADR-001 measurement: deleting 300 SKUs and
running `git gc --prune=now` left the repository **larger** (468 KB → 536 KB) with the deleted
content still retrievable. A branch does not change that; it multiplies it, because a branch is
one more ref keeping objects alive.

| Domain | Branch? | Why |
|---|---|---|
| catalog | **yes** | Products and prices. No PII. Diffs are the review artefact (R4.5) |
| knowledge | **yes** | Markdown reference library. No PII |
| reports | **yes** | Aggregates, sharded by period (ADR-003). No PII |
| customers, identity | **never** | Erasure obligation. Git cannot erase — measured |
| commerce, finance | **never** | Retained for tax, and holds order-level detail |
| people | **never** | Employee PII; tightest Access policy of the six (ADR-002) |
| audit | **never** | Append-only by construction; a branch is rewritable |

`tools/data-branch.sh` hard-codes the allowlist and exits 2 on anything else, so the guard
survives a careless argument rather than living in someone's head.

## 2. The request contains a contradiction

Two things have been asked for, and they cannot both be true:

- **"Collapse everything, push with no history."** (this request)
- **"Employees can update freely, nothing is destroyed, changes revert like a git commit."**
  (ADR-004 §2, and the reason `customer_version` exists at all)

Squash a branch to a single orphan commit and **there is nothing left to revert to.** The undo
button and the empty history are the same lever pulled in opposite directions.

**Resolution: the unit of compression is the session, not the branch.** An agent session that
touches one product forty times produces **one** commit. The next session produces the next
commit. Repeated edits to one entry never generate a million commits, and every session remains
a reviewable, revertible step.

Measured on a scratch repo with the tool as written:

| Input | Commits produced |
|---|---|
| 1 session × 6 edits | **1** |
| 5 sessions × 18 edits total | **5** |
| Re-run with no content change | **0** — refuses to write an empty commit |

Bounded retention keeps the branch from growing without limit: reroot past 200 commits or 180
days. **The retained window is the revert window.** Choose D from "how far back would we ever
want to undo a price change", not from disk usage — see §3.

**An honest note on the audit trail.** ADR-001 said "the history *is* the audit log" for catalog
changes (R4.6). Rerooting truncates it. That is acceptable only because ADR-002 gave the durable
record to the D1 `audit` store, which is insert-only and cannot be rewritten. Git history on a
data branch is the **reviewable diff**, not the system of record. If that ever stops being true,
this retention policy stops being safe.

## 3. Size is not the reason — say so plainly

The temptation is to justify squashing as "keeping the repo small". Per the ADR-001
measurements, that rationale is false at this scale:

| Measure | Result |
|---|---|
| 1,000 SKUs packed in Git | 468 KB |
| 100 agent commits (5,000 product edits) | 1.3 MB |
| Per agent commit | ~8 KB |

At ~8 KB a commit, a decade of daily agent work is a rounding error. **Commit volume is not a
size problem, and pretending it is would put a false premise in the architecture.**

The real reasons to squash are both about people reading the repo:

1. **Legibility.** "What did the agent change on Tuesday" should be one entry, not forty.
2. **Reviewable diffs.** A per-session diff is a unit a human can approve (R4.5). A per-keystroke
   diff is not, and a single all-time diff is not either.

Both are served by one commit per session. Neither is served by one commit total.

## 4. Force-push does not delete on GitHub

**This is the load-bearing warning of this ADR.** Squashing and force-pushing are a **tidiness**
mechanism. They are not, in any sense, a privacy or removal mechanism.

Verified directly against a remote, using the tool's own reroot + force-with-lease path:

```
$ git rev-list --all | grep -c 927b38f          # unreachable from any branch
0
$ git cat-file -t 927b38f                       # ...and still there
commit
$ git show 927b38f:products/bone-tee.json       # ...and still readable
{"h":"bone-tee","v":2,"by":"B"}
```

The overwritten commit was gone from every branch and completely retrievable by SHA. Only an
explicit `git reflog expire --expire-unreachable=now --all && git gc --prune=now` removed it —
and:

- **You cannot run that on GitHub.** Unreachable objects stay served by SHA until GitHub's own
  maintenance decides otherwise; removing them requires asking GitHub Support.
- **A fork network is worse than permanent.** Objects in any repository of a fork network stay
  reachable from *every* repository in that network. A commit force-pushed away here is fetchable
  by SHA from a fork you do not control, and there is no operation you can perform that undoes it.
- **Every clone already has it.** Force-pushing recalls nothing from a laptop or a CI cache.

So: **anything that must be deletable must never reach a data branch in the first place.** That is
not a process rule, it is the only control that works. It is why §1 is an allowlist and why
customers live in D1 (ADR-003) behind envelope encryption (ADR-004) where a delete is a delete.

`data-branch.sh reroot` prints this warning on every run, on purpose.

## 5. Orphan branches do not build themselves

A data branch shares **no history with `main`**. A default `actions/checkout` at `fetch-depth: 1`
on `main` fetches none of it, and the storefront build will find no `catalog/` at all. The build
must ask for each branch explicitly:

```bash
git fetch --no-tags origin '+refs/heads/data/*:refs/remotes/origin/data/*'
```

Then materialise it, by either mechanism — both are implemented in the tool:

| Mechanism | Command | Use when |
|---|---|---|
| **Archive-assemble** | `data-branch.sh checkout catalog _site/catalog` | The build just needs the files. Same `git archive <ref> \| tar -x` pattern as the per-branch Pages staging build already in use |
| **Worktree** | `data-branch.sh checkout catalog .work/catalog --worktree` | Something needs a real repo at that path (a tool that shells out to git) |

`checkout` falls back to `refs/remotes/origin/data/<domain>` when no local branch exists, so a
fresh CI clone works without a `git checkout -b` dance. Verified: a clone with zero local `data/*`
branches materialised the catalog tree correctly.

Two consequences worth stating: **`index.json` is still derived, never committed** (ADR-003) — a
branch does not change that; and **`catalog/` should be gitignored on `main`**, or the same files
exist twice with two divergent copies and one source of truth becomes two.

## 6. Concurrency: two sessions will clobber each other

Two agent sessions force-pushing one data branch is the default failure of this design, not an
edge case. Three rules, all enforced by the tool:

1. **`--force-with-lease`, leased against what this clone fetched.** Never bare `--force`.
2. **The lease value must not be read from the remote at push time.** Computing
   `--force-with-lease=<ref>:$(git ls-remote …)` leases against the value you just read — it is
   `--force` with extra steps and it will happily discard the other session's commit. The lease
   base is `refs/remotes/<remote>/data/<domain>`, updated only by an explicit fetch.
3. **One writer per branch at a time.** The tool takes a per-domain lock and fails loudly rather
   than queueing behind an unknown writer.

There is a fourth failure that only shows up in a fresh clone: committing to a data branch that
exists on the remote but not locally used to start a *new root*, which then force-pushes over
everyone. The tool now **adopts** `refs/remotes/origin/data/<domain>` as the parent instead.

Verified end to end — session A seeds, session B commits and pushes, session A then pushes stale:

```
data/catalog: adopted origin/data/catalog (9fe3e2f) as the base.        # B, not a new root
data-branch.sh: error: data/catalog moved on origin since this session fetched it
  (fetched 9fe3e2f…, remote is now 927b38f…).
  Another session wrote this data branch. Serialise the writers, fetch and
  reconcile — do NOT retry with --force, that is how one session's work disappears.
```

A's push was refused and B's commit survived on the remote.

## 7. The tool

`tools/data-branch.sh` — POSIX shell, no dependencies beyond git and tar.

```
data-branch.sh commit   <domain> <message>    fold this session's edits into ONE commit
data-branch.sh reroot   <domain> [--max-commits N] [--max-age-days D]
data-branch.sh checkout <domain> <path> [--worktree] [--force]
data-branch.sh push     <domain>              force-with-lease, leased on the fetched value
data-branch.sh status   <domain>
data-branch.sh session-new
```

Two implementation choices worth recording:

- **It never touches your index or `HEAD`.** The tree is built in a scratch index and written with
  `commit-tree` + `update-ref`. An agent can write a data branch mid-task without disturbing the
  working tree it is standing in.
- **Every ref move is a compare-and-swap.** `git update-ref <ref> <new> <old>` fails if the branch
  moved underneath, so a concurrent local write aborts instead of winning silently.

Retention runs as `reroot --max-commits 200 --max-age-days 180`; inside the bounds it is a no-op
and prints why, so it is safe on a schedule.

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Squashing or force-pushing to remove data | Unreachable ≠ gone: retrievable by SHA, forever in a fork network | Never let it in — personal data goes to D1 (ADR-003) |
| A `data/customers` branch | Erasure is impossible in Git — measured, ADR-001 | D1 + envelope encryption (ADR-004) |
| One commit total per branch | Nothing left to revert to; contradicts ADR-004 §2 | One commit **per session**, bounded retention |
| "We squash to keep the repo small" | 100 commits = 1.3 MB; the premise is false | Squash for legible, reviewable diffs — say that |
| `git push --force` | Drops another session's commits silently | `--force-with-lease` on the fetched value |
| `--force-with-lease=<ref>:$(git ls-remote …)` | Leases against the value just read — a force in disguise | Lease on `refs/remotes/<remote>/<branch>` |
| Committing when the branch exists only on the remote | Starts a new root that force-pushes over everyone | Adopt the remote-tracking ref as parent |
| Building from `main` and expecting `catalog/` | Orphan branch shares no history | Explicit `git fetch '+refs/heads/data/*:…'` then checkout |
| Rerooting to shorten an audit trail | The audit record is the D1 `audit` store, not git history | Reroot for legibility only; audit stays insert-only |
| Committing `index.json` on a data branch | Every write rewrites it; every concurrent write conflicts (ADR-003) | Derive it at build time |

## Consequences

- **`main` no longer carries the data directories.** They must be gitignored there, and a
  contributor cloning `main` sees no catalog until they fetch its branch.
- **No PR gate on a data branch by default.** ADR-001 leaned on the PR as the R4.5 approval gate;
  an agent pushing straight to `data/catalog` bypasses it. Either open PRs *between* data branches
  (`data/catalog-draft` → `data/catalog`) or accept that approval moved to the agent's own
  session boundary. **This needs deciding before agents get write credentials.**
- **A reroot invalidates every existing clone of that branch.** Consumers re-fetch with
  `--force` locally or re-clone; nothing merges cleanly across a reroot.
- **Retention is a scheduled job, not a habit.** If nobody runs `reroot`, branches grow — harmless
  for size, corrosive for legibility.
- **Bisect across a reroot is gone.** Acceptable for data; it would not be for code.

## Alternatives rejected

- **Everything on `main` with squash-merges.** Loses per-domain isolation and puts data churn in
  the code history. The branch boundary is what makes "catalog only" a fetchable thing.
- **One commit total, no history.** Directly contradicts the reversibility requirement. §2.
- **A commit per edit, tidied later.** "Later" never arrives, and the tidying is the same
  force-push with the same warning attached.
- **Tags for retention instead of rerooting.** A tag pins the objects it names, which is the exact
  opposite of what retention is for.
- **Branch per entry.** 1,000 branches, no reviewable unit, no gain.
