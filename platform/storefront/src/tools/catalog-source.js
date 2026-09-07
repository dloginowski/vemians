/*
 * The catalog read path, behind one small interface.
 *
 * Test-PRD-P0-02-catalog_git_shards. The catalog is JSON in Git, one shard per
 * product, and search reads a DERIVED index that is never committed. Neither
 * the Git read nor the index build exists yet, so this module ships a seeded
 * index and keeps the boundary narrow enough that the Git-backed source drops
 * in without a tool changing:
 *
 *   search({ q, brand, status, limit })  -> [ indexRecord ]     (index)
 *   get(handle)                          -> shard | null        (shard)
 *   stagePriceChange({...})              -> { staged }          (the PR)
 *   staged()                             -> [ stagedChange ]
 *
 * catalog-skills rule 5: "Search reads the index; writes read the shard."
 * `get` is therefore the only thing a write path may read from, and the index
 * record carries `source: "index"` so a caller cannot pretend otherwise.
 *
 * The Git-backed replacement implements the same four methods over
 * `catalog/products/<handle>.json` plus the build-time index, and
 * `stagePriceChange` becomes "open a pull request against one shard".
 * NOTHING in this module writes: a staged change is an in-memory proposal, and
 * the tool that produces it is T2 precisely because the merge is the action.
 */
import { products as seedProducts } from "../seed.js";

/* One index record per shard, as the build step would derive it. */
function indexFrom(product, i) {
  return {
    handle: product.handle,
    title: product.name,
    brand: product.brand,
    sku: `VEM-${String(i + 1).padStart(4, "0")}`,
    price_minor: product.minor,
    currency: product.currency,
    status: "active",
    tags: [product.eyebrow].filter(Boolean),
  };
}

export function createSeedCatalogSource(products = seedProducts) {
  /* The index: derived here, in memory, never written to disk or to Git. */
  const index = products.map(indexFrom);
  const byHandle = new Map(index.map((r) => [r.handle, r]));
  const stagedChanges = [];

  const match = (rec, q) => {
    if (!q) return true;
    const hay = `${rec.handle} ${rec.title} ${rec.brand} ${rec.tags.join(" ")}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  };

  return {
    kind: "seed",

    async search({ q, brand, status, limit }) {
      const hits = index.filter(
        (r) =>
          match(r, q) &&
          (!brand || r.brand.toLowerCase() === brand.toLowerCase()) &&
          (!status || r.status === status),
      );
      return hits.slice(0, limit).map((r) => ({ ...r, source: "index" }));
    },

    /* The shard. Provenance included, because a write must read from here. */
    async get(handle) {
      const rec = byHandle.get(handle);
      if (!rec) return null;
      return {
        ...rec,
        source: "shard",
        path: `catalog/products/${handle}.json`,
      };
    },

    /*
     * Stage the one-shard change a pull request would carry. Returns the patch;
     * it does not touch the index, because the index is derived and a write that
     * edited it would be writing to a cache (catalog-skills, T3 "index write").
     */
    async stagePriceChange({ handle, from_minor, to_minor, currency, reason, actor, approvalToken }) {
      const staged = {
        id: `stg_${stagedChanges.length + 1}`,
        path: `catalog/products/${handle}.json`,
        branch: `agent/price/${handle}`,
        patch: [
          { op: "replace", field: "price_minor", from: from_minor, to: to_minor },
        ],
        currency,
        reason,
        actor,
        approval: approvalToken ? "in-session" : null,
        staged_at: new Date().toISOString(),
      };
      stagedChanges.push(staged);
      return staged;
    },

    async staged() {
      return stagedChanges.slice();
    },
  };
}
