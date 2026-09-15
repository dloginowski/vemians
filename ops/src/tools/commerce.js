/*
 * order.* / inventory.* — inherits agent-tool-contract, then commerce-skills.
 *
 * order.* is reads only. `order.refund`, cancellation and any row deletion are
 * T3 — absent, and named in commerce-skills so nobody builds them by accident.
 * Money movement lives in the provider that holds the payment. `inventory.
 * bulk_set` is T3 for the same reason (tiers.js): "one approval covering the
 * entire stock position." `inventory.adjust` below is the bounded, T2
 * opposite — ONE variation, a delta, one approval, the same shape every
 * catalog write already uses.
 *
 * `inventory.check` is a live D1 read on every call. Serving stock from the
 * static build shows a number that was true at deploy time and sells something
 * that is gone (commerce-skills rule 1), so there is no cache here and no
 * fallback to src/seed.js.
 *
 * Orders carry `customer_id` and no PII — Test-PRD-P0-11-erasure_vs_tax_retention
 * is a property of the schema, and these SELECTs name their columns so it stays
 * one.
 *
 * `inventory.adjust` (Test-PRD-P0-31-inventory_ledger, revised) — "the count
 * cannot be written directly" holds here exactly as it does everywhere else in
 * this file's own ledger: this tool NEVER writes `inventory_adjustment`
 * itself. It writes the resulting absolute count to SQUARE
 * (`t.square.adapter.pushInventory`, ADR-009's authority for stock, same as a
 * price), then syncs (`pullInventory`) so the SAME code path that turns any
 * OTHER Square inventory event into a ledger row — mirror.js's own
 * `syncInventoryChanges` — turns this one into a row too. One writer into the
 * ledger, always the sync, never an agent tool; this tool only ever moves the
 * number Square itself holds.
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

  "inventory.adjust": {
    tier: "T2",
    domain: "commerce",
    stores: ["commerce"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Move ONE variation's stock by a delta (positive to receive, negative to remove) — a bounded " +
      "version of the bulk stock-position change this codebase deliberately never built " +
      "(inventory.bulk_set, tiers.js). Writes the resulting count to Square, never to our own ledger " +
      "directly; the mirror sync turns Square's own resulting event into the actual ledger row, the " +
      "same way any OTHER stock movement Square knows about already becomes one.",
    undo: "another inventory.adjust with the opposite delta",
    schema: {
      variant_id: { type: "string", required: true, format: "id" },
      delta: { type: "integer", required: true },
    },
    async variant(args, t) {
      /* Through t.square, not a `catalog_mirror` store of this tool's own —
         "no tool holds two stores at once" (Test-PRD-P0-24-binding_scoped_
         tools). t.square already carries its own internal mirror access
         (the same one productByHandle uses for every catalog write); this
         is that same read, exposed as variantById (catalog-writer.js). */
      return t.square.variantById(args.variant_id);
    },
    async onHand(sku, t) {
      const row = await t.db.commerce.prepare("SELECT on_hand FROM inventory_level WHERE sku = ?").bind(sku).first();
      return Number(row?.on_hand ?? 0);
    },
    async check(args, t) {
      if (args.delta === 0) return { denied: "a delta of 0 would change nothing" };
      const variant = await this.variant(args, t);
      if (!variant) return { denied: `no variation '${args.variant_id}' in the mirror` };
      if (!variant.sku) {
        return {
          denied:
            `'${variant.product_title}' — '${variant.variant_title}' has no SKU yet, so it has never ` +
            "been mirrored into stock — nothing to adjust",
        };
      }
      const current = await this.onHand(variant.sku, t);
      const resulting = current + args.delta;
      if (resulting < 0) {
        return {
          denied: `${current} in stock — a change of ${args.delta} would take it negative`,
          detail: { reason: "would_go_negative", current },
        };
      }
      return {
        ok: true,
        summary:
          `adjust "${variant.product_title}" — "${variant.variant_title}" stock by ` +
          `${args.delta > 0 ? "+" : ""}${args.delta} (${current} -> ${resulting})`,
        preflight: { variant, current },
      };
    },
    async run(args, t) {
      /* Re-derived, not trusted from check() — real time passes between a T2
         check() and its approved run(), and someone else's sale or receipt in
         that gap must not be silently overwritten by a stale target count. */
      const variant = await this.variant(args, t);
      if (!variant?.sku) return { error: `no SKU for variation '${args.variant_id}' — nothing to adjust` };
      const current = await this.onHand(variant.sku, t);
      const resulting = current + args.delta;
      if (resulting < 0) {
        return { error: `${current} in stock now — a change of ${args.delta} would take it negative` };
      }

      /* Square is still the write that matters (ADR-009) — once pushInventory
         returns, the count Square itself will report from here on is
         `resulting`, full stop. The immediate pullInventory right after is
         only this call's own best-effort shortcut to reflect that back
         without waiting for the next 15-minute cron sync; a hiccup in IT
         (a transient batch-retrieve failure) must never make this call look
         refused when the actual write already landed — the cron's own
         regular pullInventory({ since }) will reconcile the ledger anyway. */
      await t.square.adapter.pushInventory([{ externalRef: variant.external_ref, onHand: resulting }]);
      try {
        await t.square.adapter.pullInventory({ catalogObjectIds: [variant.external_ref] });
      } catch (err) {
        console.error(`ERROR inventory.adjust: immediate post-write sync failed, cron will reconcile — ${err.message}`);
        return { adjusted: true, sku: variant.sku, delta: args.delta, on_hand: resulting, synced: false };
      }

      const after = await this.onHand(variant.sku, t);
      return { adjusted: true, sku: variant.sku, delta: args.delta, on_hand: after, synced: true };
    },
  },
};
