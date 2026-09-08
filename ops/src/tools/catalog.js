/*
 * catalog.* — inherits agent-tool-contract, then catalog-skills.
 *
 * No D1 binding of any kind: `stores: []`. A catalog tool cannot see orders,
 * customers or finance because the registry hands it no database handle at all
 * (Test-PRD-P0-24-binding_scoped_tools), and that is the enforcement — not the
 * sentence you are reading.
 *
 * Undo path: revert the commit. Nothing here is overwritten in place.
 */
import { CAPS, pctChange, rowLimit } from "./caps.js";

export const catalogTools = {
  "catalog.search": {
    tier: "T0",
    domain: "catalog",
    stores: [],
    minRole: "staff",
    describe:
      "Search the derived catalog index by free text, brand or status. Returns index " +
      "records — never edit from one, re-read the shard with catalog.get.",
    undo: null,
    schema: {
      q: { type: "string", maxLength: 100 },
      brand: { type: "string", maxLength: 60 },
      status: { type: "string", enum: ["active", "draft", "archived"] },
      limit: { type: "integer", min: 1, max: CAPS.MAX_ROWS },
    },
    async run(args, t) {
      const limit = rowLimit(args.limit);
      const results = await t.catalog.search({ ...args, limit });
      return { results, count: results.length, limit, source: t.catalog.kind };
    },
  },

  "catalog.get": {
    tier: "T0",
    domain: "catalog",
    stores: [],
    minRole: "staff",
    describe: "Read one product shard by handle. The read path for any write.",
    undo: null,
    schema: {
      handle: { type: "string", required: true, format: "handle" },
    },
    async run(args, t) {
      const product = await t.catalog.get(args.handle);
      if (!product) return { error: `no product with handle '${args.handle}'` };
      return { product };
    },
  },

  /*
   * The riskiest tool in this domain, built last and gated twice: a manager or
   * owner role, AND an in-session approval. catalog-skills rule 4 — "a merged PR
   * and a wrong number are the same event".
   *
   * The cap is the part that cannot be argued with. A move beyond
   * CAPS.PRICE_CHANGE_MAX_PCT is REFUSED, not flagged for the approver: an
   * approval is for a change, and nobody approves "a price change" in the
   * abstract. Test-PRD-P0-25-write_approval_gate.
   */
  "catalog.set_price": {
    tier: "T2",
    domain: "catalog",
    stores: [],
    minRole: "manager",
    describe:
      "Stage a price change for one product as a single-shard pull request. " +
      `Refuses a move beyond ${CAPS.PRICE_CHANGE_MAX_PCT}% of the current price.`,
    undo: "revert the commit",
    schema: {
      handle: { type: "string", required: true, format: "handle" },
      price_minor: { type: "integer", required: true, min: CAPS.PRICE_MIN_MINOR },
      currency: { type: "string", required: true, format: "currency" },
      reason: { type: "string", required: true, maxLength: CAPS.MAX_TEXT },
    },
    /*
     * The cap is checked in the read-only preflight, so a change that would be
     * refused never gets an approval token issued for it. Approving something
     * the tool would then refuse is how a gate becomes theatre.
     */
    async check(args, t) {
      /* Read the SHARD, never the index: an index record may be stale. */
      const shard = await t.catalog.get(args.handle);
      if (!shard) return { denied: `no product with handle '${args.handle}'` };

      if (shard.currency !== args.currency) {
        return {
          denied:
            `currency mismatch: the shard is priced in ${shard.currency}, ` +
            `the call says ${args.currency}. A repricing is not a redenomination.`,
        };
      }

      const pct = pctChange(shard.price_minor, args.price_minor);
      if (pct > CAPS.PRICE_CHANGE_MAX_PCT) {
        return {
          denied:
            `price change of ${pct.toFixed(1)}% exceeds the ${CAPS.PRICE_CHANGE_MAX_PCT}% cap ` +
            `(${shard.price_minor} -> ${args.price_minor} ${shard.currency}). Refused, not warned.`,
          detail: { limit_pct: CAPS.PRICE_CHANGE_MAX_PCT, requested_pct: Number(pct.toFixed(2)) },
        };
      }

      return {
        ok: true,
        summary:
          `${args.handle}: ${shard.price_minor} -> ${args.price_minor} ${shard.currency} ` +
          `(${pct.toFixed(1)}%) — ${args.reason}`,
        preflight: { shard, pct },
      };
    },

    async run(args, t) {
      const { shard, pct } = t.preflight;
      const staged = await t.catalog.stagePriceChange({
        handle: args.handle,
        from_minor: shard.price_minor,
        to_minor: args.price_minor,
        currency: shard.currency,
        reason: args.reason,
        actor: t.actor,
        approvalToken: t.approved,
      });
      return { staged, change_pct: Number(pct.toFixed(2)) };
    },
  },
};
