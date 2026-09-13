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
   * The other end of the same refusal. An agent authoring a product from a
   * photo and a sentence will occasionally propose 4999 when it meant 49.99,
   * or carry a minor/major confusion straight through. Neither end is a
   * warning: a price outside [PRICE_MIN_MINOR, PRICE_MAX_MINOR] is refused
   * here and never reaches Square (Test-PRD-P0-25-write_approval_gate).
   * 5,000,000 minor units is £50,000 — above anything this shop sells, and
   * far below what a decimal-point slip produces.
   */
  PRICE_MAX_MINOR: 5_000_000,

  /* ── agentic catalog authoring (Test-PRD-P0-40-closed_category_set) ──── */

  /* Square's own item name ceiling is 512; ours is tighter because a title
     that long is a description that lost its way, and it is the storefront's
     card heading. A 300-character title is refused, not truncated. */
  CATALOG_TITLE_MAX: 120,
  /* Square's description ceiling is 4096. This copy is mirrored for
     reconciliation only — the editorial copy lives in Git (ADR-009). */
  CATALOG_DESCRIPTION_MAX: 4000,
  /* A product with no variation cannot be sold; a product with forty was not
     drafted, it was generated. */
  CATALOG_MIN_VARIATIONS: 1,
  CATALOG_MAX_VARIATIONS: 24,
  /* Images attached to one product in one call. */
  CATALOG_MAX_IMAGES: 8,

  /*
   * INLINE image bytes, base64, in a tool ARGUMENT.
   *
   * This is not a transport limit, it is a MODEL limit, and it is the reason
   * catalog.upload_image has a second mode at all. Argument bytes have to be
   * emitted token by token by the model making the call; 192 KiB of image is
   * ~256 KiB of base64 is ~64k output tokens, which is already the whole
   * output budget of a frontier model. A phone photo is an order of magnitude
   * past it and cannot be passed this way at any price — see the signed
   * upload ticket in ops/src/tools/media.js.
   */
  INLINE_IMAGE_MAX_BYTES: 192 * 1024,
  /* Ceiling on an ORIGINAL arriving through the signed upload route, where
     the bytes never touch a model. Square's own catalog-image limit is 15 MB
     and ours matches it so a stored original is always forwardable. */
  ORIGINAL_IMAGE_MAX_BYTES: 15 * 1024 * 1024,
  /* A signed upload ticket is a link a human opens now, not a share link. */
  MEDIA_TICKET_TTL_MS: 15 * 60 * 1000,

  /*
   * Batch spreadsheet upload (batch.js). Each row calls runTool and, for a
   * row that resolves, parkForApproval — sequentially, inside one Worker
   * request, one of which reaches Square. A row count with no ceiling is a
   * timeout waiting for a big enough file, not a feature.
   */
  BATCH_MAX_ROWS: 200,
  /* Generous for 200 short rows and nowhere near ORIGINAL_IMAGE_MAX_BYTES —
     a file this size holding fewer rows than the cap above is not a CSV. */
  BATCH_MAX_BYTES: 2 * 1024 * 1024,

  /*
   * Category near-duplicate refusal. Two names whose normalised token sets
   * overlap by at least this share are treated as the same category, so
   * "Coats" cannot be created next to "Coats & Jackets" without the refusal
   * naming the one that already exists.
   */
  CATEGORY_DUPLICATE_SIMILARITY: 0.5,

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
