/*
 * The T2 approval gate — park an intent, hand back a URL, and only run the
 * write when a person opens that link and says yes on ops.vemians.com.
 *
 * Split out of what used to be mcp.js when the MCP endpoint was removed
 * (P0-81): this half was never MCP-specific — it is reached by batch.js's
 * CSV upload flow and by the `/approvals/<id>` page in index.js, and it is
 * the same gate a T2 tool call from ANY caller parks itself behind. MCP just
 * happened to be one more caller of it.
 *
 * The built-in browser chat (agent.js) does NOT go through this module — it
 * has its own, simpler pending-approval map (`PENDING` in agent.js), because
 * a same-request browser round-trip never needed a durable, cross-request
 * store the way a CSV batch (reviewed later, by a human, from a link) does.
 */

import { TOOLS, runTool } from "./tools/index.js";

/* ------------------------------------------------------------------------ *
 * WHY A MODEL CANNOT APPROVE ITS OWN WRITE
 *
 * The approval token is not a secret the model is trusted not to guess. It is
 * a value this module never hands to whatever parked the intent in the first
 * place. The token is minted in `approvePending()`, reachable only from a
 * browser POST on ops.vemians.com carrying its own Cloudflare Access
 * assertion — a second, independently authenticated human turn, by a person
 * whose role is checked again there. The token is created inside that
 * request, spent inside that request, and never serialised into anything a
 * model could read back.
 * ------------------------------------------------------------------------ */

/*
 * Which role may approve which tool. A tool that declares `roles` wins;
 * otherwise the floor comes from its tier and its domain, mirroring the
 * role-to-tool matrix in skills/agent-tool-contract.
 */
const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };
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
 * A T2 call parks its intent here and hands the human a URL. Nothing has been
 * written at this point and nothing will be until approvePending() runs.
 *
 * PROTOTYPE STORAGE. With no binding configured this is a per-isolate Map: an
 * approval link survives only as long as the isolate that minted it. That is
 * fine for `wrangler dev` and NOT fine on ops.vemians.com — bind `APPROVALS`
 * (KV) in wrangler.toml and the same code uses it. The Worker says which one
 * it is out loud rather than pretending durability it does not have.
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

/* Exported so a test can assert the URL this ACTUALLY emits has a route. It
   was not, and the 404 that followed shipped unnoticed for exactly that
   reason: every test asked the code what it meant, none asked what it sent. */
export async function parkForApproval(env, { name, args, actor, role, tier, summary }) {
  const id = crypto.randomUUID();
  const store = pendingStore(env);
  if (!store.durable) {
    console.warn(
      `WARNING approvals: APPROVALS binding absent — approval ${id} is held in this isolate only. Bind APPROVALS before ops.vemians.com is reachable.`,
    );
  }
  await store.put(id, {
    id,
    tool: name,
    args,
    /* The one-line plain-English description the tool's own check() already
       wrote (e.g. `create "Necklace" in Jewellery — 1 variation(s): ...`) —
       carried through so the approval page can lead with that instead of a
       raw argument dump only a developer would parse on sight. */
    summary: summary ?? null,
    /* Who asked. The approver is a different person on a different request, and
       the audit row for the execution names both. */
    requestedBy: actor,
    requestedRole: role,
    tier,
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TTL_MS,
  });
  return { id, url: `${opsOrigin(env)}/approvals/${id}` };
}

/*
 * Read one parked approval without executing it. The page needs to SHOW the
 * human what they are about to authorise, and showing is not approving.
 * `durable` comes back too, because "expired" and "a different isolate held
 * it" look identical from a browser and need different advice.
 */
export async function peekPending(env, id) {
  const store = pendingStore(env);
  return { pending: await store.get(id), durable: store.durable };
}

/*
 * The browser half of the gate. Called by the approvals route on
 * ops.vemians.com with the Access identity of the person clicking approve.
 * This is the only place an approval token exists, and it is spent in the
 * same request that made it.
 */
export async function approvePending(env, id, approver, argsOverride) {
  if (!approver?.email || !approver?.role) {
    console.error("ERROR approvals: called without a verified approver identity");
    return { ok: false, error: "Approval requires a verified Access identity." };
  }
  /* An unverified assertion may read. It may not authorise a write. */
  if (!approver.verified) {
    console.error("ERROR approvals: refusing to approve on an unverified Access assertion");
    return { ok: false, error: "Approval requires a verified Access assertion (ACCESS_TEAM_DOMAIN / ACCESS_AUD)." };
  }

  const store = pendingStore(env);
  const pending = await store.get(id);
  if (!pending) return { ok: false, error: "No such pending approval, or it has expired." };

  const tool = TOOLS[pending.tool];
  if (!roleCanUse(approver.role, tool)) {
    console.error(`ERROR approvals: ${approver.email} (${approver.role}) cannot approve ${pending.tool}`);
    return { ok: false, error: "Your role cannot approve this write." };
  }

  await store.del(id);

  /*
   * THE T2 GATE IS ISSUE-THEN-CONSUME, BOTH KEYED BY (tool, actor, args) —
   * see approval.js's `fingerprint()`. A random UUID here (what this used to
   * do) never matches anything `approvals.issue()` ever minted, so
   * `consume()` always answered "unknown_or_used_token" and runTool always
   * fell back to issuing yet another token nobody could see — this page's
   * "Approve and run" button has never actually written to Square. Fixed by
   * doing the same two-call dance a same-session caller does: call once to
   * get a token bound to THIS actor, then call again with it.
   *
   * The actor for BOTH calls is the APPROVER, not the original requester —
   * this page's own promise ("This runs under your identity, not the
   * assistant's") and P0-35 both require it, and the fingerprint match
   * requires the second call's actor to equal the first's. Who originally
   * asked is preserved separately via onBehalfOf, which lands in the audit
   * row's detail rather than overwriting who actually did it.
   */
  /* A person reviewing the prefilled form may have fixed a typo'd title or a
     wrong price before clicking "Yes, do this" — argsOverride carries that
     edit. It still goes through the SAME check() as the originally parked
     args did (a bad edit is refused exactly like a bad CSV row), and the
     audit row ends up recording what was actually created, not what was
     first proposed. */
  const args = argsOverride ?? pending.args;
  const ctx = { actor: approver.email, role: approver.role, env, onBehalfOf: pending.requestedBy };
  const proposal = await runTool(pending.tool, args, ctx);
  if (!proposal?.needsApproval) return proposal;

  return runTool(pending.tool, args, { ...ctx, approvalToken: proposal.data?.approval?.token });
}
