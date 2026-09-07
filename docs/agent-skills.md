# Agent skill catalogue

The tool surface employees reach through `ops.vemians.com`. Identity comes from Google
Workspace via Cloudflare Access (**R1.1**); the verified email is the `actor` on every audit row.

Status: **specification.** No tool here is implemented yet.

---

## 1. Three rules that make this safe

**Scope is a binding, not an instruction.** Each skill declares which stores it may reach, and
the Worker binds only those. A knowledge tool *cannot* read finance — not because the prompt
says so, but because the binding does not exist. Prompt-level scoping fails under adversarial
input; binding-level scoping does not.

**Nothing destroys.** Every write is an append plus a pointer:

| Domain | Write mechanism | Undo |
|---|---|---|
| catalog, knowledge | Pull request | Revert the commit |
| customers | `customer_version` row, then apply | Append a compensating row |
| commerce, finance | Status transition | Reverse entry, never an edit |
| people | Shift row with status | Cancel, never delete |

There is no tool that deletes. The only exception is erasure, which is its own gated workflow.

**Tiers decide what needs a human.**

- **T0 read** — runs immediately. Audited.
- **T1 propose** — produces a diff or pull request. A human merges. This is where catalog and
  knowledge edits live, and it is the tier that gets the most use.
- **T2 approve** — executes only after in-session approval by someone holding the role. Prices,
  refunds, expense approval, publishing.
- **T3 absent** — not built. Payroll writes, bulk deletion, raw SQL, disabling the audit log.

## 2. Catalogue

### catalog · Git
| Skill | Tier | Notes |
|---|---|---|
| `catalog.search` | T0 | Reads the derived index |
| `catalog.get` | T0 | One product shard |
| `catalog.draft_edit` | T1 | Opens a PR against one shard |
| `catalog.set_price` | T2 | PR **and** approval — prices are money |
| `catalog.publish` | T2 | Flips status to `active` |

### customers · D1 `customers`
| Skill | Tier | Notes |
|---|---|---|
| `customer.profile` | T0 | Opaque id. **Returns no name** |
| `customer.fit` | T0 | Sizes; separate binding from contact details |
| `customer.update_fit` | T1 | Versioned; revertible |
| `customer.history` | T0 | Joined from `commerce` by id |
| `customer.revert` | T1 | Appends a compensating version row |

### identity · D1 `identity`
| Skill | Tier | Notes |
|---|---|---|
| `identity.lookup` | T0 | HMAC exact match only. **Separate Access group** |
| `identity.reveal` | T2 | Decrypts one record. Heavily audited — the most sensitive tool here |
| `identity.erase` | T2 | Crypto-shred + cascade. Owner only |

### commerce · D1 `commerce`
| Skill | Tier | Notes |
|---|---|---|
| `order.search` / `order.get` | T0 | |
| `inventory.check` | T0 | Live; never served from the static build |
| `inventory.adjust` | T2 | Reconciliation only |
| `order.refund` | **T3** | Absent. Issue refunds in the provider |

### people · D1 `people`
| Skill | Tier | Notes |
|---|---|---|
| `schedule.view` | T0 | Own shifts; managers see all |
| `schedule.draft` | T1 | Proposes a week; overlap refused by the database |
| `schedule.publish` | T2 | Manager only |
| `shift.swap` | T1 | Both employees confirm |

### finance · D1 `finance`
| Skill | Tier | Notes |
|---|---|---|
| `expense.submit` | T1 | Any employee; receipt to R2 |
| `expense.approve` | T2 | Manager. Approved expenses become immutable |
| `budget.status` | T0 | |
| `report.quarterly` | T1 | Writes a shard to `reports/` via PR |

### knowledge · Git + Vectorize
| Skill | Tier | Notes |
|---|---|---|
| `knowledge.search` | T0 | Semantic over the derived index |
| `knowledge.write` | T1 | PR against a Markdown shard |

## 3. Role → skill matrix

| | Staff | Manager | Owner |
|---|---|---|---|
| catalog read / propose | ✅ | ✅ | ✅ |
| catalog price / publish | — | ✅ | ✅ |
| customer profile, fit | ✅ | ✅ | ✅ |
| `identity.reveal` | — | ✅ | ✅ |
| `identity.erase` | — | — | ✅ |
| own schedule | ✅ | ✅ | ✅ |
| publish schedules | — | ✅ | ✅ |
| submit expenses | ✅ | ✅ | ✅ |
| approve expenses | — | ✅ | ✅ |
| audit log | — | — | ✅ |

Roles come from Google Workspace groups (**R1.3**). Nothing is assigned in the application.

## 4. Every tool, without exception

1. Writes an `audit` row before returning — including denials and errors.
2. Receives the Access identity as `actor`; it is never a parameter the agent can set.
3. Fails closed. An unavailable audit store means the write does not happen.
4. Enforces its own caps in code — never in the prompt.

## 5. Build order

`identity.reveal` and `catalog.set_price` are the two highest-risk tools and should be built
**last**, once the audit path and approval gate have been exercised by lower-risk ones.

1. Audit store + the write path — before any tool.
2. T0 reads across catalog, customers, commerce.
3. T1 proposals: catalog PRs, expense submission, fit updates.
4. Scheduling, including the overlap refusal end to end.
5. T2 gated writes.
6. `identity.reveal`, `identity.erase`.
