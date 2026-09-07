/*
 * customer.* — inherits agent-tool-contract, then customer-skills.
 *
 * THE RULE THIS FILE EXISTS TO KEEP
 *   No response from any tool here contains a name, an email or a phone number.
 *   Test-PRD-P0-08-customers_no_identifiers. Two mechanisms, because one is a
 *   promise and two is a design:
 *
 *   1. These tools declare `stores: ["customers"]`. The registry maps that to
 *      the CUSTOMERS binding and nothing else; there is no IDENTITY binding in
 *      the map at all, so the identifiers are not merely unselected — they are
 *      not reachable from this code path.
 *   2. Every column is named in every SELECT. No `SELECT *` anywhere in this
 *      file, so a column added to `customer` tomorrow cannot appear in a
 *      response by accident. That is what makes the guarantee survive a schema
 *      change made by somebody who never read this comment.
 *
 *   `notes` is deliberately not returned either. Free text accumulates names
 *   (customer-skills rule 6), so a T0 tool reports only whether notes exist.
 *
 * Undo path: `customer_version` — append the version row, then apply. Which is
 * why customer.update_fit is T1: it produces the version rows and the patch,
 * and applies neither.
 */
import { CAPS, rowLimit } from "./caps.js";

export const customerTools = {
  "customer.profile": {
    tier: "T0",
    domain: "customers",
    stores: ["customers"],
    minRole: "staff",
    describe:
      "Profile for one opaque customer id: birth year, consent, timestamps. " +
      "Returns no name, email or phone — that is the identity store's job, and " +
      "this tool holds no binding to it.",
    undo: null,
    schema: { customer_id: { type: "string", required: true, format: "id" } },
    async run(args, t) {
      const row = await t.db.customers
        .prepare(
          "SELECT id, birth_year, created_at, updated_at, length(notes) AS notes_len" +
            " FROM customer WHERE id = ?",
        )
        .bind(args.customer_id)
        .first();
      if (!row) return { error: `no customer '${args.customer_id}'` };

      const consent = await t.db.customers
        .prepare(
          "SELECT purpose, granted, source, recorded_at FROM customer_consent" +
            " WHERE customer_id = ? ORDER BY purpose LIMIT ?",
        )
        .bind(args.customer_id, CAPS.MAX_ROWS)
        .all();

      return {
        profile: {
          customer_id: row.id,
          birth_year: row.birth_year,
          created_at: row.created_at,
          updated_at: row.updated_at,
          /* The existence of notes, never the notes. */
          has_notes: Number(row.notes_len ?? 0) > 0,
        },
        consent: (consent.results ?? []).map((c) => ({
          purpose: c.purpose,
          granted: Boolean(c.granted),
          source: c.source,
          recorded_at: c.recorded_at,
        })),
      };
    },
  },

  "customer.fit": {
    tier: "T0",
    domain: "customers",
    stores: ["customers"],
    minRole: "staff",
    describe: "Fit profile — garment, size label, measurements — for one opaque customer id.",
    undo: null,
    schema: {
      customer_id: { type: "string", required: true, format: "id" },
      garment: { type: "string", maxLength: 40 },
    },
    async run(args, t) {
      const sql =
        "SELECT customer_id, garment, size_label, measurements, updated_at FROM customer_fit" +
        " WHERE customer_id = ?" +
        (args.garment ? " AND garment = ?" : "") +
        " ORDER BY garment LIMIT ?";
      const binds = args.garment
        ? [args.customer_id, args.garment, CAPS.MAX_ROWS]
        : [args.customer_id, CAPS.MAX_ROWS];
      const rows = await t.db.customers.prepare(sql).bind(...binds).all();
      return {
        customer_id: args.customer_id,
        fit: (rows.results ?? []).map((r) => ({
          garment: r.garment,
          size_label: r.size_label,
          measurements: parseJson(r.measurements),
          updated_at: r.updated_at,
        })),
      };
    },
  },

  /*
   * History is a join IN THE CALLER, not a wider binding (agent-tool-contract
   * rule 6): this tool binds `commerce` only and reads by customer_id. It never
   * touches the customers store, so it cannot leak a profile into an order view
   * or the reverse.
   */
  "customer.history": {
    tier: "T0",
    domain: "customers",
    stores: ["commerce"],
    minRole: "staff",
    describe:
      "Purchase history for one opaque customer id, derived from the commerce store. " +
      "Never duplicated into the profile (Test-PRD-P0-09-data_minimisation).",
    undo: null,
    schema: {
      customer_id: { type: "string", required: true, format: "id" },
      limit: { type: "integer", min: 1, max: CAPS.MAX_ROWS },
    },
    async run(args, t) {
      const limit = rowLimit(args.limit);
      const rows = await t.db.commerce
        .prepare(
          'SELECT id, order_number, channel, status, total_minor, currency, placed_at' +
            ' FROM "order" WHERE customer_id = ? ORDER BY placed_at DESC LIMIT ?',
        )
        .bind(args.customer_id, limit)
        .all();
      const orders = rows.results ?? [];
      const currencies = [...new Set(orders.map((o) => o.currency))];
      return {
        customer_id: args.customer_id,
        orders,
        count: orders.length,
        /* Money is minor units plus an explicit currency, and a mixed-currency
         * history gets no total at all rather than a wrong one. */
        lifetime:
          currencies.length === 1
            ? { total_minor: orders.reduce((s, o) => s + o.total_minor, 0), currency: currencies[0] }
            : null,
      };
    },
  },

  /*
   * T1. Produces the version rows and the patch; applies neither.
   * customer-skills rule 2: record the version row BEFORE applying the change —
   * so the proposal literally is the version rows, in order, and the human who
   * merges it writes them first.
   */
  "customer.update_fit": {
    tier: "T1",
    domain: "customers",
    stores: ["customers"],
    minRole: "staff",
    describe:
      "Propose a change to a customer's fit profile. Returns the customer_version " +
      "rows to append and the patch to apply after them. Writes nothing.",
    undo: "append a compensating customer_version row (customer.revert)",
    schema: {
      customer_id: { type: "string", required: true, format: "id" },
      garment: { type: "string", required: true, maxLength: 40 },
      size_label: { type: "string", maxLength: 40 },
      measurements: { type: "string", maxLength: CAPS.MAX_TEXT },
    },
    async check(args, t) {
      if (args.size_label === undefined && args.measurements === undefined) {
        return { denied: "nothing to change: give size_label, measurements, or both" };
      }
      if (args.measurements !== undefined && parseJson(args.measurements) === null) {
        return { denied: "measurements must be a JSON object" };
      }
      const customer = await t.db.customers
        .prepare("SELECT id FROM customer WHERE id = ?")
        .bind(args.customer_id)
        .first();
      if (!customer) return { denied: `no customer '${args.customer_id}'` };

      const consent = await t.db.customers
        .prepare(
          "SELECT granted FROM customer_consent WHERE customer_id = ? AND purpose = 'fit_profile'",
        )
        .bind(args.customer_id)
        .first();
      /* Absent consent is not consent. Fit data is intimate; fail closed. */
      if (!consent || !Number(consent.granted)) {
        return { denied: "no recorded fit_profile consent for this customer" };
      }
      return { ok: true, summary: `fit ${args.garment} for ${args.customer_id}` };
    },
    async run(args, t) {
      const current = await t.db.customers
        .prepare(
          "SELECT size_label, measurements FROM customer_fit WHERE customer_id = ? AND garment = ?",
        )
        .bind(args.customer_id, args.garment)
        .first();

      const changes = [];
      if (args.size_label !== undefined && (current?.size_label ?? null) !== args.size_label) {
        changes.push({ field: "size_label", old_value: current?.size_label ?? null, new_value: args.size_label });
      }
      if (args.measurements !== undefined && (current?.measurements ?? null) !== args.measurements) {
        changes.push({
          field: "measurements",
          old_value: current?.measurements ?? null,
          new_value: args.measurements,
        });
      }

      return {
        applied: false,
        proposal: {
          customer_id: args.customer_id,
          table: "customer_fit",
          garment: args.garment,
          exists: Boolean(current),
          changes,
          /* Written first, by the human who applies this. Then the patch. */
          version_rows: changes.map((c) => ({
            customer_id: args.customer_id,
            table_name: "customer_fit",
            field: c.field,
            old_value: c.old_value,
            new_value: c.new_value,
            actor: t.actor,
          })),
          patch: current
            ? {
                op: "update",
                where: { customer_id: args.customer_id, garment: args.garment },
                set: Object.fromEntries(changes.map((c) => [c.field, c.new_value])),
              }
            : {
                op: "insert",
                values: {
                  customer_id: args.customer_id,
                  garment: args.garment,
                  ...Object.fromEntries(changes.map((c) => [c.field, c.new_value])),
                },
              },
        },
      };
    },
  },
};

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
