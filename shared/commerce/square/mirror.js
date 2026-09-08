/*
 * The mirror: normalised Square facts -> our stores.
 *
 * ADR-009: "We still hold a full mirror. Square's catalog and stock are
 * mirrored into our stores on webhook and on a nightly reconcile. If Square
 * goes away we keep the data; we lose the till."
 *
 * This module is the only one in the adapter that touches a database, and the
 * only one that may. catalog.js and inventory.js are pure, so a sync is
 * replayable from a stored payload; the moment normalising could write, that
 * property is gone.
 *
 * TWO STORES, NO TRANSACTION ACROSS THEM
 *
 *   catalog_mirror (schema.sql)   products, variants, images, categories,
 *                                 and the receipt for every inventory change
 *                                 we have ingested.
 *   commerce (shared/db/commerce.sql)  `inventory_adjustment` — the actual
 *                                 stock ledger, with `inventory_level` derived
 *                                 as a VIEW over it.
 *
 * ADR-002 forbids a transaction across two stores, so the rule is "idempotent
 * and retryable, not atomic". That is not a caveat here, it is the design:
 *
 *   * Catalog rows key on `external_ref UNIQUE` and upsert, so a re-run
 *     updates rather than inserting.
 *   * `inventory_adjustment.id` is DERIVED from the Square change id (a v5
 *     uuid — see ids.js) and inserted with `INSERT OR IGNORE`, so re-applying
 *     the same Square change is a no-op no matter how many times it arrives.
 *   * The commerce write happens BEFORE the mirror receipt. A crash between
 *     them leaves a ledger row and no receipt; the retry re-derives the same
 *     uuid, the OR IGNORE absorbs it, and the receipt lands. The reverse order
 *     would let a crash lose the ledger row permanently.
 *
 * That is what "re-running a sync must not duplicate rows or double-count
 * stock" reduces to, and the tests assert exactly those two.
 *
 * IDS
 *
 * Our uuids are the primary keys. Square's id lives in `external_ref` and
 * nowhere else — not in `inventory_adjustment`, not in `location_id`, not in an
 * options blob. `location_id` on a ledger row is OUR location uuid; Square's
 * location id is configuration held by the client and never written to a row
 * (ADR-009 anti-pattern: "Square ids as our primary keys").
 *
 * NOTHING IS DELETED
 *
 * A product withdrawn in Square gets `archived_at` and keeps its row, its id
 * and its history (ADR-008 / Test-PRD-P0-36-working_set_index). schema.sql
 * refuses DELETE by trigger so that is a property of the database rather than
 * of this file remembering.
 */
import { newId, derivedId, handleFrom, NS_SQUARE_INVENTORY_CHANGE } from "./ids.js";
import { toStorableMinor } from "./money.js";

/* The actor recorded on a machine-driven ledger write. `actor` in
   inventory_adjustment is "Access identity, never a tool argument"; a nightly
   reconcile has no human, so it gets a system identity that is obviously not a
   person rather than borrowing whoever triggered the deploy. */
export const SYNC_ACTOR = "system:square-sync";

const REASONS = new Set([
  "count", "receipt", "sale", "return", "damage", "theft", "correction", "transfer",
]);

/**
 * @param mirror   D1 binding for the catalog_mirror store (schema.sql)
 * @param opts.commerce  D1 binding for the commerce store
 * @param opts.locationId  OUR location uuid (never Square's)
 * @param opts.audit  optional async hook, see recordIntent below
 */
export function createMirror(mirror, { commerce, locationId, audit = null, now = () => new Date().toISOString() } = {}) {
  if (!mirror?.prepare) {
    console.error("ERROR square/mirror: no catalog_mirror binding — refusing to sync");
    throw new Error("catalog_mirror binding missing");
  }

  const all = async (sql, ...args) => (await mirror.prepare(sql).bind(...args).all()).results ?? [];
  const first = (sql, ...args) => mirror.prepare(sql).bind(...args).first();
  const run = (sql, ...args) => mirror.prepare(sql).bind(...args).run();

  /*
   * The audit seam.
   *
   * RULES.md: "Every write goes through the existing audit path where one
   * applies." The audit writer lives in ops/src/tools/audit.js and belongs to
   * the ops Worker; `shared/` is the core that ops depends on, so importing it
   * here would invert that. Instead ops passes `writeAudit` in, and this module
   * calls it with the same intent-then-outcome pair audit.js documents.
   *
   * Where one applies: a webhook-driven mirror sync is a machine reacting to
   * the till, not an agent action, so the default is no hook and no row — the
   * audit log is a record of who did what, and filling it with "the cron ran"
   * makes the rows that matter harder to find. An agent-initiated reconcile
   * passes a hook and gets audited like any other action.
   *
   * If a hook IS supplied and it throws, this fails closed exactly as audit.js
   * does: nothing runs. Degrade to refusal, never to an unlogged write.
   */
  async function audited(action, detail, body) {
    if (typeof audit !== "function") return body();

    let intentId;
    try {
      intentId = await audit({ phase: "intent", action, detail });
    } catch (err) {
      console.error(`ERROR square/mirror: audit refused ${action} — nothing ran (${err.message})`);
      throw err;
    }
    try {
      const result = await body();
      await audit({ phase: "ok", action, detail, result, reverses: intentId });
      return result;
    } catch (err) {
      try {
        await audit({ phase: "error", action, detail, reverses: intentId, error: err.message });
      } catch (auditErr) {
        console.error(
          `ERROR square/mirror: could not audit the failure of ${action} — ${auditErr.message}`,
        );
      }
      throw err;
    }
  }

  /* ── handles ──────────────────────────────────────────────────────────
   *
   * A handle is a public URL and must survive a title being retyped at the
   * counter (Test-PRD-P0-26-owned_storefront: "keeps our handles as stable URLs
   * across a provider switch"). So it is chosen ONCE, on first sight, and the
   * upsert below never writes it again.
   */
  async function freeHandle(proposed, externalRef) {
    let candidate = proposed || handleFrom("", externalRef);
    for (let n = 2; n < 50; n += 1) {
      const clash = await first(
        "SELECT external_ref FROM mirror_product WHERE handle = ?",
        candidate,
      );
      if (!clash || clash.external_ref === externalRef) return candidate;
      candidate = `${proposed}-${n}`;
    }
    /* 48 products competing for one slug is not a real catalog; it is a bug
       upstream. Fall back to something unique rather than looping. */
    console.warn(`WARNING square/mirror: handle "${proposed}" exhausted; falling back to an id-derived handle`);
    return handleFrom("", externalRef);
  }

  /* ── catalog ─────────────────────────────────────────────────────────── */

  /**
   * Write a normalised catalog (from catalog.js) into the mirror.
   *
   * @param full  true for a complete ListCatalog sweep, where anything we hold
   *              and Square did not return has been withdrawn. On an
   *              INCREMENTAL sync this must stay false: absence from a
   *              begin_time search means "unchanged", and archiving on it would
   *              retire the whole shop on the first quiet night.
   */
  async function syncCatalog({ products = [], categories = [] }, { full = false } = {}) {
    return audited("square.catalog.sync", { products: products.length, full }, async () => {
      const stamp = now();
      const counts = {
        categoriesUpserted: 0,
        productsInserted: 0,
        productsUpdated: 0,
        variantsInserted: 0,
        variantsUpdated: 0,
        imagesUpserted: 0,
        archived: 0,
      };

      const categoryIdByRef = new Map();
      for (const cat of categories) {
        const id = newId();
        await run(
          `INSERT INTO mirror_category (id, external_ref, name, archived_at, synced_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(external_ref) DO UPDATE SET
             name = excluded.name,
             archived_at = excluded.archived_at,
             synced_at = excluded.synced_at`,
          id, cat.externalRef, cat.name ?? "", cat.withdrawn ? stamp : null, stamp,
        );
        counts.categoriesUpserted += 1;
        const row = await first("SELECT id FROM mirror_category WHERE external_ref = ?", cat.externalRef);
        if (row) categoryIdByRef.set(cat.externalRef, row.id);
      }

      const seenProducts = new Set();
      const seenVariants = new Set();

      for (const p of products) {
        seenProducts.add(p.externalRef);
        const existing = await first(
          "SELECT id, handle FROM mirror_product WHERE external_ref = ?",
          p.externalRef,
        );
        const archivedAt = p.withdrawn ? stamp : null;
        const status = p.withdrawn ? "archived" : (p.status ?? "active");
        let categoryId = null;
        if (p.categoryExternalRef) {
          categoryId =
            categoryIdByRef.get(p.categoryExternalRef) ??
            (await first("SELECT id FROM mirror_category WHERE external_ref = ?", p.categoryExternalRef))?.id ??
            null;
        }

        let productId;
        if (existing) {
          productId = existing.id;
          /* handle is deliberately absent from this SET. */
          await run(
            `UPDATE mirror_product
                SET title = ?, source_description = ?, status = ?, category_id = ?,
                    source_version = ?, archived_at = ?, synced_at = ?
              WHERE id = ?`,
            p.title ?? "", p.sourceDescription ?? "", status, categoryId,
            Number(p.sourceVersion ?? 0), archivedAt, stamp, productId,
          );
          counts.productsUpdated += 1;
        } else {
          productId = newId();
          const handle = await freeHandle(p.handle, p.externalRef);
          await run(
            `INSERT INTO mirror_product
               (id, external_ref, handle, title, source_description, status,
                category_id, source_version, archived_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            productId, p.externalRef, handle, p.title ?? "", p.sourceDescription ?? "",
            status, categoryId, Number(p.sourceVersion ?? 0), archivedAt, stamp,
          );
          counts.productsInserted += 1;
        }
        if (archivedAt) counts.archived += 1;

        for (const v of p.variants ?? []) {
          seenVariants.add(v.externalRef);
          const vArchived = v.withdrawn || p.withdrawn ? stamp : null;
          /* toStorableMinor asserts the bigint fits a D1 INTEGER bind; a float
             never reaches here because money.js refused it upstream. */
          const priceMinor = toStorableMinor(v.price?.amountMinor ?? 0n, `variant ${v.externalRef}`);
          const existingVariant = await first(
            "SELECT id FROM mirror_variant WHERE external_ref = ?",
            v.externalRef,
          );
          if (existingVariant) {
            await run(
              `UPDATE mirror_variant
                  SET product_id = ?, sku = ?, title = ?, ordinal = ?, price_minor = ?,
                      currency = ?, options = ?, tracks_stock = ?, source_version = ?,
                      archived_at = ?, synced_at = ?
                WHERE id = ?`,
              productId, v.sku ?? null, v.title ?? "", Number(v.ordinal ?? 0), priceMinor,
              v.price?.currency ?? "USD", JSON.stringify(v.options ?? {}),
              v.tracksStock ? 1 : 0, Number(v.sourceVersion ?? 0), vArchived, stamp,
              existingVariant.id,
            );
            counts.variantsUpdated += 1;
          } else {
            await run(
              `INSERT INTO mirror_variant
                 (id, external_ref, product_id, sku, title, ordinal, price_minor,
                  currency, options, tracks_stock, source_version, archived_at, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              newId(), v.externalRef, productId, v.sku ?? null, v.title ?? "",
              Number(v.ordinal ?? 0), priceMinor, v.price?.currency ?? "USD",
              JSON.stringify(v.options ?? {}), v.tracksStock ? 1 : 0,
              Number(v.sourceVersion ?? 0), vArchived, stamp,
            );
            counts.variantsInserted += 1;
          }
        }

        for (const m of p.media ?? []) {
          await run(
            `INSERT INTO mirror_image
               (id, external_ref, product_id, source_url, caption, ordinal, archived_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(external_ref) DO UPDATE SET
               product_id = excluded.product_id,
               source_url = excluded.source_url,
               caption    = excluded.caption,
               ordinal    = excluded.ordinal,
               archived_at = excluded.archived_at,
               synced_at  = excluded.synced_at`,
            newId(), m.externalRef, productId, m.sourceUrl ?? "", m.caption ?? "",
            Number(m.ordinal ?? 0), m.withdrawn || p.withdrawn ? stamp : null, stamp,
          );
          counts.imagesUpserted += 1;
        }
      }

      /*
       * A full sweep is the only thing that can tell "withdrawn" from "not in
       * this page". Archived, never deleted — the DELETE trigger in schema.sql
       * would refuse anything else.
       */
      if (full) {
        for (const row of await all("SELECT id, external_ref FROM mirror_product_index")) {
          if (seenProducts.has(row.external_ref)) continue;
          await run(
            "UPDATE mirror_product SET archived_at = ?, status = 'archived', synced_at = ? WHERE id = ?",
            stamp, stamp, row.id,
          );
          await run(
            "UPDATE mirror_variant SET archived_at = ?, synced_at = ? WHERE product_id = ? AND archived_at IS NULL",
            stamp, stamp, row.id,
          );
          counts.archived += 1;
        }
        /* A variation deleted from an item that itself survives: the item came
           back in the sweep, this variation did not. Same rule, one level down. */
        for (const row of await all("SELECT id, external_ref FROM mirror_variant_index")) {
          if (seenVariants.has(row.external_ref)) continue;
          await run(
            "UPDATE mirror_variant SET archived_at = ?, synced_at = ? WHERE id = ?",
            stamp, stamp, row.id,
          );
        }
      }

      return counts;
    });
  }

  /* ── inventory ───────────────────────────────────────────────────────── */

  function requireCommerce() {
    if (!commerce?.prepare) {
      console.error("ERROR square/mirror: no COMMERCE binding — refusing to write the stock ledger");
      throw new Error("commerce binding missing");
    }
    if (!locationId) {
      console.error("ERROR square/mirror: no location id — a ledger row cannot be written without one");
      throw new Error("locationId missing");
    }
  }

  /** Our current derived on-hand for a sku, from the inventory_level VIEW. */
  async function onHand(sku) {
    const row = await commerce
      .prepare("SELECT on_hand FROM inventory_level WHERE sku = ? AND location_id = ?")
      .bind(sku, locationId)
      .first();
    return Number(row?.on_hand ?? 0);
  }

  async function skuForVariant(externalRef) {
    const row = await first(
      "SELECT id, sku FROM mirror_variant WHERE external_ref = ?",
      externalRef,
    );
    return row ?? null;
  }

  /**
   * Normalised Square inventory changes (from inventory.js) -> ledger rows.
   *
   * Idempotency lives in two places and both are load-bearing; see the header.
   */
  async function syncInventoryChanges(changes) {
    requireCommerce();
    return audited("square.inventory.sync", { changes: changes.length }, async () => {
      const stamp = now();
      const result = { applied: 0, duplicates: 0, skipped: 0 };

      for (const change of changes ?? []) {
        if (!change?.externalRef) {
          result.skipped += 1;
          continue;
        }

        const variant = await skuForVariant(change.variantExternalRef);
        if (!variant?.sku) {
          /* A stock movement for something we have never mirrored, or a
             variation with no SKU. Either way the ledger key does not exist, so
             inventing one would attach real stock to a made-up product. */
          console.error(
            `ERROR square/mirror: inventory change ${change.externalRef} references an unmirrored or SKU-less variation — skipped, sync the catalog first`,
          );
          result.skipped += 1;
          continue;
        }

        /*
         * PHYSICAL_COUNT is absolute; our ledger is deltas. This is the one
         * genuine arithmetic translation between the two models (inventory.js
         * header, point 1), and it is done HERE because it needs a read of our
         * own derived count.
         */
        let delta = change.delta;
        if (change.kind === "PHYSICAL_COUNT") {
          delta = change.quantity - (await onHand(variant.sku));
        }
        if (!Number.isInteger(delta) || delta === 0) {
          /* `CHECK (delta <> 0)`: a count that agrees with us is not an event.
             Skipping it is also what makes a re-run of a reconcile a no-op. */
          result.skipped += 1;
          continue;
        }

        const reason = REASONS.has(change.reason) ? change.reason : "correction";
        /* The SAME Square change always derives the SAME uuid. */
        const adjustmentId = derivedId(NS_SQUARE_INVENTORY_CHANGE, change.externalRef);
        const occurredAt = change.occurredAt ?? stamp;

        /*
         * Commerce first, receipt second. A crash in between is recovered by
         * the retry: the derived id collides, OR IGNORE absorbs it, and the
         * receipt lands. The other order would lose the ledger row for good.
         */
        const wrote = await commerce
          .prepare(
            `INSERT OR IGNORE INTO inventory_adjustment
               (id, sku, location_id, delta, reason, note, actor, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            adjustmentId, variant.sku, locationId, delta, reason,
            `square ${change.kind.toLowerCase()}`, SYNC_ACTOR, occurredAt,
          )
          .run();

        const inserted = Number(wrote?.meta?.changes ?? 0) > 0;

        await run(
          `INSERT INTO mirror_inventory_change
             (id, external_ref, variant_id, sku, delta, reason, kind, adjustment_id, occurred_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(external_ref) DO NOTHING`,
          newId(), change.externalRef, variant.id, variant.sku, delta, reason,
          change.kind, adjustmentId, occurredAt, stamp,
        );

        if (inserted) result.applied += 1;
        else result.duplicates += 1;
      }

      return result;
    });
  }

  /**
   * The nightly reconcile: Square's computed counts vs our derived ledger.
   *
   * Any difference becomes a CORRECTING adjustment with reason 'count', so the
   * divergence and its correction both stay on the record (ADR-008: "the undo
   * for a mistake is an equal and opposite adjustment"). Nothing overwrites a
   * number, because there is no number to overwrite — `inventory_level` is a
   * VIEW (Test-PRD-P0-31-inventory_ledger).
   *
   * Idempotent because it is self-cancelling: once corrected, the next run
   * finds a delta of zero and writes nothing.
   */
  async function reconcileCounts(counts, { note = "square reconcile" } = {}) {
    requireCommerce();
    return audited("square.inventory.reconcile", { counts: counts.length }, async () => {
      const stamp = now();
      const result = { corrected: 0, inAgreement: 0, skipped: 0 };

      for (const c of counts ?? []) {
        const variant = await skuForVariant(c.variantExternalRef);
        if (!variant?.sku) {
          console.error(
            `ERROR square/mirror: reconcile saw an unmirrored variation ${c.variantExternalRef} — skipped`,
          );
          result.skipped += 1;
          continue;
        }
        const delta = c.onHand - (await onHand(variant.sku));
        if (delta === 0) {
          result.inAgreement += 1;
          continue;
        }
        /* Keyed on the sku and the calculated_at, so re-running the SAME
           reconcile snapshot does not stack corrections. */
        const id = derivedId(
          NS_SQUARE_INVENTORY_CHANGE,
          `reconcile:${variant.sku}:${c.calculatedAt ?? stamp}`,
        );
        await commerce
          .prepare(
            `INSERT OR IGNORE INTO inventory_adjustment
               (id, sku, location_id, delta, reason, note, actor, created_at)
             VALUES (?, ?, ?, ?, 'count', ?, ?, ?)`,
          )
          .bind(id, variant.sku, locationId, delta, note, SYNC_ACTOR, c.calculatedAt ?? stamp)
          .run();
        result.corrected += 1;
      }
      return result;
    });
  }

  /* ── reads: what the storefront uses instead of calling Square ────────── */

  const productIndex = () =>
    all("SELECT * FROM mirror_product_index ORDER BY title");

  const productByHandle = (handle) =>
    first("SELECT * FROM mirror_product_index WHERE handle = ?", handle);

  const variantsFor = (productId) =>
    all("SELECT * FROM mirror_variant_index WHERE product_id = ? ORDER BY ordinal", productId);

  /** Archived rows stay queryable by an explicit call (ADR-008). */
  const archivedProducts = () =>
    all("SELECT * FROM mirror_product WHERE archived_at IS NOT NULL ORDER BY archived_at DESC");

  /**
   * OUR variant uuids -> the Square variation refs checkout needs.
   *
   * This is the ONLY direction that translation happens on the public path, and
   * it is why `createCheckoutUrl` can take our ids: nothing above the adapter
   * ever holds a Square identifier.
   */
  async function resolveVariantRefs(ourIds) {
    const out = [];
    for (const id of ourIds ?? []) {
      const row = await first(
        "SELECT id, external_ref, sku FROM mirror_variant_index WHERE id = ?",
        id,
      );
      if (!row) {
        console.error(`ERROR square/mirror: no mirrored variant ${id} — cannot build a checkout line`);
        throw new Error(`unknown variant ${id}`);
      }
      out.push(row);
    }
    return out;
  }

  const syncState = (id) => first("SELECT * FROM mirror_sync WHERE id = ?", id);

  const recordSync = (id, { cursor = null, ok = true, note = "" } = {}) =>
    run(
      `INSERT INTO mirror_sync (id, cursor, ran_at, ok, note) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, ran_at = excluded.ran_at,
                                     ok = excluded.ok, note = excluded.note`,
      id, cursor, now(), ok ? 1 : 0, note,
    );

  return {
    syncCatalog,
    syncInventoryChanges,
    reconcileCounts,
    productIndex,
    productByHandle,
    variantsFor,
    archivedProducts,
    resolveVariantRefs,
    syncState,
    recordSync,
    onHand,
  };
}
