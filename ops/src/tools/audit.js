/*
 * The audit write path. Built before any tool, per agent-tool-contract's build
 * order, and the only module in this directory that every call passes through.
 *
 * Test-PRD-P0-21-append_only_audit.
 *
 * THREE PROPERTIES, ALL ENFORCED HERE
 *
 * 1. A row is written BEFORE the tool returns — on success, on denial and on
 *    error. A tool that audits only its successes is a tool whose interesting
 *    cases are invisible.
 *
 * 2. A row is written BEFORE the effect. Denials and pending approvals are
 *    terminal, so their row is the whole record. For a call that is about to
 *    mutate, an INTENT row is appended first, and if the effect then fails a
 *    second row (`result='error'`) is appended carrying `reverses` — the id of
 *    the intent row. The audit log is append-only by trigger, so a pair of rows
 *    is the only honest way to record "we were about to, and then it broke".
 *    Editing the first row to say `error` is exactly what the trigger forbids.
 *
 * 3. Fail closed. If the insert throws — binding absent, store unavailable,
 *    domain rejected by the CHECK — `writeAudit` throws and the caller does not
 *    run the tool. Degrade to refusal, never to an unlogged action.
 *
 * THE DOMAIN VOCABULARY IS THE SCHEMA'S, NOT OURS
 *   audit.sql constrains `domain` to five values and `customers` is not one of
 *   them. Rather than silently widening the CHECK (that schema is another
 *   change's to make), the map below is explicit and a test asserts every value
 *   in it is accepted by the schema. The store actually touched is never lost:
 *   it goes into `detail.stores` verbatim.
 */

/*
 * Tool domain -> audit domain. `customers` maps to `commerce` because the
 * schema has no `customers` value; the true store is recorded in detail.stores
 * so nothing is lost. Fix by widening the CHECK in audit.sql, then delete this
 * line — not by inventing a value the database will reject.
 */
/* The audit schema now names every store, so a domain records where the action
   actually happened. This was briefly a mapping with customers -> commerce,
   because audit.sql's CHECK predated the customers store; recording an action
   against the wrong store is exactly the kind of quiet inaccuracy an audit log
   cannot afford, so the schema was widened instead of the map kept. */
export const AUDIT_DOMAINS = Object.freeze([
  "catalog", "commerce", "customers", "identity",
  "people", "finance", "knowledge", "tickets", "assets",
]);

export const RESULTS = Object.freeze(["ok", "error", "denied", "pending_approval"]);

const MAX_DETAIL = 4000;

/*
 * Arguments are audited, so they must not smuggle a secret into an append-only
 * store that nothing can redact. Values are truncated and anything that looks
 * like a credential or a receipt of one is replaced.
 */
const REDACT = /token|secret|password|key|assertion|jwt/i;

export function safeArguments(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (REDACT.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    } else if (v === null || ["number", "boolean"].includes(typeof v)) {
      out[k] = v;
    } else {
      const s = JSON.stringify(v) ?? String(v);
      out[k] = s.length > 200 ? `${s.slice(0, 200)}…` : s;
    }
  }
  return out;
}

function clamp(json) {
  const s = JSON.stringify(json ?? {});
  return s.length > MAX_DETAIL ? JSON.stringify({ truncated: true }) : s;
}

/*
 * Append one row. Returns its id.
 *
 * `db` is the AUDIT D1 binding and nothing else — the audit store is its own
 * database precisely so it survives a mistake in any other one, and so the
 * application can hold insert-only credentials against it.
 *
 * Throws on any failure. Callers must NOT catch and continue.
 */
export async function writeAudit(db, row) {
  if (!db || typeof db.prepare !== "function") {
    /* RULES.md: never swallow a service-boundary failure. */
    console.error("ERROR tools: no AUDIT binding — refusing the call, nothing ran");
    throw new Error("audit_unavailable: no AUDIT binding");
  }
  const domain = AUDIT_DOMAINS.includes(row.domain) ? row.domain : null;
  if (!domain) throw new Error(`audit_unavailable: unknown domain ${row.domain}`);
  if (!RESULTS.includes(row.result)) throw new Error(`audit_unavailable: bad result ${row.result}`);
  if (!row.actor) throw new Error("audit_unavailable: no actor");

  let res;
  try {
    res = await db
      .prepare(
        "INSERT INTO audit_log (actor, on_behalf_of, domain, tool, arguments, result, detail)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.actor,
        row.onBehalfOf ?? null,
        domain,
        row.tool,
        clamp(safeArguments(row.arguments)),
        row.result,
        clamp(row.detail),
      )
      .run();
  } catch (err) {
    console.error(`ERROR tools: audit write failed (${row.tool}/${row.result}) — ${err.message}`);
    throw new Error(`audit_unavailable: ${err.message}`);
  }

  const id = res?.meta?.last_row_id;
  if (!id) {
    console.error(`ERROR tools: audit write returned no row id (${row.tool})`);
    throw new Error("audit_unavailable: no row id");
  }
  return id;
}
