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

import { TOOLS, runTool, CAPS } from "./tools/index.js";
import { draftProductBatch, draftCustomerBatch, previewBatch, planProductBatch, submitProductBatchRow } from "./batch.js";

const MODEL = "claude-sonnet-5";
const API_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 16000;

/* Six tool round-trips. Hit it and the turn ends; it does not send a seventh. */
const MAX_ROUND_TRIPS = 6;

/* index.js's own /agent route is a fresh HTTP request every time — nothing
   here persists a session — so without `history` every turn was the ONLY
   message the model ever saw, no matter how long the conversation had
   already run. Caught live: a plain "1" answering the menu's own "1) Add
   Merchandise..." got the SAME menu back, and a direct correction ("You
   are mistaking style id with title") was ignored, greeting again from
   scratch — turn N had no way to know turn N-1 had ever happened. Capped
   at the last MAX_HISTORY_TURNS entries so one very long conversation
   still bounds the request rather than growing forever. */
const MAX_HISTORY_TURNS = 24;

/* CAPS.MAX_TEXT (500) is sized for a short reason or note, not a full
   conversational reply — the very explanation this history exists to
   remember (a spreadsheet's own column-mapping writeup, say) routinely
   runs longer than that. Bounded here instead, generously enough that a
   normal reply is never visibly cut off, still far short of "unbounded". */
const MAX_HISTORY_TEXT = 4000;

/* searchIntent() below asks for a few words back, not a turn — 16000 tokens
   of headroom for that would be a cost bug waiting to happen, not caution. */
const SEARCH_INTENT_MAX_TOKENS = 30;

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
import { searchPlanPrompt } from "./voice-search.js";
import { skillsFor, skillByName } from "./skills.js";
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

/* Can this role use ANYTHING in this domain? Asks the same tool list the
   tools themselves are filtered from, not a second table of domains — which
   is how skill visibility and tool visibility would come to disagree. The
   sole consumer is skillsFor() below: a skill for tools this role cannot
   call is not listed, for the same reason those tools are not listed. */
export function canUseDomain(role, domain) {
  const d = String(domain || "").toLowerCase();
  return allowedTools(role).some(([, tool]) => String(tool.domain || "").toLowerCase() === d);
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
  /* "record" (validate.js) is our own name for a free-form field-name ->
     string-value map — JSON Schema has no such primitive type, but expresses
     the identical shape as a plain "object" with no fixed `properties` and
     a schema on `additionalProperties` instead. */
  if (spec.type === "record") {
    const out = { type: "object", additionalProperties: { type: "string" } };
    if (spec.valueMaxLength !== undefined) out.additionalProperties.maxLength = spec.valueMaxLength;
    if (spec.maxKeys !== undefined) out.maxProperties = spec.maxKeys;
    return out;
  }
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
 * Tool ids are `domain.verb` — every one of them, by convention, everywhere
 * else in this codebase. Anthropic's own tool name grammar is
 * `^[a-zA-Z0-9_-]{1,128}$`: no dot. Every real call has 400'd on this from
 * the day a live key was first configured (P0-86) — the fix that made the
 * error visible (surfacing Anthropic's own message) is what finally named
 * it: `tools.2.custom.name: String should match pattern '^[a-zA-Z0-9_-]
 * {1,128}$'`. `toolDefinitions()` itself keeps the dotted names — tests,
 * TOOLS lookups and every caller in this file besides the actual API call
 * depend on that — so the wire form exists only at the two points that
 * touch Anthropic: the `tools` array in the request, and translating a
 * `tool_use` block's name back before dispatching it.
 */
export const wireName = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/*
 * Skills used to reach a model only through the MCP endpoint — a tool name
 * says what it is called, but not that the category set is closed, that
 * price and publish are two gates, that a photograph goes through an upload
 * ticket. Removing MCP (P0-81) would have made that knowledge unreachable
 * by any code path, so the built-in chat gets the same two meta-tools an MCP
 * client always had: `skills_list` names what is readable at this role,
 * `skills_read` returns one in full. These are not in TOOLS — they read
 * skills.js directly rather than going through runTool, since they touch no
 * store and need no audit row.
 */
const SKILLS_TOOL_DEFS = [
  {
    name: "skills_list",
    description:
      "List the skill documents available at this role — how the tools here are meant to be used, " +
      "not just what they are called. Read these before your first write. " +
      "Returns name, description and size; skills_read returns the text.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "skills_read",
    description:
      "Return one skill document in full, by the name skills_list gave. " +
      "Markdown, exactly as it is maintained in the repository.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "A name from skills_list, e.g. catalog-skills", maxLength: 60 } },
      required: ["name"],
    },
  },
];

function skillsListResult(role) {
  const visible = skillsFor(role, canUseDomain);
  return JSON.stringify(
    {
      skills: visible.map(({ name, title, description, version, bytes }) => ({ name, title, description, version, bytes })),
      start_with: "agent-tool-contract",
      note: "Filtered to this role. A skill for tools you cannot call is not listed, for the same reason those tools are not listed.",
    },
    null,
    2,
  );
}

function skillsReadResult(role, name) {
  const skill = skillByName(name);
  const visible = skill && skillsFor(role, canUseDomain).some((s) => s.name === skill.name);
  if (!visible) {
    return { isError: true, text: `No skill named ${JSON.stringify(name)} is available to you. Call skills_list for the ones that are.` };
  }
  return { isError: false, text: skill.text };
}

/*
 * A dropped spreadsheet used to reach the model as a wall of raw extracted
 * text (attachmentNote below, before this) — a model doing its own ad hoc
 * column-matching and price parsing on free-form text, with none of the
 * closed-category-set validation or per-row approval linking /products/batch
 * and /customers/batch already do deterministically. "Not the dumb uploading
 * pathway... I want the chat to be the main interface" — the owner's own
 * words: these meta-tools call the SAME draftProductBatch/draftCustomerBatch/
 * previewBatch functions the page routes use, so a spreadsheet dropped in
 * chat gets the identical column-heading matching, category and price
 * validation, and one T2 approval link per clean row — just presented
 * conversationally instead of behind a page visit.
 *
 * PREVIEW BEFORE DRAFT. "The agent should confirm with me about its
 * selections if it is unsure... a brief preview of the first row and
 * headings before generating the actual [batch]" — the owner's own words.
 * Drafting mints a real T2 approval link per clean row the moment it runs;
 * a wrong column match is 400 approval links to click through or cancel one
 * at a time, not one mistake to fix. The preview tools below read only the
 * first row and mint nothing, so a person can catch a wrong mapping before
 * the real draft ever runs. The person's own confirmation is still a real
 * chat reply, in words — "does this look right?" / "yes" — never skipped.
 *
 * REVISED — the confirmation still happens in chat, but the asset id no
 * longer has to survive in the MODEL's own memory to get there at all. A
 * real transcript showed exactly why that used to fail: previewed, the
 * person replied "Yes," and the very next turn — with nothing but its own
 * stripped-down text history (sanitizeHistory, below, keeps only the
 * client's own rendered chat bubbles: no tool call, no tool result, no
 * attachment note) — the model could no longer find the asset id at all
 * ("refused assets.list", "refused catalog_draft_product_batch," twice
 * each, then "I can't find its asset id right now"). `attachmentNote`'s
 * own asset id is handed to the model exactly once, in the turn the file
 * was attached, and a person's reply to the preview always arrives LATER.
 *
 * REVISED AGAIN — the FIRST fix here tried tagging the preview's own TOOL
 * RESULT text with the asset id, on the theory that "a later turn's history
 * still has it." It does not: `dispatchBatchPreview`'s return value is a
 * `tool_result` the MODEL reads on the same turn, never a chat bubble a
 * person sees or the client stores into `history` — only the model's OWN
 * subsequent reply text does that, and `NO_TEXT_TABLE_NOTE` (below) already
 * tells the model to keep that short and table-free, giving it every reason
 * to leave a raw id tag out. A second real transcript proved it: the exact
 * same failure recurred, unchanged. The asset id now survives the turn
 * boundary a different way, one the model cannot forget to do right because
 * it never has to do anything: `dispatchBatchPreview` records, SERVER-SIDE,
 * which asset this exact actor most recently previewed (`LAST_PREVIEW`,
 * below — the identical in-memory, per-isolate, TTL'd pattern `PENDING`
 * already uses for approvals, with the identical accepted limitation: a
 * cold isolate loses it, and that fails closed into the honest "please
 * re-attach it" outcome, never a wrong file). `dispatch()`'s own
 * catalog_draft_product_batch/customer_draft_customer_batch handling now
 * prefers that server-side record over whatever asset_id the model's own
 * call happens to carry — correct precisely because both tools' own
 * descriptions already require preview to be called on the same asset
 * immediately before draft, so "the actor's own most recent preview" and
 * "the asset this draft call means" are the same fact by construction. This
 * is the THIRD time this exact failure has been diagnosed (see
 * precheckBatchDraft's own comment below for the first, narrower fix — the
 * approval click itself needing no model memory of the id — which never
 * covered the model successfully making that first call at all).
 *
 * REVISED AGAIN — "I shouldn't need to do that," the owner's own words,
 * looking at the approval card catalog_draft_product_batch used to stash
 * even after the person had ALREADY said yes to the preview in chat. That
 * card was a second click on the same decision, not a second safety check.
 * catalog_draft_product_batch (dispatch(), below) now runs the moment it is
 * called — no button, no PENDING record — trusting the chat confirmation
 * that already happened as the one deliberate approval this represents. A
 * row-level CLASH is unaffected either way: it still parks its own,
 * genuinely necessary approval link (createRows, batch.js), the same as it
 * always has. customer_draft_customer_batch is UNCHANGED — a clean customer
 * row never creates immediately even once the batch itself is approved, it
 * always mints its own separate, individual review link regardless, so the
 * outer click there is not a redundant second yes on top of one already
 * given; it is still the only place the batch as a whole is approved at
 * all.
 *
 * Manager+ only for both, matching catalog.create_product's and
 * customer.create's own tier — offered only to roles that could actually
 * approve what the draft tools mint.
 */
/* "Dont rely on text to try to explain table structure. Thats why you have
   a scrolling preview... This is useless" — the owner's own words, after
   watching the model restate a preview's rows as its own markdown table in
   the chat reply, right next to the actual `table` the client already
   renders for exactly that. The first wording here only named "a markdown
   table or grid" — the model found the loophole immediately and switched
   to a bulleted field-by-field mapping ("- **Title** ← 'style #'...")
   instead, the identical restatement in a different shape. The note below
   now bans the WHOLE CATEGORY: any prose, bullet list, or arrow-style
   mapping that walks through the row/column structure by hand, not one
   named format among others. Relaying the data at all (a second, worse
   copy of the same table) is not the model's job here, only judging it
   and asking about it is. */
export const NO_TEXT_TABLE_NOTE =
  " A compact, scrollable table of this data is rendered for the person automatically — never restate it " +
  "yourself in any form (a markdown table, a bulleted or arrow-style field-by-field mapping, an ASCII grid); " +
  "reply in one or two plain sentences (counts, anything that looks wrong) and let the table do the showing.";

const PREVIEW_TOOL_DEFS = [
  {
    name: "catalog_preview_product_batch",
    description:
      "Read only the column headings and first row of an attached spreadsheet (asset id from the attachment " +
      "note) and show how they map to title/category/price/description/sku — without creating anything at " +
      "all. Call this FIRST for any spreadsheet of products: catalog_draft_product_batch now creates every " +
      "row that resolves cleanly IMMEDIATELY, with no approval step of its own, so this preview is the one " +
      "chance to catch a wrong column mapping before it becomes real, wrong products — show the person the " +
      "mapping, and wait for them to confirm it looks right before calling catalog_draft_product_batch. " +
      "You do not need to remember or re-supply this exact asset id later: this app tracks, on its own, " +
      "which file you most recently previewed for you, and catalog_draft_product_batch automatically uses " +
      "that one when you call it — pass whatever asset_id you have at that point, even a guess, it is not " +
      "what actually decides which file gets drafted." +
      NO_TEXT_TABLE_NOTE,
    /* A row that resolves cleanly still creates immediately, unaffected;
       a row with a real CLASH (a category name already numbered
       differently, a SKU already used elsewhere, an unparseable price)
       parks an ordinary, editable approval link instead of skipping —
       "the only time you want to do an approval link is if there's a
       clash and it has to be resolved by a person" — the owner's own
       words. This preview cannot catch a clash ahead of time (most only
       surface once real resolution runs), but it still catches the
       wrong-mapping case this note above is about. */
    input_schema: {
      type: "object",
      properties: { asset_id: { type: "string", description: "The asset id named in the attachment note." } },
      required: ["asset_id"],
    },
  },
  {
    name: "customer_preview_customer_batch",
    description: "The same as catalog_preview_product_batch, for a spreadsheet of customers instead of products." + NO_TEXT_TABLE_NOTE,
    input_schema: {
      type: "object",
      properties: { asset_id: { type: "string", description: "The asset id named in the attachment note." } },
      required: ["asset_id"],
    },
  },
];

const BATCH_TOOL_DEFS = [
  {
    name: "catalog_draft_product_batch",
    description:
      "Parse an attached spreadsheet (already uploaded — pass the asset id from the attachment note) " +
      "into products: matches column headings (title/name/item/style, category, price, description, sku " +
      "— any reasonable spelling) the same way /products/batch does, and CREATES every row that resolves " +
      "cleanly RIGHT NOW — no approval link, no second click, the person's own chat confirmation IS the " +
      "deliberate action. A row with a genuine CLASH instead (a category name already numbered differently, " +
      "a SKU already used by a different product, a price that will not parse) mints its OWN separate, " +
      "EDITABLE T2 approval link for a person to open, fix, and approve — never silently guessed at, never " +
      "a bare skip either, since \"the only time you want to do an approval link is if there's a clash and " +
      "it has to be resolved by a person\" is the owner's own rule. Every other genuinely bad row (nothing " +
      "to salvage — a rate cap, the actor's own role) is still reported as a plain skip with its real " +
      "reason, never blocking any OTHER row. Call catalog_preview_product_batch on the same asset FIRST and " +
      "wait for the person to confirm the mapping looks right before calling this one — a clean row is not " +
      "undoable by declining, there is no button left to not click. This app automatically drafts whichever " +
      "file you most recently previewed, regardless of the asset_id argument given here, so there is no need " +
      "to recall or re-derive the exact id from an earlier turn — pass whatever value is at hand and never " +
      "call assets.list to try to relocate the file yourself. This is the same deterministic logic the " +
      "dedicated upload page uses, just reached from chat." +
      NO_TEXT_TABLE_NOTE,
    input_schema: {
      type: "object",
      properties: { asset_id: { type: "string", description: "The asset id named in the attachment note." } },
      required: ["asset_id"],
    },
  },
  {
    name: "customer_draft_customer_batch",
    description:
      "Mostly the same as catalog_draft_product_batch (call customer_preview_customer_batch on the same " +
      "asset first, wait for the person to confirm the mapping, then call this one — this app automatically " +
      "drafts whichever file was most recently previewed, regardless of the asset_id argument given here, " +
      "so pass whatever value is at hand and never call assets.list to try to relocate the file yourself) — " +
      "but UNLIKE that one, this call itself still shows the person a real Approve button first (a bulk " +
      "customer import is still its own T2 decision) and, even once they click it, a customer row is STILL " +
      "never created immediately: every row that resolves cleanly mints its OWN separate T2 approval link " +
      "instead, for a person to open and approve individually — customer records always go through that " +
      "ordinary, per-row approval step." +
      NO_TEXT_TABLE_NOTE,
    input_schema: {
      type: "object",
      properties: { asset_id: { type: "string", description: "The asset id named in the attachment note." } },
      required: ["asset_id"],
    },
  },
];

function canDraftBatches(role) {
  return role === "manager" || role === "owner";
}

async function readAssetText(env, assetId) {
  if (!env.ASSETS) {
    return { isError: true, text: "No asset store is bound on this deployment, so an uploaded spreadsheet cannot be read back." };
  }
  let row;
  try {
    row = await env.ASSETS.prepare("SELECT extracted_text, content_type, filename FROM asset WHERE id = ?")
      .bind(assetId)
      .first();
  } catch (err) {
    console.error(`ERROR agent: reading asset ${assetId} failed — ${err.message}`);
    return { isError: true, text: "Could not read that asset back." };
  }
  if (!row) return { isError: true, text: `No asset '${assetId}'. Use the id from the attachment note, not a guess.` };
  if (!row.extracted_text) {
    return { isError: true, text: `"${row.filename}" has no readable text — is it actually a spreadsheet (.csv)?` };
  }
  return { isError: false, row };
}

/* One line per row, so the model has something plain to relay rather than
   re-deriving prose from a JSON blob — the same reason describeTool exists
   for a single-item proposal. `table` is the same information shaped for
   the client's own compact review table, not for the model at all. */
/* Products create immediately (createRows, batch.js) — "I don't want to
   sit here and approve them" — the owner's own words — UNLESS a row hit a
   genuine CLASH, REVISED: "the only time you want to do an approval link
   is if there's a clash and it has to be resolved by a person" — parked
   the ordinary way instead (`result.ready`), same as every row a customer
   batch parks (parkRows, unchanged) always has been. `result.created` is
   `undefined` for customers — there is no immediate-creation bucket for
   that kind at all, so it is simply treated as empty throughout. */
function formatBatchDraft(kind, result) {
  if (result.tooMany !== undefined) {
    return `The spreadsheet has ${result.tooMany} rows, past the ${CAPS.BATCH_MAX_ROWS}-row cap for one upload. Split it and try again.`;
  }
  const created = result.created ?? [];
  const ready = result.ready ?? [];
  const lines = [`${created.length} ${kind} created, ${ready.length} need a person's decision, ${result.skipped.length} skipped.`];
  for (const r of created) lines.push(`- Row ${r.row} "${r.title}": created — ${r.summary}`);
  for (const r of ready) lines.push(`- Row ${r.row} "${r.title}": ${r.summary} — ${r.url}`);
  for (const s of result.skipped) lines.push(`- Row ${s.row} "${s.title}": skipped — ${s.reason}`);
  return lines.join("\n");
}

function batchDraftTable(kind, result) {
  if (result.tooMany !== undefined) return null;
  const created = result.created ?? [];
  const ready = result.ready ?? [];
  const rows = [
    ...created.map((r) => [String(r.row), r.title, "created", r.summary]),
    ...ready.map((r) => [String(r.row), r.title, "needs a person", `${r.summary} — ${r.url}`]),
    ...result.skipped.map((s) => [String(s.row), s.title, "skipped", s.reason]),
  ];
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  return {
    title: `${kind[0].toUpperCase()}${kind.slice(1)}: ${created.length} created, ${ready.length} need a person's decision, ${result.skipped.length} skipped`,
    columns: ["Row", "Title", "Status", "Detail"],
    rows,
    /* "It says 9 need a person's decision but the next preview row is too
       short! I can't see shit, it's collapsed!!" — a real batch result can
       carry as many rows as the sheet did, same as a preview can, and this
       table was still stuck at the plain 86px cap nothing but a preview
       (P0-117/P0-89's own "three times taller") ever got raised — never
       ellipsis-cropped the way a preview is, though (views.js's own
       TABLE_CARD_CSS comment): a skip reason or a park link here is worth
       reading in full, not just recognizing the shape of. */
    tall: true,
  };
}

async function dispatchBatchDraft(name, args, { actor, role, env }) {
  if (!canDraftBatches(role)) {
    return { isError: true, text: "Your role cannot do what this would create — a manager or owner has to do this one." };
  }
  const asset = await readAssetText(env, args?.asset_id);
  if (asset.isError) return asset;

  const draft = name === "catalog_draft_product_batch" ? draftProductBatch : draftCustomerBatch;
  const kind = name === "catalog_draft_product_batch" ? "products" : "customers";
  const onProgress = (progress) => recordBatchProgress(actor, { ...progress, kind });
  try {
    const result = await draft(env, { text: asset.row.extracted_text, actor, role, onProgress });
    return { isError: false, text: formatBatchDraft(kind, result), table: batchDraftTable(kind, result) };
  } catch (err) {
    console.error(`ERROR agent: ${name} failed — ${err.message}`);
    return { isError: true, text: `Drafting from "${asset.row.filename}" failed: ${err.message}` };
  } finally {
    /* Whether it finished or threw, there is nothing left in flight for the
       client to poll for — a record left behind here would show a stale
       "6 of 16" forever, to a client that has already moved on. */
    clearBatchProgress(actor);
  }
}

/*
 * catalog_draft_product_batch's OWN dispatch, replacing a call straight
 * through to draftProductBatch (dispatchBatchDraft, above, still customers'
 * own path unchanged) — "have the agent check everything and fill
 * everything out and then just do a straight submit... with the progress
 * bar," the owner's own words, and the fix for a real "too many
 * subrequests" report a single giant create-everything call hit. See
 * planProductBatch's own header comment (batch.js) for why: this plans the
 * whole batch in one call (still bounded, still safe — resolving whatever
 * DISTINCT categories/subcategories the sheet names, never one Square
 * write per ROW), stashes whatever is genuinely ready to submit, and hands
 * the chat a CHECKLIST instead of a finished result — dispatch() (below)
 * turns that into agentTurn()'s own new `checklist` field, the same way an
 * `approval` outcome already becomes `pending`. Nothing here creates a
 * single product; that only happens later, one row per request, through
 * submitBatchPlanRow.
 */
async function dispatchProductBatchPlan(args, { actor, role, env }) {
  const asset = await readAssetText(env, args?.asset_id);
  if (asset.isError) return asset;

  let plan;
  try {
    plan = await planProductBatch(env, { text: asset.row.extracted_text, actor, role });
  } catch (err) {
    console.error(`ERROR agent: catalog_draft_product_batch planning failed — ${err.message}`);
    return { isError: true, text: `Drafting from "${asset.row.filename}" failed: ${err.message}` };
  }

  /* Nothing left needing a person to pick rows at all -- either every row
     was a clash/skip already (parked or reported below, same as always),
     or the sheet had no product rows in it. Relayed exactly like the old
     one-call draft always did for this same shape (formatBatchDraft/
     batchDraftTable already treat a missing `created` as empty). */
  if (!plan.rows.length) {
    const result = { ready: plan.ready, skipped: plan.skipped, tooMany: plan.tooMany };
    return { isError: false, text: formatBatchDraft("products", result), table: batchDraftTable("products", result) };
  }

  const id = stashBatchPlan({ actor, role, rows: plan.rows, rate: plan.rate, total: plan.rows.length });
  const readyCount = plan.rows.length;
  const lines = [
    `${readyCount} products ready to submit, ${plan.ready.length} need a person's decision, ${plan.skipped.length} skipped.`,
    "Review the list and press Submit to create the ready ones.",
  ];
  return {
    isError: false,
    text: lines.join("\n"),
    table: batchDraftTable("products", { ready: plan.ready, skipped: plan.skipped }),
    checklist: {
      id,
      rows: plan.rows.map((r) => ({ row: r.rowNumber, title: r.title, summary: r.summary })),
    },
  };
}

/*
 * Shared by both catalog_draft_product_batch and customer_draft_customer_batch
 * (dispatch(), below), which now diverge right after this same pre-check:
 *
 *   - customer_draft_customer_batch still stashes a real PENDING approval
 *     here (the mechanism this comment used to describe for both) — "I need
 *     to be able to click yes or no," the owner's own words, from the round
 *     that added it, still stands for customers: even once approved, a
 *     clean customer row STILL never creates on its own, it still mints its
 *     own separate, individual approval link (createRows, batch.js) — the
 *     outer click here is the only place the BATCH as a whole is ever
 *     approved, not a redundant second yes on top of one already given.
 *   - catalog_draft_product_batch, REVISED, no longer stashes anything at
 *     all — "I shouldn't need to do that," the owner's own words, looking
 *     at exactly this approval card for a product batch. A person who
 *     already confirmed the preview mapping looks right has already made
 *     the one deliberate decision this call represents; this pre-check
 *     (role, the asset genuinely exists and has readable text, the row cap)
 *     still runs, so a bad call still fails the same honest way it always
 *     did, but dispatch() now runs the real draft immediately right after
 *     it, no button, no PENDING record, no second click for the same yes.
 */
async function precheckBatchDraft(name, args, { role, env }) {
  if (!canDraftBatches(role)) {
    return { isError: true, text: "Your role cannot do what this would create — a manager or owner has to do this one." };
  }
  const asset = await readAssetText(env, args?.asset_id);
  if (asset.isError) return asset;
  /* The row cap is checked here too, not only inside the real draft, so a
     sheet that is already known to be too big is refused immediately —
     never offering a confirm button for something that cannot proceed
     either way. previewBatch's own {rowCount} is side-effect-free, the
     same reason dispatchBatchPreview already trusts it. */
  const kind = name === "catalog_draft_product_batch" ? "products" : "customers";
  const preview = previewBatch(asset.row.extracted_text, kind);
  if (preview.rowCount > CAPS.BATCH_MAX_ROWS) {
    /* Not a tool error (isError stays false, matching dispatchBatchDraft's
       own tooMany case below) -- a real, expected outcome the model
       should simply relay, same as it always could. */
    return {
      isError: false,
      tooMany: true,
      text: `The spreadsheet has ${preview.rowCount} rows, past the ${CAPS.BATCH_MAX_ROWS}-row cap for one upload. Split it and try again.`,
    };
  }
  return { isError: false, filename: asset.row.filename };
}

/* Preview relays previewBatch's own {headers, rowCount, sampleRows} — a
   read-only look at column headings, so a wrong mapping is caught before
   the draft tools mint anything.
   REVISED — "I always wanted to be able to click on the chat preview and
   expand and see the entire column, entire like a table... scroll up and
   down and just review the entire contents" — previewBatch's own
   `sampleRows` now carries every interpreted product/customer, not a
   sample; this text stays a SHORT orientation regardless (still just the
   first one), the same reason NO_TEXT_TABLE_NOTE bans restating the whole
   table as prose elsewhere in this file — the structured table below is
   where "the entire contents" actually lives, and where "scroll up and
   down"/"Full screen" (views.js) actually work. */
const PREVIEW_TEXT_SAMPLE = 1;

/* REVISED, THEN REVERTED — a round briefly appended a "[asset id: ...]" tag
   here, on the theory that a later turn's own history would still carry it.
   It does not: this function's return value is a tool_result the MODEL
   reads on the turn it is produced, never a chat bubble the person sees or
   the client stores into `history` — only the model's OWN subsequent reply
   text does that, and nothing here controls what the model chooses to say.
   The asset id now survives the turn boundary a different way entirely
   (LAST_PREVIEW, a server-side record keyed by actor — see the header
   comment above PREVIEW_TOOL_DEFS), so this function is back to describing
   the preview and nothing else. */
function formatBatchPreview(kind, preview) {
  if (!preview.rowCount) return "That spreadsheet has no rows to preview.";
  const noun = kind === "customers" ? "customers" : "products";
  const singular = noun.slice(0, -1);
  const total = preview.sampleRows.length;
  /* Grouping (previewBatch's own splitProductRecords, batch.js) can drop a
     row outright -- a non-blank style-id cell that does not parse as one at
     all, "if they don't have that style ID pattern, then just ignore that"
     -- the same way the real draft silently drops it. Every row detected
     but none of them a real one to interpret is a genuinely different case
     from an empty sheet, and previewTable() below has nothing to build a
     table from either way. */
  if (!total) {
    return (
      `${preview.rowCount} row${preview.rowCount === 1 ? "" : "s"} detected, but none of them could be read as a ${singular} — ` +
      `check that the column mapping (${preview.headers.join(", ")}) is what was intended.`
    );
  }
  const shown = preview.sampleRows.slice(0, PREVIEW_TEXT_SAMPLE);
  const lines = shown.map((row, i) => {
    const fields = Object.entries(row)
      .map(([field, value]) => `${field}=${value === null ? "—" : value}`)
      .join(", ");
    return `  ${singular} ${i + 1}: ${fields}`;
  });
  return (
    `${preview.rowCount} row${preview.rowCount === 1 ? "" : "s"} detected, interpreted as ${total} ${total === 1 ? singular : noun}. ` +
    `Columns found: ${preview.headers.join(", ")}.\n\n` +
    `For example, as one would read:\n${lines.join("\n")}\n\n` +
    `The complete, expandable table below has every ${singular} this file was interpreted as — have the person review it in full there ` +
    "before drafting the rest, since a wrong mapping there will be wrong for every row."
  );
}

function previewTable(kind, preview) {
  if (!preview.rowCount || !preview.sampleRows.length) return null;
  const noun = kind === "customers" ? "customers" : "products";
  const singular = noun.slice(0, -1);
  const total = preview.sampleRows.length;
  const columns = Object.keys(preview.sampleRows[0]);
  return {
    title: `Preview: ${total} ${total === 1 ? singular : noun} interpreted from ${preview.rowCount} row${preview.rowCount === 1 ? "" : "s"}`,
    columns,
    /* "Instead of using not found, just use the dash... kind of like
       indicate that it's not there, it's not available" — the owner's own
       words. A blank/missing field reads as a plain "—", the same
       lightweight not-applicable marker positionalField() (batch.js)
       already uses for a single missing value inside a per-variant list,
       rather than the more alarming, wordier "(not found)". */
    rows: preview.sampleRows.map((row) => columns.map((c) => (row[c] === null ? "—" : String(row[c])))),
    /* Collapsed to a small default height by CSS (TABLE_CARD_CSS's own
       .table-card.preview) — REVISED, no longer because the data itself was
       ever this small: it now carries every row/group the sheet was
       interpreted as, same as batchDraftTable()'s own result, scrollable in
       place or via "Full screen" (views.js's tableCard()) either way. */
    compact: true,
  };
}

async function dispatchBatchPreview(name, args, { actor, role, env }) {
  if (!canDraftBatches(role)) {
    return { isError: true, text: "Your role cannot approve what this would create — a manager or owner has to do this one." };
  }
  const asset = await readAssetText(env, args?.asset_id);
  if (asset.isError) return asset;

  const kind = name === "catalog_preview_product_batch" ? "products" : "customers";
  try {
    const preview = previewBatch(asset.row.extracted_text, kind);
    /* Recorded on a SUCCESSFUL preview only — a bad asset_id must never
       overwrite a real, earlier preview this same actor could still go on
       to confirm. See LAST_PREVIEW's own header comment for why this,
       rather than a tag in this call's own reply text, is what actually
       carries the id across the turn boundary to the confirming draft
       call. */
    recordLastPreview(actor, kind, args.asset_id);
    return { isError: false, text: formatBatchPreview(kind, preview), table: previewTable(kind, preview) };
  } catch (err) {
    console.error(`ERROR agent: ${name} failed — ${err.message}`);
    return { isError: true, text: `Previewing "${asset.row.filename}" failed: ${err.message}` };
  }
}

/*
 * This built-in browser chat is the "stupid simple" path — the one click
 * from the ops front page, no external app, no connector setup. It is now
 * the ONLY path (P0-81 removed MCP), so this is the sole place the
 * greeting-and-menu protocol has to work.
 *
 * SKILLS ARE ON-DEMAND, NOT A MANDATORY FIRST STEP (P0-82). Forcing
 * skills_list -> skills_read("agent-tool-contract") before every single
 * conversation added two guaranteed round-trips of latency and tokens to
 * even the most trivial lookup — for a document whose operational content
 * (tiers, the greeting, the approval-link framing) is already inline below
 * and in greetingScript(). The owner's own words: "minimize confusion...
 * minimizing churn and token use... present most likely solution." A
 * capable model should try the obvious, most-likely-correct tool call
 * first and consult a domain skill only when it is actually unsure — a
 * refusal is cheap to recover from; a forced read on every turn is not.
 */
export function systemPrompt(actor, role, defs, claims) {
  const firstName = firstNameFrom(claims, actor);
  return (
    [
      `You are the Vemians ops assistant on ops.vemians.com. The person you are talking to is ${actor}` +
        ` (${role}), first name ${firstName}.`,
      `You have exactly ${defs.length} tool${defs.length === 1 ? "" : "s"}. That list is the whole of what you can reach: it is built from this person's role before the request leaves the Worker, so anything absent from it is unreachable, not merely forbidden. Do not describe tools you do not have, and do not offer to run one.`,
      "Tools marked tier 2 stop for human approval before they execute. Call them normally when they are the right tool; the Worker handles the gate.",
      `If you are unsure of a domain's own rules — the category list, price/publish gates, an upload flow — call skills_read on "<domain>-skills" (skills_list names them). This is for when you are genuinely unsure, not a ritual to run before every call: try the most likely correct action first.`,
      "Answer from tool results, not from memory. If a tool refuses, say what it refused and stop. Be brief and plain.",
      "Never restate a tool result's own rows or columns in your reply — not as a markdown table, an ASCII grid, a pipe-delimited list, nor a bulleted or arrow-style field-by-field mapping (\"- **Title** ← ...\"). When a tool's own description says a table is already shown to the person, it means exactly that, in any format: your job is a short prose summary and a judgment call, not a second copy of the data in different clothes.",
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

/*
 * A planned, not-yet-submitted product batch — "have the agent check
 * everything and fill everything out and then just do a straight submit
 * ... with the progress bar," the owner's own words, and the actual fix
 * for the earlier "too many subrequests" report: planProductBatch (batch.js)
 * resolves every row's category/subcategory once, together, then stops —
 * the checklist offered back is genuinely ready to submit, one row per
 * later, SEPARATE request (submitBatchPlanRow, below), each its own fresh
 * Cloudflare invocation and subrequest budget. The identical in-memory,
 * per-isolate, TTL'd shape PENDING (above) already uses, keyed by a minted
 * id the same way — this is not one durable "the batch" record either, it
 * shrinks as rows are submitted (submitBatchPlanRow splices the row it just
 * ran out of `rows`) and is deleted outright once none are left, the same
 * "single use" property PENDING already has, just spent N times instead of
 * once. `rate` rides along whole: every one of a plan's own later, separate
 * submit requests still spends from the ONE budget planProductBatch's own
 * header comment sized for the whole batch, never a fresh one per row.
 */
const BATCH_PLANS = new Map();
const BATCH_PLAN_TTL_MS = 15 * 60 * 1000;
const BATCH_PLAN_MAX = 64;

function sweepBatchPlans(now) {
  for (const [id, rec] of BATCH_PLANS) if (now - rec.at > BATCH_PLAN_TTL_MS) BATCH_PLANS.delete(id);
  while (BATCH_PLANS.size >= BATCH_PLAN_MAX) BATCH_PLANS.delete(BATCH_PLANS.keys().next().value);
}

function stashBatchPlan(rec) {
  const now = Date.now();
  sweepBatchPlans(now);
  const id = crypto.randomUUID();
  BATCH_PLANS.set(id, { ...rec, at: now });
  return id;
}

/*
 * Which asset THIS ACTOR most recently previewed, for THIS kind of batch —
 * so a later confirmation reply can find the right file without the model
 * ever having to recall or repeat its id. See the "PREVIEW BEFORE DRAFT"
 * header comment, above PREVIEW_TOOL_DEFS, for the two things this replaced
 * (a chat turn's own stripped-down history; a tag in a tool result the
 * model was never going to relay to the person on its own) and why both
 * failed for the same underlying reason. The identical in-memory,
 * per-isolate, TTL'd shape PENDING (above) already uses for approvals, with
 * the identical accepted limitation: a cold isolate loses the record, and a
 * later confirmation then falls back to whatever asset_id the model's own
 * call happens to carry (usually none, or a guess) — the same honest
 * "please re-attach it" outcome this always degraded to before, never a
 * wrong file drafted by mistake. Keyed by actor+kind, not by any per-file
 * or per-conversation id, on purpose: catalog_draft_product_batch's own
 * description already requires preview to be called on the very same asset
 * immediately before draft, so "the actor's own most recent preview of this
 * kind" and "the asset this draft call means" are the same fact by
 * construction, not a guess.
 */
const LAST_PREVIEW = new Map();
const LAST_PREVIEW_TTL_MS = 15 * 60 * 1000;
const LAST_PREVIEW_MAX = 256;

function sweepLastPreview(now) {
  for (const [key, rec] of LAST_PREVIEW) if (now - rec.at > LAST_PREVIEW_TTL_MS) LAST_PREVIEW.delete(key);
  while (LAST_PREVIEW.size >= LAST_PREVIEW_MAX) LAST_PREVIEW.delete(LAST_PREVIEW.keys().next().value);
}

function recordLastPreview(actor, kind, assetId) {
  const now = Date.now();
  sweepLastPreview(now);
  LAST_PREVIEW.set(`${actor}::${kind}`, { assetId, at: now });
}

function lastPreviewedAsset(actor, kind) {
  sweepLastPreview(Date.now());
  return LAST_PREVIEW.get(`${actor}::${kind}`)?.assetId ?? null;
}

/*
 * Live progress for a batch draft actually running right now — "I don't like
 * how the agent goes silent without any progress reports as it creates the
 * new products," the owner's own words. draftProductBatch/draftCustomerBatch
 * (batch.js) already run every row to completion, several real Square writes
 * each, before dispatchBatchDraft (below) returns anything at all — nothing
 * reaches the chat until that ONE call the browser is already blocked on
 * finally resolves. This is a third record in the identical in-memory,
 * per-isolate, TTL'd shape PENDING/LAST_PREVIEW (above) already use, keyed by
 * actor alone like LAST_PREVIEW: the one batch an actor could plausibly have
 * running right now is the one this record means, by the same construction.
 * index.js's own GET /agent/batch-progress is a separate, cheap route the
 * client polls while the one real POST is still in flight; the same "a cold
 * isolate loses the record" limitation PENDING already accepts degrades this
 * to simply no progress shown, never a wrong one.
 */
const BATCH_PROGRESS = new Map();
const BATCH_PROGRESS_TTL_MS = 15 * 60 * 1000;
const BATCH_PROGRESS_MAX = 256;

function sweepBatchProgress(now) {
  for (const [key, rec] of BATCH_PROGRESS) if (now - rec.at > BATCH_PROGRESS_TTL_MS) BATCH_PROGRESS.delete(key);
  while (BATCH_PROGRESS.size >= BATCH_PROGRESS_MAX) BATCH_PROGRESS.delete(BATCH_PROGRESS.keys().next().value);
}

function recordBatchProgress(actor, progress) {
  const now = Date.now();
  sweepBatchProgress(now);
  BATCH_PROGRESS.set(actor, { ...progress, at: now });
}

function clearBatchProgress(actor) {
  BATCH_PROGRESS.delete(actor);
}

/* index.js's own GET /agent/batch-progress reads this back for the polling
   client — null means "nothing in flight for this actor right now," which is
   the ordinary case for almost every poll: most turns are not a batch draft
   at all, and a batch that already finished clears its own record. */
export function readBatchProgress(actor) {
  sweepBatchProgress(Date.now());
  return BATCH_PROGRESS.get(actor) ?? null;
}

/* ---- the Anthropic call ------------------------------------------------ */

/* Anthropic's own error body is JSON: {type:"error", error:{type, message}}.
   The `message` is the one line that actually says what was wrong — which
   tool, which argument, what shape it expected — everything a generic
   status code cannot. Falls back to the raw text for a body that is not
   that shape (a proxy's own error page, say), and never throws on a body
   that is not JSON at all. */
function anthropicErrorDetail(raw) {
  try {
    const parsed = JSON.parse(raw);
    const msg = parsed?.error?.message;
    if (typeof msg === "string" && msg) return msg.slice(0, 500);
  } catch {
    /* Not JSON. Fall through to the raw text below. */
  }
  return raw.slice(0, 300) || "(no detail returned)";
}

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
    const raw = await res.text().catch(() => "");
    console.error(`ERROR agent: Anthropic API ${res.status} — ${raw.slice(0, 2000)}`);
    /* A bare status code with the real reason left only in a log neither of
       us can see live turned one 400 into a guessing exercise across a whole
       session — this shop's own audit-before-return rule (agent-tool-
       contract) applied to a call to Anthropic, not only to a call to
       Square. The detail Anthropic actually sent — which argument, which
       tool, what it expected — reaches the chat itself now, truncated,
       rather than only a Worker log someone has to be tailing at the moment
       it happens. */
    return { error: `The model service returned ${res.status}: ${anthropicErrorDetail(raw)}` };
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

export async function dispatch(name, args, { actor, role, env, allowed }) {
  /* Second enforcement of the same set. The model was never shown this tool;
     if it names one anyway, that is a refusal, not a call. */
  if (!allowed.has(name)) {
    return { kind: "result", block: { type: "tool_result", tool_use_id: null, content: `No such tool: ${name}.`, is_error: true } };
  }

  /* Meta-tools, not in TOOLS: they touch no store, need no audit row, and
     answer from skills.js directly rather than through runTool. */
  if (name === "skills_list") {
    return { kind: "result", block: { type: "tool_result", tool_use_id: null, content: skillsListResult(role), is_error: false } };
  }
  if (name === "skills_read") {
    const { isError, text } = skillsReadResult(role, args?.name);
    return { kind: "result", block: { type: "tool_result", tool_use_id: null, content: text, is_error: isError } };
  }
  if (name === "catalog_draft_product_batch") {
    /* REVISED — "I shouldn't need to do that," the owner's own words,
       looking at the approval card this used to stash here. A person who
       already confirmed the preview mapping looks right has already made
       the deliberate decision; a SECOND, separate button on top of that is
       not an extra safety check, it is a second click for the same yes.
       Still pre-checked (role, the asset genuinely exists and has readable
       text, the row cap) so a bad call still fails the same way it always
       did. A row-level CLASH still parks its OWN, genuinely necessary
       approval link either way (createRows, batch.js) — nothing about
       THAT changed.
       `resolvedArgs` prefers LAST_PREVIEW's own record of what this actor
       most recently previewed over whatever asset_id the model's own call
       happens to carry — see LAST_PREVIEW's header comment for why that is
       the reliable one and the model's own copy is not.
       REVISED AGAIN — no longer creates anything itself at all. "Too many
       subrequests" from a single call creating every row is what
       dispatchProductBatchPlan/planProductBatch (above/batch.js) exist to
       fix: this plans the whole batch, once, and hands back a CHECKLIST —
       a NEW outcome kind, translated into agentTurn()'s own `checklist`
       field below, the same way `approval` already becomes `pending` —
       rather than the finished result a single dispatchBatchDraft call
       used to return here. Actually creating anything now happens later,
       one row per request, through submitBatchPlanRow. */
    const resolvedArgs = { ...args, asset_id: lastPreviewedAsset(actor, "products") ?? args?.asset_id };
    const pre = await precheckBatchDraft(name, resolvedArgs, { role, env });
    if (pre.isError || pre.tooMany) {
      return { kind: "result", table: null, block: { type: "tool_result", tool_use_id: null, content: pre.text, is_error: pre.isError } };
    }
    const { isError, text, table, checklist } = await dispatchProductBatchPlan(resolvedArgs, { actor, role, env });
    if (checklist) return { kind: "checklist", checklist, table, text };
    return { kind: "result", table, block: { type: "tool_result", tool_use_id: null, content: text, is_error: isError } };
  }
  if (name === "customer_draft_customer_batch") {
    /* UNLIKE products, immediately above: a clean customer row still never
       creates on its own, even once a person approves the batch as a whole
       — every row goes through its own separate, individual approval
       regardless (createRows, batch.js's own customer path) — so the outer
       gate here is not a redundant SECOND click on the same yes the way the
       product one was; it is still the only place a bulk customer import is
       ever actually approved at all. Left exactly as it was; only the same
       LAST_PREVIEW preference for the real asset_id is new, matching the
       product path immediately above. */
    const resolvedArgs = { ...args, asset_id: lastPreviewedAsset(actor, "customers") ?? args?.asset_id };
    const pre = await precheckBatchDraft(name, resolvedArgs, { role, env });
    if (pre.isError || pre.tooMany) {
      return { kind: "result", table: null, block: { type: "tool_result", tool_use_id: null, content: pre.text, is_error: pre.isError } };
    }
    return {
      kind: "approval",
      out: { tier: "T2" },
      args: resolvedArgs,
      effect: `Ingest "${pre.filename}" as customers — mints a review link for every row that resolves cleanly, skips only a genuine problem.`,
      stores: ["customer_mirror"],
    };
  }
  if (name === "catalog_preview_product_batch" || name === "customer_preview_customer_batch") {
    const { isError, text, table } = await dispatchBatchPreview(name, args, { actor, role, env });
    return { kind: "result", table, block: { type: "tool_result", tool_use_id: null, content: text, is_error: isError } };
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
const SPREADSHEET_TYPE = "text/csv";
function looksLikeSpreadsheet(attachment) {
  return attachment.contentType === SPREADSHEET_TYPE || /\.csv$/i.test(attachment.filename || "");
}

function attachmentNote(attachment, role) {
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
  /* A spreadsheet gets a pointer at catalog_draft_product_batch/
     customer_draft_customer_batch instead of its raw text — reading a CSV's
     rows out of a wall of text and hand-drafting each one is the "dumb
     uploading pathway" the owner asked to stop going through; the batch
     tools apply the same deterministic column-matching and validation
     /products/batch and /customers/batch already do. Only offered when the
     role can actually reach those tools (manager+, matching the writes they
     mint) — for staff, the plain extracted-text note is still the honest
     answer, same as any other file. */
  if (looksLikeSpreadsheet(attachment) && canDraftBatches(role)) {
    return (
      `\n\n[Attached spreadsheet, filename "${attachment.filename}", stored as asset id "${attachment.id}". ` +
      "Do not read its rows out of raw text yourself. First call catalog_preview_product_batch if this is a " +
      "list of products, or customer_preview_customer_batch if it is a list of customers, with this asset id " +
      "— ask the person which if it is not already obvious from what they said. Show them the column mapping " +
      "it returns, and wait for them to confirm it looks right before calling catalog_draft_product_batch / " +
      "customer_draft_customer_batch. When their confirmation arrives, in whatever later turn, you do not " +
      "need to recall or re-derive this asset id at all: this app automatically drafts whichever file was " +
      "most recently previewed, so pass whatever asset_id value is at hand and never call assets.list to try " +
      "to relocate the file yourself.]"
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

/*
 * The quick-prompt chips (P0-83) send one of these exact phrases as the
 * person's first message — a known, deliberate entry point, unlike free-form
 * text where whether a skill is worth reading is a judgment call (P0-82).
 * For these, it always is: a chip click means "I am about to do this common
 * task," so the skill's own "ask only a genuine choice" and completeness
 * rules are worth the one read every time, not something to leave to
 * confidence. The hint is appended server-side — the person's own chat
 * bubble still shows the plain chip text, only the model sees the pointer.
 */
const CHIP_SKILL_HINTS = {
  "Add products": "catalog-skills",
  "Add customers": "customer-skills",
};

function chipSkillHint(q) {
  const skill = CHIP_SKILL_HINTS[String(q || "").trim()];
  if (!skill) return "";
  return (
    `\n\n[This is the quick-action prompt for ${skill.replace(/-skills$/, "")} — call skills_read` +
    `("${skill}") before asking anything, so every question you ask is one the skill says actually ` +
    "matters, and none are ones it says are already settled.]"
  );
}

export function buildUserContent(q, attachment, role) {
  const fallback = attachment ? "I attached a file — take a look and figure out what to do with it." : "";
  const text = (q || fallback) + chipSkillHint(q) + attachmentNote(attachment, role);
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
 * `history` is the client's OWN record of what it already rendered — the
 * literal chat-bubble text (views.js's own `entry()` log), nothing more: no
 * tool_use/tool_result plumbing from a past turn's internal round-trips, and
 * no re-sent image bytes for a photo attached several turns ago. Anything
 * else is dropped rather than trusted — a stray object with the wrong shape
 * must not crash the turn just because it slipped past the client's own
 * bookkeeping. Kept to plain {role, content} pairs so it drops straight into
 * `messages` ahead of the new turn.
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const clean = [];
  for (const turn of history) {
    const role = turn?.role === "assistant" ? "assistant" : turn?.role === "user" ? "user" : null;
    const text = typeof turn?.text === "string" ? turn.text.trim().slice(0, MAX_HISTORY_TEXT) : "";
    if (!role || !text) continue;
    clean.push({ role, content: text });
  }
  return clean.slice(-MAX_HISTORY_TURNS);
}

/*
 * Runs one turn. Returns:
 *   { mode, actor, role, reply, steps: [{tool, tier, ok, auditId}], pending? }
 * `mode` is "stub" when no ANTHROPIC_API_KEY is set — the prototype keeps
 * working with no key and the page says so — or "model" otherwise.
 *
 * `attachment` (optional) is already-uploaded, from index.js's
 * ingestAgentAttachment — see the comment on buildUserContent above for why
 * this file never receives raw, unstored bytes.
 *
 * `history` (optional) is this same conversation's own prior turns — see
 * sanitizeHistory, above, for its shape and why it exists at all.
 */
export async function agentTurn({ q, identity, env, attachment = null, history = [] }) {
  const actor = identity.email;
  /* `env` is not optional here even though roleFor defaults it. Roles arrive as
     `policy_id`, matched against OWNER_POLICY_ID and its siblings, which live
     in env — without it every caller resolved to no role and the model was
     handed an empty tool list. */
  const role = await roleFor(identity, env);

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

  const defs = [
    ...SKILLS_TOOL_DEFS,
    ...(canDraftBatches(role) ? [...PREVIEW_TOOL_DEFS, ...BATCH_TOOL_DEFS] : []),
    ...toolDefinitions(role),
  ];
  const allowed = new Set(defs.map((d) => d.name));
  /* Only the outbound shape changes — everything downstream (allowed, TOOLS
     lookups, the pending record, the audit steps) keeps using the real,
     dotted name via this reverse lookup. */
  const nameForWire = new Map(defs.map((d) => [wireName(d.name), d.name]));
  const wireDefs = defs.map((d) => ({ ...d, name: wireName(d.name) }));
  const messages = [...sanitizeHistory(history), { role: "user", content: buildUserContent(q, attachment, role) }];
  const steps = [];
  /* The most recent tool call that produced a `table` — a preview or a batch
     draft result. Carried into the turn's final reply so the client can
     render it as a compact review table alongside the chat bubble, per the
     owner's own request; nothing else in this file's return shape needs it. */
  let lastTable = null;

  for (let round = 0; ; round++) {
    const { message, error } = await callClaude(env, {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(actor, role, defs, identity),
      tools: wireDefs,
      messages,
    });
    /* REVISED — a real product batch reported "ran catalog_draft_product_batch"
       (a real write — draftProductBatch creates every clean row immediately,
       P0-89's own "REVISED AGAIN") immediately followed by nothing but "The
       model service could not be reached." — this branch, unchanged until
       now, returning early with NEITHER `table` NOR any mention that a tool
       had already run. The failed call here is always the FOLLOW-UP request
       for the model's own closing summary, made AFTER dispatch() already ran
       every tool call from the round before — a network hiccup reaching
       Anthropic at that exact moment must not make a real write disappear
       from what the person is shown. `alreadyRanNote` names what already
       happened and points at the table sitting right there in `lastTable`,
       rather than leaving a person who just watched their spreadsheet import
       run wondering if it silently failed and re-uploading it. */
    const alreadyRanNote = steps.length
      ? ` ${steps.length} tool call${steps.length === 1 ? "" : "s"} already ran before this happened: ${steps
          .map((s) => `${s.tool} (${s.ok ? "ok" : "refused"})`)
          .join(", ")}. See the table below for exactly what it did — nothing here undoes it.`
      : "";
    if (error) return { mode: "model", actor, role, steps, pending: null, reply: `${error}${alreadyRanNote}`, table: lastTable };

    if (message.stop_reason === "refusal") {
      return {
        mode: "model", actor, role, steps, pending: null,
        reply: `The model declined this request.${alreadyRanNote}`,
        table: lastTable,
      };
    }

    const uses = (message.content || []).filter((b) => b.type === "tool_use");
    if (!uses.length) {
      return { mode: "model", actor, role, steps, pending: null, reply: textOf(message) || "(no reply)", table: lastTable };
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
        table: lastTable,
      };
    }

    /* Echoed back unchanged, thinking blocks included — the API requires the
       assistant turn verbatim to continue on the same model. */
    messages.push({ role: "assistant", content: message.content });

    const results = [];
    for (const use of uses) {
      /* `use.name` is the WIRE name Anthropic just called (Claude echoes back
         exactly what it was given in `tools`) — translate to the real,
         dotted name for everything from here on; the API-facing message
         content pushed above keeps the wire name untouched, as it must. */
      const name = nameForWire.get(use.name) || use.name;
      const outcome = await dispatch(name, use.input, { actor, role, env, allowed });
      if (outcome.table) lastTable = outcome.table;

      if (outcome.kind === "approval") {
        /* A T2 tool wants a human. The turn stops here — including any sibling
           tool calls in the same assistant message, which are not run.
           `outcome.effect`/`outcome.stores`, when dispatch() set them (a
           META-tool like a batch draft, not a real TOOLS[] entry), win over
           the ordinary TOOLS-derived description/stores below. `outcome.args`,
           when dispatch() set it (customer_draft_customer_batch's own
           LAST_PREVIEW-resolved asset_id, never the model's raw copy — see
           LAST_PREVIEW's header comment), wins over the model's own `use.input`
           too, so the record a person actually clicks Approve on — and the
           real draft that record later runs — both use the SAME, correct
           asset id regardless of what the model itself supplied. */
        const tool = TOOLS[name];
        const args = outcome.args || use.input;
        const id = stashPending({ actor, role, tool: name, args });
        return {
          mode: "model",
          actor,
          role,
          steps,
          reply: textOf(message) || `${name} needs your approval before it runs.`,
          table: lastTable,
          pending: {
            id,
            tool: name,
            tier: (tool && tool.tier) || outcome.out.tier,
            args,
            effect: outcome.effect || describeTool(tool, name, args),
            stores: outcome.stores || (tool && tool.stores) || [],
          },
        };
      }

      if (outcome.kind === "checklist") {
        /* catalog_draft_product_batch's own new outcome (dispatch(), above)
           — a planned, not-yet-created batch, waiting on which rows a
           person actually wants submitted, never a model decision. The
           turn stops here the same way an `approval` does, for the same
           reason: nothing past this point should run until a person acts,
           and no sibling tool call in this same assistant message runs
           either. */
        return {
          mode: "model",
          actor,
          role,
          steps,
          reply: textOf(message) || outcome.text || "Review the rows below and press Submit to create the ready ones.",
          table: lastTable,
          pending: null,
          checklist: outcome.checklist,
        };
      }

      steps.push({ tool: name, tier: (TOOLS[name] || {}).tier, ok: !outcome.block.is_error, auditId: outcome.audit });
      results.push({ ...outcome.block, tool_use_id: use.id });
    }

    /* Every result in ONE user message — splitting them teaches the model to
       stop calling tools in parallel. */
    messages.push({ role: "user", content: results });
  }
}

/*
 * The Voice Search skill (skills/voice-search-skill/SKILL.md) — the owner's
 * own choice of name. A single, non-agentic model call — never a tool call,
 * never a conversation — that turns a spoken description of what someone is
 * looking for into a SEARCH PLAN for Items' own client-side filter:
 * `category` (one or more exact matches against real categories,
 * comma-separated, applied as their own selector) and `keywords` (a short
 * plain-substring search over
 * title/handle/SKU/custom fields). Kept as two separate fields, not one
 * blended string, per the owner's own worked example: "let's say we have
 * categories dresses, shoes, and jewelry... I'm currently set to
 * jewelry... if I ask the agent to find all blue dresses, it knows that I
 * need to switch my category to dresses, right, or multiple categories...
 * and then it's gonna do a filter for the color... blue... Of course, I
 * could get more specific and say a designer name, then it would also add
 * the designer tag as well." One request can name a category switch (one
 * or several), keywords, both, or neither — never conflated into a single
 * string the client would have to re-split.
 *
 * `categories` (the ones actually on a product, same list itemsPage() shows
 * in its own filter menu) are given so the model can map "dresses" to a
 * real category exactly, rather than guessing at a string the category
 * filter will never match.
 */
export async function searchIntent({ q, env, categories = [] }) {
  const utterance = String(q || "").slice(0, CAPS.MAX_TEXT).trim();
  if (!utterance) return { mode: "stub", category: "", keywords: "" };

  if (!env.ANTHROPIC_API_KEY) {
    /* No key, no model — the same benign fallback agentTurn() gives: the
       literal utterance becomes a keyword search (no category switch),
       so voice search still does something rather than nothing. */
    return { mode: "stub", category: "", keywords: utterance };
  }

  const { message, error } = await callClaude(env, {
    model: MODEL,
    max_tokens: SEARCH_INTENT_MAX_TOKENS,
    system: searchPlanPrompt(categories),
    messages: [{ role: "user", content: utterance }],
  });
  if (error) return { mode: "model", error };

  /* [ \t]* rather than \s* after the colon — \s matches a newline too, so a
     greedy \s* on the CATEGORY line swallowed the line break and bled into
     KEYWORDS' own text whenever CATEGORY was blank (caught by its own
     test). Confining it to same-line whitespace keeps each line's capture
     stopped by the newline, the same way "." already stops there. */
  const text = textOf(message);
  const category = (/CATEGORY:[ \t]*(.*)/i.exec(text)?.[1] || "").trim().replace(/^["']|["']$/g, "");
  const keywords = (/KEYWORDS:[ \t]*(.*)/i.exec(text)?.[1] || "").trim().replace(/^["']|["']$/g, "");
  return { mode: "model", category, keywords };
}

/* ---- applying an approved action --------------------------------------- */

/*
 * The human's POST arrives here with nothing but an id. The tool name and the
 * arguments come from the server-side record; the token is created on the line
 * below and dies inside runTool.
 */
export async function approve({ id, identity, env }) {
  const actor = identity.email;
  const role = await roleFor(identity, env);

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

  /* A spreadsheet batch draft is a META-tool (agent.js's own dispatch(), not
     runTool/TOOLS) — "I need to be able to click yes or no" — the owner's
     own words, after the mapping-confirm step used to be a free-text
     question a person answered in plain chat, relying on the model to
     correctly recall the asset id from its own stripped-down history on
     the NEXT turn (it did not, reliably — "it can't find the file"). This
     button instead carries the asset id in the server's own PENDING
     record from the moment it was proposed, the same way any other T2
     approval already does; clicking it needs no model turn at all. */
  const BATCH_DRAFT_TOOLS = new Set(["catalog_draft_product_batch", "customer_draft_customer_batch"]);
  if (BATCH_DRAFT_TOOLS.has(rec.tool)) {
    const { isError, text, table } = await dispatchBatchDraft(rec.tool, rec.args, { actor, role, env });
    return { ok: !isError, status: 200, tool: rec.tool, reply: text, table };
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

/*
 * ONE row of a stashed planProductBatch checklist (BATCH_PLANS, above),
 * actually created — index.js's own POST /agent/batch-submit-row, called
 * once per checked row, sequentially, by the browser's own submit loop.
 * Deliberately not run through dispatch()/runTool's usual approvalToken
 * dance a second time here: submitProductBatchRow (batch.js) already does
 * the real gate-then-execute pair against Square, the identical mechanism
 * createRows always has; this function's own job is only the same
 * authorization PENDING/approve() already enforce — the plan belongs to
 * the actor asking to spend it, and one submitted row is spent once.
 */
export async function submitBatchPlanRow({ id, row, title, identity, env }) {
  const actor = identity.email;
  const role = await roleFor(identity, env);

  sweepBatchPlans(Date.now());
  const plan = BATCH_PLANS.get(id);
  if (!plan) return { ok: false, status: 404, reply: "That batch is unknown or has expired. Nothing was run." };

  if (plan.actor !== actor) {
    console.error(`ERROR agent: batch plan ${id} raised by ${plan.actor} but submitted by ${actor}; refused`);
    return { ok: false, status: 403, reply: "That batch belongs to a different person." };
  }

  const idx = plan.rows.findIndex((r) => r.rowNumber === row);
  if (idx === -1) {
    return { ok: false, status: 404, reply: "That row is unknown, already submitted, or was never part of this batch." };
  }
  /* Spent the moment it is picked up, whatever createRows goes on to do with
     it — the same "single use" property PENDING's own approve() already
     has, just per-row here instead of per-record. */
  const [target] = plan.rows.splice(idx, 1);
  plan.done = (plan.done ?? 0) + 1;
  const total = plan.total;
  if (plan.rows.length === 0) BATCH_PLANS.delete(id);

  /* "The only thing the user might want to tweak is the title" — the
     owner's own words, reviewing the checklist. Trimmed and length-capped
     here only so an absurd paste cannot ride further than it would from
     any other input; catalog.create_product's own real check (below) is
     what actually enforces CATALOG_TITLE_MAX and refuses/parks accordingly
     — this is not a second validation, just not handing it a string with
     no ceiling at all. */
  const editedTitle = typeof title === "string" && title.trim() ? title.trim().slice(0, CAPS.CATALOG_TITLE_MAX) : null;

  let result;
  try {
    result = await submitProductBatchRow(env, { actor, role, rate: plan.rate }, target, editedTitle);
  } catch (err) {
    console.error(`ERROR agent: batch plan ${id} row ${row} failed — ${err.message}`);
    return { ok: false, status: 502, reply: `Row ${row} failed while running.`, done: plan.done, total };
  }

  return { ok: true, status: 200, ...result, done: plan.done, total };
}
