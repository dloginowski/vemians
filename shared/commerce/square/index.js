/*
 * SquareAdapter — the commerce port, implemented against Square.
 *
 * ADR-009: "The commerce port is unchanged. `SquareAdapter` implements the same
 * interface `ShopifyAdapter` did. That interface existing is why this is an
 * afternoon and not a rewrite."
 *
 * Test-PRD-P0-16-commerce_port. This file and its siblings are the ONLY place a
 * Square identifier or a Square URL may appear. Everything above it — the
 * storefront, the agent tools, the MCP endpoint — trades in our uuids, our
 * handles and our `Money`.
 *
 * THE DIRECTION OF THE OUTBOUND METHODS CHANGED, AND THAT IS THE POINT
 *
 * The port was written when our catalog was authoritative and projected OUT to
 * a channel. ADR-009 reverses that: "Square becomes the system of record for
 * inventory, and for the commercial facts of the catalog." So `projectProduct`
 * and `pushInventory` are no longer "keep the channel's copy in step with
 * ours" — they are "write to the authority", which is what a staff price change
 * or a stock correction from ops actually has to do now. They stay in
 * GATED_OPERATIONS, so both go through the approval gate and the audit log
 * before they leave the building.
 *
 * `retractProduct` deliberately does NOT call DeleteCatalogObject. Withdrawing
 * a product from sale must not destroy the authoritative record of it, and our
 * own copy is archived rather than removed (ADR-008: "deleting instead of
 * archiving destroys evidence"). It removes the item from our location and
 * archives the mirror row.
 */
import { createSquareClient } from "./client.js";
import { CATALOG_TYPES, listCatalog, normaliseCatalog, searchCatalogObjects } from "./catalog.js";
import { retrieveInventoryChanges, retrieveInventoryCounts } from "./inventory.js";
import { createPaymentLink } from "./checkout.js";
import { normaliseWebhook, verifyWebhook as verifySquareWebhook } from "./webhooks.js";
import { createMirror } from "./mirror.js";
import { idempotencyKey } from "./ids.js";
import { moneyFromSquare, moneyToSquare } from "./money.js";

export { SQUARE_VERSION, SquareError, createSquareClient } from "./client.js";
export { createMirror } from "./mirror.js";
export * from "./catalog.js";
export * from "./inventory.js";
export * from "./checkout.js";
export * from "./webhooks.js";

export const CHANNEL_KIND = "square";

/**
 * A Square Order -> our `Order`.
 *
 * Money stays integer minor units the whole way; `moneyFromSquare` throws on a
 * float rather than rounding one into a financial record
 * (Test-PRD-P0-15-money_minor_units).
 *
 * Lines carry snapshots and no foreign key, because the catalog is not in this
 * store (Test-PRD-P0-14-order_line_snapshot). `variantId` is our uuid, resolved
 * through the mirror when the variation is one we hold and null when it is not
 * — a counter sale of something never mirrored is still a real order.
 */
export function orderFromSquare(order, { variantIdByRef = new Map() } = {}) {
  if (!order?.id) return null;
  const currency = order.total_money?.currency ?? "USD";
  return {
    id: null, /* assigned by the persister; ours, never Square's */
    externalId: order.id,
    orderNumber: null,
    status: statusFromSquare(order.state),
    lines: (order.line_items ?? []).map((li) => ({
      variantId: variantIdByRef.get(li.catalog_object_id) ?? null,
      titleSnapshot: li.name ?? "",
      skuSnapshot: li.variation_name ?? null,
      quantity: Number.parseInt(li.quantity ?? "0", 10),
      unitPrice: li.base_price_money
        ? moneyFromSquare(li.base_price_money, `line ${li.uid ?? "?"}`)
        : { amountMinor: 0n, currency },
    })),
    total: order.total_money
      ? moneyFromSquare(order.total_money, `order ${order.id}`)
      : { amountMinor: 0n, currency },
    placedAt: order.created_at ? new Date(order.created_at) : new Date(),
  };
}

/* Square's order states are not our order states, and the map is lossy in one
   direction only: Square has no 'fulfilled' at the order level (it is per
   fulfilment), so COMPLETED is the closest honest reading. */
function statusFromSquare(state) {
  switch (state) {
    case "COMPLETED":
      return "paid";
    case "CANCELED":
      return "cancelled";
    case "DRAFT":
    case "OPEN":
    default:
      return "pending";
  }
}

/**
 * @param env   SQUARE_ACCESS_TOKEN, SQUARE_ENV, SQUARE_LOCATION_ID,
 *              SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_WEBHOOK_URL
 * @param deps  { mirrorDb, commerceDb, locationId (OURS), audit, client }
 */
export function createSquareAdapter(env, deps = {}) {
  const client = deps.client ?? createSquareClient(env, deps.clientOptions);
  const mirror =
    deps.mirror ??
    (deps.mirrorDb
      ? createMirror(deps.mirrorDb, {
          commerce: deps.commerceDb,
          locationId: deps.locationId ?? env?.LOCATION_ID ?? null,
          audit: deps.audit ?? null,
        })
      : null);

  function requireMirror(what) {
    if (!mirror) {
      console.error(`ERROR square/adapter: ${what} needs the catalog mirror and none is bound`);
      throw new Error("catalog mirror binding missing");
    }
    return mirror;
  }

  return {
    channelKind: CHANNEL_KIND,
    client,
    mirror,

    /* ── inbound: Square -> us ──────────────────────────────────────────── */

    /** Full sweep. The nightly reconcile, and the first sync. */
    async pullCatalog({ full = true, since = null } = {}) {
      const locationId = client.locationId;
      const objects = full
        ? await listCatalog(client, { types: CATALOG_TYPES })
        : null;
      if (full) {
        const normalised = normaliseCatalog(objects, { locationId });
        const counts = await requireMirror("pullCatalog").syncCatalog(normalised, { full: true });
        await mirror.recordSync("catalog", { cursor: new Date().toISOString() });
        return counts;
      }
      const { objects: found, related } = await searchCatalogObjects(client, { beginTime: since });
      const normalised = normaliseCatalog(found, { locationId, related });
      const counts = await requireMirror("pullCatalog").syncCatalog(normalised, { full: false });
      await mirror.recordSync("catalog", { cursor: new Date().toISOString() });
      return counts;
    },

    /** Square's inventory HISTORY into our append-only ledger. */
    async pullInventory({ since = null, catalogObjectIds = [] } = {}) {
      const changes = await retrieveInventoryChanges(client, { updatedAfter: since, catalogObjectIds });
      const result = await requireMirror("pullInventory").syncInventoryChanges(changes);
      await mirror.recordSync("inventory", { cursor: new Date().toISOString() });
      return result;
    },

    /** Square's computed counts vs our derived ledger; differences corrected. */
    async reconcileInventory({ catalogObjectIds = [] } = {}) {
      const counts = await retrieveInventoryCounts(client, { catalogObjectIds });
      return requireMirror("reconcileInventory").reconcileCounts(counts);
    },

    /* ── outbound: us -> Square (all GATED_OPERATIONS) ──────────────────── */

    /**
     * UpsertCatalogObject. Under ADR-009 this writes to the AUTHORITY, so it is
     * how a staff price change actually takes effect — and why it is gated.
     * `version` carries Square's optimistic concurrency: sending a stale one is
     * refused by Square rather than silently overwriting a counter edit.
     */
    async projectProduct(product) {
      const existing = product.externalRef
        ? { id: product.externalRef, version: product.sourceVersion ?? undefined }
        : null;
      const body = {
        idempotency_key: idempotencyKey(`product:${product.id ?? product.handle}`),
        object: {
          type: "ITEM",
          id: existing?.id ?? `#${product.handle}`,
          ...(existing?.version === undefined ? {} : { version: existing.version }),
          item_data: {
            name: product.title,
            variations: (product.variants ?? []).map((v, i) => ({
              type: "ITEM_VARIATION",
              id: v.externalRef ?? `#${product.handle}-${i}`,
              ...(v.sourceVersion === undefined ? {} : { version: v.sourceVersion }),
              item_variation_data: {
                item_id: existing?.id ?? `#${product.handle}`,
                name: v.title,
                sku: v.sku ?? undefined,
                pricing_type: "FIXED_PRICING",
                price_money: moneyToSquare(v.price, `variant ${v.id}`),
              },
            })),
          },
        },
      };
      const res = await client.post("/v2/catalog/object", body);
      return { entityId: product.id, externalId: res?.catalog_object?.id ?? null };
    },

    /**
     * Withdraw, do not destroy. `present_at_all_locations: false` with an empty
     * include list takes the item off sale everywhere without deleting the
     * authoritative record, and the mirror row is archived rather than removed.
     */
    async retractProduct(productId) {
      const m = requireMirror("retractProduct");
      const row = await m.productByHandle(productId).catch(() => null);
      const externalRef = row?.external_ref ?? productId;
      await client.post("/v2/catalog/object", {
        idempotency_key: idempotencyKey(`retract:${productId}`),
        object: {
          type: "ITEM",
          id: externalRef,
          present_at_all_locations: false,
          present_at_location_ids: [],
        },
      });
      /* The mirror archives on the next sync; no DELETE anywhere, ever. */
    },

    /**
     * BatchChangeInventory. Our deltas become Square ADJUSTMENT changes, which
     * is the direction that keeps ONE ledger: writing a number into Square and
     * a number into us would be the two-authoritative-counts bug ADR-009 exists
     * to prevent.
     */
    async pushInventory(levels) {
      const locationId = client.locationId;
      const changes = (levels ?? []).map((l) => ({
        type: "PHYSICAL_COUNT",
        physical_count: {
          catalog_object_id: l.externalRef,
          state: "IN_STOCK",
          location_id: locationId,
          quantity: String(l.onHand),
          occurred_at: new Date().toISOString(),
        },
      }));
      if (changes.length === 0) return;
      await client.post("/v2/inventory/changes/batch-create", {
        idempotency_key: idempotencyKey(`inventory:${JSON.stringify(changes)}`),
        changes,
        ignore_unchanged_counts: true,
      });
    },

    /* ── webhooks ───────────────────────────────────────────────────────── */

    verifyWebhook(headers, body) {
      return verifySquareWebhook(headers, body, {
        signatureKey: env?.SQUARE_WEBHOOK_SIGNATURE_KEY,
        notificationUrl: env?.SQUARE_WEBHOOK_URL,
      });
    },

    /**
     * port.ts: MUST NOT write to the database — the caller persists, so ingest
     * stays replayable from `order.raw_payload`. So this parses and returns.
     *
     * It returns null for an `order.created` that carries only an envelope,
     * which is Square's usual shape: id, version, location, state, and no line
     * items or total. `parseOrderWebhook` cannot invent a total, and an Order
     * with zero lines and zero money is a false financial record. The caller
     * reads `normaliseWebhook(...).needsFetch` and does a RetrieveOrder.
     */
    async parseOrderWebhook(headers, body) {
      let event;
      try {
        event = JSON.parse(body);
      } catch (err) {
        console.error(`ERROR square/adapter: unparseable webhook body — ${err.message}`);
        return null;
      }
      const normalised = normaliseWebhook(event, { locationId: client.locationId });
      if (normalised?.kind !== "order.created") return null;
      if (!normalised.order) {
        console.warn(
          `WARNING square/adapter: order ${normalised.externalId} arrived as an envelope; RetrieveOrder needed before persisting`,
        );
        return null;
      }
      return orderFromSquare(normalised.order);
    },

    /** RetrieveOrder, for the envelope case above. */
    async fetchOrder(externalId) {
      const res = await client.get(`/v2/orders/${encodeURIComponent(externalId)}`);
      return orderFromSquare(res?.order ?? null);
    },

    /* ── checkout: the one rented thing, and the one live Square call ───── */

    /**
     * Our variant uuids in, a Square-hosted URL out. The uuid -> Square
     * variation translation happens in the mirror and nowhere else, so no
     * caller has ever held a Square identifier.
     */
    async createCheckoutUrl(items, options = {}) {
      const m = requireMirror("createCheckoutUrl");
      const rows = await m.resolveVariantRefs(items.map((i) => i.variantId));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const lineItems = items.map((i) => ({
        externalRef: byId.get(i.variantId).external_ref,
        quantity: i.quantity,
      }));
      const { url } = await createPaymentLink(client, {
        lineItems,
        /* A stable seed: the same cart retried mints the same link, which is
           what Square's idempotency_key is for. */
        idempotencySeed:
          options.cartId ?? items.map((i) => `${i.variantId}x${i.quantity}`).join("|"),
        redirectUrl: options.redirectUrl ?? null,
      });
      return url;
    },
  };
}
