# ADR-007 — The ops tools as a remote MCP server

**Status:** Proposed · **Date:** 2026-09-07 · **Depends on:** ADR-002, `skills/agent-tool-contract`

## Decision

`POST /mcp` on `ops.vemians.com` exposes the existing ops tools over the Model Context
Protocol, so staff drive them from whichever AI client they already use instead of only from
the browser chat.

| | |
|---|---|
| Endpoint | `POST https://ops.vemians.com/mcp`, stateless, one route |
| Library | `createMcpHandler` from `@modelcontextprotocol/server` v2 |
| Tools | `TOOLS` / `runTool` from `src/tools/` — the same layer the browser chat calls |
| Identity | Cloudflare Access assertion, per-user, machine identities refused |
| T0 read | Runs, audited, returns data |
| T1 propose | Runs, returns the diff, applies nothing |
| **T2 write** | **Returns an approval URL. Never executes in-band.** |
| T3 | Absent, as everywhere else |

## One tool layer, three consumers

The browser chat, this endpoint, and whatever automation comes next all call the same
`runTool()`. `src/mcp.js` holds no business logic, no store binding and no query: it is a
protocol adapter, and it is about two hundred lines because that is all an adapter is.

The alternative — an MCP implementation of each tool alongside the chat implementation — is
not a second copy of the *logic*, it is a second copy of the **guarantees**. The tier rules,
the caps, the actor derivation and the audit row all have to be reproduced, and the copy that
gets reproduced last is the one that forgets to audit. A tool is defined by the row it writes
before it returns, not by the function that returns.

So the boundary is: MCP owns the wire, `src/tools/` owns the behaviour, and a change to a
cap is one edit in one file that every client inherits at once.

## Why the approval never happens in the model's context

A T2 tool called over MCP returns a URL on `ops.vemians.com` and writes nothing. A human
opens it in a browser, passes Access again, and approves. Only that browser request mints an
approval token, and it spends it in the same request.

**This is structural, not a convention.** The context object that reaches `runTool()` from an
MCP call is built in one place, `mcpCtx()`, and it has no `approvalToken` key at all. Nothing
adds one and nothing reads one out of the arguments. `runTool` is handed a context with no
token, so the only answer it can give is `needsApproval` — the MCP path is a proposal path by
construction, not by discipline.

The version of this rule that is only a convention — *"don't forward `approvalToken` from tool
input"* — survives exactly until someone adds a passthrough for convenience, and nothing fails
when they do. Verified: a `tools/call` carrying `approvalToken` in its arguments, against a
tool whose schema accepts extra properties, still came back with an approval URL and still
changed nothing.

The reason is narrower than "humans should approve writes". A model that can reach both the
tool and the approval is one context window holding both halves of a two-party control, and
prompt injection then buys the write, not just the read. Putting the second half in a browser
under a separate Access assertion means the attacker needs a session it cannot reach from
inside the conversation it poisoned.

## Tools the caller cannot use are absent, not refused

`tools/list` is filtered by the caller's role before it is built. A staff member's list has
three tools in it; a manager's has five; the owner's has six.

A refused-but-listed tool is worse than an absent one twice over. The model sees the name, so
it tries, gets told no, and tries a neighbouring phrasing — the refusal is a hint, not a stop.
And the name itself leaks the shape of what the caller cannot reach: `identity.reveal` in a
staff member's tool list says the reveal exists and is one role away.

The floor comes from the tier and the domain, mirroring the role matrix in
`agent-tool-contract`: T2 is manager and up, `identity` is manager and up, `audit` is owner
only, T3 is nobody. A tool that declares its own `roles` overrides that.

## Identity: what we found, stated honestly

`actor` on an audit row has to name a person (P0-21, P0-23). That constraint decides how a
remote MCP client is allowed to authenticate, and it rules out the obvious answer.

| Path | What the origin sees | Verdict |
|---|---|---|
| **Access service token** (`CF-Access-Client-Id` / `-Secret`) | `common_name`, **no `email` claim** | **Rejected.** Names a machine |
| **Access managed OAuth** | The authorising human's assertion | The only acceptable path |

A service token is the easy way to get an MCP client through Access, and it would put one
robot name in the actor column for every action by every member of staff — an audit log that
records that *the platform* did something. That is not an audit log. So the endpoint refuses
any assertion with no `email` claim and says why, rather than falling back to `common_name`
the way the ops *page* reasonably does for a header line.

Managed OAuth is the answer, and it is dashboard configuration rather than code: Access
becomes the authorization server, an unauthenticated client gets a `WWW-Authenticate` pointing
at `/.well-known/oauth-authorization-server`, registers itself dynamically, and a human
authorises in a browser. The Worker's side of it is already written — it reads the same
`Cf-Access-Jwt-Assertion` either way.

Two things this endpoint does that the default would not:

- **The 401 carries `WWW-Authenticate: Bearer resource_metadata="…"`** and the Worker serves an
  RFC 9728 protected-resource document. Claude Code tolerates a bare 401 and probes the
  well-known path; the claude.ai connector does not, and fails before it ever shows a login
  screen (`anthropics/claude-ai-mcp#410`). One header is cheaper than that bug report.
- **No role, no session.** An identity in none of the mapped Access groups gets a 403, not an
  empty tool list.

**Unresolved, and not to be papered over.** Neither claim below has been verified against a
live Cloudflare tenant — there is no account attached to this work, and `developers.cloudflare.com`
is unreachable from the environment the endpoint was built in, so both rest on secondary
sources:

1. **The group claim shape.** The role is read from `groups`, then `custom.groups`. Which of
   those a real Access assertion carries has not been seen. It reads defensively and fails
   closed, but "fails closed" here means *nobody has a role*, so this must be confirmed
   against a captured assertion before the endpoint is announced.
2. **Whether managed OAuth forwards the authorising human's assertion on every later call**,
   or only at grant time. If it turns out the origin sees only the OAuth client and not the
   person, then per-user attribution is not achievable on this path, and the correct response
   is to leave the endpoint closed — **not** to fall back to a service token and write a
   machine name into `actor`.

Confirming both is a launch blocker for `/mcp`, not a follow-up.

## Why `createMcpHandler` and not `McpAgent`

`McpAgent` from the Cloudflare Agents SDK backs an MCP server with a Durable Object per
session. It is deprecated and feature-frozen; the stateless request-scoped handler replaced it.

The replacement also happens to be the right shape here regardless of deprecation. Our tools
hold no conversation state — every call is `actor` plus arguments plus an audit row — so a
per-session Durable Object would be a stateful object storing nothing, on the critical path of
every call, in a system whose stated boundary rule (ADR-002) is that state belongs in a named
store. `createMcpHandler` builds a fresh server per request, which is also what makes the
per-role tool list cheap: the list is built for the caller of *this* request and thrown away.

Confirmed against `@modelcontextprotocol/server@2.0.0`'s own types and driven with curl: one
handler serves both the 2026-07-28 per-request-envelope protocol and 2025-era Streamable HTTP
clients from the same factory, so the tool definitions cannot drift between protocol eras.

## Claude or ChatGPT is now a preference, not an architecture

Nothing above names a vendor. The endpoint speaks MCP; the tier rules, the caps, the role
filter and the audit row live under it and apply identically to every client. Someone who
prefers ChatGPT gets the same six tools, the same refusals and the same approval link as
someone who prefers Claude, and switching is a connector setting rather than a project.

The one concession made to a specific vendor is small and worth naming: MCP tolerates a dot in
a tool name, OpenAI's function-name grammar (`^[a-zA-Z0-9_-]{1,64}$`) does not, so
`catalog.set_price` goes out as `catalog_set_price`. That translation is in one function. It is
the shape of every accommodation we should be willing to make — a mapping at the edge, never a
branch in the tool.

## The cost, stated plainly

**A write cannot be completed from a terminal.** An MCP client in a headless session can
propose a T2 write and will get a URL back; finishing it needs a browser. That is not a
limitation to be engineered away later — it is the control.

**A second role-derivation site.** `src/mcp.js` maps Access groups to roles. The browser chat
has its own path to the same answer. Two sites, one truth, and the usual outcome: extract a
shared `roleFor()` the moment the second one is written, or they will disagree under an
edge case nobody tested.

**Approvals are not durable yet.** With no `APPROVALS` binding, pending intents live in a
per-isolate `Map` and an approval link dies with its isolate. The Worker logs a warning saying
so on every T2 call. Binding `APPROVALS` in `wrangler.toml` is a one-line change and a launch
requirement; the approvals page itself (`/approvals/:id`) is not built here — `approvePending()`
is exported and waiting for it.

**Two names for one tool.** The audit row says `catalog.set_price`, the wire says
`catalog_set_price`. Anyone grepping across the two needs to know that.

**Tools only.** No resources, no prompts, no server-initiated notifications. Add them when
something wants them, not before.

## Anti-patterns (NEVER)

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Reimplement the tools per client | Duplicates the guarantees, not just the code; the copy forgets to audit | One `runTool`, adapters at the edge |
| Accept `approvalToken` from tool arguments | The model is then holding both halves of a two-party control | Mint it in the browser request; never build a context that can carry it |
| Return the approval token in the tool result | A replayable token in the model's context is not an approval | Return a URL; the token never leaves the browser request |
| Authenticate the endpoint with an Access service token | `actor` becomes a robot name for every human action | Managed OAuth; refuse assertions with no `email` |
| Fall back to `common_name` when `email` is absent | Fabricates a person on the audit row | 403, and say why |
| List a tool the role cannot use and refuse the call | The refusal is a hint; the name leaks the surface | Absent from `tools/list` |
| Empty tool list for an unmapped identity | Looks like "no tools exist" and hides a misconfiguration | 403 with the reason |
| `McpAgent` / Durable Object per session | Deprecated, and stateful storage for zero state | `createMcpHandler`, request-scoped |
| Bare 401 with no `WWW-Authenticate` | claude.ai fails before showing a login screen | `Bearer resource_metadata="…"` + RFC 9728 document |
| Ship `/mcp` before a real assertion has been inspected | The role mapping is unverified; it fails closed, which means it fails shut | Capture an assertion, confirm the claims, then announce |

## Consequences

- **R4 / the agent surface** gains a second consumer. Every rule about tools now has to be
  written where both consumers read it — `src/tools/`, not in either client.
- **P0-25 (`write_approval_gate`)** is satisfied on this surface by construction rather than by
  in-session confirmation: the MCP path cannot execute a T2 write at all.
- **P0-23 (`group_derived_roles`)** needs a captured Access assertion before launch, per the
  identity section. The claim shape is currently inferred.
- **A PRD feature is owed.** `Test-PRD-P0-31-mcp_per_user_identity` — the MCP endpoint refuses
  any Access assertion without an `email` claim, exposes to each role only the tools that role
  may use, and returns an approval URL rather than executing any T2 write. It is not added
  here because `docs/PRD.md` is being edited concurrently; the labelled regression test lands
  with it.
- **`wrangler.toml`** wants an `APPROVALS` binding and, on the ops env only, the group-name
  vars (`OWNER_GROUP`, `MANAGER_GROUP`, `STAFF_GROUP`) if they ever differ from the defaults.
- **`docs/deploy-cloudflare.md`** wants the managed-OAuth click-path next to the Access
  application it already documents.
