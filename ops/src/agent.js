/*
 * The ops agent — a tool-use loop against the Anthropic Messages API.
 *
 * Three things in this file are load-bearing and none of them are prompt text:
 *
 *   1. TOOL FILTERING IS SUBTRACTIVE (P0-24). The tool list sent upstream is
 *      built from the caller's role. A tool the role may not use is not in the
 *      request body at all — not described, not offered, not refused. The model
 *      cannot ask for a tool it has never been shown, and `dispatch` refuses a
 *      name outside the same set a second time, so a hallucinated name is a
 *      refusal rather than a call. Prompt-level scoping is not scoping.
 *
 *   2. THE APPROVAL TOKEN IS NEVER IN THE MODEL'S REACH (P0-25). See the block
 *      comment above PENDING.
 *
 *   3. THE LOOP HAS A CEILING. MAX_ROUND_TRIPS tool round-trips, then the turn
 *      ends with a refusal instead of another request.
 *
 * The key is a Worker secret, not a var — `npx wrangler secret put
 * ANTHROPIC_API_KEY` (run from `ops/`; there is no named environment in
 * ops/wrangler.toml to target), or a line in a local `.dev.vars`. With it
 * unset the whole file degrades to the echo stub and the ops page says so, so
 * the prototype runs with no Anthropic account at all.
 *
 * `src/tools/index.js` is a separate deliverable and is deliberately not
 * implemented here; this file only consumes its published interface:
 *
 *   TOOLS: name -> { tier, domain, stores, describe, schema }
 *   runTool(name, args, ctx) -> { ok, data?, error?, tier, needsApproval?, auditId }
 *   ctx = { actor, role, env, approvalToken? }
 *
 * PRD: Test-PRD-P0-23-group_derived_roles, Test-PRD-P0-24-binding_scoped_tools,
 *      Test-PRD-P0-25-write_approval_gate.
 * Contract: skills/agent-tool-contract/SKILL.md.
 */

import { TOOLS, runTool } from "./tools/index.js";

const MODEL = "claude-sonnet-5";
const API_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 16000;

/* Six tool round-trips. Hit it and the turn ends; it does not send a seventh. */
const MAX_ROUND_TRIPS = 6;

/* ---- roles ------------------------------------------------------------- *
 * Roles come from Access group membership (R1.3 / P0-23), never from the
 * application and never from a request parameter. Cloudflare Access puts group
 * membership in the assertion; until the Access Groups are configured this
 * reads whichever claim is present and falls back to the least privilege.
 */
const ROLES = ["staff", "manager", "owner"];

/* Canonical mapping lives in access.js; see the comment there for why there is
   exactly one. Re-exported so existing callers keep working. */
/* Imported, not re-exported blind: `export … from` creates no local
   binding, so the module could not call it. */
import { roleFor, firstNameFrom } from "./access.js";
import { greetingScript } from "./greeting.js";
export { roleFor };


/* Role -> tool visibility. The matrix in the tool contract, expressed against
   the only two fields of a tool a role decision may depend on: its tier and its
   domain. T3 is absent by construction — if one ever appears in TOOLS it is
   filtered here as well, so a mistake in the tool layer is not a privilege
   escalation here. */
const MAX_TIER = { staff: 1, manager: 2, owner: 2 };
const OWNER_ONLY_DOMAINS = new Set(["audit"]);
const OWNER_ONLY_TOOLS = new Set(["identity.erase"]);

function tierNumber(tier) {
  const n = typeof tier === "number" ? tier : Number(String(tier).replace(/^T/i, ""));
  return Number.isFinite(n) ? n : 3; /* unreadable tier is treated as T3: absent */
}

export function mayUse(role, name, tool) {
  if (!tool) return false;
  if (tierNumber(tool.tier) > (MAX_TIER[role] ?? 0)) return false;
  if (OWNER_ONLY_TOOLS.has(name) && role !== "owner") return false;
  if (OWNER_ONLY_DOMAINS.has(tool.domain) && role !== "owner") return false;
  return true;
}

/* The set of tool names this role may reach. Everything downstream — the tool
   definitions sent upstream, the dispatch check, the approve path, the bindings
   line on screen — is derived from this one function. One source of truth. */
export function allowedTools(role) {
  return Object.entries(TOOLS || {}).filter(([name, tool]) => mayUse(role, name, tool));
}

/* What the ops page prints under "Bindings": the stores this session can reach,
   which is the union of the stores of the tools it can call and nothing else. */
export function sessionBindings(role) {
  const allowed = allowedTools(role);
  const stores = new Set();
  for (const [, tool] of allowed) for (const s of tool.stores || []) stores.add(s);
  return {
    role,
    tools: allowed.map(([name]) => name).sort(),
    stores: [...stores].sort(),
    hidden: Object.keys(TOOLS || {}).length - allowed.length,
  };
}

/* ---- tool definitions for Claude --------------------------------------- */

function describeTool(tool, name, args) {
  /* `describe` is the tool layer's human-readable effect line. It may be a
     string or a function of the arguments; accept either rather than assume. */
  const d = tool && tool.describe;
  try {
    if (typeof d === "function") return String(d(args || {}));
    if (typeof d === "string" && d) return d;
  } catch (err) {
    console.error(`ERROR agent: describe() threw for ${name} — ${err.message}`);
  }
  return name;
}

/*
 * `tool.schema` is THIS CODEBASE'S OWN validation DSL (tools/validate.js) — a
 * flat map of field name to spec, with validate.js-specific keys (`required`
 * living on the FIELD, not a top-level array; `format` naming our own
 * patterns like "handle" or "currency"; `of` for array items). It is not, and
 * was never, the JSON Schema object Anthropic's tool-use API requires for
 * `input_schema`: `{type:"object", properties:{...}, required:[...]}`.
 *
 * Sending the raw DSL straight through validated correctly against our OWN
 * runTool() — a completely separate code path — but was never valid input to
 * Claude at all. Every real call was going to get a 400 back from Anthropic
 * the first time a real API key made it reach them, because no test in this
 * codebase calls the actual Messages API; the stub and every mocked test
 * exercise runTool()'s own validate(), not this shape. Test-PRD-P0-76-
 * valid_tool_schema.
 */
function fieldToJsonSchema(spec) {
  const out = { type: spec.type === "integer" ? "integer" : spec.type };
  if (spec.enum) out.enum = spec.enum;
  if (spec.maxLength !== undefined) out.maxLength = spec.maxLength;
  if (spec.min !== undefined) out.minimum = spec.min;
  if (spec.max !== undefined) out.maximum = spec.max;
  if (spec.maxItems !== undefined) out.maxItems = spec.maxItems;
  if (spec.format) out.description = `Format: ${spec.format}`;
  if (spec.type === "array" && spec.of) {
    out.items = spec.of.type === "object" ? toJsonSchema(spec.of.schema) : fieldToJsonSchema(spec.of);
  }
  return out;
}

export function toJsonSchema(schema) {
  const properties = {};
  const required = [];
  for (const [field, spec] of Object.entries(schema || {})) {
    properties[field] = fieldToJsonSchema(spec);
    if (spec.required) required.push(field);
  }
  const out = { type: "object", properties };
  if (required.length) out.required = required;
  return out;
}

export function toolDefinitions(role) {
  return allowedTools(role).map(([name, tool]) => ({
    name,
    description: `${describeTool(tool, name)} [tier ${tool.tier}, domain ${tool.domain}, stores ${(tool.stores || []).join(", ") || "none"}]`,
    input_schema: toJsonSchema(tool.schema),
  }));
}

/*
 * This built-in browser chat is the "stupid simple" path — the one click
 * from the ops front page, no external app, no connector setup. It has to
 * open the SAME way the MCP path does (P0-62/P0-68), or "one click from ops"
 * quietly means "a worse, unbranded version of the real thing" instead of
 * the primary experience it is meant to be.
 */
export function systemPrompt(actor, role, defs, claims) {
  const firstName = firstNameFrom(claims, actor);
  return (
    [
      `You are the Vemians ops assistant on ops.vemians.com. The person you are talking to is ${actor}` +
        ` (${role}), first name ${firstName}.`,
      `You have exactly ${defs.length} tool${defs.length === 1 ? "" : "s"}. That list is the whole of what you can reach: it is built from this person's role before the request leaves the Worker, so anything absent from it is unreachable, not merely forbidden. Do not describe tools you do not have, and do not offer to run one.`,
      "Tools marked tier 2 stop for human approval before they execute. Call them normally when they are the right tool; the Worker handles the gate.",
      "Answer from tool results, not from memory. If a tool refuses, say what it refused and stop. Be brief and plain.",
    ].join("\n\n") + "\n\n" + greetingScript(firstName).trim()
  );
}

/* ---- the approval gate (P0-25) ----------------------------------------- *
 *
 * WHY THE MODEL CANNOT SELF-APPROVE, STRUCTURALLY:
 *
 * The approval token is not a value that travels. It is minted inside
 * `approve()` — which runs only in the handler for a POST that carried its own
 * Cloudflare Access assertion — and it is handed straight to `runTool` in the
 * same function call. It is never serialised into a response, never written
 * into `messages`, and never read from anything the model produced. During a
 * turn, `ctx` is built by `dispatch()` from the Access identity alone and has
 * no `approvalToken` property at all, so there is no field for model output to
 * land in: an approval cannot be forged in the loop because the loop has no
 * code path that sets one. Prompt injection can make the model *ask* for a T2
 * tool; it cannot make the tool execute, because the only thing that reaches
 * `runTool` with a token is a human's second HTTP request.
 *
 * The arguments are pinned the same way. The browser is given an opaque id, not
 * the arguments to send back; `approve()` re-reads the arguments from the
 * server-side record, so what executes is byte-for-byte what was rendered for
 * approval. A model that says one thing on screen and sends another on approve
 * has no channel to do it in.
 *
 * The record is in memory, which for this prototype means one Worker isolate.
 * That is a real limitation, and it fails closed: an approval that lands on a
 * cold isolate finds no record and is refused, rather than executing something
 * reconstructed from the request. A durable store replaces this Map without
 * changing the shape above.
 */
const PENDING = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 64;

function sweepPending(now) {
  for (const [id, rec] of PENDING) if (now - rec.at > PENDING_TTL_MS) PENDING.delete(id);
  while (PENDING.size >= PENDING_MAX) PENDING.delete(PENDING.keys().next().value);
}

function stashPending(rec) {
  const now = Date.now();
  sweepPending(now);
  const id = crypto.randomUUID();
  PENDING.set(id, { ...rec, at: now });
  return id;
}

/* ---- the Anthropic call ------------------------------------------------ */

async function callClaude(env, body) {
  /* ANTHROPIC_BASE_URL is the SDKs' own override and exists here for the same
     reason: pointing a local run at a recorder to assert on the request that
     goes upstream. Unset in every deployment, which is the real endpoint. */
  const url = `${env.ANTHROPIC_BASE_URL || API_BASE}/v1/messages`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    /* Service boundary. RULES.md: never swallow this. */
    console.error(`ERROR agent: Anthropic API unreachable — ${err.message}`);
    return { error: "The model service could not be reached." };
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`ERROR agent: Anthropic API ${res.status} — ${detail}`);
    return { error: `The model service returned ${res.status}.` };
  }

  try {
    return { message: await res.json() };
  } catch (err) {
    console.error(`ERROR agent: unparseable Anthropic response — ${err.message}`);
    return { error: "The model service returned something unreadable." };
  }
}

function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/* ---- tool dispatch ----------------------------------------------------- */

async function dispatch(name, args, { actor, role, env, allowed }) {
  /* Second enforcement of the same set. The model was never shown this tool;
     if it names one anyway, that is a refusal, not a call. */
  if (!allowed.has(name)) {
    return { kind: "result", block: { type: "tool_result", tool_use_id: null, content: `No such tool: ${name}.`, is_error: true } };
  }

  let out;
  try {
    /* No approvalToken. There is no expression in this function that can put
       one here, which is what makes the gate structural rather than polite. */
    out = await runTool(name, args, { actor, role, env });
  } catch (err) {
    console.error(`ERROR agent: tool dispatch failed for ${name} — ${err.message}`);
    return { kind: "result", block: { type: "tool_result", tool_use_id: null, content: `Tool ${name} failed.`, is_error: true } };
  }

  if (out && out.needsApproval) return { kind: "approval", out };

  const payload = out && out.ok ? JSON.stringify(out.data ?? null) : `Refused: ${(out && out.error) || "unknown error"}`;
  return {
    kind: "result",
    audit: out && out.auditId,
    block: { type: "tool_result", tool_use_id: null, content: payload, is_error: !(out && out.ok) },
  };
}

/* ---- an attached photo or file ------------------------------------------
 *
 * "A row of icons under chat; let the agent figure out what to do with them"
 * — the owner's own words. The bytes are ALREADY uploaded by the time this
 * file ever sees them (index.js's ingestAgentAttachment stores a photo in the
 * media store or a file in the asset store before calling agentTurn at all),
 * for the same reason catalog.upload_image never takes bytes as a tool
 * argument: a model cannot usefully re-emit a photo's bytes into a tool call,
 * only reference a key it was already given.
 *
 * A photo therefore reaches Claude TWICE, for two different reasons: as an
 * `image` content block, so the model can actually look at it and reason
 * about what it is showing (a coat, a receipt, a shelf) — and as a plain
 * sentence naming the key it is already stored under, so a tool call that
 * wants to use it (`catalog.create_product`'s `images`) references that key
 * directly rather than the model trying to invent one or call
 * catalog.upload_image a second, redundant time. A file that is not a photo
 * has no vision block at all — it is EXTRACTED TEXT, read the same way
 * assets.js already reads one for a person browsing /assets, folded into the
 * same sentence.
 */
function attachmentNote(attachment) {
  if (!attachment) return "";
  if (attachment.kind === "photo") {
    const preview = attachment.image
      ? ""
      : " (too large to preview inline here — judge it from the filename and what the person says)";
    return (
      `\n\n[Attached photo, filename "${attachment.filename}", already stored at media key ` +
      `"${attachment.key}"${preview}. If you use it on a product, pass this key directly in a catalog ` +
      "tool's images argument — it is already uploaded; do not call catalog.upload_image for it.]"
    );
  }
  return (
    `\n\n[Attached file, filename "${attachment.filename}", stored as asset id "${attachment.id}". ` +
    (attachment.extractedText
      ? `Extracted text follows:\n\n${attachment.extractedText}`
      : "No text could be extracted from this file type — ask the person what it contains if it matters.") +
    "]"
  );
}

export function buildUserContent(q, attachment) {
  const fallback = attachment ? "I attached a file — take a look and figure out what to do with it." : "";
  const text = (q || fallback) + attachmentNote(attachment);
  if (attachment?.kind === "photo" && attachment.image) {
    return [
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type: attachment.image.mediaType, data: attachment.image.base64 } },
    ];
  }
  return text;
}

/* ---- a turn ------------------------------------------------------------ */

/*
 * Runs one turn. Returns:
 *   { mode, actor, role, reply, steps: [{tool, tier, ok, auditId}], pending? }
 * `mode` is "stub" when no ANTHROPIC_API_KEY is set — the prototype keeps
 * working with no key and the page says so — or "model" otherwise.
 *
 * `attachment` (optional) is already-uploaded, from index.js's
 * ingestAgentAttachment — see the comment on buildUserContent above for why
 * this file never receives raw, unstored bytes.
 */
export async function agentTurn({ q, identity, env, attachment = null }) {
  const actor = identity.email;
  /* `env` is not optional here even though roleFor defaults it. Roles arrive as
     `policy_id`, matched against OWNER_POLICY_ID and its siblings, which live
     in env — without it every caller resolved to no role and the model was
     handed an empty tool list. */
  const role = roleFor(identity, env);

  if (!env.ANTHROPIC_API_KEY) {
    /* Benign, configured fallback: no key, no model. Quiet, per RULES.md. */
    return {
      mode: "stub",
      actor,
      role,
      steps: [],
      pending: null,
      reply: `Echo (ANTHROPIC_API_KEY unset, no model wired): ${q}${attachment ? ` [attached: ${attachment.filename}]` : ""}`,
    };
  }

  const defs = toolDefinitions(role);
  const allowed = new Set(defs.map((d) => d.name));
  const messages = [{ role: "user", content: buildUserContent(q, attachment) }];
  const steps = [];

  for (let round = 0; ; round++) {
    const { message, error } = await callClaude(env, {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(actor, role, defs, identity),
      tools: defs,
      messages,
    });
    if (error) return { mode: "model", actor, role, steps, pending: null, reply: error };

    if (message.stop_reason === "refusal") {
      return { mode: "model", actor, role, steps, pending: null, reply: "The model declined this request." };
    }

    const uses = (message.content || []).filter((b) => b.type === "tool_use");
    if (!uses.length) {
      return { mode: "model", actor, role, steps, pending: null, reply: textOf(message) || "(no reply)" };
    }

    if (round >= MAX_ROUND_TRIPS) {
      /* Fail closed on overrun: stop, do not run this round's tools. */
      console.warn(`WARNING agent: ${actor} hit the ${MAX_ROUND_TRIPS} tool round-trip cap; turn ended`);
      return {
        mode: "model",
        actor,
        role,
        steps,
        pending: null,
        reply: `Stopped after ${MAX_ROUND_TRIPS} tool calls without an answer. Nothing further was run.`,
      };
    }

    /* Echoed back unchanged, thinking blocks included — the API requires the
       assistant turn verbatim to continue on the same model. */
    messages.push({ role: "assistant", content: message.content });

    const results = [];
    for (const use of uses) {
      const outcome = await dispatch(use.name, use.input, { actor, role, env, allowed });

      if (outcome.kind === "approval") {
        /* A T2 tool wants a human. The turn stops here — including any sibling
           tool calls in the same assistant message, which are not run. */
        const tool = TOOLS[use.name];
        const id = stashPending({ actor, role, tool: use.name, args: use.input });
        return {
          mode: "model",
          actor,
          role,
          steps,
          reply: textOf(message) || `${use.name} needs your approval before it runs.`,
          pending: {
            id,
            tool: use.name,
            tier: (tool && tool.tier) || outcome.out.tier,
            args: use.input,
            effect: describeTool(tool, use.name, use.input),
            stores: (tool && tool.stores) || [],
          },
        };
      }

      steps.push({ tool: use.name, tier: (TOOLS[use.name] || {}).tier, ok: !outcome.block.is_error, auditId: outcome.audit });
      results.push({ ...outcome.block, tool_use_id: use.id });
    }

    /* Every result in ONE user message — splitting them teaches the model to
       stop calling tools in parallel. */
    messages.push({ role: "user", content: results });
  }
}

/* ---- applying an approved action --------------------------------------- */

/*
 * The human's POST arrives here with nothing but an id. The tool name and the
 * arguments come from the server-side record; the token is created on the line
 * below and dies inside runTool.
 */
export async function approve({ id, identity, env }) {
  const actor = identity.email;
  const role = roleFor(identity, env);

  sweepPending(Date.now());
  const rec = PENDING.get(id);
  if (!rec) return { ok: false, status: 404, reply: "That approval is unknown or has expired. Nothing was run." };

  /* Single use, whatever happens next — a refused approval burns the record
     too, so a wrong-actor attempt cannot be retried against a right one. */
  PENDING.delete(id);

  if (rec.actor !== actor) {
    console.error(`ERROR agent: approval ${id} raised by ${rec.actor} but approved by ${actor}; refused`);
    return { ok: false, status: 403, reply: "That approval belongs to a different person." };
  }

  /* Re-checked against the role as it is NOW, not as it was when proposed. */
  const tool = TOOLS[rec.tool];
  if (!mayUse(role, rec.tool, tool)) {
    return { ok: false, status: 403, reply: `Your role may not run ${rec.tool}.` };
  }

  let out;
  try {
    out = await runTool(rec.tool, rec.args, { actor, role, env, approvalToken: crypto.randomUUID() });
  } catch (err) {
    console.error(`ERROR agent: approved tool ${rec.tool} failed — ${err.message}`);
    return { ok: false, status: 502, reply: `${rec.tool} failed while running.` };
  }

  if (out && out.needsApproval) {
    /* The tool layer rejected the token. Fail closed and say so. */
    console.error(`ERROR agent: ${rec.tool} still needsApproval after an approved call`);
    return { ok: false, status: 403, reply: `${rec.tool} did not accept the approval.` };
  }

  return {
    ok: Boolean(out && out.ok),
    status: 200,
    tool: rec.tool,
    auditId: out && out.auditId,
    reply: out && out.ok ? `${rec.tool} ran. ${describeTool(tool, rec.tool, rec.args)}` : `${rec.tool} refused: ${(out && out.error) || "unknown error"}`,
  };
}
