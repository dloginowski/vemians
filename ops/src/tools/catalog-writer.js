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
import { createVendor } from "../../../shared/commerce/square/vendors.js";

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
    .prepare("SELECT id, name, parent_id, numeric_id FROM mirror_category_index ORDER BY name COLLATE NOCASE")
    .bind()
    .all();
  return (res.results ?? []).map((r) => ({ id: r.id, name: r.name, parent_id: r.parent_id, numeric_id: r.numeric_id }));
}

/* Every vendor, for the picker/admin panel — "the same kind of drop down
   schema that we have for categories" the owner's own words asked for.
   Named distinctly from shared/commerce/square/vendors.js's own
   listVendors (that one calls Square live, for a real full sweep; this
   one reads OUR mirror, the same read-the-mirror-not-the-provider
   reasoning every other list in this file already follows). */
export async function listMirrorVendors(db) {
  const res = await db
    .prepare("SELECT id, name, commission_pct FROM mirror_vendor_index ORDER BY name COLLATE NOCASE")
    .bind()
    .all();
  return (res.results ?? []).map((r) => ({ id: r.id, name: r.name, commission_pct: r.commission_pct }));
}

/* Every globally-known custom field NAME, for the admin panel and the
   Items tab alike — "if I'm adding custom fields, I'm adding them to all
   items... this is done inside of the admin panel, not inside of the
   item panel." No view needed (unlike categories/vendors) — this table
   has no archived_at column at all, nothing to filter. */
export async function listCustomFieldNames(db) {
  const res = await db.prepare("SELECT name FROM mirror_custom_field_name ORDER BY name COLLATE NOCASE").bind().all();
  return (res.results ?? []).map((r) => r.name);
}

/* NN-NN-NNN -> the category this style_id sorts to, or null if neither
   segment matches anything yet. The second (subcategory) segment is
   authoritative when it matches — subcategory numeric_ids are globally
   unique across the WHOLE tree regardless of depth (the owner's own
   words: "it doesn't matter how deep the levels are... once an ID is used
   by any subcategory, it stops being available"), so the deepest matching
   node is exactly the right one to file the product under; the first
   (top-level category) segment is only a fallback for a style_id whose
   subcategory segment does not (yet) match anything real. */
export async function deriveCategoryIdForStyleId(db, styleId) {
  const m = /^(\d{2})-(\d{2})-\d{3}$/.exec(styleId ?? "");
  if (!m) return null;
  const [, catCode, subCode] = m;
  const subcategory = await db
    .prepare("SELECT id FROM mirror_category_index WHERE parent_id IS NOT NULL AND numeric_id = ?")
    .bind(subCode)
    .first();
  if (subcategory) return subcategory.id;
  const category = await db
    .prepare("SELECT id FROM mirror_category_index WHERE parent_id IS NULL AND numeric_id = ?")
    .bind(catCode)
    .first();
  return category?.id ?? null;
}


/*
 * vendor/vendor_code/unit_cost_minor/unit_cost_currency are resolved off the
 * product's own ORDINAL-0 variation (LEFT JOIN, so a product with no
 * variations yet — created but not synced — still returns a row) — "one
 * vendor per product, applied uniformly to every variation," the
 * simplification chosen over Square's own per-variation granularity. vendor
 * itself moved off mirror_product entirely once the owner got Retail Plus
 * (Test-PRD-P0-136-square_custom_attributes, revised): it is Square's own
 * Vendor name now, not a plain-text custom attribute.
 */
const PRODUCT_WITH_VENDOR_COLUMNS = `
  p.id, p.handle, p.title, p.source_description, p.status, p.channel, p.custom_fields,
  p.style_id, p.commission_pct, p.category_id,
  mv.name AS vendor, v0.vendor_code, v0.unit_cost_minor, v0.unit_cost_currency
`;
const PRODUCT_WITH_VENDOR_JOIN = `
  LEFT JOIN mirror_variant_index v0 ON v0.product_id = p.id AND v0.ordinal = 0
  LEFT JOIN mirror_vendor_index mv ON mv.id = v0.vendor_id
`;
const PRODUCT_WITH_VENDOR_SELECT = `SELECT ${PRODUCT_WITH_VENDOR_COLUMNS} FROM mirror_product_index p ${PRODUCT_WITH_VENDOR_JOIN}`;

export async function productByHandle(db, handle) {
  return db
    .prepare(`${PRODUCT_WITH_VENDOR_SELECT} WHERE p.handle = ?`)
    .bind(handle)
    .first();
}

/* Same shape, but archived rows too — catalog.set_active's own check(): a
   product it might RESTORE is by definition absent from mirror_product_index
   (that view excludes archived_at rows), so telling "already active" from
   "already archived" needs the base table, not the index. */
export async function productByHandleAny(db, handle) {
  return db
    .prepare(`SELECT ${PRODUCT_WITH_VENDOR_COLUMNS} FROM mirror_product p ${PRODUCT_WITH_VENDOR_JOIN} WHERE p.handle = ?`)
    .bind(handle)
    .first();
}

/* One variation, its own external_ref/sku, and its product's handle/title —
   for a caller that holds our OWN variant uuid and needs Square's id to
   reach it (inventory.adjust, commerce.js). Exposed here rather than on a
   `catalog_mirror` store binding of its own: "no tool holds two stores at
   once" (Test-PRD-P0-24-binding_scoped_tools) — a tool whose OWN store is
   `commerce` reaches this through `resources: ["square"]` instead, the same
   way `t.square` already carries its own internal mirror access for
   `productByHandle` above. */
export async function variantById(db, id) {
  return db
    .prepare(
      `SELECT v.id, v.external_ref, v.sku, v.title AS variant_title, p.handle, p.title AS product_title
         FROM mirror_variant_index v JOIN mirror_product_index p ON p.id = v.product_id
        WHERE v.id = ?`,
    )
    .bind(id)
    .first();
}

/* REVISED: "let's not force vendor's commission to be stated out loud [on
   every item]... we store it in essential locations per vendor so that
   their commission is recorded in a central location and automatically
   applied" — the owner's own words. Replaces the old vendorExists(): a
   plain existence check was never actually the fact either T2 tool's own
   check() cared about — a vendor Square already knows about (created
   directly in Square's own dashboard, say) but with no commission_pct of
   OURS on file yet is exactly as unable to supply one automatically as a
   vendor that does not exist at all. Read-only: this never decides to
   create or update a vendor itself, and returns null for either case a
   caller must treat identically — "give me one now." */
export async function vendorCommission(db, name) {
  const row = await db
    .prepare("SELECT commission_pct FROM mirror_vendor_index WHERE name = ? COLLATE NOCASE")
    .bind(name)
    .first();
  return row?.commission_pct ?? null;
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

/*
 * The read path for the ops Items tab (a server-rendered page, not an agent
 * tool call) — every mirrored product, its category name, every variation,
 * and custom_fields already parsed rather than left as a JSON string for
 * every caller to re-parse. One query for products, one for every variant
 * (grouped here rather than N+1 queries per product), the same trade every
 * other list view in this codebase makes at this scale.
 */
export async function listAllProducts(db, { limit } = {}) {
  /* mirror_product, not mirror_product_index: an archived product is the
     ONLY way the Items tab's own "Inactive" filter (P0-131) ever shows
     anything real — draft/archived "both collapse into the same inactive
     bucket," and the Active checkbox (P0-137) is precisely how a person
     gets an archived product back, which needs it to still be findable
     here. Archived rows stay excluded from every OTHER read in this
     codebase (ADR-008's own default), but this ONE list is the explicit
     call that surfaces them, same as mirror.js's own archivedProducts(). */
  const products = await db
    .prepare(
      `SELECT p.id, p.handle, p.title, p.source_description, p.status, p.channel, p.custom_fields, p.style_id, p.commission_pct, p.category_id, c.name AS category_name
         FROM mirror_product p
         LEFT JOIN mirror_category_index c ON c.id = p.category_id
        ORDER BY p.title COLLATE NOCASE
        LIMIT ?`,
    )
    .bind(limit ?? 1000)
    .all();

  const variants = await db
    .prepare(
      "SELECT id, product_id, sku, title, ordinal, price_minor, currency, vendor_id, vendor_code, unit_cost_minor, unit_cost_currency" +
        " FROM mirror_variant_index ORDER BY product_id, ordinal",
    )
    .bind()
    .all();
  const byProduct = new Map();
  for (const v of variants.results ?? []) {
    if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
    byProduct.get(v.product_id).push(v);
  }

  /* vendor NAMEs, batched the same way images/categories already are —
     the ordinal-0 variation of each product is where "the product's own
     vendor" is read from (see PRODUCT_WITH_VENDOR_SELECT's own comment). */
  const vendors = await db.prepare("SELECT id, name FROM mirror_vendor_index").bind().all();
  const vendorNameById = new Map((vendors.results ?? []).map((v) => [v.id, v.name]));

  /* The tile's own primary photograph (ordinal 0) — one query for every
     product's first image, the same batched-not-N+1 trade `variants` above
     already makes, rather than a correlated subquery per row. `media_key` is
     OUR R2 key, populated by the backfill job (media-backfill.js); NULL until
     then, same as the storefront's own read (store/src/catalog.js). */
  const images = await db
    .prepare("SELECT product_id, media_key FROM mirror_image_index WHERE ordinal = 0")
    .bind()
    .all();
  const imageByProduct = new Map();
  for (const i of images.results ?? []) {
    if (i.media_key) imageByProduct.set(i.product_id, i.media_key);
  }

  return (products.results ?? []).map((p) => {
    let custom_fields = {};
    try {
      custom_fields = JSON.parse(p.custom_fields || "{}");
    } catch {
      custom_fields = {};
    }
    const variations = byProduct.get(p.id) ?? [];
    const v0 = variations[0];
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      description: p.source_description ?? "",
      status: p.status,
      channel: p.channel,
      category_id: p.category_id ?? null,
      category_name: p.category_name,
      custom_fields,
      style_id: p.style_id ?? null,
      vendor: v0?.vendor_id ? (vendorNameById.get(v0.vendor_id) ?? null) : null,
      vendor_code: v0?.vendor_code ?? null,
      unit_cost_minor: v0?.vendor_id ? (v0.unit_cost_minor ?? 0) : null,
      unit_cost_currency: v0?.vendor_id ? (v0.unit_cost_currency ?? "USD") : null,
      commission_pct: p.commission_pct ?? null,
      variations,
      image_key: imageByProduct.get(p.id) ?? null,
    };
  });
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
        /* A brand-new row added through this same patch has no existing
           unit cost to fall back to — undefined here means updateProduct's
           own per-variation resolution falls back to the product-level
           default, same as every other newly-added variation field. */
        unit_cost_minor: p.unit_cost_minor,
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
      /* Revised — "all the variants can have a different unit cost too":
         a variation's OWN cost now survives a merge that was not about
         it, the same "resend or it may vanish" reasoning title/price
         already use one line up. */
      unit_cost_minor: p.unit_cost_minor ?? cur.unit_cost_minor,
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
      .prepare(
        "SELECT id, external_ref, handle, title, source_description, source_version, category_id, style_id, commission_pct" +
          " FROM mirror_product_index WHERE handle = ?",
      )
      .bind(handle)
      .first();
    if (!row) throw new Error(`no product with handle '${handle}'`);
    return row;
  }

  /* The CURRENT vendor/cost, read off the product's own ordinal-0 variation
     — "one vendor per product, applied uniformly," the same simplification
     PRODUCT_WITH_VENDOR_SELECT's own comment describes. Used by
     updateProduct's own "resend the whole thing" fallback: undefined always
     means "this call is not about that field," resolved to whatever is
     already there, the same reasoning style_id/commission already use for
     an item-level field — this is that same reasoning one level down, at
     the variation Square itself stores vendor_information on. */
  async function currentVendorInfo(productId) {
    const row = await mirrorDb
      .prepare(
        `SELECT mv.external_ref AS vendor_external_ref, mv.name AS vendor_name,
                v.vendor_code, v.unit_cost_minor, v.unit_cost_currency
           FROM mirror_variant_index v
           LEFT JOIN mirror_vendor_index mv ON mv.id = v.vendor_id
          WHERE v.product_id = ? AND v.ordinal = 0`,
      )
      .bind(productId)
      .first();
    return (
      row ?? {
        vendor_external_ref: null,
        vendor_name: null,
        vendor_code: null,
        unit_cost_minor: 0,
        unit_cost_currency: "USD",
      }
    );
  }

  /*
   * A plain vendor NAME in, Square's own vendor_id out — never the reverse
   * (Test-PRD-P0-16-commerce_port: no Square identifier crosses this file's
   * boundary in EITHER direction; a caller above this file never even sees
   * one). OUR mirror_vendor is checked first, case-insensitively, the same
   * "closed set, read from the mirror" pattern catalog-write.js's own
   * matchCategory uses for categories — except vendors are NOT a closed
   * set: a name with no match calls Square's real CreateVendor. Nothing is
   * written to the mirror here — "the agent writes to Square, never to the
   * mirror" (this file's own header) holds for vendors too — syncAfterWrite
   * always runs vendors THROUGH THE REAL SYNC (index.js's own pullCatalog,
   * vendors before catalog) before readBack() ever needs the new vendor's
   * name, so mirror_vendor gets its row the same authoritative way every
   * other Square fact does.
   */
  async function vendorRef(name) {
    const existing = await mirrorDb
      .prepare("SELECT external_ref, name FROM mirror_vendor_index WHERE name = ? COLLATE NOCASE")
      .bind(name)
      .first();
    if (existing) return existing;
    const created = await createVendor(client, name);
    return { external_ref: created.externalRef, name: created.name };
  }

  /* Square's own CatalogItemVariationVendorInformation shape, applied to
     EVERY variation uniformly by itemData() below (option 1: one vendor per
     product, not Square's own per-variation granularity — the owner's own
     choice). undefined with no vendorExternalRef at all, rather than an
     object with a null vendor_id, since Square's own field is genuinely
     absent for a product with no vendor, not present-and-empty. */
  function vendorInformationFor({ vendorExternalRef, vendorCode, unitCostMinor, unitCostCurrency }) {
    if (!vendorExternalRef) return undefined;
    const out = { vendor_id: vendorExternalRef };
    if (vendorCode) out.vendor_code = vendorCode;
    if (unitCostMinor) {
      out.unit_cost_money = moneyToSquare(
        { amountMinor: BigInt(unitCostMinor), currency: unitCostCurrency ?? "USD" },
        "vendor unit cost",
      );
    }
    return out;
  }

  /* { style_id: "01-04-001", commission: undefined } -> only style_id in the
     result; undefined always means "leave this one out of the request",
     never "clear it" — every caller resolves "not provided" to the
     product's own CURRENT value before calling this, so nothing is ever
     silently wiped by an edit that only meant to touch the other field.
     commission is stored as a plain integer string (STRING type, not
     Square's NUMBER type) purely to keep this builder and catalog.js's own
     customAttr() as ONE code path for style_id/commission alike — see
     customAttrInt's own comment there for why NUMBER was considered and
     set aside. vendor is NOT built here any more — see vendorInformationFor
     above; it lives on each variation, not in custom_attribute_values. */
  function customAttributeValues({ styleId, commissionPct } = {}) {
    const out = {};
    if (styleId) out.style_id = { key: "style_id", type: "STRING", string_value: styleId };
    if (commissionPct !== undefined && commissionPct !== null) {
      out.commission = { key: "commission", type: "STRING", string_value: String(commissionPct) };
    }
    return Object.keys(out).length ? out : undefined;
  }

  function itemData({ title, description, catRef, variations, itemRef, imageIds, customAttributeValues: attrs, vendorInfos }) {
    return {
      name: title,
      /* Photographs already in Square are LINKED here at creation rather than
         re-uploaded afterwards: the bytes went to Square when the human
         uploaded them, and sending them again makes a second CatalogImage
         for one photograph (ADR-013). */
      ...(imageIds?.length ? { image_ids: imageIds } : {}),
      ...(description ? { description } : {}),
      ...(catRef
        ? { categories: [{ id: catRef, ordinal: 0 }], reporting_category: { id: catRef } }
        : {}),
      /* Square's own Custom Attributes (P0-136) — style_id and commission,
         addressed by the well-known `key` this codebase's own attribute
         definitions use, never by Square's opaque definition id. Omitted
         entirely with neither set, rather than sent as an empty object —
         UpsertCatalogObject replaces item_data wholesale (the same reason
         `variations` below is always resent in full, not just what changed),
         so every caller here is responsible for passing through whatever
         value should survive, not just what it means to change. */
      ...(attrs ? { custom_attribute_values: attrs } : {}),
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
          /* vendor_information (P0-136, revised again — "all the variants
             can have a different unit cost too"): the vendor ITSELF is
             still one fact about the product (resolved once, above), but
             each variation now carries its OWN entry, so its own cost can
             differ from its siblings' — vendorInfos is built index-aligned
             with `variations` by every caller below. */
          ...(vendorInfos?.[i] ? { vendor_information: [vendorInfos[i]] } : {}),
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
      /* Already in Square — linked via item_data.image_ids at upsert time, so
         there is nothing to send. Reported as attached because it IS on the
         item; a caller must not be told a photograph was skipped when it is
         visible on the till. */
      if (img.imageRef) {
        attached.push(img.key);
        continue;
      }
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
      .prepare("SELECT id, handle, title, status, style_id, commission_pct FROM mirror_product WHERE external_ref = ?")
      .bind(externalRef)
      .first();
    if (!row) return null;
    const vendorInfo = await currentVendorInfo(row.id);
    return {
      id: row.id,
      handle: row.handle,
      title: row.title,
      status: row.status,
      style_id: row.style_id,
      commission_pct: row.commission_pct,
      vendor: vendorInfo.vendor_name,
      vendor_code: vendorInfo.vendor_code,
      unit_cost_minor: vendorInfo.vendor_name ? vendorInfo.unit_cost_minor : null,
      unit_cost_currency: vendorInfo.vendor_name ? vendorInfo.unit_cost_currency : null,
    };
  }

  return {
    kind: "square",
    adapter,

    listCategories: () => listCategories(mirrorDb),
    productByHandle: (handle) => productByHandle(mirrorDb, handle),
    productByHandleAny: (handle) => productByHandleAny(mirrorDb, handle),
    variantById: (id) => variantById(mirrorDb, id),
    priceBand: (categoryId) => priceBand(mirrorDb, categoryId),
    /* Exposed for catalog.set_active: an archive/restore writes straight to
       the adapter (adapter.retractProduct/restoreProduct), not through any
       of the ITEM-upsert helpers below, so it needs this same incremental
       resync afterward without duplicating it. */
    syncAfterWrite,

    /* Exposed for catalog.create_vendor — a real Square Vendor, standalone,
       with no product attached at all (the picker/admin panel's own "add a
       vendor" flow, as opposed to vendorRef's own resolve-or-create that
       only ever runs as a side effect of writing a PRODUCT's own vendor
       field). Reuses the exact same raw CreateVendor call vendorRef
       already makes internally, then syncs so the new mirror_vendor row
       exists before the tool layer's own commission_pct write (OURS, not
       Square's) can reach it. */
    async createVendorEntity(name) {
      const created = await createVendor(client, name);
      const sync = await syncAfterWrite();
      return { vendor: created, sync };
    },

    /**
     * Retroactive re-sort (the owner's own explicit choice, over "only
     * apply going forward"): every unarchived product whose style_id's own
     * subcategory/category segment now matches a numeric_id that did not
     * exist (or pointed elsewhere) before gets a REAL Square write, via
     * this.updateProduct — category is Square's own concept
     * (reporting_category), not ours, so poking mirror_product.category_id
     * directly here would just be overwritten back by the very next full
     * sync, which still reads it from Square. A product whose style_id
     * matches nothing (yet) keeps whatever category_id it already had —
     * this never CLEARS an assignment, only ever improves one. One write
     * per affected product, sequentially (this codebase has no batch
     * upsert) — fine at the boutique catalog scale this whole feature is
     * built for; a much larger catalog would need real batching.
     */
    async resortProductsByStyleId() {
      const products = await mirrorDb
        .prepare("SELECT handle, style_id, category_id FROM mirror_product_index WHERE style_id IS NOT NULL")
        .bind()
        .all();
      let resorted = 0;
      const errors = [];
      for (const p of products.results ?? []) {
        const derived = await deriveCategoryIdForStyleId(mirrorDb, p.style_id);
        if (!derived || derived === p.category_id) continue;
        try {
          await this.updateProduct({ handle: p.handle, categoryId: derived });
          resorted += 1;
        } catch (err) {
          console.error(`ERROR catalog-writer: resort failed for ${p.handle} — ${err.message}`);
          errors.push({ handle: p.handle, error: err.message });
        }
      }
      return { resorted, errors };
    },

    /**
     * ITEM + ITEM_VARIATIONs in one UpsertCatalogObject, then the image copies,
     * then the mirror sync. In that order, always.
     */
    async createProduct({
      title,
      description = "",
      categoryId,
      variations,
      images = [],
      styleId,
      vendor,
      vendorCode,
      unitCostMinor,
      unitCostCurrency,
      commissionPct,
    }) {
      const cat = categoryId ? await categoryRef(categoryId) : null;
      const itemRef = tempId("item", 0);
      /* Photographs that are already Square objects are linked on the item
         itself; the rest are uploaded afterwards, which is the only order
         possible for bytes Square has not seen. */
      const imageIds = images.map((i) => i.imageRef).filter(Boolean);
      /* vendor is a plain NAME in, Square's own vendor_id out — vendorRef
         resolves-or-creates against the real Vendors API. Nothing to
         resolve for a fresh product with no vendor at all. */
      const vref = vendor ? await vendorRef(vendor) : null;
      const vendorInfo = vendorInformationFor({
        vendorExternalRef: vref?.external_ref ?? null,
        vendorCode,
        unitCostMinor,
        unitCostCurrency,
      });
      const body = {
        idempotency_key: idempotencyKey(`catalog.create:${title}:${JSON.stringify(variations)}`),
        object: {
          type: "ITEM",
          id: itemRef,
          present_at_all_locations: true,
          item_data: itemData({
            title,
            description,
            catRef: cat?.external_ref ?? null,
            variations,
            itemRef,
            imageIds,
            customAttributeValues: customAttributeValues({ styleId, commissionPct }),
            /* A brand-new product has no per-variation history yet — every
               variation starts with the SAME vendor/cost, the one given at
               creation time; they only diverge later, through updateProduct. */
            vendorInfos: variations.map(() => vendorInfo),
          }),
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
    async updateProduct({
      handle,
      title,
      description,
      categoryId,
      variations,
      images = [],
      styleId,
      vendor,
      vendorCode,
      unitCostMinor,
      unitCostCurrency,
      commissionPct,
    }) {
      const row = await productRow(handle);
      /* Bug found while wiring up style_id-driven auto-categorization: an
         UNDEFINED categoryId used to resolve straight to null, which
         itemData() below reads as "omit categories/reporting_category
         entirely" — and Square's UpsertCatalogObject is FULL-REPLACEMENT
         (the same semantics the retractProduct fix, P0-137, verified
         against Square's own spec), so EVERY update_product call that
         did not explicitly resend a categoryId — a title edit, a price
         edit, a style_id edit, anything — was silently clearing the
         product's own category in Square. undefined now means "this call
         is not about that field," the same "resend the whole thing"
         fallback style_id/vendor/description already use one line below. */
      const resolvedCategoryId = categoryId !== undefined ? categoryId : row.category_id;
      const cat = resolvedCategoryId ? await categoryRef(resolvedCategoryId) : null;

      /* The refs stay INSIDE this file: the ops tool validates against
         `variantsOf`, which has no external_ref column in its SELECT.
         unit_cost_minor/unit_cost_currency ride along per row too, now
         that a variation's own cost can outlive an edit that was not
         about it — mergeVariations' own fallback below needs them. */
      const currentRes = await mirrorDb
        .prepare(
          "SELECT id, external_ref, source_version, sku, title, ordinal, price_minor, currency, unit_cost_minor, unit_cost_currency" +
            " FROM mirror_variant_index WHERE product_id = ? ORDER BY ordinal",
        )
        .bind(row.id)
        .all();
      const merged = mergeVariations(currentRes.results ?? [], variations);
      if (merged.error) throw new Error(`${merged.error} ('${handle}')`);
      const keep = merged.variations;

      /* Undefined means "this call is not about that field" for style_id and
         commission alike — resolved to whatever the mirror already has, the
         same "resend the whole thing, not just the diff" reasoning `keep`
         above already exists for. Neither is EVER generated here: style_id
         is validated and conflict-checked one layer up, in
         catalog-write.js's own tool, and a variation's own `sku` a few
         lines above is Square's, read back verbatim, never invented here. */
      const resolvedStyleId = styleId !== undefined ? styleId : row.style_id;
      const resolvedCommissionPct = commissionPct !== undefined ? commissionPct : row.commission_pct;

      /* vendor/vendorCode resolve the SAME way as style_id/commission above
         — one vendor per product, still (nobody has asked for a garment
         sold under two vendors at once). Cost is different: "all the
         variants can have a different unit cost too" — so unitCostMinor
         here is ONLY the bulk, uniform override catalog.set_square_
         attributes' own header field still sends; when it is not given,
         each variation below falls back to its OWN current cost, not the
         product's ordinal-0 one. */
      const current = await currentVendorInfo(row.id);
      const vref = vendor !== undefined ? await vendorRef(vendor) : null;
      const resolvedVendorExternalRef = vendor !== undefined ? vref?.external_ref ?? null : current.vendor_external_ref;
      const resolvedVendorCode = vendorCode !== undefined ? vendorCode : current.vendor_code;
      const vendorInfos = keep.map((v) => {
        const perUnitCostMinor = unitCostMinor ?? v.unit_cost_minor ?? current.unit_cost_minor;
        const perUnitCostCurrency = (unitCostMinor !== undefined ? unitCostCurrency : v.unit_cost_currency) ?? current.unit_cost_currency ?? "USD";
        return vendorInformationFor({
          vendorExternalRef: resolvedVendorExternalRef,
          vendorCode: resolvedVendorCode,
          unitCostMinor: perUnitCostMinor,
          unitCostCurrency: perUnitCostCurrency,
        });
      });

      const resolvedTitle = title ?? row.title;
      /* description has the same "resend or it may vanish" property as
         variations above — preserved from the mirror when this call was
         not actually about changing it. */
      const resolvedDescription = description ?? row.source_description ?? undefined;

      const body = {
        /* A real bug, caught live from the owner's own pasted error:
           "IDEMPOTENCY_KEY_REUSED... can only be retried with the same
           request data." The key used to hash only external_ref/
           source_version/style_id/vendor/commission — NOT title,
           description, category or variations. source_version stays the
           SAME across every failed or not-yet-synced attempt (Square never
           applied one, so it never bumped), so two DIFFERENT edits made
           back to back while it hadn't moved yet — two different
           descriptions, say — hashed to the IDENTICAL key while sending
           DIFFERENT bodies, which is exactly what Square's own idempotency
           contract refuses: same key, different data. Every field that can
           actually vary this upsert's own content is now in the key
           material, so two calls only ever collide when they would send
           the identical body anyway — the correct idempotent-retry case. */
        idempotency_key: idempotencyKey(
          `catalog.update:${row.external_ref}:${row.source_version}:${resolvedTitle}:` +
            `${resolvedDescription ?? ""}:${cat?.external_ref ?? ""}:${JSON.stringify(keep)}:` +
            `${resolvedStyleId ?? ""}:${resolvedVendorExternalRef ?? ""}:${JSON.stringify(vendorInfos)}:` +
            `${resolvedCommissionPct ?? ""}`,
        ),
        object: {
          type: "ITEM",
          id: row.external_ref,
          version: Number(row.source_version ?? 0),
          present_at_all_locations: true,
          item_data: itemData({
            title: resolvedTitle,
            description: resolvedDescription,
            catRef: cat?.external_ref ?? null,
            variations: keep,
            itemRef: row.external_ref,
            customAttributeValues: customAttributeValues({
              styleId: resolvedStyleId,
              commissionPct: resolvedCommissionPct,
            }),
            vendorInfos,
          }),
        },
      };

      try {
        await client.post("/v2/catalog/object", body);
      } catch (err) {
        /* Square's own optimistic concurrency doing exactly its job — the
           object changed in Square (directly, or by another edit) since
           this mirror row's own source_version was last synced, and Square
           correctly refuses to blindly overwrite it. Not a bug, but the
           raw category/code/field dump (P0-139) reads like one to a
           manager who has no reason to know what "VERSION_MISMATCH" or a
           request/latest version pair means. Rethrown with a plain-English
           hint IN FRONT of that same technical detail (err.errors carried
           over so errorDetail — ops/src/tools/index.js — still appends it
           after this sentence), never in place of it: the raw detail is
           still worth having if reloading does not actually resolve it. */
        if ((err?.errors ?? []).some((e) => e.code === "VERSION_MISMATCH")) {
          const friendly = new Error(
            "This item was changed directly in Square since this page last loaded — reload the Items tab to see the current version, then try your edit again.",
          );
          friendly.errors = err.errors;
          throw friendly;
        }
        throw err;
      }
      const media = await attachImages(row.external_ref, images);
      const sync = await syncAfterWrite();

      return { product: await readBack(row.external_ref), images: media, sync, category: cat?.name ?? null };
    },

    /**
     * The deliberate one. Creating a CATEGORY is its own T2 tool and its own
     * Square object precisely so it cannot happen as a side effect of authoring
     * a product (Test-PRD-P0-40-closed_category_set).
     */
    /* parentId (ours, optional) makes this a SUBCATEGORY instead of a
       top-level category — Square's own real category hierarchy
       (category_data.parent_category, GA, verified against Square's own
       CatalogCategory reference), not something this codebase invents. */
    async createCategory({ name, parentId }) {
      const parent = parentId ? await categoryRef(parentId) : null;
      const temp = tempId("cat", 0);
      const res = await client.post("/v2/catalog/object", {
        idempotency_key: idempotencyKey(`catalog.category:${name}:${parent?.external_ref ?? ""}`),
        object: {
          type: "CATEGORY",
          id: temp,
          present_at_all_locations: true,
          category_data: {
            name,
            ...(parent ? { parent_category: { id: parent.external_ref } } : {}),
          },
        },
      });
      const created = res?.catalog_object?.id ?? realId(res, temp);
      if (!created) throw new Error("Square returned no catalog object id for the new category");
      const sync = await syncAfterWrite();
      const row = await mirrorDb
        .prepare("SELECT id, name, parent_id FROM mirror_category WHERE external_ref = ?")
        .bind(created)
        .first();
      return { category: row ? { id: row.id, name: row.name, parent_id: row.parent_id } : null, sync };
    },

    /**
     * Rename an EXISTING category or subcategory in place. mirror_category
     * has no source_version column (unlike mirror_product), so this can't
     * resend a locally-tracked version the way updateProduct does — it
     * follows setProductPresence's own pattern instead: GET the object live
     * from Square right before writing, so nothing we don't track locally
     * (present_at_all_locations, parent_category, ...) gets silently
     * clobbered by a stale local copy.
     */
    async renameCategory({ categoryId, name }) {
      const cat = await categoryRef(categoryId);
      const res = await client.get(`/v2/catalog/object/${encodeURIComponent(cat.external_ref)}`);
      if (!res?.object) {
        throw new Error(`Square has no catalog object '${cat.external_ref}' to rename`);
      }
      await client.post("/v2/catalog/object", {
        idempotency_key: idempotencyKey(`catalog.rename_category:${cat.external_ref}:${res.object.version}:${name}`),
        object: {
          ...res.object,
          category_data: {
            ...res.object.category_data,
            name,
          },
        },
      });
      const sync = await syncAfterWrite();
      const row = await mirrorDb
        .prepare("SELECT id, name, parent_id FROM mirror_category WHERE external_ref = ?")
        .bind(cat.external_ref)
        .first();
      return { category: row ? { id: row.id, name: row.name, parent_id: row.parent_id } : null, sync };
    },

    /**
     * Remove a category/subcategory. Real production error, ground truth
     * over the setProductPresence-style guess this used to make: "Square
     * POST /v2/catalog/object failed with 400 — INVALID_REQUEST_ERROR/
     * INVALID_VALUE... Object of type CATEGORY cannot be disabled." Unlike
     * ITEM, a CATEGORY object has no presence lifecycle in Square at all —
     * present_at_all_locations only ever meant something for what actually
     * gets sold. A real DeleteCatalogObject is Square's only removal path
     * for one. ADR-008's "archived, not deleted" still holds on OUR side:
     * this never deletes the mirror_category ROW, only asks Square to
     * delete ITS OWN object — the very next sync sees is_deleted: true on
     * it (isWithdrawn's own FIRST check, ahead of any presence field) and
     * archives the row exactly the same way a withdrawn product already
     * is, through the identical pipeline, no special-casing needed.
     * catalog.remove_category's own check() already refuses this while the
     * category still has subcategories — this only ever runs on a leaf.
     */
    async removeCategory({ categoryId }) {
      const cat = await categoryRef(categoryId);
      await client.delete(`/v2/catalog/object/${encodeURIComponent(cat.external_ref)}`);
      const sync = await syncAfterWrite();
      return { sync };
    },
  };
}
