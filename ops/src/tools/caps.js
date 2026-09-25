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
  /* Option sets assigned to one category in one call — a category offering
     more than this was almost certainly meant to be several categories. */
  CATALOG_MAX_ITEM_OPTIONS_PER_CATEGORY: 12,

  /*
   * custom_fields (mirror_product) — whatever a spreadsheet import or an
   * agent edit carries that Square has no field for at all. Capped the same
   * way every other free-text store field is: a warning in a tool
   * description is not a cap, a rejected write is. A spreadsheet with more
   * distinct extra columns than this, or a single cell this long, was not a
   * product row.
   */
  CATALOG_CUSTOM_FIELDS_MAX_KEYS: 20,
  CATALOG_CUSTOM_FIELD_KEY_MAX: 60,
  CATALOG_CUSTOM_FIELD_VALUE_MAX: 500,
  /* Size/Color (or any other Option Set) values named directly on a
     variation at creation time — a garment offering more distinct option
     names than this in one call was not typed by a person either. */
  CATALOG_MAX_OPTION_VALUES_PER_VARIATION: 6,
  CATALOG_OPTION_NAME_MAX: 40,
  CATALOG_OPTION_VALUE_MAX: 80,
  /* The employee-only /items grid (ops/src/index.js) — a shop this size
     fits comfortably under this in one page; past it, the honest answer is
     pagination, not a page that silently gets slower to render. */
  CATALOG_ITEMS_PAGE_MAX_ROWS: 1000,

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
   * The fetch-and-store backfill (media-backfill.js), run once per scheduled
   * sync (every 15 minutes). Capped so a first-time backfill of a large
   * existing catalog spreads itself across many runs rather than spending the
   * whole cron budget — and the cron's own timeout — fetching a hundred
   * photographs in one invocation. A steady-state catalog backfills whatever
   * Square added since the last run, which is almost always far fewer.
   */
  MEDIA_BACKFILL_MAX_PER_RUN: 20,
  /*
   * A photo attached straight into the ops chat (the icon row under the
   * input) rides to Claude as a vision content block, base64-encoded inline
   * in the request body — a real network payload this time, not a tool
   * argument the model itself has to emit, so the arithmetic that rules out
   * inline tool-argument bytes does not apply here. Still capped, well under
   * Anthropic's own per-image ceiling, so one large phone photo cannot blow
   * out the request. The photo is stored in full regardless of this cap —
   * only the COPY sent for the model to look at is skipped past it, and the
   * turn still proceeds, just without vision on that one attachment.
   */
  AGENT_VISION_MAX_BYTES: 4 * 1024 * 1024,

  /*
   * Batch spreadsheet upload (batch.js). Each row calls runTool and, for a
   * row that resolves, parkForApproval — sequentially, inside one Worker
   * request, one of which reaches Square. A row count with no ceiling is a
   * timeout waiting for a big enough file, not a feature.
   */
  BATCH_MAX_ROWS: 400,
  /* Generous for 400 short rows and nowhere near ORIGINAL_IMAGE_MAX_BYTES —
     a file this size holding fewer rows than the cap above is not a CSV. */
  BATCH_MAX_BYTES: 2 * 1024 * 1024,
  /*
   * A real 16-row batch reported "some categories and subcategories did get
   * created, but only like two items got added" -- traced to every row of a
   * batch sharing the SAME per-Access-identity CALLS_PER_MINUTE budget
   * (rate.js) as that person's own ordinary chat activity, sized for "an
   * agent in a retry loop," never for a single, bounded, already
   * human-confirmed pass over up to BATCH_MAX_ROWS rows. Category/
   * subcategory resolution runs FIRST for every row (draftProductBatch's own
   * two-phase loop), then every row's own catalog.create_product call runs
   * SECOND — so the shared budget being merely close to exhausted already
   * (this same actor's own earlier chat turns, or an earlier attempt at this
   * same import) reliably starves the LATER phase first, the exact "some
   * categories, almost no products" shape this was. A batch run structurally
   * cannot loop the way the shared cap defends against — it makes at most
   * two runTool calls per row, once, ever — so its own dedicated limiter
   * (created fresh per draftProductBatch/draftCustomerBatch call, batch.js)
   * is sized for the worst case instead of anti-abuse: every one of
   * BATCH_MAX_ROWS rows naming its own distinct new category AND
   * subcategory (2 calls each) plus its own create (2 calls) is 6 ×
   * BATCH_MAX_ROWS; rounded up with real headroom.
   */
  BATCH_CALLS_PER_MINUTE: 3000,

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

  /*
   * Employee asset drop site (assets.js). A working document, not a photo —
   * generous enough for a real spreadsheet or PDF, nowhere near what a store
   * would need to hold video or a full media library.
   */
  ASSET_MAX_BYTES: 20 * 1024 * 1024,
  /* Extracted TEXT an agent tool can hand back in one call. A cap in
     characters, not bytes — this is what a model actually reads, and the
     same "a warning in the prompt is not a cap" rule applies to it. Refusing
     is wrong here (the file is still worth having on record); truncating and
     saying so is not. */
  ASSET_TEXT_MAX_CHARS: 100_000,
  ASSET_LIST_MAX_ROWS: 100,

  /*
   * Receipt scanning (receipt-ocr.js). A photograph, so the same ceiling as
   * an original catalog image — comfortably past what a phone camera
   * produces, nowhere near a KV value's 25 MB ceiling.
   */
  RECEIPT_MAX_BYTES: 15 * 1024 * 1024,
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
