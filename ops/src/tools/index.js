/*
 * The agent tool registry for ops.vemians.com.
 *
 * This file is the contract in `skills/agent-tool-contract/SKILL.md` expressed
 * as code. Everything below is enforcement; the skill is the reasoning.
 *
 *   TOOLS                     name -> { tier, domain, stores, describe, schema, run }
 *   runTool(name, args, ctx)  -> { ok, data?, error?, tier, needsApproval?, auditId }
 *
 * ctx is { actor, role, env, approvalToken?, onBehalfOf?, approvals?, rate?,
 *          catalog?, square?, media? }.
 * `actor` is the verified Access email from ops/src/access.js and NOTHING ELSE.
 * `square` and `media` are injection seams for tests; in the Worker they are
 * built from `env` by `scopedResources`, and only for a tool that declared them.
 *
 * ─── what a call goes through, in order ────────────────────────────────────
 *   1. the tool exists                                   -> else audit denied
 *   2. the caller is under the per-identity rate cap     -> else audit denied
 *   3. the arguments do not name an identity or a store  -> else audit denied
 *   4. the arguments match a CLOSED schema               -> else audit error
 *   5. the caller's role meets the tool's minimum        -> else audit denied
 *   6. read-only preflight: caps, state, ownership       -> else audit denied
 *   7. T2 only: an approval token matching THIS call     -> else audit
 *                                                           pending_approval,
 *                                                           return needsApproval
 *   8. an INTENT audit row is appended                   -> if this fails,
 *                                                           NOTHING runs
 *   9. the tool runs against ONLY its declared stores
 *  10. a failure appends an `error` row pointing at the intent row
 *
 * Steps 1-7 end in a terminal audit row and a return: no effect has happened,
 * so one row is the whole story. Step 8 is the fail-closed line — after it the
 * store may change, so the row that says we were about to already exists.
 *
 * ─── scope is a binding ────────────────────────────────────────────────────
 * A tool declares `stores`. `scopedStores` hands `run` a `db` object holding
 * exactly those D1 handles and no others, so a finance tool has no property to
 * reach a customer through. STORE_BINDINGS has no `identity` entry at all: the
 * vault is unreachable from this registry by construction, not by policy
 * (Test-PRD-P0-24-binding_scoped_tools).
 *
 * ─── nothing here deletes ──────────────────────────────────────────────────
 * There is no DELETE statement in this directory. Every write is an append or a
 * status transition; the erasure workflow is the single exception the contract
 * allows and it is owner-only, requires an open erasure_request, and is not
 * built yet (identity-skills: build it last). A test greps this directory to
 * keep that true (Test-PRD-P0-25-write_approval_gate).
 */
import { writeAudit } from "./audit.js";
import { approvals as defaultApprovals } from "./approval.js";
import { CAPS } from "./caps.js";
import { createSeedCatalogSource } from "./catalog-source.js";
import { createSquareCatalogWriter } from "./catalog-writer.js";
import { catalogTools } from "./catalog.js";
import { catalogWriteTools } from "./catalog-write.js";
import { commerceTools } from "./commerce.js";
import { createMediaStore, createSquareMediaStore } from "./media.js";
import { createImageUploader } from "../../../shared/commerce/square/images.js";
import { createSquareClient } from "../../../shared/commerce/square/client.js";
import { customerTools } from "./customers.js";
import { financeTools } from "./finance.js";
import { peopleTools } from "./people.js";
import { rateLimiter as defaultRateLimiter } from "./rate.js";
import { roleAtLeast, isRole } from "./roles.js";
import { assertNoIdentityFields, checkForbiddenArgs, validate } from "./validate.js";

export { CAPS } from "./caps.js";
export { TIERS } from "./tiers.js";

/*
 * store name -> wrangler binding. The map IS the reachable surface.
 * `identity` is deliberately absent: adding it here is the decision to let an
 * agent tool reach the vault, and it must be made in identity-skills' terms
 * (its own Access group, its own tool, built last), not by adding a line.
 */
export const STORE_BINDINGS = Object.freeze({
  customers: "CUSTOMERS",
  commerce: "COMMERCE",
  people: "PEOPLE",
  finance: "FINANCE",
  /* Our copy of Square's authoritative catalog (ADR-009, shared/commerce/square/
     schema.sql). READ from here; a catalog write goes to Square and the mirror
     follows by sync — see catalog-writer.js. */
  catalog_mirror: "CATALOG_MIRROR",
});

/*
 * Resources that are not a D1 store, declared and scoped by the same rule.
 *
 * A tool receives `t.square` or `t.media` only if it names the resource, and
 * nothing else in this file adds one. That is what makes "catalog.draft_product
 * writes nothing" a structural fact rather than a promise about its body: the
 * tool holds no object with a Square write on it, so there is no line of code
 * that could be added later to change that without also adding the declaration
 * (Test-PRD-P0-24-binding_scoped_tools).
 *
 *   square  the catalog WRITE path — an authenticated Square client plus the
 *           mirror sync that follows a write. Constructed from env; a tool
 *           never sees a raw client and never sees a Square identifier.
 *   square_client  the SAME authenticated client, with none of the catalog
 *           machinery — no mirror, no CATALOG_MIRROR requirement. For a tool
 *           that calls Square directly for something that is not the catalog
 *           (customer.create's CreateCustomer today) and would otherwise have
 *           to depend on a binding it has no reason to need.
 *   media   OUR R2 bucket for photographic originals, through the narrow view
 *           in media.js — which has no `delete`, because nothing here removes a
 *           photograph.
 */
export const RESOURCES = Object.freeze(["square", "square_client", "media"]);

const AUDIT_BINDING = "AUDIT";

/* Assembled once, then frozen. A tool cannot be added at runtime. */
function buildRegistry(groups) {
  const tools = {};
  for (const group of groups) {
    for (const [name, tool] of Object.entries(group)) {
      if (tools[name]) throw new Error(`duplicate tool ${name}`);
      assertNoIdentityFields(name, tool.schema);
      for (const store of tool.stores) {
        if (!STORE_BINDINGS[store]) {
          throw new Error(`tool ${name} declares store '${store}', which has no binding`);
        }
      }
      for (const resource of tool.resources ?? []) {
        if (!RESOURCES.includes(resource)) {
          throw new Error(`tool ${name} declares resource '${resource}', which does not exist`);
        }
      }
      /* A T0 read that can reach a write path is a T0 read in name only. */
      if (tool.tier === "T0" && (tool.resources ?? []).includes("square")) {
        throw new Error(`tool ${name} is T0 and declares the square write path`);
      }
      if (!["T0", "T1", "T2"].includes(tool.tier)) {
        throw new Error(`tool ${name} has tier '${tool.tier}'; T3 means absent, not declared`);
      }
      if (!isRole(tool.minRole)) throw new Error(`tool ${name} has an unknown minRole`);
      tools[name] = Object.freeze(tool);
    }
  }
  return Object.freeze(tools);
}

export const TOOLS = buildRegistry([
  catalogTools,
  catalogWriteTools,
  customerTools,
  commerceTools,
  peopleTools,
  financeTools,
]);

/* The description an agent is given. Data, not prose in a prompt. */
export function describeTools(role) {
  return Object.entries(TOOLS)
    .filter(([, t]) => !role || roleAtLeast(role, t.minRole))
    .map(([name, t]) => ({
      name,
      tier: t.tier,
      domain: t.domain,
      stores: t.stores,
      min_role: t.minRole,
      resources: t.resources ?? [],
      describe: t.describe,
      schema: t.schema,
      undo: t.undo ?? null,
    }));
}

/*
 * Hand `run` exactly the bindings its tool declared. A missing binding is a
 * hard failure, never a silent undefined that a query then throws on.
 */
function scopedStores(tool, env) {
  const db = {};
  for (const store of tool.stores) {
    const handle = env?.[STORE_BINDINGS[store]];
    if (!handle) throw new Error(`binding ${STORE_BINDINGS[store]} is not attached to this Worker`);
    db[store] = handle;
  }
  return Object.freeze(db);
}

/*
 * The same rule, one level out. Built LAZILY and only for what the tool
 * declared: constructing the Square client throws when SQUARE_ACCESS_TOKEN is
 * unset (client.js refuses rather than 401-ing per request later), and a tool
 * that never asked for Square must not be refused because of a var it does not
 * use. A missing resource is a hard failure, never a silent undefined that the
 * tool body then dereferences halfway through a write.
 */
/*
 * Which media store this deployment has.
 *
 * R2 when the bucket is bound; Square when it is not. Not a fallback so much
 * as a choice already made (ADR-013): with no bucket, Square holds the only
 * copy of a photograph, and the exit plan is to export from Square before
 * leaving rather than to keep a mirror as you go.
 *
 * Both are announced at INFO, because "where did that photograph go" should be
 * answerable from a log rather than by reading wrangler.toml.
 */
export function mediaStoreFor(env) {
  if (env?.MEDIA) return createMediaStore(env.MEDIA, env);
  console.info("INFO media: no MEDIA bucket bound — photographs go to Square, which holds the only copy");
  return createSquareMediaStore(createImageUploader(env), env);
}

function scopedResources(tool, ctx) {
  const out = {};
  for (const resource of tool.resources ?? []) {
    if (resource === "square") {
      out.square = ctx.square ?? createSquareCatalogWriter(ctx.env, { commerceDb: ctx.env?.COMMERCE ?? null });
    } else if (resource === "square_client") {
      out.square_client = ctx.square_client ?? createSquareClient(ctx.env, ctx.clientOptions);
    } else if (resource === "media") {
      out.media = ctx.media ?? mediaStoreFor(ctx.env ?? {});
    }
    if (!out[resource]) throw new Error(`resource '${resource}' is not available on this Worker`);
  }
  return out;
}

export async function runTool(name, args = {}, ctx = {}) {
  const { actor, role, env } = ctx;
  const tool = TOOLS[name];

  /*
   * Before anything: an actor. Not an argument, not a default, not "unknown".
   * access.js has already failed closed on a missing assertion; this is the
   * second gate for a caller that reached the registry another way.
   */
  if (!actor || typeof actor !== "string") {
    console.error(`ERROR tools: ${name} called with no Access actor — refused, nothing audited`);
    return { ok: false, error: "no verified Access identity on this call", tier: tool?.tier ?? null, auditId: null };
  }

  const audit = env?.[AUDIT_BINDING];
  const approvals = ctx.approvals ?? defaultApprovals;
  const rate = ctx.rate ?? defaultRateLimiter;
  const catalog = ctx.catalog ?? createSeedCatalogSource();

  /* Terminal outcome: one audit row, then return. No effect has happened. */
  const terminal = async ({ result, error, needsApproval, data, detail, domain, tier }) => {
    let auditId = null;
    try {
      auditId = await writeAudit(audit, {
        actor,
        onBehalfOf: ctx.onBehalfOf ?? null,
        domain: domain ?? tool?.domain ?? "knowledge",
        tool: name,
        arguments: args,
        result,
        detail: { ...(detail ?? {}), stores: tool?.stores ?? [], role: role ?? null },
      });
    } catch (err) {
      /* Fail closed: an unlogged refusal is still an unlogged action. */
      return { ok: false, error: `audit unavailable: ${err.message}`, tier: tier ?? tool?.tier ?? null, auditId: null };
    }
    const out = { ok: result === "ok", tier: tier ?? tool?.tier ?? null, auditId };
    if (error) out.error = error;
    if (needsApproval) out.needsApproval = true;
    if (data) out.data = data;
    return out;
  };

  /* 1. Unknown tool. Audited under the domain its namespace implies. */
  if (!tool) {
    return terminal({
      result: "denied",
      error: `no tool '${name}'`,
      domain: domainOfUnknown(name),
      detail: { reason: "unknown_tool" },
      tier: null,
    });
  }

  /* 2. The call-rate cap, per Access identity. Refusal, not throttling. */
  const allowance = rate.take(actor);
  if (!allowance.ok) {
    return terminal({
      result: "denied",
      error: `rate cap: ${allowance.max} calls per ${allowance.window_ms / 1000}s per identity`,
      detail: { reason: "rate_cap", ...allowance },
    });
  }

  /* 3. Identity and scope are never arguments. */
  const forbidden = checkForbiddenArgs(args);
  if (forbidden) {
    console.error(`ERROR tools: ${name} called with '${forbidden}' as an argument by ${actor}`);
    return terminal({
      result: "denied",
      error:
        `'${forbidden}' cannot be passed as an argument: identity comes from Cloudflare Access ` +
        "and scope comes from the bindings",
      detail: { reason: "identity_or_scope_in_arguments", field: forbidden },
    });
  }

  /* 4. Closed schema. */
  const parsed = validate(tool.schema, args);
  if (!parsed.ok) {
    return terminal({ result: "error", error: parsed.error, detail: { reason: "bad_arguments" } });
  }
  const value = parsed.value;

  /* 5. Role, from the Access groups. Never widened by an argument. */
  if (!roleAtLeast(role, tool.minRole)) {
    return terminal({
      result: "denied",
      error: `${name} requires the ${tool.minRole} role; this identity holds '${role ?? "none"}'`,
      detail: { reason: "role", required: tool.minRole, held: role ?? null },
    });
  }

  let db;
  let resources;
  try {
    db = scopedStores(tool, env);
    resources = scopedResources(tool, ctx);
  } catch (err) {
    console.error(`ERROR tools: ${name} — ${err.message}`);
    return terminal({ result: "error", error: err.message, detail: { reason: "missing_binding" } });
  }

  const t = {
    actor,
    role,
    db,
    catalog,
    /* Only what the tool declared. Undeclared resources are absent properties,
       not disabled ones (Test-PRD-P0-24-binding_scoped_tools). */
    ...resources,
    approved: false,
    preflight: null,
    now: ctx.now ?? (() => new Date()),
  };

  /* 6. Read-only preflight: caps and state, before any token is issued. */
  if (tool.check) {
    let pre;
    try {
      pre = await tool.check(value, t);
    } catch (err) {
      console.error(`ERROR tools: ${name} preflight failed — ${err.message}`);
      return terminal({ result: "error", error: err.message, detail: { reason: "preflight_failed" } });
    }
    if (pre?.denied) {
      return terminal({
        result: "denied",
        error: pre.denied,
        detail: { reason: "refused_by_cap_or_state", ...(pre.detail ?? {}) },
      });
    }
    t.preflight = pre?.preflight ?? null;
    t.summary = pre?.summary ?? null;
  }

  /* 7. T2: an approval token issued by a prior call, for THIS call. */
  if (tool.tier === "T2") {
    const consumed = approvals.consume(ctx.approvalToken, { tool: name, actor, args: value });
    if (!consumed.ok) {
      const issued = approvals.issue({ tool: name, actor, args: value, summary: t.summary });
      return terminal({
        result: "pending_approval",
        needsApproval: true,
        data: {
          approval: {
            token: issued.token,
            expires_at: issued.expiresAt,
            summary: issued.summary,
            ttl_seconds: Math.round(CAPS.APPROVAL_TTL_MS / 1000),
          },
          would: t.summary,
        },
        detail: { reason: consumed.reason, tier: "T2" },
      });
    }
    t.approved = true;
  }

  /*
   * 8. THE FAIL-CLOSED LINE. From here the store may change, so the row that
   *    records the attempt is written first. If this throws, nothing runs.
   */
  let auditId;
  try {
    auditId = await writeAudit(audit, {
      actor,
      onBehalfOf: ctx.onBehalfOf ?? null,
      domain: tool.domain,
      tool: name,
      arguments: value,
      result: "ok",
      detail: {
        tier: tool.tier,
        stores: tool.stores,
        role,
        phase: tool.tier === "T0" ? "read" : "authorised",
        approved: t.approved,
        ...(t.summary ? { summary: t.summary } : {}),
      },
    });
  } catch (err) {
    return { ok: false, error: `audit unavailable: ${err.message}`, tier: tool.tier, auditId: null };
  }

  /* 9. Run, with only the declared stores in reach. */
  let data;
  try {
    data = await tool.run(value, t);
  } catch (err) {
    console.error(`ERROR tools: ${name} failed after its audit row (${auditId}) — ${err.message}`);
    /*
     * 10. The log is append-only, so the failure is a SECOND row pointing at the
     *    first. Editing row `auditId` to say `error` is what the trigger exists
     *    to forbid.
     */
    try {
      await writeAudit(audit, {
        actor,
        onBehalfOf: ctx.onBehalfOf ?? null,
        domain: tool.domain,
        tool: name,
        arguments: value,
        result: "error",
        detail: { reverses: auditId, message: err.message, stores: tool.stores },
      });
    } catch (auditErr) {
      console.error(`ERROR tools: could not audit the failure of ${name} — ${auditErr.message}`);
    }
    return { ok: false, error: err.message, tier: tool.tier, auditId };
  }

  /*
   * A tool may still refuse on what it read while running — a row that changed
   * state between the preflight and the write, say. Same append-a-second-row
   * shape as a failure, and the same fail-closed handling if that row cannot be
   * written.
   */
  const outcome = data?.denied ? "denied" : data?.error ? "error" : null;
  if (outcome) {
    const message = data.denied ?? data.error;
    try {
      await writeAudit(audit, {
        actor,
        onBehalfOf: ctx.onBehalfOf ?? null,
        domain: tool.domain,
        tool: name,
        arguments: value,
        result: outcome,
        detail: { reverses: auditId, message, stores: tool.stores },
      });
    } catch (err) {
      console.error(`ERROR tools: could not audit the outcome of ${name} — ${err.message}`);
      return { ok: false, error: `audit unavailable: ${err.message}`, tier: tool.tier, auditId };
    }
    return { ok: false, error: message, tier: tool.tier, auditId };
  }

  return { ok: true, data, tier: tool.tier, auditId };
}

/* An unknown tool still gets a row; its namespace picks a legal audit domain. */
function domainOfUnknown(name) {
  const prefix = String(name).split(".")[0];
  const known = {
    catalog: "catalog",
    customer: "customers",
    order: "commerce",
    inventory: "commerce",
    schedule: "people",
    shift: "people",
    expense: "finance",
    budget: "finance",
    report: "finance",
  };
  return known[prefix] ?? "knowledge";
}
