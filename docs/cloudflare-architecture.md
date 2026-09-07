# Vemians — Cloudflare architecture

Goal: an online store whose **operations run through an agentic control plane** on a
subdomain, where Shopify is one replaceable sales channel rather than the system of record.

Status: proposed design. Nothing here is provisioned yet.

---

## 1. The load-bearing constraint

**Shopify storefronts cannot be proxied through Cloudflare.** Cloudflare's orange-cloud
proxy interferes with Shopify's TLS certificate provisioning and can break at any time as
either side changes. Shopify's own tooling detects it and errors with *"Your domain has a
Cloudflare Proxy, which is not supported by Shopify."*

This is not a reason to avoid Cloudflare. It only means the zone is **split**:

- storefront records → **DNS only** (grey cloud), Shopify terminates TLS
- everything we own → **proxied** (orange cloud), full Cloudflare feature set

## 2. DNS layout

Zone `vemians.com` on Cloudflare nameservers.

| Type  | Name | Value                  | Proxy      | Purpose            |
|-------|------|------------------------|------------|--------------------|
| A     | `@`  | `23.227.38.65`         | DNS only   | Shopify storefront |
| CNAME | `www`| `shops.myshopify.com`  | DNS only   | Shopify storefront |
| —     | `ops`| Workers Custom Domain  | Proxied    | Agentic control plane |

`ops` is not added by hand — declare it as a Workers Custom Domain in `wrangler.toml` and
Cloudflare creates and manages the proxied record.

Verify before trusting it:

```sh
dig +short vemians.com A          # expect 23.227.38.65
dig +short www.vemians.com CNAME  # expect shops.myshopify.com
```

If either resolves to a Cloudflare anycast IP (104.x / 172.67.x), the proxy is still on and
Shopify TLS will fail. DNS changes can take up to 48h to settle.

## 3. Control plane — `ops.vemians.com`

A single Cloudflare Worker, fronted by **Cloudflare Access** (Zero Trust). Access handles
employee SSO — Google or email OTP — before a request reaches the Worker. That removes the
entire auth surface from our code, which is the highest-leverage decision in this design.
Free for small teams; confirm the current user limit against Cloudflare's pricing page.

**Runtime**
- **Agents SDK** (`agents`) — stateful conversational agent, one Durable Object per session.
  Durable Objects are the right primitive here precisely because the agent *does* hold state.
- **`createMcpHandler`** — tools exposed as MCP servers. This is the current pattern; the
  older Durable-Object-backed `McpAgent` is deprecated and feature-frozen. Tools are
  request-scoped and stateless, so they scale independently of session state.
- **Model** — Anthropic API (Claude) for the reasoning loop. Tool-use quality is the whole
  product here, so this is not the place to economise.

**Storage**
- **D1** — employees, shifts, schedule, order mirror, ledger mirror, audit log.
- **R2** — receipts, invoices, contracts, exports.
- **Durable Objects** — session state, plus one coordinator DO holding the schedule lock so
  two concurrent agent runs cannot double-book a shift.
- **Queues** — async fan-out (order sync, notifications).
- **Workflows** — durable multi-step processes with retries and resumption. Correct primitive
  for anything that must not half-complete: employee onboarding, month-end close.
- **Cron Triggers** — nightly reconciliation jobs.

Cost is roughly Workers Paid ($5/mo, covers Workers + DO + Queues + Workflows) plus
generous D1/R2 free tiers, plus Anthropic API usage. The model calls will dominate.

## 4. Keeping Shopify replaceable

This is the part that answers *"Shopify is just a sales channel but I'm not sure I like them."*

Define a **commerce port** — a narrow interface the control plane talks to:

```
listOrders · getOrder · listProducts · updateInventory · getPayouts
```

`ShopifyAdapter` implements it against the Shopify Admin GraphQL API. Shopify's official
**AI Toolkit** (open-sourced April 2026, MIT) ships MCP servers that cover the read-heavy
side well; writes work but need deliberate API scopes.

Two rules make the swap cheap later:

1. **Shopify types never leak past the adapter.** The agent's tools speak our vocabulary.
2. **Shopify GIDs are never primary keys.** D1 rows carry our own IDs plus an
   `external_ref` column.

Swapping to Medusa, Swell, or a custom storefront then costs one adapter plus a backfill,
not a rewrite — the control plane, the schedule, the employee records and the audit history
all stay put.

One honest caveat: **checkout and payments are the expensive part to leave**, not the
catalog. Budget the migration around that, not around product data.

## 5. Domain-by-domain, and where to stop building

| Domain | Build it? | Approach |
|---|---|---|
| Shopify ops | Integrate | Official Shopify MCP servers behind the commerce port |
| Scheduling | **Build** | D1 + coordinator DO. Genuinely ours; no vendor lock-in worth paying for |
| Finances | **Mirror only** | Read-only sync into D1 for the agent to reason over. Books of record stay in Xero/QuickBooks |
| Employees | Split | Scheduling and documents ours; **payroll via Gusto/Deel** |

Do not build a ledger of record. Tax and audit obligations need a real accounting system,
and an agent writing directly into one is not a position to be in. Mirror for reasoning,
write through the accounting vendor's API for anything that counts.

Likewise, employment records are sensitive PII. Encrypt at rest in D1 and gate them behind
a dedicated Cloudflare Access group, not the general employee login.

## 6. Guardrails

Non-negotiable before any write tool is enabled:

- **Two-tier tools.** Reads run automatically. Writes — refunds, price changes, publishing,
  anything touching payroll — go through a human approval gate. The Agents SDK supports
  human-in-the-loop confirmation directly.
- **Append-only audit log** in D1: actor, tool, arguments, result, timestamp. Every agent
  action, no exceptions. This is what makes the system defensible after an incident.
- **Scoped credentials.** Separate Shopify custom-app tokens for read and write paths, held
  in Workers Secrets. Never one token with full Admin scope.
- **Caps.** Rate and monetary limits on write tools, enforced in the tool layer rather than
  trusted to the prompt.

## 7. Repository layout

This repo (`vemians`) is a fork of Shopify's **Dawn** theme — it is the storefront
presentation layer and should stay that. The control plane belongs in a **separate repo**
with its own `wrangler.toml` and deploy pipeline; its lifecycle, dependencies and blast
radius have nothing in common with a Liquid theme.

## 8. Order of work

1. Move `vemians.com` to Cloudflare nameservers; add the two storefront records **DNS only**.
2. Confirm Shopify issues its TLS certificate and the storefront serves cleanly.
3. Stand up the control-plane repo: Worker + Access on `ops.vemians.com`, auth only, no tools.
4. Add D1 schema and the audit log **before** the first tool.
5. Add read-only Shopify tools behind the commerce port.
6. Add scheduling (D1 + coordinator DO).
7. Add write tools, each one behind the approval gate.
8. Finance and payroll integrations last — they carry the most risk and the least novelty.

## References

- [Shopify — troubleshooting connected domains](https://help.shopify.com/en/manual/domains/troubleshoot-issues-with-domains)
- [Shopify/hydrogen — Cloudflare Proxy not supported](https://github.com/Shopify/hydrogen/discussions/1180)
- [Cloudflare Agents SDK](https://github.com/cloudflare/agents)
- [Cloudflare — the next generation of MCP](https://blog.cloudflare.com/mcp-v2/)
- [Cloudflare — McpAgent API docs](https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/)
