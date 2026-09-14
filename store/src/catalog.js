/*
 * What the shop is selling, and where that came from.
 *
 * Test-PRD-P0-37-mirror_is_ours, Test-PRD-P0-49-mirror_or_seed.
 *
 * ─── THE MIRROR, NEVER THE PROVIDER ────────────────────────────────────────
 *
 * ADR-009's anti-patterns table: "storefront reading Square live per request —
 * provider outage takes the shop down; rate limits. Correct: read the mirror;
 * Square only to mint checkout." So this module reads D1 and holds no HTTP
 * client, no token and no Square identifier. There is nothing here that COULD
 * call a provider; that is the point, and Test-PRD-P0-26-owned_storefront's
 * "zero calls to a commerce provider" is a property of the import list.
 *
 * ─── AND THE SEED WHEN THE MIRROR IS EMPTY ─────────────────────────────────
 *
 * A sync that has not run yet, or that failed, must not blank the shop. An
 * empty grid is not a smaller catalog, it reads as a broken site — and it is a
 * worse outcome than a stale one, because stale still sells. So an empty mirror
 * falls back to shared/seed/catalog.js and SAYS SO at INFO, once per render, on
 * both paths: "which one served" is the first question anyone debugging this
 * asks, and it should be answerable from the log rather than by guessing from
 * the product names.
 *
 * It is also what keeps `wrangler dev --local` a working shop with no Square
 * account, no token and no local database — which is how this file gets
 * exercised at all before there is a real mirror to read.
 *
 * ─── WHAT THE MIRROR DOES NOT HOLD ─────────────────────────────────────────
 *
 * `brand` and `eyebrow` are not Square's to give: schema.sql mirrors Square's
 * ITEM, and Square's item has neither. They are left EMPTY on a mirrored
 * product rather than derived from something adjacent — a brand guessed from
 * the first word of a title would be wrong in public, on the card, under the
 * price. `brandsOf()` drops empties, so the brand filter simply does not appear
 * until brands exist; that is honest, where a filter full of blanks is not.
 * Editorial copy is Git's half of ADR-009's split and arrives with the
 * editorial layer, keyed by handle.
 *
 * `tone` (the placeholder shot's one parameter) IS derived, from the handle,
 * because it is not a fact about the product — it is a deterministic pixel
 * seed, and a product with no picture at all would render an empty card.
 */
import { products as seedProducts } from "../../shared/seed/catalog.js";

/*
 * Where a mirrored photograph actually lives, once the backfill job
 * (ops/src/media-backfill.js) has fetched it off Square's CDN and
 * `.put()` it into OUR bucket under OUR key. This is a Cloudflare R2 bucket
 * with its own public custom domain — the bytes are served by Cloudflare's
 * edge directly, so this file still makes no outbound request and the
 * storefront Worker still binds nothing but CATALOG_MIRROR (Test-PRD-P0-24-
 * binding_scoped_tools): building this URL is string concatenation over a
 * fact already sitting in the mirror row, not a fetch.
 *
 * A subdomain of vemians.com on purpose (Test-PRD-P0-28-image_contract: "no
 * external URL in anything that fetches" — this must read as OURS, not as a
 * third party's CDN, to the same check that would refuse a Square or R2.dev
 * URL here).
 */
const MEDIA_BASE_URL = "https://media.vemians.com";

/*
 * The read. One statement, the INDEX VIEWS rather than the base tables
 * (ADR-008 / Test-PRD-P0-36-working_set_index), so an archived product is
 * absent from the shop without anything here knowing what "archived" means.
 *
 * The price is the LOWEST-ORDINAL variation, which is how "from" pricing works
 * on a card that shows one number for a garment with five sizes. Ordering by
 * title keeps the default grid stable between renders; `sort` then reorders it.
 *
 * `image0`/`image1` are the R2 keys for the product's first two synced
 * photographs (Test-PRD-P0-73-real_photography), NULL until the backfill job
 * has fetched them — `fromMirror` falls back to the placeholder shot per
 * missing slot, exactly as it always has for a product with no photography
 * mirrored at all.
 */
const MIRROR_SQL = `
  SELECT p.handle                                    AS handle,
         p.title                                     AS name,
         COALESCE(c.name, '')                        AS category,
         (SELECT v.price_minor FROM mirror_variant_index v
           WHERE v.product_id = p.id ORDER BY v.ordinal, v.id LIMIT 1) AS minor,
         (SELECT v.currency FROM mirror_variant_index v
           WHERE v.product_id = p.id ORDER BY v.ordinal, v.id LIMIT 1) AS currency,
         (SELECT i.media_key FROM mirror_image_index i
           WHERE i.product_id = p.id AND i.ordinal = 0 LIMIT 1) AS image0,
         (SELECT i.media_key FROM mirror_image_index i
           WHERE i.product_id = p.id AND i.ordinal = 1 LIMIT 1) AS image1
    FROM mirror_product_index p
    LEFT JOIN mirror_category_index c ON c.id = p.category_id
   WHERE p.status = 'active' AND p.channel = 'website'
   ORDER BY p.title`;

/*
 * One product, read by handle rather than filtered from the grid's own list —
 * `direct_link` belongs at its own URL without ever appearing in `MIRROR_SQL`'s
 * results, which is the entire point of that channel (Test-PRD-P0-71-product_
 * channel). No channel filter here at all: every product in the mirror has a
 * working page by construction (the owner's own words: "if it's on here, it's
 * all accessible through a direct link"); `channel` only ever decides whether
 * MIRROR_SQL's own grid ALSO lists it.
 */
const PRODUCT_SQL = `
  SELECT p.handle                                    AS handle,
         p.title                                     AS name,
         p.source_description                        AS description,
         COALESCE(c.name, '')                        AS category,
         (SELECT v.price_minor FROM mirror_variant_index v
           WHERE v.product_id = p.id ORDER BY v.ordinal, v.id LIMIT 1) AS minor,
         (SELECT v.currency FROM mirror_variant_index v
           WHERE v.product_id = p.id ORDER BY v.ordinal, v.id LIMIT 1) AS currency,
         (SELECT i.media_key FROM mirror_image_index i
           WHERE i.product_id = p.id AND i.ordinal = 0 LIMIT 1) AS image0,
         (SELECT i.media_key FROM mirror_image_index i
           WHERE i.product_id = p.id AND i.ordinal = 1 LIMIT 1) AS image1
    FROM mirror_product_index p
    LEFT JOIN mirror_category_index c ON c.id = p.category_id
   WHERE p.status = 'active' AND p.handle = ?`;

/*
 * A deterministic 0.00–0.24, the range the seed's hand-picked tones sit in.
 * FNV-1a because it needs to be stable across isolates and deployments, not
 * because it needs to be good: the same handle must produce the same shot
 * forever, or the picture changes under a visitor on a reload.
 */
export function toneFor(handle) {
  let h = 0x811c9dc5;
  for (let i = 0; i < handle.length; i += 1) {
    h ^= handle.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 25) / 100;
}

/* A mirror row -> the shape views.js and query.js already render.
   `photos` is a fixed two-slot array, index-aligned with the shot variant
   (0 = primary, 1 = the hover alt) — NOT `.filter(Boolean)`, which would
   shift a lone ordinal-1 photo into slot 0. A slot is `null` until the
   backfill job has mirrored that photograph; `shotUrl` (views.js) is what
   turns a null slot into the placeholder. */
function fromMirror(row) {
  return {
    handle: row.handle,
    brand: "",
    name: row.name,
    minor: Number(row.minor),
    currency: row.currency,
    category: row.category || null,
    eyebrow: "",
    tone: toneFor(row.handle),
    photos: [row.image0 ? `${MEDIA_BASE_URL}/${row.image0}` : null, row.image1 ? `${MEDIA_BASE_URL}/${row.image1}` : null],
  };
}

/* The grid's shape, plus the one field only a product's own page needs. */
function fromMirrorDetail(row) {
  return { ...fromMirror(row), description: row.description || "" };
}

/**
 * The catalog this request renders, and which source it came from.
 *
 * Never throws. A storefront that 500s because a database was slow is a worse
 * failure than one that serves the seed, and every path out of here logs what
 * it did at the level RULES.md §14 asks for: INFO for which source served,
 * WARNING for a mirror that is bound but not yet migrated (the expected state
 * of a fresh local dev), ERROR for a read that failed for any other reason —
 * that one is a service-boundary failure and is not swallowed.
 *
 * @param env  the Worker env; reads CATALOG_MIRROR and nothing else.
 * @returns {Promise<{source: "mirror"|"seed", products: object[]}>}
 */
export async function loadCatalog(env) {
  const seed = () => ({ source: "seed", products: seedProducts });

  const db = env?.CATALOG_MIRROR;
  if (!db?.prepare) {
    console.info(
      `INFO store: no CATALOG_MIRROR binding — serving ${seedProducts.length} products from the seed catalog`,
    );
    return seed();
  }

  let rows;
  try {
    rows = (await db.prepare(MIRROR_SQL).all())?.results ?? [];
  } catch (err) {
    /* The one benign case, and it is the common one on a fresh machine: the
       binding exists, the database is empty of SCHEMA, `npm run db:local` has
       not been run. Not an incident, so not an ERROR — but not silent either. */
    if (/no such table|no such view/i.test(err?.message ?? "")) {
      console.warn(
        "WARNING store: CATALOG_MIRROR has no schema yet — run `npm run db:local` in store/, serving the seed catalog",
      );
    } else {
      console.error(`ERROR store: reading the catalog mirror failed — ${err.message}`);
    }
    console.info(
      `INFO store: serving ${seedProducts.length} products from the seed catalog (mirror unreadable)`,
    );
    return seed();
  }

  /* A variation-less item cannot be priced and therefore cannot be sold; it is
     dropped from the grid rather than rendered at zero. Said out loud, because
     a product missing from the shop with no explanation is how an hour goes. */
  const priced = rows.filter((r) => r.minor !== null && r.minor !== undefined && r.currency);
  if (priced.length !== rows.length) {
    console.warn(
      `WARNING store: ${rows.length - priced.length} mirrored product(s) have no priced variation and are not shown`,
    );
  }

  if (priced.length === 0) {
    console.info(
      `INFO store: catalog mirror holds no sellable products — serving ${seedProducts.length} from the seed catalog`,
    );
    return seed();
  }

  console.info(`INFO store: serving ${priced.length} products from the catalog mirror`);
  return { source: "mirror", products: priced.map(fromMirror) };
}

/**
 * One product's own page, by handle. `website` and `direct_link` both
 * resolve here — a direct link is still a real, open URL, just one this
 * function's caller (loadCatalog's grid) never lists.
 *
 * Falls back to the seed catalog under the same "mirror not ready" cases
 * loadCatalog treats as seed-served, so a fresh `wrangler dev --local` can
 * open a seeded product's page with no Square account at all. A handle that
 * is simply wrong is an honest 404 — the seed fallback only fires when the
 * mirror itself holds nothing yet.
 *
 * @returns {Promise<{source: "mirror"|"seed", product: object}|null>} null means 404.
 */
export async function loadProduct(env, handle) {
  const seeded = () => seedProducts.find((p) => p.handle === handle) ?? null;

  const db = env?.CATALOG_MIRROR;
  if (!db?.prepare) {
    const product = seeded();
    return product ? { source: "seed", product } : null;
  }

  let row;
  try {
    row = await db.prepare(PRODUCT_SQL).bind(handle).first();
  } catch (err) {
    if (/no such table|no such view/i.test(err?.message ?? "")) {
      console.warn(
        "WARNING store: CATALOG_MIRROR has no schema yet — run `npm run db:local` in store/, serving the seed catalog",
      );
    } else {
      console.error(`ERROR store: reading a product from the catalog mirror failed — ${err.message}`);
    }
    const product = seeded();
    return product ? { source: "seed", product } : null;
  }

  if (row && row.minor !== null && row.minor !== undefined && row.currency) {
    return { source: "mirror", product: fromMirrorDetail(row) };
  }

  /* No visible, priced product at that handle in the mirror — could be a
     genuinely unknown handle, an unpriced/unsynced variation, or a mirror
     that has not synced anything at all yet. Only the last of those falls
     back to the seed; the other two are an honest 404. */
  const product = seeded();
  if (!product) return null;
  const anySynced = await db.prepare("SELECT 1 FROM mirror_product_index LIMIT 1").first();
  return anySynced ? null : { source: "seed", product };
}
