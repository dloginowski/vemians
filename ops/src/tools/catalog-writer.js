/*
 * The catalog WRITE path, behind one small interface — the sibling of
 * catalog-source.js, which is the read path.
 *
 * ─── THE ONE ARCHITECTURAL RULE THIS FILE EXISTS TO HOLD ───────────────────
 *
 * THE AGENT WRITES TO SQUARE. IT NEVER WRITES TO THE MIRROR.
 *
 * ADR-009 makes Square the system of record for the commercial facts of the
 * catalog, because the till changes them without asking us. The mirror
 * (shared/commerce/square/schema.sql) is a COPY that follows by sync and
 * webhook. If an agent tool wrote a product row into the mirror directly there
 * would be two writers into one copy — the till's sync and ours — and they
 * would diverge silently, in the direction that shows the shop something Square
 * has never heard of. So every method below ends at `client.post(...)` against
 * Square, and the mirror is touched only through `mirror.syncCatalog`, reading
 * back what Square now says. `syncAfterWrite` is the last step of every write
 * and never the first.
 *
 * ─── AND THE SECOND ONE ────────────────────────────────────────────────────
 *
 * No Square identifier crosses this file's boundary (Test-PRD-P0-16-commerce_port).
 * Callers name a category by OUR uuid and a product by OUR handle; the
 * translation to `external_ref` happens here, against the mirror, exactly as
 * `resolveVariantRefs` does it for checkout. An ops tool that held a Square id
 * would have to give it back to something eventually, and that is how a vendor
 * id ends up in an audit row and then in a schema.
 *
 * ─── MEDIA ────────────────────────────────────────────────────────────────
 *
 * The ORIGINAL is already in R2 before anything here runs; the caller passes
 * the bytes it read from our bucket. Square gets a copy so the item looks right
 * on the till (shared/commerce/square/images.js). A format Square will not take
 * is skipped, reported, and still ours — losing Square must not lose our
 * photography (Test-PRD-P0-29-exit_test).
 */
import { createSquareAdapter } from "../../../shared/commerce/square/index.js";
import { createImageUploader, squareAcceptsType } from "../../../shared/commerce/square/images.js";
import { idempotencyKey } from "../../../shared/commerce/square/ids.js";
import { moneyToSquare } from "../../../shared/commerce/square/money.js";

/* ── mirror READS, over the raw D1 binding ──────────────────────────────── */
/*
 * These take `db.catalog_mirror` directly, so a tool that needs only to LIST
 * categories or read a shard declares the store and no Square resource at all.
 * That is the structural half of "the draft tool writes nothing": it has no
 * object in scope that can reach Square.
 */

/** The closed set. Our uuid and a name — no `external_ref` leaves this file. */
export async function listCategories(db) {
  const res = await db
    .prepare("SELECT id, name FROM mirror_category_index ORDER BY name COLLATE NOCASE")
    .bind()
    .all();
  return (res.results ?? []).map((r) => ({ id: r.id, name: r.name }));
}

export async function productByHandle(db, handle) {
  return db
    .prepare(
      "SELECT id, handle, title, source_description, status, category_id FROM mirror_product_index WHERE handle = ?",
    )
    .bind(handle)
    .first();
}

export async function variantsOf(db, productId) {
  const res = await db
    .prepare(
      "SELECT id, sku, title, ordinal, price_minor, currency FROM mirror_variant_index WHERE product_id = ? ORDER BY ordinal",
    )
    .bind(productId)
    .all();
  return res.results ?? [];
}

/**
 * Apply a variation patch to the variations a product ALREADY has.
 *
 * An entry carrying `variant_id` edits that variation; one without adds a new
 * one; anything not mentioned is carried through untouched. That last clause is
 * the whole point: Square's UpsertCatalogObject REPLACES `item_data.variations`
 * wholesale, so sending only the variation being repriced would silently delete
 * every other size of the garment. Nothing here removes a variation — that is
 * the withdraw path, and it is not this tool.
 *
 * Pure, and shared by the write and by the preflight that validates the
 * RESULT of the edit rather than the patch.
 */
export function mergeVariations(current, patch) {
  const byId = new Map((current ?? []).map((v) => [v.id, { ...v, price_minor: Number(v.price_minor) }]));
  const order = (current ?? []).map((v) => v.id);
  const added = [];
  for (const p of patch ?? []) {
    if (!p.variant_id) {
      added.push({
        id: null,
        title: p.title,
        sku: p.sku ?? null,
        price_minor: p.price_minor,
        currency: p.currency,
      });
      continue;
    }
    const cur = byId.get(p.variant_id);
    if (!cur) return { error: `no variant '${p.variant_id}' on this product` };
    byId.set(p.variant_id, {
      ...cur,
      title: p.title ?? cur.title,
      sku: p.sku ?? cur.sku,
      price_minor: p.price_minor ?? cur.price_minor,
      currency: p.currency ?? cur.currency,
    });
  }
  return { variations: [...order.map((id) => byId.get(id)), ...added] };
}

/**
 * What comparable stock in this category is priced at. A price SUGGESTION has
 * to come from somewhere real; this is the shop's own shelf, not a guess, and
 * it is returned with its sample size so a band of one is visibly a band of one.
 */
export async function priceBand(db, categoryId) {
  const res = await db
    .prepare(
      `SELECT v.price_minor AS price_minor, v.currency AS currency
         FROM mirror_variant_index v
         JOIN mirror_product_index p ON p.id = v.product_id
        WHERE p.category_id = ? AND v.price_minor > 0
        ORDER BY v.price_minor`,
    )
    .bind(categoryId)
    .all();
  const rows = res.results ?? [];
  if (rows.length === 0) return null;
  const prices = rows.map((r) => Number(r.price_minor));
  const at = (q) => prices[Math.min(prices.length - 1, Math.floor(q * (prices.length - 1)))];
  return {
    sample: prices.length,
    currency: rows[0].currency,
    min_minor: prices[0],
    median_minor: at(0.5),
    max_minor: prices[prices.length - 1],
  };
}

/* ── Square WRITES ──────────────────────────────────────────────────────── */

function tempId(prefix, n) {
  return `#${prefix}-${n}`;
}

/* Square answers an upsert with id_mappings from our `#temp` ids to real ones. */
function realId(res, temp) {
  const map = res?.id_mappings ?? [];
  return map.find((m) => m.client_object_id === temp)?.object_id ?? null;
}

/**
 * @param env   SQUARE_ACCESS_TOKEN, SQUARE_ENV, SQUARE_LOCATION_ID, LOCATION_ID,
 *              plus the CATALOG_MIRROR / COMMERCE bindings on the Worker.
 * @param opts  { adapter, uploader, mirrorDb, commerceDb, now } — the injection
 *              seams the tests use. A stub Square client goes in through
 *              `opts.clientOptions.fetchImpl` or a whole `opts.adapter`.
 */
export function createSquareCatalogWriter(env, opts = {}) {
  const mirrorDb = opts.mirrorDb ?? env?.CATALOG_MIRROR ?? null;
  if (!mirrorDb?.prepare) {
    console.error("ERROR catalog-writer: no CATALOG_MIRROR binding — a Square write could not be mirrored back");
    throw new Error("binding CATALOG_MIRROR is not attached to this Worker");
  }

  const adapter =
    opts.adapter ??
    createSquareAdapter(env, {
      mirrorDb,
      commerceDb: opts.commerceDb ?? env?.COMMERCE ?? null,
      locationId: opts.locationId ?? env?.LOCATION_ID ?? null,
      client: opts.client,
      clientOptions: opts.clientOptions,
    });

  const uploader = opts.uploader ?? createImageUploader(env, opts.uploaderOptions);
  const client = adapter.client;
  const mirror = adapter.mirror;
  const now = opts.now ?? (() => new Date());

  /* Our uuid -> the Square id, read from the mirror. The only direction this
     translation ever runs, and it runs nowhere else in ops/. */
  async function categoryRef(ourId) {
    const row = await mirrorDb
      .prepare("SELECT external_ref, name FROM mirror_category_index WHERE id = ?")
      .bind(ourId)
      .first();
    if (!row) throw new Error(`no such category ${ourId}`);
    return row;
  }

  async function productRow(handle) {
    const row = await mirrorDb
      .prepare("SELECT id, external_ref, handle, title, source_version, category_id FROM mirror_product_index WHERE handle = ?")
      .bind(handle)
      .first();
    if (!row) throw new Error(`no product with handle '${handle}'`);
    return row;
  }

  function itemData({ title, description, catRef, variations, itemRef }) {
    return {
      name: title,
      ...(description ? { description } : {}),
      ...(catRef
        ? { categories: [{ id: catRef, ordinal: 0 }], reporting_category: { id: catRef } }
        : {}),
      variations: variations.map((v, i) => ({
        type: "ITEM_VARIATION",
        id: v.external_ref ?? tempId("var", i),
        ...(v.source_version === undefined || v.source_version === null
          ? {}
          : { version: Number(v.source_version) }),
        present_at_all_locations: true,
        item_variation_data: {
          item_id: itemRef,
          name: v.title,
          ...(v.sku ? { sku: v.sku } : {}),
          pricing_type: "FIXED_PRICING",
          /* moneyToSquare wants a bigint and refuses a float. The tool already
             refused a non-integer minor amount; this is the second gate, at the
             boundary, where Test-PRD-P0-15-money_minor_units lives. */
          price_money: moneyToSquare(
            { amountMinor: BigInt(v.price_minor), currency: v.currency },
            `variation ${v.title}`,
          ),
          track_inventory: true,
        },
      })),
    };
  }

  /*
   * The mirror follows. `full: false` is deliberate: an incremental
   * SearchCatalogObjects since just before our write picks up what we just
   * created plus anything the till did in the meantime, whereas a full sweep
   * would archive on absence and is the nightly reconcile's job, not a
   * per-write one (mirror.js says exactly this).
   */
  async function syncAfterWrite() {
    const since = new Date(now().getTime() - 60_000).toISOString();
    return adapter.pullCatalog({ full: false, since });
  }

  /*
   * Copy each original to Square. One failure does not fail the product: the
   * item exists and is priced, the photograph is safe in R2, and a missing
   * Square thumbnail is recoverable by re-running the attach. Refusing the
   * whole write here would be strictly worse.
   */
  async function attachImages(itemRef, images) {
    const attached = [];
    const skipped = [];
    for (const img of images ?? []) {
      if (!squareAcceptsType(img.contentType)) {
        skipped.push({ key: img.key, why: `Square does not accept ${img.contentType}; the original is ours and kept` });
        continue;
      }
      try {
        await uploader.attach({
          objectId: itemRef,
          bytes: img.bytes,
          contentType: img.contentType,
          filename: img.key.split("/").pop(),
          caption: img.caption ?? "",
          idempotencySeed: img.key,
        });
        attached.push(img.key);
      } catch (err) {
        console.error(`ERROR catalog-writer: Square rejected the copy of ${img.key} — ${err.message}`);
        skipped.push({ key: img.key, why: err.message });
      }
    }
    return { attached, skipped };
  }

  async function readBack(externalRef) {
    const row = await mirrorDb
      .prepare("SELECT id, handle, title, status FROM mirror_product WHERE external_ref = ?")
      .bind(externalRef)
      .first();
    return row ? { id: row.id, handle: row.handle, title: row.title, status: row.status } : null;
  }

  return {
    kind: "square",
    adapter,

    listCategories: () => listCategories(mirrorDb),
    productByHandle: (handle) => productByHandle(mirrorDb, handle),
    priceBand: (categoryId) => priceBand(mirrorDb, categoryId),

    /**
     * ITEM + ITEM_VARIATIONs in one UpsertCatalogObject, then the image copies,
     * then the mirror sync. In that order, always.
     */
    async createProduct({ title, description = "", categoryId, variations, images = [] }) {
      const cat = categoryId ? await categoryRef(categoryId) : null;
      const itemRef = tempId("item", 0);
      const body = {
        idempotency_key: idempotencyKey(`catalog.create:${title}:${JSON.stringify(variations)}`),
        object: {
          type: "ITEM",
          id: itemRef,
          present_at_all_locations: true,
          item_data: itemData({ title, description, catRef: cat?.external_ref ?? null, variations, itemRef }),
        },
      };

      const res = await client.post("/v2/catalog/object", body);
      const created = res?.catalog_object?.id ?? realId(res, itemRef);
      if (!created) {
        console.error("ERROR catalog-writer: Square accepted the item but returned no id");
        throw new Error("Square returned no catalog object id for the new item");
      }

      const media = await attachImages(created, images);
      const sync = await syncAfterWrite();

      return { product: await readBack(created), images: media, sync, category: cat?.name ?? null };
    },

    /**
     * The same path for an edit. `version` carries Square's optimistic
     * concurrency straight from the mirror: if someone changed the item at the
     * counter since our last sync, Square refuses this write rather than
     * silently overwriting them, which is the behaviour ADR-009 is built on.
     */
    async updateProduct({ handle, title, description, categoryId, variations, images = [] }) {
      const row = await productRow(handle);
      const cat = categoryId ? await categoryRef(categoryId) : null;

      /* The refs stay INSIDE this file: the ops tool validates against
         `variantsOf`, which has no external_ref column in its SELECT. */
      const currentRes = await mirrorDb
        .prepare(
          "SELECT id, external_ref, source_version, sku, title, ordinal, price_minor, currency" +
            " FROM mirror_variant_index WHERE product_id = ? ORDER BY ordinal",
        )
        .bind(row.id)
        .all();
      const merged = mergeVariations(currentRes.results ?? [], variations);
      if (merged.error) throw new Error(`${merged.error} ('${handle}')`);
      const keep = merged.variations;

      const body = {
        idempotency_key: idempotencyKey(`catalog.update:${row.external_ref}:${row.source_version}`),
        object: {
          type: "ITEM",
          id: row.external_ref,
          version: Number(row.source_version ?? 0),
          present_at_all_locations: true,
          item_data: itemData({
            title: title ?? row.title,
            description,
            catRef: cat?.external_ref ?? null,
            variations: keep,
            itemRef: row.external_ref,
          }),
        },
      };

      await client.post("/v2/catalog/object", body);
      const media = await attachImages(row.external_ref, images);
      const sync = await syncAfterWrite();

      return { product: await readBack(row.external_ref), images: media, sync, category: cat?.name ?? null };
    },

    /**
     * The deliberate one. Creating a CATEGORY is its own T2 tool and its own
     * Square object precisely so it cannot happen as a side effect of authoring
     * a product (Test-PRD-P0-40-closed_category_set).
     */
    async createCategory({ name }) {
      const temp = tempId("cat", 0);
      const res = await client.post("/v2/catalog/object", {
        idempotency_key: idempotencyKey(`catalog.category:${name}`),
        object: {
          type: "CATEGORY",
          id: temp,
          present_at_all_locations: true,
          category_data: { name },
        },
      });
      const created = res?.catalog_object?.id ?? realId(res, temp);
      if (!created) throw new Error("Square returned no catalog object id for the new category");
      const sync = await syncAfterWrite();
      const row = await mirrorDb
        .prepare("SELECT id, name FROM mirror_category WHERE external_ref = ?")
        .bind(created)
        .first();
      return { category: row ? { id: row.id, name: row.name } : null, sync };
    },
  };
}
