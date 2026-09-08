/*
 * Caps — in code, never in the prompt.
 *
 * agent-tool-contract rule 4: "Page sizes, row limits, refund ceilings, batch
 * sizes — enforced by the tool. A cap stated only in a prompt is a suggestion."
 * Every number here is read by a tool at the point of refusal, and every one is
 * asserted by a test (Test-PRD-P0-25-write_approval_gate). Nothing here is a
 * warning: a call over a cap is DENIED and audited as such.
 *
 * Freeze the object so a tool cannot raise its own ceiling at runtime — the one
 * failure mode a cap in a module is otherwise open to.
 */
export const CAPS = Object.freeze({
  /* Reads. A LIMIT in the query, not a promise in a description. */
  MAX_ROWS: 50,
  DEFAULT_ROWS: 20,

  /*
   * Price. A change beyond this share of the current price is refused outright:
   * a manager approving "a price change" has not approved an unbounded one, and
   * the catalog skill's T3 list already puts bulk / percentage moves out of
   * reach. 15% is a markdown; 60% is a typo or an attack.
   */
  PRICE_CHANGE_MAX_PCT: 15,
  /* A price of zero or below is not a discount, it is a broken write. */
  PRICE_MIN_MINOR: 1,

  /*
   * Expense approval ceiling, in minor units. Above this the agent tool refuses
   * and the payment goes through the accounting provider with a human on it —
   * "one approval covering unbounded money" is a T3 in finance-skills.
   */
  EXPENSE_APPROVE_MAX_MINOR: 500_000,
  EXPENSE_SUBMIT_MAX_MINOR: 2_000_000,

  /* Scheduling. A draft that proposes a quarter is not a draft. */
  SCHEDULE_DRAFT_MAX_SHIFTS: 40,
  SCHEDULE_VIEW_MAX_DAYS: 62,

  /* Approval tokens are in-session, and a session is not a day. */
  APPROVAL_TTL_MS: 10 * 60 * 1000,

  /*
   * Call rate, per Access identity, per minute. An agent in a retry loop is the
   * ordinary case; this is what stops it becoming a bill. Enforced in rate.js,
   * applied by the registry to every tool call.
   */
  CALLS_PER_MINUTE: 120,

  /* Free text an agent can put into a store, per field. */
  MAX_TEXT: 500,
});

/* Clamp a caller-supplied row count into the cap. Never trust the argument. */
export function rowLimit(requested) {
  const n = Number.isInteger(requested) ? requested : CAPS.DEFAULT_ROWS;
  return Math.max(1, Math.min(n, CAPS.MAX_ROWS));
}

/* Percentage move between two integer minor amounts, as a positive number. */
export function pctChange(fromMinor, toMinor) {
  if (!Number.isFinite(fromMinor) || fromMinor <= 0) return Infinity;
  return Math.abs((toMinor - fromMinor) / fromMinor) * 100;
}
