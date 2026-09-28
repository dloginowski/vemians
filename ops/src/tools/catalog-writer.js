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
import { errorDetail } from "./error-detail.js";
import { CAPS } from "./caps.js";

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

/* How many products currently sit in each category — the Admin panel's own
   remove button needs this to hide itself the same "not reachable, don't
   show it" way it already does for a category that still has subcategories
   of its own (catalog.remove_category's own check() refuses either way; this
   is purely the UI's own advance knowledge of that same fact, so the button
   for a category with products assigned never renders as clickable-but-
   refused in the first place). A Map, id -> count, with no entry at all for
   a category that currently has none. */
export async function categoryProductCounts(db) {
  const res = await db
    .prepare("SELECT category_id, COUNT(*) AS n FROM mirror_product_index WHERE category_id IS NOT NULL GROUP BY category_id")
    .bind()
    .all();
  return new Map((res.results ?? []).map((r) => [r.category_id, Number(r.n)]));
}

/* Every item option ("Option Set"), each with its own full, ordered list of
   values — "do you have access to these option sets?" the owner's own
   question, answered by actually mirroring them (shared/commerce/square/
   schema.sql's own comment on mirror_item_option has the full reasoning).
   One query each, joined in JS rather than a single query with a JSON
   aggregate — this file's own established style (listAllProducts below
   does the identical thing for a product's own variants) — since D1/SQLite
   JSON aggregation is not worth the readability cost at this catalog's own
   scale. Read-only: there is no write path for item options yet. */
export async function listItemOptions(db) {
  const [optionsRes, valuesRes] = await Promise.all([
    db.prepare("SELECT id, name FROM mirror_item_option_index ORDER BY name COLLATE NOCASE").bind().all(),
    db.prepare("SELECT id, item_option_id, name, ordinal FROM mirror_item_option_value_index ORDER BY ordinal, name COLLATE NOCASE").bind().all(),
  ]);
  const valuesByOption = new Map();
  for (const v of valuesRes.results ?? []) {
    if (!valuesByOption.has(v.item_option_id)) valuesByOption.set(v.item_option_id, []);
    valuesByOption.get(v.item_option_id).push({ id: v.id, name: v.name });
  }
  return (optionsRes.results ?? []).map((o) => ({ id: o.id, name: o.name, values: valuesByOption.get(o.id) ?? [] }));
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

/* A product's own style_id, computed FROM its category, never the other
   way — "changing its category or subcategory is the same thing as
   changing the style ID number," the owner's own words. This is the one
   place that reads a category's own NN-NN pair: its own numeric_id as
   the second half, its PARENT's as the first — or null when either half
   has no numeric_id yet, since there is nothing real to build a style_id
   out of. Only ever a subcategory: this shop's own NN-NN-NNN nomenclature
   needs both halves, and a bare top-level category has no second number
   of its own to give — a product filed directly there simply has no
   style_id yet, same as one with no category at all. */
export async function styleIdCodesFor(db, categoryId) {
  const cat = await db.prepare("SELECT parent_id, numeric_id FROM mirror_category_index WHERE id = ?").bind(categoryId).first();
  if (!cat?.parent_id || !cat.numeric_id) return null;
  const parent = await db.prepare("SELECT numeric_id FROM mirror_category_index WHERE id = ?").bind(cat.parent_id).first();
  if (!parent?.numeric_id) return null;
  return { catCode: parent.numeric_id, subCode: cat.numeric_id };
}

/* NN-NN, plus the next unused NNN under it — "an index that auto
   increments... takes the next available index if one conflicts," the
   owner's own words. Called both at creation time and whenever a product
   MOVES to a different category (catalog.update_product's own check()) —
   scans mirror_style_id_ledger, not mirror_product's own current style_id
   column: a style_id a product has since moved away from is still
   reserved forever (the ledger's own append-only contract — schema.sql's
   own comment on it), so it must still count as used here. */
export async function nextStyleIdFor(db, catCode, subCode) {
  const prefix = `${catCode}-${subCode}-`;
  const res = await db
    .prepare("SELECT style_id FROM mirror_style_id_ledger WHERE style_id LIKE ? || '%'")
    .bind(prefix)
    .all();
  const used = (res.results ?? [])
    .map((r) => Number(r.style_id.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}


/*
 * vendor/vendor_code/unit_cost_minor/unit_cost_currency are resolved off the
 * product's own PRIMARY variation (LEFT JOIN, so a product with no
 * variations yet — created but not synced — still returns a row) — "one
 * vendor per product, applied uniformly to every variation," the
 * simplification chosen over Square's own per-variation granularity. vendor
 * itself moved off mirror_product entirely once the owner got Retail Plus
 * (Test-PRD-P0-136-square_custom_attributes, revised): it is Square's own
 * Vendor name now, not a plain-text custom attribute.
 *
 * REVISED, a real bug caught live: "I ran assign inhouse vendor... but not
 * all items have it automatically assigned." "Primary" here used to mean
 * "the variation Square happens to have numbered ordinal 0" — but Square's
 * own ordinal field is whatever Square itself assigned when the variation
 * was created, not a value this codebase controls or one Square documents
 * as zero-based; a real product's first (and often only) variation can
 * carry any starting ordinal. Every query that filtered for the LITERAL
 * value 0 silently found no match at all for such a product — not "found
 * the wrong variation," found NONE — so it was skipped by the vendor
 * backfill entirely, read back with no vendor/cost by productByHandle, and
 * (currentVendorInfo, below) could even have an UNRELATED edit silently
 * resend "no vendor" to Square by reading a false "nothing on file" for a
 * product that actually had a real vendor. listAllProducts (this file, its
 * own comment) already had the right instinct — sort variants by ordinal
 * and take the first one, rather than filter for a specific number — every
 * other read of "the product's own primary variation" now matches it:
 * PRIMARY_VARIANT_ORDINAL, the query fragment below, picks the variation
 * with the LOWEST ordinal for a product, whatever that number actually is.
 */
export const PRIMARY_VARIANT_ORDINAL = "(SELECT MIN(ordinal) FROM mirror_variant_index WHERE product_id = p.id)";
/* "For all items that do not have a vendor, they're now considered
   In-house... this has nothing to do with vendors [conceptually], but
   every item must have [a cost] associated with it" — the owner's own
   words, retiring the vendor-independent item_unit_cost_minor Custom
   Attribute (schema.sql's own comment has the full history). "No vendor
   at all" is no longer a real state: a product either names a real
   external vendor, or it gets this one, a real Square Vendor resolved/
   created through the exact same vendorRef() every named vendor already
   goes through — never a special case Square itself would treat
   differently. Cost then always lives on vendor_information.
   unit_cost_money (vendorInformationFor, below), whether the vendor is
   "In-house" or a real supplier. Exported so catalog-write.js's own
   no-op/no-vendor checks can compare against the identical literal
   rather than a second copy of the string. */
export const INHOUSE_VENDOR_NAME = "In-house";

/* Every spreadsheet-column spelling batch.js's own UNIT_COST_KEYS/
   IGNORED_KEYS already recognize as "this is cost" / "this is margin" —
   re-exported here, the single canonical list, rather than a second copy
   in catalog-write.js's own legacy-field cleanup tool (below) that could
   drift out of sync with batch.js's own. Before the real cost/vendor
   mechanism existed (this file's own INHOUSE_VENDOR_NAME comment has the
   history), a spreadsheet's Cost/Margin column landed here, in a
   product's own custom_fields, verbatim — catalog.strip_legacy_cost_
   fields (catalog-write.js) is the one-time pass that removes it from
   whatever product still carries it. */
export const LEGACY_COST_FIELD_KEYS = ["unit cost", "cost", "cost (usd)", "cost usd", "cogs", "cost of goods", "wholesale cost"];
export const LEGACY_MARGIN_FIELD_KEYS = ["margin", "margin %", "margin pct", "gross margin", "profit margin"];

const PRODUCT_WITH_VENDOR_COLUMNS = `
  p.id, p.handle, p.title, p.source_description, p.status, p.channel, p.custom_fields,
  p.import_style_number, p.style_id, p.commission_pct, p.category_id,
  mv.name AS vendor, v0.vendor_code, v0.unit_cost_minor, v0.unit_cost_currency
`;
const PRODUCT_WITH_VENDOR_JOIN = `
  LEFT JOIN mirror_variant_index v0 ON v0.product_id = p.id AND v0.ordinal = ${PRIMARY_VARIANT_ORDINAL}
  LEFT JOIN mirror_vendor_index mv ON mv.id = v0.vendor_id
`;
const PRODUCT_WITH_VENDOR_SELECT = `SELECT ${PRODUCT_WITH_VENDOR_COLUMNS} FROM mirror_product_index p ${PRODUCT_WITH_VENDOR_JOIN}`;

export async function productByHandle(db, handle) {
  return db
    .prepare(`${PRODUCT_WITH_VENDOR_SELECT} WHERE p.handle = ?`)
    .bind(handle)
    .first();
}

/* A resubmitted CSV row's own way to find the product it already created,
   last time — "if that all matches, then you just update," the owner's
   own words, once style_id itself could no longer serve as that key
   (Test-PRD-P0-179-import_style_number_matching has the full reasoning).
   NULL is never searched for (every style-numbered CSV row has a real,
   non-empty base) — batch.js only ever calls this with one. */
export async function productByImportStyleNumber(db, importStyleNumber) {
  return db
    .prepare(`${PRODUCT_WITH_VENDOR_SELECT} WHERE p.import_style_number = ?`)
    .bind(importStyleNumber)
    .first();
}

/* The SAME resubmit-matching job as productByImportStyleNumber, just the
   other of the two identifiers a resubmitted row can carry — "the most
   important match... our style ID... because that's how we want to
   identify items externally... there may be situations where we want to
   bulk update a bunch of items based on their style IDs," the owner's own
   words, once import_style_number turned out not to be the only text a
   real resubmit sheet uses to find an item: a person bulk-editing prices
   types the CURRENT, live style_id shown on the item today, which has
   moved on from whatever import_style_number still holds if the item's own
   category was corrected since it was first created. batch.js tries
   productByImportStyleNumber FIRST (immune to any later renumber at all,
   so an ordinary "resubmit the same sheet" always finds it), then this ONLY
   when that finds nothing — never both landing on two DIFFERENT products,
   since mirror_style_id_ledger reserves a style_id forever once assigned
   (Test-PRD-P0-177-fluid_style_id): the exact text import_style_number
   still holds for THIS product can never become some OTHER product's own
   live style_id later. */
export async function productByStyleId(db, styleId) {
  return db
    .prepare(`${PRODUCT_WITH_VENDOR_SELECT} WHERE p.style_id = ?`)
    .bind(styleId)
    .first();
}

/* The FALLBACK resubmit match, tried only once NEITHER style-number lookup
   above finds anything at all — "our style ID numbers may be different, we
   may have changed them, but the categories and subcategories and names
   have not... if you find the same item with the same title that we are
   providing you, then that's a match, just update it," the owner's own
   words, for a sheet whose style numbers were deliberately renumbered
   (rather than merely moved, which import_style_number/style_id already
   cover between them). Every row in this codebase's own CSV pipeline is
   the same shape: EXACTLY one category (already resolved by the caller,
   by name or number, same as ever) and one title — never a fuzzy text
   search, just an exact, case/whitespace-insensitive title match scoped to
   that one category, so "Wool Coat" in Outerwear can never accidentally
   match an unrelated "Wool Coat" filed somewhere else. Returns every match,
   not just one: batch.js's own caller treats ZERO as "no fallback match,
   proceed to create," EXACTLY ONE as confident enough to update outright,
   and MORE THAN ONE as a genuine ambiguity to park for a person — "if you
   have any doubts, pop up a window... only if you have a question about it
   though, if you're confident, then just update." */
export async function productsByCategoryAndTitle(db, categoryId, title) {
  const res = await db
    .prepare(`${PRODUCT_WITH_VENDOR_SELECT} WHERE p.category_id = ? AND LOWER(TRIM(p.title)) = LOWER(TRIM(?))`)
    .bind(categoryId, title)
    .all();
  return res.results ?? [];
}

/* The LAST-RESORT half of the same fallback, tried only when a resubmit's
   own category could not be resolved to anything AT ALL -- a real
   production report, the day after import_style_number/style_id matching
   shipped: a shop whose sheet carries only a numeric style-number code
   (no Category/Subcategory NAME columns) and whose categories have since
   been renumbered (this shop's own recurring workflow, P0-138/P0-177)
   has no code left to scope a search to -- resolveCategoryByCode finds
   nothing by number, and there is no name to try either. Rather than give
   up (every one of the three tiers this feature has would otherwise miss:
   import_style_number is NULL for anything created before this feature
   existed, style_id has moved since the sheet's own numbers were current,
   and productsByCategoryAndTitle has no category to search within), this
   searches every category by title alone -- still exactly ONE candidate
   to be confident, still an ambiguous clash naming every one when more
   than one product anywhere shares that exact title, same as the
   category-scoped version. */
export async function productsByTitle(db, title) {
  const res = await db
    .prepare(`${PRODUCT_WITH_VENDOR_SELECT} WHERE LOWER(TRIM(p.title)) = LOWER(TRIM(?))`)
    .bind(title)
    .all();
  return res.results ?? [];
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
      `SELECT v.id, v.external_ref, v.sku, v.title AS variant_title, v.options, p.handle, p.title AS product_title
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

/* Same rows as variantsOf, plus each one's own already-resolved
   option_values (name -> value, e.g. {"Color":"Red","Size":"M"}) — for a
   caller that needs to recognize WHICH existing variation a row
   corresponds to, not just list them. batch.js's own resubmit-matching
   (Test-PRD-P0-179-import_style_number_matching) is the one caller: a
   CSV row's own Color/Size only ever means anything against a product's
   CURRENT variations, never a stored id the sheet itself could carry. */
export async function variantsWithOptionsOf(db, productId) {
  const res = await db
    .prepare(
      "SELECT id, sku, title, ordinal, price_minor, currency, options FROM mirror_variant_index WHERE product_id = ? ORDER BY ordinal",
    )
    .bind(productId)
    .all();
  return (res.results ?? []).map((v) => {
    let options = {};
    try {
      options = JSON.parse(v.options || "{}");
    } catch {
      options = {};
    }
    return { ...v, options };
  });
}

/* Marks a mirror_image row as ours, never Square's — shared by the insert
   and the delete below so the two never quietly disagree on the shape. */
const OPS_IMAGE_REF_PREFIX = "ops-upload:";

/*
 * A photograph added directly from the Items tab (POST /items/<handle>/photo,
 * index.js) — "upload an image specifically for that option, for, like, for
 * that variant." OUR row from the start, never Square's: this never calls
 * Square, and never will be reconciled away by a later sync (schema.sql's own
 * comment on mirror_image.variant_id has the full reasoning why that is
 * safe). external_ref only exists to satisfy mirror_image's own UNIQUE
 * constraint — synthesized here, in a shape (OPS_IMAGE_REF_PREFIX) no real
 * Square IMAGE id could ever collide with. Always appended (MAX(ordinal)+1):
 * a Square-synced general photo, if this product has one, keeps its own
 * ordinal 0 and stays first in the gallery.
 */
export async function insertVariantImage(db, { productId, variantId, mediaKey }) {
  const row = await db
    .prepare("SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM mirror_image WHERE product_id = ?")
    .bind(productId)
    .first();
  const ordinal = Number(row?.max_ordinal ?? -1) + 1;
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO mirror_image (id, external_ref, product_id, variant_id, source_url, caption, ordinal, media_key, archived_at, synced_at)
       VALUES (?, ?, ?, ?, '', '', ?, ?, NULL, datetime('now'))`,
    )
    .bind(id, `${OPS_IMAGE_REF_PREFIX}${crypto.randomUUID()}`, productId, variantId ?? null, ordinal, mediaKey)
    .run();
  return { id, ordinal };
}

/*
 * "Add a delete button... so I can delete the images as well" — the owner's
 * own words. Archive-only, like every mirror table (mirror_image_no_delete
 * refuses a literal DELETE outright) — but ALSO scoped to a row this app
 * added itself. A Square-sourced photo (a real Square IMAGE id) is refused
 * outright rather than silently archived: mirror.js's own sync upserts by
 * external_ref on every pass and sets archived_at from Square's own current
 * withdrawn state, so archiving a Square-sourced row here would just be
 * silently undone the next time this item syncs — a "delete" that quietly
 * comes back is worse than one that never worked, so this refuses with a
 * reason instead of pretending to succeed.
 */
export async function archiveImage(db, { productId, imageId }) {
  const row = await db
    .prepare("SELECT external_ref FROM mirror_image WHERE id = ? AND product_id = ? AND archived_at IS NULL")
    .bind(imageId, productId)
    .first();
  if (!row) return { error: "no such photo on this item" };
  if (!row.external_ref.startsWith(OPS_IMAGE_REF_PREFIX)) {
    return { error: "this photo came from Square — remove it there, not here" };
  }
  await db.prepare("UPDATE mirror_image SET archived_at = datetime('now') WHERE id = ?").bind(imageId).run();
  return { ok: true };
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
      "SELECT id, product_id, sku, title, ordinal, price_minor, currency, options, vendor_id, vendor_code, unit_cost_minor, unit_cost_currency" +
        " FROM mirror_variant_index ORDER BY product_id, ordinal",
    )
    .bind()
    .all();
  const byProduct = new Map();
  for (const v of variants.results ?? []) {
    if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
    /* options is Square's own resolved name -> value blob (P0-143's own
       comment on mirror_variant.options has the full reasoning) — parsed
       here, once, rather than left as a JSON string for the Items tab's
       own Variants grid (views.js) to re-parse per render. */
    let options = {};
    try {
      options = JSON.parse(v.options || "{}");
    } catch {
      options = {};
    }
    byProduct.get(v.product_id).push({ ...v, options });
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

  /* EVERY mirrored photograph, not just ordinal 0 — the full-view gallery
     (itemTile(), views.js) swipes across every one of a product's own
     images, general or variant-tagged alike (schema.sql's own comment on
     mirror_image.variant_id has the full reasoning). Ordinal order keeps a
     Square-synced general photo first (ordinal 0..N) and a locally-added
     variant photo after it (insertVariantImage, below, always appends). */
  const allImages = await db
    .prepare("SELECT id, product_id, variant_id, media_key, ordinal FROM mirror_image_index WHERE media_key IS NOT NULL ORDER BY product_id, ordinal")
    .bind()
    .all();
  const imagesByProduct = new Map();
  for (const i of allImages.results ?? []) {
    if (!imagesByProduct.has(i.product_id)) imagesByProduct.set(i.product_id, []);
    imagesByProduct.get(i.product_id).push({ id: i.id, media_key: i.media_key, variant_id: i.variant_id ?? null });
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
      /* Every product has a real vendor now — a supplier's, or the built-in
         "In-house" one (catalog-writer.js's own INHOUSE_VENDOR_NAME) — so
         cost always lives on vendor_information, never a fallback column.
         Still defensive against v0 itself being absent (a product created
         but not yet synced has no variation row to join at all yet). */
      unit_cost_minor: v0?.unit_cost_minor ?? 0,
      unit_cost_currency: v0?.unit_cost_currency ?? "USD",
      commission_pct: p.commission_pct ?? null,
      variations,
      image_key: imageByProduct.get(p.id) ?? null,
      images: imagesByProduct.get(p.id) ?? [],
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
  /* option_values rides along on BOTH sides now — an EXISTING variation's
     own already-mirrored `options` (P0-143's own JSON blob, name -> value)
     renamed here to the same `option_values` shape a NEW entry's own
     patch data uses, so updateProduct's own resolution loop (below) reads
     one field regardless of which side a kept variation came from. This
     is what lets an unrelated edit resend an existing variation's own
     Size/Color selection instead of silently dropping it — the same
     "resend the whole thing or it vanishes" rule this file already
     applies to item_options/vendor_information one level up. */
  const byId = new Map(
    (current ?? []).map((v) => [v.id, { ...v, price_minor: Number(v.price_minor), option_values: v.options ?? {} }]),
  );
  const order = (current ?? []).map((v) => v.id);
  const added = [];
  for (const p of patch ?? []) {
    if (!p.variant_id) {
      /* A stable per-product seed (an existing sibling variation's own
         external_ref, when this product already has one) plus this
         variation's own title/option_values — so a genuine retry of the
         exact same patch (missing-combo generation re-run before the
         mirror has synced, say) regenerates the identical code rather than
         minting a second one, and two different new variations on the
         same product never collide with each other. */
      const skuSeed = `${current?.[0]?.external_ref ?? current?.[0]?.id ?? ""}|${p.title}|${JSON.stringify(p.option_values ?? {})}`;
      added.push({
        id: null,
        title: p.title,
        sku: generateSku(skuSeed),
        price_minor: p.price_minor,
        currency: p.currency,
        /* A brand-new row added through this same patch has no existing
           unit cost to fall back to — undefined here means updateProduct's
           own per-variation resolution falls back to the product-level
           default, same as every other newly-added variation field. */
        unit_cost_minor: p.unit_cost_minor,
        /* "Add this size or color to the option list and update it so
           that this item can still be added as a SKU" — a brand-new
           variation this file itself adds (catalog.apply_category_item_
           options_to_products' own auto-generated combinations) names
           which of the item's own Option Set values it IS, the same
           option_values shape catalog.create_product's own variations
           already use. */
        option_values: p.option_values ?? {},
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
      /* A patch naming an EXISTING variant's own option_values (a CSV/agent
         edit giving a variation that predates Option Sets entirely its
         own Size/Color, for instance) must actually reach it — this used
         to be silently dropped on the UPDATE side of a merge; only a
         brand-new added entry ever carried option_values through at all. */
      option_values: p.option_values ?? cur.option_values,
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

/* A small, fast, purely synchronous hash (FNV-1a) — not crypto.randomUUID():
   generateSku()'s own output rides inside mergeVariations'/createProduct's
   own content, which Square's own idempotency_key is hashed from (this file
   already got burned once by "same key, different body" —
   IDEMPOTENCY_KEY_REUSED, updateProduct's own comment below). A genuinely
   random sku would make an identical retry of the same write hash to a
   DIFFERENT key every time, the same class of bug. Deterministic instead:
   the same seed always produces the same code, so a retry regenerates
   byte-for-byte identical content, never a second, duplicate object in
   Square. */
function fnv1aHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

/* "I think the SKUs need to be just a hash, a unique hash across the whole
   items... it should live completely separately from the style ID because
   the style ID tells us a lot about an item and that can change in the
   future" — the owner's own words, retiring an earlier design that
   embedded style_id in a human-readable SKU. A permanent, opaque SKU
   plain 12-digit numeric code, the same shape a UPC-A barcode label
   already takes, so it prints and scans in Square exactly like a real one
   would (Code128, since it's simply never a REGISTERED code outside this
   shop's own account — same as any other home-grown SKU); "Automatically
   generate SKUs" is a real Square feature, but Dashboard/POS-side only —
   verified live it never fires for a variation created through the
   Catalog API this file calls, so this file has always had to mint one
   itself. `seed` should be whatever already distinguishes this variation
   from every other one reached by the SAME write (a stable product
   identifier plus the variation's own title/option_values), so two
   different variations never collide and the same variation never gets a
   second code on retry — this is also what keeps a SKU permanent: nothing
   here ever re-derives one from a category or style_id, so nothing about
   an item's own categorization can ever change what its SKU already is. */
function generateSku(seed) {
  const a = fnv1aHash(seed);
  const b = fnv1aHash(`${seed}#2`);
  return `${a}${b}`.slice(0, 12).padStart(12, "0");
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

  /* The item's own CURRENTLY mirrored item_options, as Square external
     refs — updateProduct's own "resend the whole thing" fallback for
     this field, same reasoning currentVendorInfo below exists for a
     vendor's own fields: itemData()'s own item_options key is a full
     REPLACE of Square's own item_data.item_options, so a caller not
     actually about this field must still resend what is already there,
     never leave it to silently vanish. */
  async function currentItemOptionExternalRefs(productId) {
    const res = await mirrorDb
      .prepare(
        "SELECT moi.external_ref AS external_ref FROM mirror_product_item_option_index ppo" +
          " JOIN mirror_item_option_index moi ON moi.id = ppo.item_option_id WHERE ppo.product_id = ?",
      )
      .bind(productId)
      .all();
    return (res.results ?? []).map((r) => r.external_ref);
  }

  /*
   * "If we are adding a set of items and we specify its size or color, and
   * this size or color is not already defined in our option, add this size
   * or color to the option list and update it so that this item can still
   * be added as a SKU" — the owner's own words. Resolves an Option Set's
   * own NAME (e.g. "Size") and one of its VALUE names (e.g. "XL") to
   * Square's own external refs for both, minting whichever half is
   * missing: a known option with a new value gets that value APPENDED
   * (UpsertCatalogObject is a full replace, so the option's own current
   * values are resent whole, the same rule as every other field in this
   * file — see the module header); an option this shop has never used at
   * all yet is created outright, with this value as its own first entry.
   * Matching is case-insensitive on both halves, the same tolerance
   * matchCategory already gives a spreadsheet that was not typed to a
   * spec. Nothing to resolve, and no Square write at all, for a value
   * already on file.
   */
  async function ensureItemOptionValue(optionName, valueName) {
    const option = await mirrorDb
      .prepare("SELECT id, external_ref FROM mirror_item_option_index WHERE name = ? COLLATE NOCASE")
      .bind(optionName)
      .first();

    if (option) {
      const value = await mirrorDb
        .prepare("SELECT external_ref FROM mirror_item_option_value_index WHERE item_option_id = ? AND name = ? COLLATE NOCASE")
        .bind(option.id, valueName)
        .first();
      if (value) return { itemOptionRef: option.external_ref, itemOptionValueRef: value.external_ref };

      const res = await client.get(`/v2/catalog/object/${encodeURIComponent(option.external_ref)}`);
      if (!res?.object) {
        throw new Error(`Square has no catalog object '${option.external_ref}' for item option '${optionName}'`);
      }
      const valueTemp = tempId("optval", 0);
      const upserted = await client.post("/v2/catalog/object", {
        idempotency_key: idempotencyKey(`catalog.add_option_value:${option.external_ref}:${res.object.version}:${valueName}`),
        object: {
          ...res.object,
          item_option_data: {
            ...res.object.item_option_data,
            values: [
              ...(res.object.item_option_data?.values ?? []),
              {
                type: "ITEM_OPTION_VAL",
                id: valueTemp,
                item_option_value_data: { item_option_id: option.external_ref, name: valueName },
              },
            ],
          },
        },
      });
      const createdValueRef = realId(upserted, valueTemp);
      if (!createdValueRef) {
        console.error("ERROR catalog-writer: Square accepted the new option value but returned no id");
        throw new Error("Square returned no catalog object id for the new item option value");
      }
      await syncAfterWrite();
      return { itemOptionRef: option.external_ref, itemOptionValueRef: createdValueRef };
    }

    /* No such Option Set at all yet — createCategory's own "#temp id, real
       ones come back in id_mappings" pattern, one level deeper: the
       ITEM_OPTION itself and its one value are both brand new. */
    const optionTemp = tempId("opt", 0);
    const valueTemp = tempId("optval", 0);
    const created = await client.post("/v2/catalog/object", {
      idempotency_key: idempotencyKey(`catalog.create_option:${optionName}:${valueName}`),
      object: {
        type: "ITEM_OPTION",
        id: optionTemp,
        item_option_data: {
          name: optionName,
          values: [
            {
              type: "ITEM_OPTION_VAL",
              id: valueTemp,
              item_option_value_data: { item_option_id: optionTemp, name: valueName },
            },
          ],
        },
      },
    });
    const createdOptionRef = created?.catalog_object?.id ?? realId(created, optionTemp);
    const createdValueRef = realId(created, valueTemp);
    if (!createdOptionRef || !createdValueRef) {
      console.error("ERROR catalog-writer: Square accepted the new item option but returned no id");
      throw new Error("Square returned no catalog object id for the new item option");
    }
    await syncAfterWrite();
    return { itemOptionRef: createdOptionRef, itemOptionValueRef: createdValueRef };
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

  /* The CURRENT vendor/cost, read off the product's own PRIMARY variation
     (PRIMARY_VARIANT_ORDINAL's own comment has the full history — this is
     the one call site that correlates by a bound productId rather than an
     outer p.id, so it repeats the same MIN(ordinal) shape rather than
     reusing that constant directly) — "one vendor per product, applied
     uniformly," the same simplification PRODUCT_WITH_VENDOR_SELECT's own
     comment describes. Used by updateProduct's own "resend the whole
     thing" fallback: undefined always means "this call is not about that
     field," resolved to whatever is already there, the same reasoning
     style_id/commission already use for an item-level field — this is
     that same reasoning one level down, at the variation Square itself
     stores vendor_information on. Getting this one wrong is worse than a
     display gap: a fallback that reads the WRONG "current" vendor (or
     none, when a real one exists) can resend that false state to Square
     as part of an edit that was never about vendor at all. */
  async function currentVendorInfo(productId) {
    const row = await mirrorDb
      .prepare(
        `SELECT mv.external_ref AS vendor_external_ref, mv.name AS vendor_name,
                v.vendor_code, v.unit_cost_minor, v.unit_cost_currency
           FROM mirror_variant_index v
           LEFT JOIN mirror_vendor_index mv ON mv.id = v.vendor_id
          WHERE v.product_id = ?
            AND v.ordinal = (SELECT MIN(ordinal) FROM mirror_variant_index WHERE product_id = ?)`,
      )
      .bind(productId, productId)
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

  async function vendorRefOrInHouse(name) {
    return vendorRef(name || INHOUSE_VENDOR_NAME);
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
     above; it lives on each variation, not in custom_attribute_values. Cost
     no longer lives here either — item_unit_cost_minor (this file's own
     third, vendor-independent attempt at it) is retired; every product now
     has a real vendor (a supplier's, or INHOUSE_VENDOR_NAME above), so cost
     always resolves through vendorInformationFor instead. */
  function customAttributeValues({ styleId, commissionPct } = {}) {
    const out = {};
    if (styleId) out.style_id = { key: "style_id", type: "STRING", string_value: styleId };
    if (commissionPct !== undefined && commissionPct !== null) {
      out.commission = { key: "commission", type: "STRING", string_value: String(commissionPct) };
    }
    return Object.keys(out).length ? out : undefined;
  }

  function itemData({ title, description, catRef, variations, itemRef, imageIds, customAttributeValues: attrs, vendorInfos, itemOptionRefs, variationOptionValueRefs }) {
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
      /* Which Option Sets this ITEM itself declares (P0-143) — "mass apply
         the options to all of the items that are part of the category,"
         the owner's own words. Only ever a full REPLACE, the same as
         every other field here: a caller not actually about this field
         still resends whatever is already mirrored (updateProduct's own
         currentItemOptionExternalRefs), never leaves it to vanish. */
      ...(itemOptionRefs?.length ? { item_options: itemOptionRefs.map((ref) => ({ item_option_id: ref })) } : {}),
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
          /* Which of the item's own Option Set values THIS variation is —
             "so that this item can still be added as a SKU," the owner's
             own words. Index-aligned with `variations`, the same
             convention vendorInfos above already uses; resolved by the
             caller (ensureItemOptionValue), never guessed at here. */
          ...(variationOptionValueRefs?.[i]?.length ? { item_option_values: variationOptionValueRefs[i] } : {}),
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
      /* Every product has a real vendor now (a supplier's, or "In-house"),
         so this is always vendor_information's own cost — see
         listAllProducts' own identical comment above. */
      unit_cost_minor: vendorInfo.unit_cost_minor,
      unit_cost_currency: vendorInfo.unit_cost_currency,
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

    /* "When I add item to inventory, can't you auto generate it if
       missing" — the owner's own words. inventory.adjust (commerce.js)
       calls this before moving stock on a variation with no SKU, rather
       than refusing outright the way it used to ("has no SKU yet...
       nothing to adjust"). Exposed here rather than on a `catalog_mirror`
       store of commerce.js's own — the same "no tool holds two stores at
       once" reasoning variantById's own comment gives; commerce.js reaches
       this through `resources: ["square"]`, never a store of its own.
       Already-real (a variant with a SKU already, the common case) is a
       pure no-op read, never a write. */
    async ensureVariantSku(variantId) {
      const v = await variantById(mirrorDb, variantId);
      if (!v) return null;
      if (v.sku) return v.sku;
      const sku = generateSku(`${v.external_ref}|inventory`);
      /* updateProduct never returns an {error} shape of its own — a real
         failure throws, and that's exactly what should happen here too:
         inventory.adjust's own run() has nothing sensible left to do if
         the SKU it was about to adjust against could not even be written. */
      await this.updateProduct({ handle: v.handle, variations: [{ variant_id: v.id, sku }] });
      return sku;
    },
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
     * "Style IDs need to be fluid. They need to be always shown and
     * updated based on the categorizing of items. If something ever
     * changes the system of categorizing them and their IDs, that should
     * affect the style IDs" — the owner's own words. Called whenever a
     * category's OWN numeric_id (or its parent's) changes
     * (catalog.set_category_number, and catalog.create_category when a
     * bare category finally gets numbered) — every product currently
     * filed in ANY category updates ITS OWN style_id's PREFIX to match,
     * via a REAL Square write (this.updateProduct — style_id is Square's
     * own Custom Attribute, ADR-009), keeping each product's own sequence
     * number (the last three digits) exactly as it was: a prefix swap
     * applied uniformly can never collide with anything, since every
     * product under the old prefix moves to the identical new one
     * together — there is nothing here for the ledger to re-arbitrate.
     * A product whose category has no numeric_id (or no parent) yet keeps
     * its last valid style_id rather than losing it — this never CLEARS
     * an assignment, only ever corrects one. One write per AFFECTED
     * product only (never one whose prefix already matches), sequentially
     * (this codebase has no batch upsert) — fine at the boutique catalog
     * scale this whole feature is built for.
     *
     * This is NOT how a product's style_id changes when IT ITSELF moves to
     * a different category — that needs a freshly ALLOCATED sequence
     * number (the destination category may already use the number this
     * product had elsewhere), handled by catalog.update_product's own
     * check()/nextStyleIdFor, not here.
     */
    async resyncStyleIdPrefixes() {
      const products = await mirrorDb
        .prepare("SELECT handle, style_id, category_id FROM mirror_product_index WHERE style_id IS NOT NULL AND category_id IS NOT NULL")
        .bind()
        .all();
      let updated = 0;
      const errors = [];
      for (const p of products.results ?? []) {
        const m = /^(\d{2}-\d{2})-(\d{3})$/.exec(p.style_id);
        if (!m) continue;
        const [, , seq] = m;
        const codes = await styleIdCodesFor(mirrorDb, p.category_id);
        if (!codes) continue;
        const correct = `${codes.catCode}-${codes.subCode}-${seq}`;
        if (correct === p.style_id) continue;
        try {
          await this.updateProduct({ handle: p.handle, styleId: correct });
          updated += 1;
        } catch (err) {
          console.error(`ERROR catalog-writer: style_id prefix resync failed for ${p.handle} — ${err.message}`);
          errors.push({ handle: p.handle, error: err.message });
        }
      }
      return { updated, errors };
    },

    /* One-time backfill for the "In-house" vendor rule (schema.sql's own
       comment on mirror_product.commission_pct has the full history): every
       product a real vendor was never named for still has vendor_id: null
       on its own PRIMARY variation, from before this shop's data could
       not be in that state at all. vendor: "" is updateProduct's own
       "reassign to In-house" signal (vendorRefOrInHouse) — the exact same
       path a fresh clear_vendor call takes, run here once per row instead
       of once per person clicking it. Same applied/errors shape as
       resyncStyleIdPrefixes above, for the same reason: a genuine Square
       failure on one product must never stop the rest.

       REVISED, a real bug caught live: "I ran assign inhouse vendor... but
       not all items have it automatically assigned. They have no vendor
       still." This JOIN used to filter for ordinal = 0 literally —
       PRIMARY_VARIANT_ORDINAL's own comment (above) has the full story —
       so a vendorless product whose real Square ordinal for its first
       variation was not exactly zero matched NOTHING here and was silently
       skipped by this exact tool, the one this whole backfill exists to
       reach. Fixed by joining on the lowest ordinal per product instead of
       a hardcoded literal. */
    async assignInHouseVendorToVendorlessProducts() {
      const products = await mirrorDb
        .prepare(
          `SELECT p.handle FROM mirror_product_index p
             JOIN mirror_variant_index v0 ON v0.product_id = p.id AND v0.ordinal = ${PRIMARY_VARIANT_ORDINAL}
            WHERE v0.vendor_id IS NULL`,
        )
        .bind()
        .all();
      const rows = products.results ?? [];
      let applied = 0;
      const errors = [];
      for (const p of rows) {
        try {
          await this.updateProduct({ handle: p.handle, vendor: "" });
          applied += 1;
        } catch (err) {
          const detail = errorDetail(err);
          console.error(`ERROR catalog-writer: assigning "In-house" failed for ${p.handle} — ${detail}`);
          errors.push({ handle: p.handle, error: detail });
        }
      }
      /* "We should have In-house [in the vendor picker], right?" — the
         owner's own words, after running this with every product already
         on a real named vendor. Every row the loop above actually touches
         already creates "In-house" (updateProduct's own vendorRefOrInHouse)
         and syncs it back through its own syncAfterWrite — but a shop
         where NOTHING currently lacks a vendor would leave rows empty and
         skip both entirely, so the one product-level guarantee this tool
         makes ("In-house exists, and is on file in our own mirror") would
         quietly not hold. Ensured here, once, regardless of how many rows
         there were to reassign — idempotent, since vendorRefOrInHouse
         itself already resolves to the existing vendor once one is on
         file, never creating a second. */
      if (!rows.length) {
        await vendorRefOrInHouse(null);
        await syncAfterWrite();
      }
      return { applied, errors };
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
         resolves-or-creates against the real Vendors API. A fresh product
         with no vendor named at all still gets one: vendorRefOrInHouse
         falls back to the built-in "In-house" vendor, since "no vendor at
         all" is no longer a state this shop's data can be in. */
      const vref = await vendorRefOrInHouse(vendor);
      const vendorInfo = vendorInformationFor({
        vendorExternalRef: vref.external_ref,
        vendorCode,
        unitCostMinor,
        unitCostCurrency,
      });
      /* Every brand-new variation gets a real, permanent, opaque SKU —
         generateSku()'s own comment. Seeded on this ITEM's own title (no
         external_ref exists yet for a product that does not exist yet)
         plus each variation's own title/option_values, so two variations
         on the same new item never collide with each other. */
      const resolvedVariations = variations.map((v) => ({
        ...v,
        sku: generateSku(`${title}|${v.title}|${JSON.stringify(v.option_values ?? {})}`),
      }));
      /* A variation naming a Size/Color (etc.) it wants is resolved to
         Square's own refs here, minting whichever half (the option
         itself, or just a new value on an option that already exists) is
         missing — see ensureItemOptionValue's own comment. One at a time,
         never in parallel: two rows in the same batch both minting the
         SAME brand-new value would otherwise race to create it twice. */
      const variationOptionValueRefs = [];
      const itemOptionRefSet = new Set();
      for (const v of resolvedVariations) {
        const pairs = [];
        for (const [optionName, valueName] of Object.entries(v.option_values ?? {})) {
          const { itemOptionRef, itemOptionValueRef } = await ensureItemOptionValue(optionName, valueName);
          itemOptionRefSet.add(itemOptionRef);
          pairs.push({ item_option_id: itemOptionRef, item_option_value_id: itemOptionValueRef });
        }
        variationOptionValueRefs.push(pairs);
      }
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
            variations: resolvedVariations,
            itemRef,
            imageIds,
            customAttributeValues: customAttributeValues({ styleId, commissionPct }),
            /* A brand-new product has no per-variation history yet — every
               variation starts with the SAME vendor/cost, the one given at
               creation time; they only diverge later, through updateProduct. */
            vendorInfos: resolvedVariations.map(() => vendorInfo),
            /* The item itself must declare every Option Set any of its own
               variations actually uses (Square's own requirement — a
               variation's item_option_values means nothing without it),
               derived here rather than asked for separately: a caller
               that names Size/Color per variation should never also have
               to repeat which Option Sets those are. */
            itemOptionRefs: [...itemOptionRefSet],
            variationOptionValueRefs,
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
      /* A call to this function is never about the item's own option
         sets — resolved to whatever is already mirrored, the same
         "resend the whole thing" fallback every other field on this
         function already follows. */
      const resolvedItemOptionExternalRefs = await currentItemOptionExternalRefs(row.id);
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
          "SELECT id, external_ref, source_version, sku, title, ordinal, price_minor, currency, options, unit_cost_minor, unit_cost_currency" +
            " FROM mirror_variant_index WHERE product_id = ? ORDER BY ordinal",
        )
        .bind(row.id)
        .all();
      const currentVariations = (currentRes.results ?? []).map((v) => {
        let options = {};
        try {
          options = JSON.parse(v.options || "{}");
        } catch {
          options = {};
        }
        return { ...v, options };
      });
      const resolvedStyleId = styleId !== undefined ? styleId : row.style_id;
      const merged = mergeVariations(currentVariations, variations);
      if (merged.error) throw new Error(`${merged.error} ('${handle}')`);
      const keep = merged.variations;

      /* Every kept variation's own item_option_values must be resent
         whole — Square's own UpsertCatalogObject replaces each
         variation's own data wholesale, the same "resend or it
         vanishes" rule item_options/vendor_information already follow
         one level up. An EXISTING variation's own values (carried
         through mergeVariations' own option_values, from this file's
         SELECT above) resolve back to their own external refs; a newly
         added one (only ever from an option_values-bearing patch entry,
         e.g. a CSV/agent-given Size/Color) resolves the same way
         createProduct's own loop does. Nothing here is EXPECTED to
         mint a brand-new value — every name/value reaching this call
         already exists — but ensureItemOptionValue's own tolerance for
         "not on file yet" costs nothing to reuse rather than duplicate. */
      const variationOptionValueRefs = [];
      for (const v of keep) {
        const pairs = [];
        for (const [optionName, valueName] of Object.entries(v.option_values ?? {})) {
          const { itemOptionRef, itemOptionValueRef } = await ensureItemOptionValue(optionName, valueName);
          pairs.push({ item_option_id: itemOptionRef, item_option_value_id: itemOptionValueRef });
        }
        variationOptionValueRefs.push(pairs);
      }

      /* Undefined means "this call is not about that field" for commission —
         resolved to whatever the mirror already has, the same "resend the
         whole thing, not just the diff" reasoning `keep` above already
         exists for (style_id resolves the identical way, just earlier now
         — above, before the merge). style_id itself is resolved one layer
         up, in catalog-write.js's own tool (either kept as-is, or freshly
         allocated when a product moves category); an EXISTING variation's
         own `sku` a few lines above (mergeVariations' own UPDATE branch) is
         Square's, read back verbatim, never invented here — only a
         BRAND-NEW variation with none given gets one minted, inside
         mergeVariations itself (generateSku's own comment, above). */
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
      /* vendor === "" (an explicit clear, from catalog.set_square_attributes'
         own clear_vendor flag) no longer lands on external_ref: null —
         vendorRefOrInHouse resolves the empty name to the built-in
         "In-house" vendor instead, same as createProduct's own fresh-
         product default. vendor === undefined ("this call is not about
         that field") keeps whatever the product already has, UNCHANGED —
         an ordinary title or price edit must never reassign a legacy
         vendor-less product's vendor as an unannounced side effect;
         catalog.assign_inhouse_vendor is the real, explicit, one-time pass
         for that. The ONE exception: this same call is setting a cost
         (unitCostMinor !== undefined) on a product with no vendor at all —
         "unit_cost_minor is never refused for lack of a vendor" (this
         tool's own describe text) means the cost has to land somewhere
         real, and vendor_information needs a real vendor_id to attach to,
         so THAT specific combination gets "In-house" the same way a
         brand-new vendor-less product's own cost already does at
         creation. */
      const resolvedVendorExternalRef =
        vendor !== undefined
          ? (await vendorRefOrInHouse(vendor)).external_ref
          : (current.vendor_external_ref ?? (unitCostMinor !== undefined ? (await vendorRefOrInHouse(null)).external_ref : null));
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
            `${resolvedCommissionPct ?? ""}:${JSON.stringify(resolvedItemOptionExternalRefs)}:` +
            `${JSON.stringify(variationOptionValueRefs)}`,
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
            itemOptionRefs: resolvedItemOptionExternalRefs,
            variationOptionValueRefs,
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
