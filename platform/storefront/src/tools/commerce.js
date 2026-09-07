/*
 * order.* / inventory.* — inherits agent-tool-contract, then commerce-skills.
 *
 * Reads only. `order.refund`, cancellation and any row deletion are T3 —
 * absent, and named in commerce-skills so nobody builds them by accident. Money
 * movement lives in the provider that holds the payment.
 *
 * `inventory.check` is a live D1 read on every call. Serving stock from the
 * static build shows a number that was true at deploy time and sells something
 * that is gone (commerce-skills rule 1), so there is no cache here and no
 * fallback to src/seed.js.
 *
 * Orders carry `customer_id` and no PII — Test-PRD-P0-11-erasure_vs_tax_retention
 * is a property of the schema, and these SELECTs name their columns so it stays
 * one.
 */
import { CAPS, rowLimit } from "./caps.js";

const ORDER_COLUMNS =
  'id, order_number, channel, external_id, customer_id, status, total_minor, currency, placed_at';

export const commerceTools = {
  "order.search": {
    tier: "T0",
    domain: "commerce",
    stores: ["commerce"],
    minRole: "staff",
    describe: "Search orders by status, channel or date range. Capped page size.",
    undo: null,
    schema: {
      status: {
        type: "string",
        enum: ["pending", "paid", "fulfilled", "cancelled", "refunded"],
      },
      channel: { type: "string", maxLength: 40 },
      since: { type: "string", format: "date" },
      until: { type: "string", format: "date" },
      limit: { type: "integer", min: 1, max: CAPS.MAX_ROWS },
    },
    async run(args, t) {
      const where = [];
      const binds = [];
      const clause = (sql, value) => {
        where.push(sql);
        binds.push(value);
      };
      if (args.status) clause("status = ?", args.status);
      if (args.channel) clause("channel = ?", args.channel);
      if (args.since) clause("placed_at >= ?", args.since);
      if (args.until) clause("placed_at <= ?", `${args.until}T23:59:59Z`);
      const limit = rowLimit(args.limit);
      binds.push(limit);

      const rows = await t.db.commerce
        .prepare(
          `SELECT ${ORDER_COLUMNS} FROM "order"` +
            (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
            " ORDER BY placed_at DESC LIMIT ?",
        )
        .bind(...binds)
        .all();
      const orders = rows.results ?? [];
      return { orders, count: orders.length, limit };
    },
  },

  "order.get": {
    tier: "T0",
    domain: "commerce",
    stores: ["commerce"],
    minRole: "staff",
    describe:
      "One order with its lines. Lines carry handle, title, SKU and unit-price " +
      "snapshots and no foreign key into the Git catalog.",
    undo: null,
    schema: { order_id: { type: "string", required: true, format: "id" } },
    async run(args, t) {
      const order = await t.db.commerce
        .prepare(`SELECT ${ORDER_COLUMNS} FROM "order" WHERE id = ?`)
        .bind(args.order_id)
        .first();
      if (!order) return { error: `no order '${args.order_id}'` };

      const lines = await t.db.commerce
        .prepare(
          "SELECT id, product_handle, sku_snapshot, title_snapshot, quantity," +
            " unit_price_minor, currency FROM order_line WHERE order_id = ? ORDER BY id LIMIT ?",
        )
        .bind(args.order_id, CAPS.MAX_ROWS)
        .all();

      return { order, lines: lines.results ?? [] };
    },
  },

  "inventory.check": {
    tier: "T0",
    domain: "commerce",
    stores: ["commerce"],
    minRole: "staff",
    describe:
      "Live stock for one SKU across locations. Never served from the static build.",
    undo: null,
    schema: {
      sku: { type: "string", required: true, format: "id" },
      location_id: { type: "string", format: "id" },
    },
    async run(args, t) {
      const sql =
        "SELECT il.sku, il.location_id, l.name AS location_name, il.on_hand, il.reserved," +
        " (il.on_hand - il.reserved) AS available, il.updated_at" +
        " FROM inventory_level il LEFT JOIN location l ON l.id = il.location_id" +
        " WHERE il.sku = ?" +
        (args.location_id ? " AND il.location_id = ?" : "") +
        " ORDER BY il.location_id LIMIT ?";
      const binds = args.location_id
        ? [args.sku, args.location_id, CAPS.MAX_ROWS]
        : [args.sku, CAPS.MAX_ROWS];
      const rows = await t.db.commerce.prepare(sql).bind(...binds).all();
      const levels = rows.results ?? [];
      return {
        sku: args.sku,
        levels,
        available_total: levels.reduce((s, r) => s + r.available, 0),
        /* Stated so a caller cannot mistake this for a build-time number. */
        read_at: new Date().toISOString(),
        live: true,
      };
    },
  },
};
