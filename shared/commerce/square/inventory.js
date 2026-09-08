/*
 * Square's inventory -> our append-only ledger.
 *
 * ADR-009 says the fit is close, and it is: "Square's inventory model is
 * already a ledger -- InventoryPhysicalCount (provided) and InventoryCount
 * (computed), with adjustments between them. That is precisely the design in
 * ADR-008... the semantics line up without translation."
 *
 * THREE PLACES THEY DO NOT LINE UP, STATED PLAINLY
 *
 * The ADR is right about the SHAPE and understates the arithmetic. Three real
 * translations happen in this file, and pretending otherwise would put the
 * mistakes in the stock number:
 *
 * 1. SQUARE'S PHYSICAL COUNTS ARE ABSOLUTE; OURS ARE DELTAS.
 *    `InventoryPhysicalCount.quantity` is "there are 7 of these on the shelf".
 *    `inventory_adjustment.delta` is "+2", with `CHECK (delta <> 0)`. So a
 *    physical count cannot be mapped without knowing what we currently think
 *    the count is: delta = counted - derived_on_hand. That subtraction is a
 *    READ of our own `inventory_level` view, which is why `normaliseChanges`
 *    leaves physical counts as `{ kind: 'PHYSICAL_COUNT', quantity }` and
 *    mirror.js — the only module holding a database — resolves the delta.
 *    Getting this wrong in the other direction (treating 7 as +7) is precisely
 *    the double-count the idempotency tests exist to catch.
 *
 * 2. SQUARE'S STATE MACHINE IS WIDER THAN OUR `reason` VOCABULARY.
 *    Square has ~15 inventory states and models a change as a transition
 *    between two of them. `inventory_adjustment.reason` has eight values,
 *    CHECKed by the schema. The map below is therefore lossy and explicit; an
 *    unrecognised transition becomes 'correction' and is logged, never dropped
 *    and never invented into a value the CHECK would reject.
 *
 * 3. SQUARE KEYS BY `catalog_object_id`; WE KEY BY `sku`.
 *    `inventory_adjustment(sku, location_id)` has no variation column and must
 *    not grow one (Test-PRD-P0-16-commerce_port: `order.external_id` is the
 *    only vendor field in the commerce store). The variation id resolves to a
 *    SKU through the catalog mirror, so a stock change for a variation we have
 *    never mirrored is refused rather than guessed at.
 *
 * ONE LOCATION. ADR-009 open question 2, answered: one. Stock is a single
 * number per variation, so every read here is filtered to the configured
 * location and a change at any other location is dropped with a warning —
 * silently folding a second location's stock into ours is the overselling bug
 * the ADR is about.
 */
import { minorFromSquare } from "./money.js";

/* Square states that mean "sellable stock we hold". Only IN_STOCK counts. */
export const SELLABLE_STATE = "IN_STOCK";

/*
 * Square transition -> our `reason`. The commerce schema CHECKs the right-hand
 * side; anything not here becomes 'correction' with a WARNING, because a stock
 * movement we cannot name is still a stock movement and dropping it would make
 * our count diverge from the till's for a reason nobody could later find.
 */
const REASON_BY_TRANSITION = Object.freeze({
  "NONE>IN_STOCK": "receipt",
  "ORDERED_FROM_VENDOR>IN_STOCK": "receipt",
  "RECEIVED_FROM_VENDOR>IN_STOCK": "receipt",
  "IN_TRANSIT_TO>IN_STOCK": "transfer",
  "IN_STOCK>SOLD": "sale",
  "IN_STOCK>SOLD_ONLINE": "sale",
  "IN_STOCK>RESERVED_FOR_SALE": "sale",
  "IN_STOCK>WASTE": "damage",
  "IN_STOCK>UNLINKED_RETURN": "return",
  "RETURNED_BY_CUSTOMER>IN_STOCK": "return",
  "UNLINKED_RETURN>IN_STOCK": "return",
  "IN_STOCK>IN_TRANSIT_TO": "transfer",
  "IN_STOCK>NONE": "correction",
  "IN_STOCK>COMPOSED": "correction",
  "DECOMPOSED>IN_STOCK": "correction",
});

export function reasonForTransition(fromState, toState) {
  const key = `${fromState}>${toState}`;
  const known = REASON_BY_TRANSITION[key];
  if (known) return known;
  console.warn(
    `WARNING square/inventory: unmapped state transition ${key} — recorded as 'correction'`,
  );
  return "correction";
}

/* Square quantities are decimal STRINGS ("7", and "1.5" for measured goods). */
function quantityOf(raw, context) {
  if (raw === undefined || raw === null || raw === "") return 0;
  try {
    return Number(minorFromSquare(raw, context));
  } catch (err) {
    /* A fractional quantity means the item is sold by weight. Our ledger is
       whole units (`delta INTEGER`), so refusing is honest; rounding would put
       a silent error into a number money depends on. */
    console.error(`ERROR square/inventory: ${context} — ${err.message}`);
    return null;
  }
}

/* ── reads ─────────────────────────────────────────────────────────────── */

/**
 * RetrieveInventoryCount — one variation, the computed number.
 * `GET /v2/inventory/{catalog_object_id}`.
 */
export async function retrieveInventoryCount(client, catalogObjectId, { locationId } = {}) {
  const location = locationId ?? client.locationId;
  const counts = [];
  for await (const page of client.paginate("GET", `/v2/inventory/${encodeURIComponent(catalogObjectId)}`, {
    query: { location_ids: location ?? undefined },
    cursorIn: "query",
  })) {
    counts.push(...(page.counts ?? []));
  }
  return normaliseCounts(counts, { locationId: location });
}

/**
 * BatchRetrieveInventoryCounts — the nightly reconcile's "what does Square
 * think right now", used to prove the derived ledger has not drifted.
 * `POST /v2/inventory/counts/batch-retrieve`.
 */
export async function retrieveInventoryCounts(
  client,
  { catalogObjectIds = [], locationId, updatedAfter = null } = {},
) {
  const location = locationId ?? client.locationId;
  const counts = [];
  const body = {
    ...(catalogObjectIds.length ? { catalog_object_ids: catalogObjectIds } : {}),
    ...(location ? { location_ids: [location] } : {}),
    states: [SELLABLE_STATE],
    ...(updatedAfter ? { updated_after: updatedAfter } : {}),
  };
  for await (const page of client.paginate("POST", "/v2/inventory/counts/batch-retrieve", {
    body,
    cursorIn: "body",
  })) {
    counts.push(...(page.counts ?? []));
  }
  return normaliseCounts(counts, { locationId: location });
}

/**
 * BatchRetrieveInventoryChanges — the HISTORY, which is the point.
 *
 * ADR-009: "Our inventory_adjustment table becomes a mirror of Square's changes
 * rather than a competing ledger." Mirroring only the latest number would keep
 * Square's answer and throw away Square's reasoning, which is the thing an
 * append-only ledger exists to hold.
 * `POST /v2/inventory/changes/batch-retrieve`.
 */
export async function retrieveInventoryChanges(
  client,
  { catalogObjectIds = [], locationId, updatedAfter = null, types = ["PHYSICAL_COUNT", "ADJUSTMENT", "TRANSFER"] } = {},
) {
  const location = locationId ?? client.locationId;
  const changes = [];
  const body = {
    ...(catalogObjectIds.length ? { catalog_object_ids: catalogObjectIds } : {}),
    ...(location ? { location_ids: [location] } : {}),
    types,
    ...(updatedAfter ? { updated_after: updatedAfter } : {}),
  };
  for await (const page of client.paginate("POST", "/v2/inventory/changes/batch-retrieve", {
    body,
    cursorIn: "body",
  })) {
    changes.push(...(page.changes ?? []));
  }
  return normaliseChanges(changes, { locationId: location });
}

/* ── normalisation (pure; replayable from a stored payload) ────────────── */

/**
 * InventoryCount[] -> our shape. Filtered to the one location and to sellable
 * state, because "in stock" is a lookup and not a decision (ADR-009).
 */
export function normaliseCounts(counts, { locationId = null } = {}) {
  const out = [];
  for (const c of counts ?? []) {
    if (locationId && c?.location_id && c.location_id !== locationId) {
      console.warn(
        `WARNING square/inventory: count at location ${c.location_id} ignored — this platform runs one location`,
      );
      continue;
    }
    if (c?.state && c.state !== SELLABLE_STATE) continue;
    const quantity = quantityOf(c?.quantity, `count for ${c?.catalog_object_id}`);
    if (quantity === null) continue;
    out.push({
      variantExternalRef: c.catalog_object_id,
      onHand: quantity,
      calculatedAt: c.calculated_at ?? null,
    });
  }
  return out;
}

/**
 * InventoryChange[] -> our shape.
 *
 * Emits one record per change that touches sellable stock at our location.
 * A PHYSICAL_COUNT carries `quantity` (absolute) and no delta — see the header:
 * only a module that can read our current count may turn that into a delta.
 */
export function normaliseChanges(changes, { locationId = null } = {}) {
  const out = [];

  for (const change of changes ?? []) {
    const kind = change?.type;

    if (kind === "PHYSICAL_COUNT") {
      const pc = change.physical_count;
      if (!pc) continue;
      if (locationId && pc.location_id && pc.location_id !== locationId) {
        console.warn(
          `WARNING square/inventory: physical count at location ${pc.location_id} ignored — one location only`,
        );
        continue;
      }
      if (pc.state && pc.state !== SELLABLE_STATE) continue;
      const quantity = quantityOf(pc.quantity, `physical count ${pc.id}`);
      if (quantity === null) continue;
      out.push({
        kind: "PHYSICAL_COUNT",
        externalRef: pc.id,
        variantExternalRef: pc.catalog_object_id,
        quantity, /* ABSOLUTE. mirror.js derives the delta. */
        delta: null,
        reason: "count",
        occurredAt: pc.occurred_at ?? pc.created_at ?? null,
      });
      continue;
    }

    if (kind === "ADJUSTMENT") {
      const adj = change.adjustment;
      if (!adj) continue;
      if (locationId && adj.location_id && adj.location_id !== locationId) {
        console.warn(
          `WARNING square/inventory: adjustment at location ${adj.location_id} ignored — one location only`,
        );
        continue;
      }
      const quantity = quantityOf(adj.quantity, `adjustment ${adj.id}`);
      if (quantity === null) continue;

      /* Only the sellable side of the transition moves OUR number. A
         SOLD -> NONE tidy-up inside Square changes nothing we count. */
      let delta = 0;
      if (adj.to_state === SELLABLE_STATE) delta = quantity;
      else if (adj.from_state === SELLABLE_STATE) delta = -quantity;
      if (delta === 0) continue;

      out.push({
        kind: "ADJUSTMENT",
        externalRef: adj.id,
        variantExternalRef: adj.catalog_object_id,
        quantity: null,
        delta,
        reason: reasonForTransition(adj.from_state, adj.to_state),
        occurredAt: adj.occurred_at ?? adj.created_at ?? null,
      });
      continue;
    }

    if (kind === "TRANSFER") {
      const tr = change.transfer;
      if (!tr) continue;
      /* With one location a transfer should not exist. If one arrives, it is
         either a second location opening (ADR-009 says that stops being a
         lookup and needs an explicit rule) or a mistake. Either way it is
         reported, not absorbed. */
      const quantity = quantityOf(tr.quantity, `transfer ${tr.id}`);
      if (quantity === null) continue;
      let delta = 0;
      if (locationId && tr.to_location_id === locationId) delta = quantity;
      else if (locationId && tr.from_location_id === locationId) delta = -quantity;
      if (delta === 0) {
        console.warn(
          `WARNING square/inventory: transfer ${tr.id} touches neither side of location ${locationId} — ignored`,
        );
        continue;
      }
      console.warn(
        `WARNING square/inventory: transfer ${tr.id} seen on a single-location platform (ADR-009 q2) — mirrored as 'transfer'`,
      );
      out.push({
        kind: "TRANSFER",
        externalRef: tr.id,
        variantExternalRef: tr.catalog_object_id,
        quantity: null,
        delta,
        reason: "transfer",
        occurredAt: tr.occurred_at ?? tr.created_at ?? null,
      });
      continue;
    }

    if (kind) {
      console.warn(`WARNING square/inventory: unhandled inventory change type ${kind} — ignored`);
    }
  }

  return out;
}
