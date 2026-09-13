# ADR-017 — The MCP endpoint is removed

**Status:** Accepted · **Date:** 2026-09-13 · **Amends:** ADR-007 · **Narrows:** P0-54, P0-62

## Decision

**Delete `POST /mcp` outright** — the handler (`ops/src/mcp.js`), the checked-in `.mcp.json`
Claude Code registration, and the `@modelcontextprotocol/server` dependency. The built-in
browser chat (`/ops/agent`, P0-68 in `docs/PRD.md`) is the only way anything talks to the ops
tools now.

The owner's call, in their own words, given while asking for the front page to be reduced to
its minimum interface: *"No dev. No examples. No mcp."* — and, on MCP specifically: *"Mcp is
probably only for me. Even then. I don't think I'll need it."*

## Why this does not contradict ADR-007

ADR-007 was never wrong about the shape of the problem it solved — one tool layer, three
consumers, MCP as a thin protocol adapter with no business logic of its own — only about
whether a second consumer was worth having at all. It was Proposed, never confirmed against a
live client, and the owner who would have been that second consumer said directly they expect
not to need it. A protocol adapter for a client that will not connect is not a thin adapter, it
is dead weight with a maintenance surface: a dependency to keep current, an OAuth discovery
responder, a second identity check to keep in sync with the page's own.

## What this does NOT remove

**The tool layer itself.** `TOOLS`/`runTool` in `ops/src/tools/` are untouched — ADR-007's own
point, that the protocol owns the wire and the tool layer owns the behaviour, is exactly what
made removing the wire safe. The built-in chat calls the same functions it always did.

**The T2 approval gate.** `parkForApproval`/`peekPending`/`approvePending` were never
MCP-specific in practice — `batch.js`'s CSV upload flow and the `/approvals/<id>` page reached
them the whole time, MCP was only one more caller of the same gate. They move to a new
`ops/src/approvals.js` rather than disappear with the rest of `mcp.js`.

**Skills.** `skills/*/SKILL.md` — the category-set, price/publish-gate and upload-ticket
knowledge a tool name alone does not carry — had exactly one reader before this change: an MCP
client's `skills_list`/`skills_read` calls. Deleting MCP without moving that reader would have
made `skills.js` dead code nothing ever executes, directly contradicting "Good skills" — the
owner's own next sentence in the same message that asked to remove MCP. So `agent.js`'s tool
loop gained the same two meta-tools an MCP client always had, handled before either name ever
reaches `runTool()`. See P0-81 (`docs/PRD.md`) for the full account of what moved where and why.

## What actually goes away

- The endpoint itself, and both `/.well-known/oauth-*` discovery responders.
- `buildInstructions()` — the MCP-specific connect-time greeting. `greetingScript()`, the text it
  wrapped, was always shared verbatim with the built-in chat's own `systemPrompt()` and needed no
  MCP-specific wrapper to keep working.
- MCP's own `canUseDomain`/`toolsFor`/`roleCanUse` role-scoping rule (`TIER_FLOOR`/`DOMAIN_FLOOR`/
  `ROLE_RANK`) for tool and skill visibility — a rule this codebase had never reconciled with the
  built-in chat's own, separately-evolved `mayUse`/`MAX_TIER`. Skill visibility now runs on the
  built-in chat's own rule instead of a second one nobody else read.
  `roleCanUse` itself survives, relocated to `approvals.js`, because `approvePending` still
  re-checks an approver's role against it — that one caller was never MCP's alone either.
- The `.mcp.json` Claude Code registration and the `@modelcontextprotocol/server` dependency.

## If MCP is ever wanted again

Nothing about this removal makes it structurally harder to add back than it was to add the
first time: the tool layer, the approval gate and skills all still exist, independent of any
protocol adapter, exactly as ADR-007's own "one tool layer, three consumers" design intended. A
future MCP endpoint would be a new protocol adapter calling the same `runTool()` and the same
skills, not a rebuild of either.
