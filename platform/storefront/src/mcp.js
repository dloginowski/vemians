/*
 * Remote MCP server for the ops tools — POST /mcp on ops.vemians.com.
 *
 * ONE TOOL LAYER, THREE CONSUMERS. The browser chat, this endpoint and any
 * future automation all call `runTool()` from src/tools/. This file contains no
 * business logic, no store binding and no query: it is a protocol adapter that
 * turns a JSON-RPC `tools/call` into the same call the browser chat makes, with
 * the same tier rules, the same caps and the same audit row. A tool
 * reimplemented per client is a tool whose guarantees are reimplemented per
 * client too, and the second copy is always the one that forgets to audit.
 *
 * The protocol entry is `createMcpHandler` from @modelcontextprotocol/server
 * (SDK v2) — a stateless, request-scoped handler with no session id and no
 * Durable Object. `McpAgent` from the Cloudflare Agents SDK is the deprecated
 * predecessor of this; it is not used here.
 *
 * PRD: Test-PRD-P0-21-append_only_audit, Test-PRD-P0-22-access_gated_ops,
 *      Test-PRD-P0-23-group_derived_roles, Test-PRD-P0-24-binding_scoped_tools,
 *      Test-PRD-P0-25-write_approval_gate. ADR-007.
 */

import { createMcpHandler, McpServer, fromJsonSchema, preloadSchemas } from "@modelcontextprotocol/server";
import { readAccessIdentity } from "./access.js";
import { TOOLS, runTool } from "./tools/index.js";

/* Isolate warm-up, not first-request latency. See the SDK's own note. */
preloadSchemas();

const SERVER_NAME = "vemians-ops";
const SERVER_VERSION = "0.1.0";

/* ------------------------------------------------------------------------ *
 * WHY A MODEL CANNOT APPROVE ITS OWN WRITE
 *
 * The approval token is not a secret the model is trusted not to guess. It is a
 * value this module never holds on the MCP path at all.
 *
 * `mcpCtx()` builds the only context object that reaches `runTool()` from a
 * `tools/call`, and it has no `approvalToken` key. No branch adds one, and no
 * branch reads one out of `args` — the argument object is passed to the tool
 * layer untouched and the tool layer takes its token from `ctx`, never from
 * arguments (agent-tool-contract: "a tool signature that accepts an actor is a
 * tool that can be impersonated"; the same is true of an approval). So the T2
 * path through MCP is structurally a proposal: `runTool` is handed a context
 * with no token and can answer nothing but `needsApproval`.
 *
 * The token is minted in `approvePending()`. That function is reachable only
 * from a browser POST on ops.vemians.com, which carries its own Cloudflare
 * Access assertion — a second, independently authenticated human turn, by a
 * person whose role is checked again there. The token is created inside that
 * request, spent inside that request, and never serialised into any MCP
 * response. A model that replayed every byte this endpoint has ever sent it
 * still holds nothing `runTool` will accept.
 *
 * The convention version of this rule — "don't forward approvalToken from tool
 * input" — fails the first time somebody adds a passthrough for convenience.
 * The structural version fails only if someone deletes this comment and the
 * code beneath it in the same edit.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------- identity */

/*
 * Roles come from Cloudflare Access group membership (P0-23), never from
 * anything the client sends and never from a table in this application. The
 * assertion carries the groups; the mapping from group name to role is
 * configuration, so renaming a Workspace group is a var change, not a deploy.
 */
const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };

function groupsFrom(claims) {
  const raw = claims.groups ?? claims.custom?.groups ?? claims["cf-access-groups"] ?? [];
  return (Array.isArray(raw) ? raw : [raw]).filter((g) => typeof g === "string").map((g) => g.toLowerCase());
}

export function roleFor(claims, env) {
  const groups = new Set(groupsFrom(claims));
  const named = (v, fallback) => String(v || fallback).toLowerCase();
  if (groups.has(named(env.OWNER_GROUP, "vemians-owner"))) return "owner";
  if (groups.has(named(env.MANAGER_GROUP, "vemians-manager"))) return "manager";
  if (groups.has(named(env.STAFF_GROUP, "vemians-staff"))) return "staff";
  return null; /* fail closed: an identity with no known group has no role */
}

/*
 * A service token is a MACHINE, and `actor` on an audit row has to name a
 * person (P0-21, P0-23). Cloudflare Access issues service-token assertions with
 * a `common_name` and no `email`; access.js falls back to `common_name` for
 * display, which is right for a page header and wrong for an audit row. So the
 * MCP endpoint refuses any assertion without an `email` claim rather than
 * writing a machine name into the actor column. See ADR-007 §identity.
 */
function humanActor(identity) {
  const email = identity.claims?.email;
  if (typeof email === "string" && email.includes("@")) return email;
  return null;
}

/* ------------------------------------------------------------- tool naming */

/*
 * Tool ids are `domain.verb`. MCP itself tolerates the dot, but OpenAI's
 * function-name grammar is /^[a-zA-Z0-9_-]{1,64}$/ and staff use ChatGPT as
 * well as Claude, so the wire name is underscored and mapped back here. Doing
 * it in one place is what keeps the client choice a preference (ADR-007).
 */
const wireName = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/* --------------------------------------------------------------- tier gate */

/*
 * Which role may see which tool. A tool that declares `roles` wins; otherwise
 * the floor comes from its tier and its domain, mirroring the role-to-tool
 * matrix in skills/agent-tool-contract. T3 is absent by construction — if one
 * ever appears in TOOLS it is a bug, and it is still not listed.
 */
const TIER_FLOOR = { t0: "staff", t1: "staff", t2: "manager" };
const DOMAIN_FLOOR = { identity: "manager", audit: "owner" };

export function roleCanUse(role, tool) {
  if (!role || !tool) return false;
  const tier = String(tool.tier || "").toLowerCase();
  if (tier === "t3") return false;
  if (Array.isArray(tool.roles)) return tool.roles.includes(role);

  const floor = Math.max(
    ROLE_RANK[TIER_FLOOR[tier] || "owner"] || 3,
    ROLE_RANK[DOMAIN_FLOOR[String(tool.domain || "").toLowerCase()] || "staff"],
  );
  return (ROLE_RANK[role] || 0) >= floor;
}

/*
 * The list this role gets. Tools it cannot use are ABSENT, not present and
 * refused: a tool in `tools/list` is a tool the model will try, will be told no
 * about, and will try again a different way. Absence ends that loop, and it
 * also stops the tool name itself leaking the shape of what it cannot reach.
 */
export function toolsFor(role) {
  return Object.entries(TOOLS).filter(([, tool]) => roleCanUse(role, tool));
}

/* --------------------------------------------------- pending T2 approvals */

/*
 * A T2 call parks its intent here and hands the human a URL. Nothing has been
 * written at this point and nothing will be until approvePending() runs.
 *
 * PROTOTYPE STORAGE. With no binding configured this is a per-isolate Map:
 * an approval link survives only as long as the isolate that minted it. That is
 * fine for `wrangler dev` and NOT fine on ops.vemians.com — bind `APPROVALS`
 * (KV) in wrangler.toml and the same code uses it. The Worker says which one it
 * is out loud rather than pretending durability it does not have.
 */
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const memoryPending = new Map();

function pendingStore(env) {
  if (env.APPROVALS) {
    return {
      durable: true,
      put: (id, rec) => env.APPROVALS.put(id, JSON.stringify(rec), { expirationTtl: APPROVAL_TTL_MS / 1000 }),
      get: async (id) => JSON.parse((await env.APPROVALS.get(id)) || "null"),
      del: (id) => env.APPROVALS.delete(id),
    };
  }
  return {
    durable: false,
    put: async (id, rec) => {
      for (const [k, v] of memoryPending) if (v.expiresAt < Date.now()) memoryPending.delete(k);
      memoryPending.set(id, rec);
    },
    get: async (id) => {
      const rec = memoryPending.get(id);
      if (!rec) return null;
      if (rec.expiresAt < Date.now()) {
        memoryPending.delete(id);
        return null;
      }
      return rec;
    },
    del: async (id) => memoryPending.delete(id),
  };
}

const opsOrigin = (env) => `https://${env.OPS_HOST || "ops.vemians.com"}`;

async function parkForApproval(env, { name, args, actor, role, tier }) {
  const id = crypto.randomUUID();
  const store = pendingStore(env);
  if (!store.durable) {
    console.warn(
      `WARNING mcp: APPROVALS binding absent — approval ${id} is held in this isolate only. Bind APPROVALS before ops.vemians.com is reachable.`,
    );
  }
  await store.put(id, {
    id,
    tool: name,
    args,
    /* Who asked. The approver is a different person on a different request, and
       the audit row for the execution names both. */
    requestedBy: actor,
    requestedRole: role,
    tier,
    via: "mcp",
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TTL_MS,
  });
  return { id, url: `${opsOrigin(env)}/approvals/${id}` };
}

/*
 * The browser half of the gate. Called by the approvals route on
 * ops.vemians.com — NOT from anything on the MCP path — with the Access
 * identity of the person clicking approve. This is the only place an approval
 * token exists, and it is spent in the same request that made it.
 *
 * Exported so the approvals view can call it; it takes an already-verified
 * identity rather than a request, so it cannot be reached without one.
 */
export async function approvePending(env, id, approver) {
  if (!approver?.email || !approver?.role) {
    console.error("ERROR mcp/approve: called without a verified approver identity");
    return { ok: false, error: "Approval requires a verified Access identity." };
  }
  /* An unverified assertion may read. It may not authorise a write. */
  if (!approver.verified) {
    console.error("ERROR mcp/approve: refusing to approve on an unverified Access assertion");
    return { ok: false, error: "Approval requires a verified Access assertion (ACCESS_TEAM_DOMAIN / ACCESS_AUD)." };
  }

  const store = pendingStore(env);
  const pending = await store.get(id);
  if (!pending) return { ok: false, error: "No such pending approval, or it has expired." };

  const tool = TOOLS[pending.tool];
  if (!roleCanUse(approver.role, tool)) {
    console.error(`ERROR mcp/approve: ${approver.email} (${approver.role}) cannot approve ${pending.tool}`);
    return { ok: false, error: "Your role cannot approve this write." };
  }

  /* Minted here, from this browser request, never returned to any caller. */
  const approvalToken = crypto.randomUUID();
  await store.del(id);

  return runTool(pending.tool, pending.args, {
    actor: pending.requestedBy,
    approvedBy: approver.email,
    role: approver.role,
    env,
    approvalToken,
  });
}

/* ----------------------------------------------------------------- adapter */

/*
 * The context handed to runTool from an MCP call. Note what is NOT here.
 * See the block comment at the top of this file.
 */
function mcpCtx(identity, env) {
  return Object.freeze({
    actor: identity.actor,
    role: identity.role,
    env,
    surface: "mcp",
    verified: identity.verified,
  });
}

const text = (value) => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });

function inputSchemaFor(tool) {
  if (!tool.schema) return undefined;
  /* Already a Standard Schema (zod v4, arktype, valibot) — hand it over. */
  if (tool.schema["~standard"]) return tool.schema;
  return fromJsonSchema(tool.schema);
}

function describe(id, tool) {
  const base = tool.describe || `${id} (${tool.domain})`;
  if (String(tool.tier).toLowerCase() === "t2") {
    return `${base}\n\n[T2 write] Calling this does NOT perform the write. It returns a link for a human to approve in a browser on ops.vemians.com. There is no argument that skips that step.`;
  }
  if (String(tool.tier).toLowerCase() === "t1") {
    return `${base}\n\n[T1 proposal] Returns the proposed change. A human merges it; this call applies nothing.`;
  }
  return `${base}\n\n[T0 read]`;
}

function buildServer(identity, env) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Vemians ops tools for ${identity.actor} (${identity.role}).` +
        ` Only the tools this role may use are listed.` +
        ` T2 writes are never executed by this endpoint: they return a link a human approves in a browser.` +
        (identity.verified ? "" : " WARNING: the Access assertion was decoded but NOT signature-verified on this deployment."),
    },
  );

  for (const [id, tool] of toolsFor(identity.role)) {
    server.registerTool(
      wireName(id),
      {
        title: id,
        description: describe(id, tool),
        inputSchema: inputSchemaFor(tool),
        annotations: {
          readOnlyHint: String(tool.tier).toLowerCase() === "t0",
          /* A T2 call through MCP writes nothing, so it is not destructive here.
             The write happens on the browser approval, under its own identity. */
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        const tier = String(tool.tier).toLowerCase();

        if (tier === "t2") {
          const { id: approvalId, url } = await parkForApproval(env, {
            name: id,
            args: args ?? {},
            actor: identity.actor,
            role: identity.role,
            tier,
          });
          return {
            content: [
              text(
                `This is a T2 write and has NOT been performed.\n\n` +
                  `A human must approve it in a browser:\n${url}\n\n` +
                  `Nothing in ${id} runs until someone with the role opens that link and approves. ` +
                  `The approval is minted there; there is no token to pass back here.`,
              ),
            ],
            _meta: {
              "vemians.com/needs_approval": true,
              "vemians.com/approval_url": url,
              "vemians.com/approval_id": approvalId,
              "vemians.com/tier": "T2",
            },
          };
        }

        const result = await runTool(id, args ?? {}, mcpCtx(identity, env));

        /* A T1 tool that came back needing approval, or a tool layer that
           changed shape under us: do not paper over it. */
        if (result?.needsApproval) {
          const { url } = await parkForApproval(env, {
            name: id,
            args: args ?? {},
            actor: identity.actor,
            role: identity.role,
            tier,
          });
          return {
            content: [text(`Requires human approval, which happens in a browser:\n${url}`)],
            _meta: { "vemians.com/needs_approval": true, "vemians.com/approval_url": url },
          };
        }

        if (!result?.ok) {
          console.error(`ERROR mcp/tool ${id} refused for ${identity.actor}: ${result?.error || "unknown"}`);
          return {
            isError: true,
            content: [text(result?.error || `${id} failed.`)],
            _meta: { "vemians.com/audit_id": result?.auditId ?? null, "vemians.com/tier": result?.tier ?? tool.tier },
          };
        }

        return {
          content: [text(result.data)],
          _meta: { "vemians.com/audit_id": result.auditId ?? null, "vemians.com/tier": result.tier ?? tool.tier },
        };
      },
    );
  }

  return server;
}

/*
 * One handler per isolate. `createMcpHandler` builds a fresh McpServer per
 * request from the factory, so the per-caller tool list is still per-caller —
 * the handler itself holds nothing about who is calling.
 */
let HANDLER = null;

function handler(env) {
  if (HANDLER) return HANDLER;
  HANDLER = createMcpHandler(
    (ctx) => {
      const identity = ctx.authInfo?.extra?.identity;
      if (!identity) {
        /* Unreachable: handleMcp never calls fetch() without authInfo. Kept as
           a fail-closed assertion rather than an empty-tools server. */
        throw new Error("MCP factory invoked without a verified Access identity");
      }
      return buildServer(identity, env);
    },
    { onerror: (err) => console.error(`ERROR mcp: ${err.message}`) },
  );
  return HANDLER;
}

/* ------------------------------------------------------------------ routes */

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/*
 * RFC 9728 protected-resource metadata. In production Cloudflare Access
 * (Managed OAuth) answers the discovery paths at the edge and the Worker never
 * sees them; this copy exists so the endpoint is self-describing when it is
 * reached directly, and so the 401 below has something true to point at.
 */
function protectedResourceMetadata(env) {
  const origin = opsOrigin(env);
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  });
}

/*
 * The 401 carries WWW-Authenticate. Claude Code tolerates its absence by
 * probing the well-known path; the claude.ai connector does not, and fails
 * before it ever shows a login screen (anthropics/claude-ai-mcp#410). One
 * header is cheaper than that bug report.
 */
function unauthorized(env, reason) {
  return json(
    { error: "unauthorized", error_description: reason },
    401,
    {
      "www-authenticate": `Bearer realm="${SERVER_NAME}", resource_metadata="${opsOrigin(env)}/.well-known/oauth-protected-resource"`,
    },
  );
}

export const isMcpPath = (path) => path === "/mcp" || path.startsWith("/.well-known/oauth-");

/*
 * Entry point. Owns its own identity check rather than inheriting the ops
 * page's, because the two disagree on purpose: the ops page renders for a
 * service token, this endpoint refuses one.
 */
export async function handleMcp(request, env, path) {
  if (path.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata(env);
  if (path.startsWith("/.well-known/oauth-")) return json({ error: "not_found" }, 404);

  const identity = await readAccessIdentity(request, env);
  if (!identity.ok) return unauthorized(env, identity.reason);

  const actor = humanActor(identity);
  if (!actor) {
    /* Fail closed rather than write a machine name into the actor column. */
    console.error("ERROR mcp: assertion has no email claim (service token?) — refusing, per-user audit is not possible");
    return json(
      {
        error: "forbidden",
        error_description:
          "This endpoint requires a per-user Access identity. A service token names a machine, and every audit row here must name a person.",
      },
      403,
    );
  }

  const role = roleFor(identity.claims, env);
  if (!role) {
    console.error(`ERROR mcp: ${actor} is in no known Access group — no role, refusing`);
    return json({ error: "forbidden", error_description: "Your Access identity is in no group this application maps to a role." }, 403);
  }

  if (request.method === "GET" || request.method === "DELETE") {
    /* Stateless: there is no session to stream on or to delete. */
    return json({ error: "method_not_allowed", error_description: "POST only. This endpoint is stateless." }, 405);
  }

  return handler(env).fetch(request, {
    authInfo: {
      token: "cf-access",
      clientId: request.headers.get("mcp-client-id") || "cf-access",
      scopes: [],
      extra: { identity: { actor, role, verified: identity.verified, claims: identity.claims } },
    },
  });
}
