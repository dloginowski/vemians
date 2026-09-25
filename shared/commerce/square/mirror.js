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
  async function syncCatalog({ products = [], categories = [], itemOptions = [] }, { full = false } = {}) {
    return audited("square.catalog.sync", { products: products.length, full }, async () => {
      const stamp = now();
      const counts = {
        categoriesUpserted: 0,
        itemOptionsUpserted: 0,
        itemOptionValuesUpserted: 0,
        productItemOptionsUpserted: 0,
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
      /* Second pass, only once every category in THIS sync has its own row
         — a child can arrive before its own parent in Square's own list
         order. Falls back to a DB lookup (not just categoryIdByRef, which
         only holds rows touched in THIS call) so an incremental sync of
         just the child alone does not NULL OUT an already-known parent
         link the parent's own earlier sync already recorded. numeric_id is
         deliberately never touched here: it is OURS, not Square's, and
         survives every future re-sync untouched, the same convention
         channel/custom_fields already establish on mirror_product. */
      for (const cat of categories) {
        const parentId = cat.parentExternalRef
          ? (categoryIdByRef.get(cat.parentExternalRef) ??
              (await first("SELECT id FROM mirror_category WHERE external_ref = ?", cat.parentExternalRef))?.id ??
              null)
          : null;
        await run("UPDATE mirror_category SET parent_id = ? WHERE external_ref = ?", parentId, cat.externalRef);
      }

      /* ITEM_OPTION ("Option Sets") — each one's own values arrive already
         embedded (catalog.js's own normaliseCatalog), so there is no
         child-before-parent ordering hazard the categories block above
         needs a second pass for: an option and its whole value list are
         upserted together, in one pass. numeric_id has no equivalent here
         — nothing OURS lives on this table yet, only what Square itself
         reports. */
      for (const opt of itemOptions) {
        const id = newId();
        await run(
          `INSERT INTO mirror_item_option (id, external_ref, name, archived_at, synced_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(external_ref) DO UPDATE SET
             name = excluded.name,
             archived_at = excluded.archived_at,
             synced_at = excluded.synced_at`,
          id, opt.externalRef, opt.name ?? "", opt.withdrawn ? stamp : null, stamp,
        );
        counts.itemOptionsUpserted += 1;
        const itemOptionId = (await first("SELECT id FROM mirror_item_option WHERE external_ref = ?", opt.externalRef))?.id;
        for (const val of opt.values ?? []) {
          const valId = newId();
          await run(
            `INSERT INTO mirror_item_option_value (id, external_ref, item_option_id, name, ordinal, archived_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(external_ref) DO UPDATE SET
               item_option_id = excluded.item_option_id,
               name = excluded.name,
               ordinal = excluded.ordinal,
               archived_at = excluded.archived_at,
               synced_at = excluded.synced_at`,
            valId, val.externalRef, itemOptionId, val.name ?? "", val.ordinal ?? 0, val.withdrawn ? stamp : null, stamp,
          );
          counts.itemOptionValuesUpserted += 1;
        }
      }

      /* Built once, not per-product: every item_option a product might
         declare was already upserted by the block just above, in THIS
         same sync call (item options carry no ordering hazard relative to
         products the way category parents do), so one query up front
         beats one query per product per declared option set. */
      const itemOptionIdByRef = new Map();
      for (const row of await all("SELECT id, external_ref FROM mirror_item_option_index")) {
        itemOptionIdByRef.set(row.external_ref, row.id);
      }

      const seenProducts = new Set();
      const seenVariants = new Set();
      const seenProductItemOptions = new Set();

      for (const p of products) {
        seenProducts.add(p.externalRef);
        const existing = await first(
          "SELECT id, handle FROM mirror_product WHERE external_ref = ?",
          p.externalRef,
        );
        const archivedAt = p.withdrawn ? stamp : null;
        const status = p.withdrawn ? "archived" : (p.status ?? "active");
        /* catalog.js hands us candidates in priority order (reporting_category
           first, then categories[], then the legacy singular category_id) —
           but reporting_category can be stale or orphaned (see catalog.js's
           own comment on categoryExternalRefs), so a candidate that does not
           resolve to a row we actually hold is skipped rather than treated
           as "uncategorized": the next, less-preferred but still-live
           candidate wins instead. */
        let categoryId = null;
        for (const ref of p.categoryExternalRefs ?? []) {
          categoryId =
            categoryIdByRef.get(ref) ??
            (await first("SELECT id FROM mirror_category WHERE external_ref = ?", ref))?.id ??
            null;
          if (categoryId) break;
        }

        let productId;
        if (existing) {
          productId = existing.id;
          /* handle is deliberately absent from this SET — channel and
             custom_fields too, same reason, see schema.sql's own comment.
             style_id/commission_pct/item_unit_cost_minor ARE named here, on
             purpose: unlike those, Square is authoritative for all three
             now, so a re-sync overwrites them the same way it already
             overwrites title. vendor is no longer a product-level column at
             all — see the per-variant vendor_id resolution below. */
          await run(
            `UPDATE mirror_product
                SET title = ?, source_description = ?, status = ?, category_id = ?,
                    style_id = ?, commission_pct = ?, item_unit_cost_minor = ?,
                    source_version = ?, archived_at = ?, synced_at = ?
              WHERE id = ?`,
            p.title ?? "", p.sourceDescription ?? "", status, categoryId,
            p.styleId ?? null, p.commissionPct ?? null, p.itemUnitCostMinor ?? 0,
            Number(p.sourceVersion ?? 0), archivedAt, stamp, productId,
          );
          counts.productsUpdated += 1;
        } else {
          productId = newId();
          const handle = await freeHandle(p.handle, p.externalRef);
          await run(
            `INSERT INTO mirror_product
               (id, external_ref, handle, title, source_description, status,
                category_id, style_id, commission_pct, item_unit_cost_minor, source_version, archived_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            productId, p.externalRef, handle, p.title ?? "", p.sourceDescription ?? "",
            status, categoryId, p.styleId ?? null, p.commissionPct ?? null, p.itemUnitCostMinor ?? 0,
            Number(p.sourceVersion ?? 0), archivedAt, stamp,
          );
          counts.productsInserted += 1;
        }
        if (archivedAt) counts.archived += 1;

        /* The permanent style_id reservation (schema.sql's own comment on
           mirror_style_id_ledger) — recorded here, on every sync, rather
           than only at the moment our own tools set one, so a style_id
           typed directly into Square's own dashboard (bypassing ops
           entirely) still gets reserved the instant it is first seen.
           ON CONFLICT DO NOTHING because the whole point is that a style_id
           already ledgered — even one this SAME product has since moved
           away from — is never touched again. */
        if (p.styleId) {
          await run(
            `INSERT INTO mirror_style_id_ledger (style_id, product_id) VALUES (?, ?)
             ON CONFLICT(style_id) DO NOTHING`,
            p.styleId, productId,
          );
        }

        for (const v of p.variants ?? []) {
          seenVariants.add(v.externalRef);
          const vArchived = v.withdrawn || p.withdrawn ? stamp : null;
          /* toStorableMinor asserts the bigint fits a D1 INTEGER bind; a float
             never reaches here because money.js refused it upstream. */
          const priceMinor = toStorableMinor(v.price?.amountMinor ?? 0n, `variant ${v.externalRef}`);
          /* vendor_information carries Square's own vendor_id, resolved to
             OUR mirror_vendor.id the same way categoryExternalRefs resolves
             to category_id above — a query per variant rather than a
             pre-built map, since vendors sync in their own separate pass
             (syncVendors, called before this one) rather than arriving as
             an argument here the way categories do. Unresolved (a vendor
             Square knows about that our own vendor sync has not seen yet)
             is left null rather than guessed at; the next vendor sync
             catches it up. */
          const vendorId = v.vendorExternalRef
            ? (await first("SELECT id FROM mirror_vendor WHERE external_ref = ?", v.vendorExternalRef))?.id ?? null
            : null;
          const unitCostMinor = toStorableMinor(
            v.unitCost?.amountMinor ?? 0n,
            `variant ${v.externalRef} unit cost`,
          );
          const unitCostCurrency = v.unitCost?.currency ?? "USD";
          const existingVariant = await first(
            "SELECT id FROM mirror_variant WHERE external_ref = ?",
            v.externalRef,
          );
          if (existingVariant) {
            await run(
              `UPDATE mirror_variant
                  SET product_id = ?, sku = ?, title = ?, ordinal = ?, price_minor = ?,
                      currency = ?, options = ?, tracks_stock = ?,
                      vendor_id = ?, vendor_code = ?, unit_cost_minor = ?, unit_cost_currency = ?,
                      source_version = ?, archived_at = ?, synced_at = ?
                WHERE id = ?`,
              productId, v.sku ?? null, v.title ?? "", Number(v.ordinal ?? 0), priceMinor,
              v.price?.currency ?? "USD", JSON.stringify(v.options ?? {}),
              v.tracksStock ? 1 : 0, vendorId, v.vendorCode ?? null, unitCostMinor, unitCostCurrency,
              Number(v.sourceVersion ?? 0), vArchived, stamp,
              existingVariant.id,
            );
            counts.variantsUpdated += 1;
          } else {
            await run(
              `INSERT INTO mirror_variant
                 (id, external_ref, product_id, sku, title, ordinal, price_minor,
                  currency, options, tracks_stock, vendor_id, vendor_code,
                  unit_cost_minor, unit_cost_currency, source_version, archived_at, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              newId(), v.externalRef, productId, v.sku ?? null, v.title ?? "",
              Number(v.ordinal ?? 0), priceMinor, v.price?.currency ?? "USD",
              JSON.stringify(v.options ?? {}), v.tracksStock ? 1 : 0,
              vendorId, v.vendorCode ?? null, unitCostMinor, unitCostCurrency,
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

        /* Which Option Sets this ITEM itself declares — a real Square
           fact (item_data.item_options), so it is mirrored the same way
           variations/media just above are: whatever Square says NOW is
           upserted active; an item_option this product no longer
           declares is caught by the full-sweep archive pass below, the
           same latency variations already accept on an incremental
           sync (mirror.js's own comment on seenVariants has the full
           reasoning). An unresolvable ref (an item_option this shop's
           own item_option sync has not seen yet) is skipped, not
           guessed at — the next item_option sync catches it up, same as
           an unresolved vendor_id above. */
        for (const ref of p.itemOptionExternalRefs ?? []) {
          const itemOptionId = itemOptionIdByRef.get(ref);
          if (!itemOptionId) continue;
          seenProductItemOptions.add(`${productId}:${itemOptionId}`);
          const poArchived = p.withdrawn ? stamp : null;
          await run(
            `INSERT INTO mirror_product_item_option (product_id, item_option_id, archived_at, synced_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(product_id, item_option_id) DO UPDATE SET
               archived_at = excluded.archived_at,
               synced_at = excluded.synced_at`,
            productId, itemOptionId, poArchived, stamp,
          );
          counts.productItemOptionsUpserted += 1;
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
        /* An item_option a product no longer declares: same rule again, one
           more level down — only a full sweep (which reports every option
           set an item CURRENTLY declares) can tell "removed" from "just not
           in this incremental page". */
        for (const row of await all("SELECT product_id, item_option_id FROM mirror_product_item_option_index")) {
          if (seenProductItemOptions.has(`${row.product_id}:${row.item_option_id}`)) continue;
          await run(
            "UPDATE mirror_product_item_option SET archived_at = ?, synced_at = ? WHERE product_id = ? AND item_option_id = ?",
            stamp, stamp, row.product_id, row.item_option_id,
          );
        }
      }

      return counts;
    });
  }

  /*
   * Vendors live at a wholly separate Square API (/v2/vendors/*) from the
   * Catalog API syncCatalog above pulls from, so they get their own sync
   * pass rather than arriving bundled with `products`/`categories` the way
   * categories do. Called BEFORE syncCatalog in the adapter's own
   * pullCatalog, so a variant's vendor_information.vendor_id already has a
   * mirror_vendor row to resolve against by the time syncCatalog runs.
   *
   * No archival pass: Square's Vendors API has no `include_deleted` sweep
   * the way Catalog's does, so there is nothing to diff a full list
   * against. A vendor's own `status` (active/inactive) is mirrored as-is;
   * mirror_vendor.archived_at stays available for the same "archive, never
   * delete" convention every other mirror_* table follows, unused until
   * there is a real signal to set it from.
   */
  async function syncVendors(vendors) {
    return audited("square.vendors.sync", { vendors: vendors.length }, async () => {
      const stamp = now();
      let upserted = 0;
      for (const v of vendors ?? []) {
        if (!v?.externalRef) continue;
        await run(
          `INSERT INTO mirror_vendor (id, external_ref, name, status, synced_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(external_ref) DO UPDATE SET
             name = excluded.name,
             status = excluded.status,
             synced_at = excluded.synced_at`,
          newId(), v.externalRef, v.name ?? "", v.status === "inactive" ? "inactive" : "active", stamp,
        );
        upserted += 1;
      }
      return { upserted };
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

  /* Same lookup, but archived rows too — restoreProduct's own use: a
     withdrawn product is by definition absent from mirror_product_index,
     so finding its external_ref to un-withdraw it needs the base table. */
  const productByHandleAny = (handle) =>
    first("SELECT * FROM mirror_product WHERE handle = ?", handle);

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
    syncVendors,
    syncInventoryChanges,
    reconcileCounts,
    productIndex,
    productByHandle,
    productByHandleAny,
    variantsFor,
    archivedProducts,
    resolveVariantRefs,
    syncState,
    recordSync,
    onHand,
  };
}
