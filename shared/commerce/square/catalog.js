/*
 * Square's catalog -> our shape.
 *
 * ADR-009: "Catalog maps cleanly too: Square ITEM -> our product,
 * ITEM_VARIATION -> our variant, with stock tracked at the variation level,
 * exactly where we track it."  That is true, and this file is mostly a
 * flattening rather than a translation. The parts that are NOT a straight map
 * are called out where they happen:
 *
 *   1. Square has no `handle`. It has an id and a name. Our URLs are handles
 *      (Test-PRD-P0-26-owned_storefront), so one is derived on first sight and
 *      then frozen by mirror.js — a title edited at the counter must not
 *      silently 404 a page someone linked to.
 *   2. Square has no draft/active/archived. It has `is_deleted`, and
 *      `present_at_all_locations` / `present_at_location_ids`. A product
 *      withdrawn from our one location is 'archived' to us, not gone (ADR-008).
 *   3. Square's `item_options` are ids pointing at OPTION objects; the
 *      per-variation `item_option_values` are id pairs. Resolving them to
 *      human names needs the related objects, so `normaliseCatalog` takes the
 *      whole object set and resolves what it can, rather than emitting
 *      `{"OPT_1": "OPTVAL_9"}` into our store.
 *
 * NOTHING HERE WRITES. Normalising is pure so a sync can be replayed from a
 * stored payload — the same property `order.raw_payload` gives order ingest.
 */
import { moneyFromSquare } from "./money.js";
import { handleFrom } from "./ids.js";

/** The object types this adapter mirrors. Ordered as Square documents them. */
export const CATALOG_TYPES = Object.freeze(["ITEM", "ITEM_VARIATION", "IMAGE", "CATEGORY"]);

/* ── reads ─────────────────────────────────────────────────────────────── */

/**
 * ListCatalog — the full sweep, for the nightly reconcile and the first sync.
 * Paginated by cursor in the query string.
 *
 * @returns {Promise<object[]>} every CatalogObject of the requested types.
 */
export async function listCatalog(client, { types = CATALOG_TYPES } = {}) {
  const objects = [];
  for await (const page of client.paginate("GET", "/v2/catalog/list", {
    query: { types: types.join(",") },
    cursorIn: "query",
  })) {
    objects.push(...(page.objects ?? []));
  }
  return objects;
}

/**
 * SearchCatalogObjects — the incremental sweep.
 *
 * This is the one that matters in steady state. `catalog.version.updated` tells
 * us that SOMETHING in the catalog changed and nothing about what, so the
 * follow-up is a search since the last successful sync rather than a full
 * re-list on every till edit.
 *
 * `include_deleted_objects` is on deliberately: a product withdrawn in Square
 * arrives here as `is_deleted: true`, and if we did not ask for it we would
 * simply stop seeing the object and have no way to tell "withdrawn" from "not
 * in this page". Withdrawal must reach us as a fact, because the mirror
 * archives it (ADR-008) rather than dropping it.
 */
export async function searchCatalogObjects(
  client,
  { types = CATALOG_TYPES, beginTime = null, includeDeleted = true, includeRelated = true, limit = 200 } = {},
) {
  const objects = [];
  const related = [];
  const body = {
    object_types: types,
    include_deleted_objects: includeDeleted,
    include_related_objects: includeRelated,
    limit,
    ...(beginTime ? { begin_time: beginTime } : {}),
  };
  for await (const page of client.paginate("POST", "/v2/catalog/search", {
    body,
    cursorIn: "body",
  })) {
    objects.push(...(page.objects ?? []));
    related.push(...(page.related_objects ?? []));
  }
  return { objects, related };
}

/* ── normalisation ─────────────────────────────────────────────────────── */

/*
 * Square marks withdrawal in three different places and they do not mean the
 * same thing:
 *
 *   is_deleted                  the object is gone from Square's catalog
 *   present_at_all_locations    sold everywhere unless excluded
 *   present_at_location_ids     the explicit include list
 *   absent_at_location_ids      the explicit exclude list
 *
 * With ONE location (ADR-009, open question 2 answered) "withdrawn" means any
 * of: deleted, or not present at our location. All three collapse to the same
 * outcome for us — archived in the mirror, never removed.
 */
export function isWithdrawn(object, locationId) {
  if (object?.is_deleted === true) return true;
  if (!locationId) return false;
  if (Array.isArray(object?.absent_at_location_ids) && object.absent_at_location_ids.includes(locationId)) {
    return true;
  }
  if (object?.present_at_all_locations === true) return false;
  const present = object?.present_at_location_ids;
  if (Array.isArray(present)) return !present.includes(locationId);
  /* present_at_all_locations false with no include list = present nowhere. */
  return object?.present_at_all_locations === false;
}

/* Square's option values are ids. Without the OPTION objects they are noise. */
function optionsFor(variationData, optionNames, optionValueNames) {
  const out = {};
  for (const pair of variationData?.item_option_values ?? []) {
    const name = optionNames.get(pair.item_option_id);
    const value = optionValueNames.get(pair.item_option_value_id);
    /* An unresolved pair is dropped rather than stored as raw ids: a Square
       identifier belongs in external_ref, not smuggled into an options blob
       (Test-PRD-P0-16-commerce_port). It is logged so the missing OPTION
       object is visible instead of silently thinning the variant. */
    if (name === undefined || value === undefined) {
      console.warn(
        `WARNING square/catalog: unresolved item option on variation ${variationData?.sku ?? "?"} — related OPTION objects not fetched`,
      );
      continue;
    }
    out[name] = value;
  }
  return out;
}

function variationPrice(data, context) {
  /* VARIABLE_PRICING carries no price_money at all. Zero-with-a-currency is the
     honest mirror of "priced at the counter"; a null would put the storefront's
     price formatting in the business of guessing. */
  if (!data?.price_money) {
    return { amountMinor: 0n, currency: data?.currency ?? "USD" };
  }
  return moneyFromSquare(data.price_money, context);
}

function tracksStock(data, locationId) {
  const overrides = data?.location_overrides ?? [];
  const mine = overrides.find((o) => o.location_id === locationId);
  if (mine && typeof mine.track_inventory === "boolean") return mine.track_inventory;
  return Boolean(data?.track_inventory);
}

/**
 * The whole map, in one pass over a flat CatalogObject list.
 *
 * @param objects    CatalogObject[] from listCatalog or searchCatalogObjects
 * @param locationId our single Square location
 * @returns {{ products: object[], categories: object[] }} in OUR shape:
 *          every entity carries `externalRef` (the Square id) and nothing else
 *          Square-shaped, money is `{ amountMinor: bigint, currency }`.
 */
export function normaliseCatalog(objects, { locationId = null, related = [] } = {}) {
  const all = [...(objects ?? []), ...(related ?? [])];

  const categories = [];
  const byId = new Map();
  const images = new Map();
  const optionNames = new Map();
  const optionValueNames = new Map();

  for (const o of all) {
    if (!o?.id || !o?.type) continue;
    byId.set(o.id, o);
    if (o.type === "IMAGE") images.set(o.id, o);
    if (o.type === "ITEM_OPTION") {
      optionNames.set(o.id, o.item_option_data?.name ?? o.id);
      for (const v of o.item_option_data?.values ?? []) {
        optionValueNames.set(v.id, v.item_option_value_data?.name ?? v.id);
      }
    }
    if (o.type === "ITEM_OPTION_VAL") {
      optionValueNames.set(o.id, o.item_option_value_data?.name ?? o.id);
    }
  }

  for (const o of all) {
    if (o?.type !== "CATEGORY") continue;
    categories.push({
      externalRef: o.id,
      name: o.category_data?.name ?? "",
      withdrawn: isWithdrawn(o, locationId),
    });
  }

  /* Variations arrive as their own top-level objects on an incremental search
     and nested under the item on a full list. Collect both, keyed by item. */
  const variationsByItem = new Map();
  const pushVariation = (v) => {
    const itemId = v?.item_variation_data?.item_id;
    if (!itemId) return;
    if (!variationsByItem.has(itemId)) variationsByItem.set(itemId, new Map());
    variationsByItem.get(itemId).set(v.id, v);
  };
  for (const o of all) if (o?.type === "ITEM_VARIATION") pushVariation(o);
  for (const o of all) {
    if (o?.type !== "ITEM") continue;
    for (const v of o.item_data?.variations ?? []) {
      if (v?.id) pushVariation({ ...v, item_variation_data: { ...v.item_variation_data, item_id: o.id } });
    }
  }

  const products = [];
  for (const o of all) {
    if (o?.type !== "ITEM") continue;
    const data = o.item_data ?? {};
    const withdrawn = isWithdrawn(o, locationId);

    const variations = [...(variationsByItem.get(o.id)?.values() ?? [])];
    const variants = variations.map((v, i) => {
      const vd = v.item_variation_data ?? {};
      return {
        externalRef: v.id,
        sku: vd.sku ?? null,
        title: vd.name ?? "",
        ordinal: Number.isInteger(vd.ordinal) ? vd.ordinal : i,
        price: variationPrice(vd, `variation ${v.id}`),
        options: optionsFor(vd, optionNames, optionValueNames),
        tracksStock: tracksStock(vd, locationId),
        sourceVersion: Number(v.version ?? 0),
        /* A variation is withdrawn if IT is, or if its item is. */
        withdrawn: withdrawn || isWithdrawn(v, locationId),
      };
    });

    const imageIds = [
      ...(data.image_ids ?? []),
      ...(data.image_id ? [data.image_id] : []),
    ];
    const media = [];
    const seenImages = new Set();
    for (const [i, id] of imageIds.entries()) {
      if (seenImages.has(id)) continue;
      seenImages.add(id);
      const img = images.get(id);
      media.push({
        externalRef: id,
        sourceUrl: img?.image_data?.url ?? "",
        caption: img?.image_data?.caption ?? "",
        ordinal: i,
        withdrawn: img ? isWithdrawn(img, locationId) : false,
      });
    }

    products.push({
      externalRef: o.id,
      /* Proposed, not authoritative: mirror.js keeps the handle it already has. */
      handle: handleFrom(data.name, o.id),
      title: data.name ?? "",
      /* Square's description is mirrored for reconciliation ONLY. ADR-009
         anti-pattern: editorial copy does not live in Square item
         descriptions — it lives in Git, keyed by handle. */
      sourceDescription: data.description_plaintext ?? data.description ?? "",
      status: withdrawn ? "archived" : "active",
      categoryExternalRef:
        data.reporting_category?.id ??
        data.categories?.[0]?.id ??
        data.category_id ??
        null,
      sourceVersion: Number(o.version ?? 0),
      withdrawn,
      variants,
      media,
    });
  }

  return { products, categories };
}
