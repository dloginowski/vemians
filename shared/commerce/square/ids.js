/*
 * Identifiers.
 *
 * ADR-009, anti-patterns table: "Square ids as our primary keys — reinstates
 * exactly the lock-in this design avoids. Our uuids, Square id in
 * `external_ref`." So every row this adapter writes gets a uuid of ours, and
 * the Square id it came from goes in `external_ref` and nowhere else.
 *
 * TWO KINDS OF UUID, FOR TWO DIFFERENT REASONS
 *
 * `newId()` — a random v4. Used wherever the row has an `external_ref` column,
 * because that column's UNIQUE constraint is what makes a re-sync idempotent;
 * the id itself only has to be ours and stable once assigned.
 *
 * `derivedId()` — a deterministic v5 (RFC 4122 §4.3: SHA-1 over a namespace
 * uuid and a name). Used for `inventory_adjustment.id`, which is the one place
 * that needs idempotency in a table with NO external_ref column to key on.
 *
 *   Why no external_ref there: shared/db/commerce.sql holds exactly one
 *   vendor-shaped field, `order.external_id`, and shared/db/verify.py asserts
 *   it (test_PRD_P0_16_commerce_port__external_id_is_the_only_vendor_field_in_the_store).
 *   Adding `inventory_adjustment.external_ref` would break that invariant and
 *   scatter Square ids through the commerce store. So instead the SAME Square
 *   inventory-change id always derives the SAME uuid, and `INSERT OR IGNORE`
 *   makes replaying a sync a no-op. The Square id is never stored in commerce —
 *   it is stored once, in the mirror's `mirror_inventory_change.external_ref`.
 *
 * The derivation is one-way (SHA-1 of a namespace plus the id, truncated to 128
 * bits), so this is not a vendor identifier in disguise: you cannot read a
 * Square id back out of it, and the Exit Test
 * (Test-PRD-P0-29-exit_test) has nothing to strip.
 */
import { createHash, randomUUID } from "node:crypto";

/** A fresh uuid of ours. */
export function newId() {
  return randomUUID();
}

/*
 * Namespace uuids. Fixed constants: changing one changes every derived id and
 * would re-ingest history as new rows, so they are frozen and never generated.
 */
export const NS_SQUARE_INVENTORY_CHANGE = "6b1f2f8a-3f5e-4a1d-9a7c-2f0b4e6d8c11";

const HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function namespaceBytes(namespace) {
  if (!HEX.test(namespace)) throw new Error(`namespace is not a uuid: ${namespace}`);
  return Buffer.from(namespace.replace(/-/g, ""), "hex");
}

/**
 * RFC 4122 version 5 (SHA-1, name-based). Deterministic: same inputs, same uuid,
 * forever and on every isolate.
 */
export function derivedId(namespace, name) {
  const hash = createHash("sha1");
  hash.update(namespaceBytes(namespace));
  hash.update(Buffer.from(String(name), "utf8"));
  const bytes = hash.digest().subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50; /* version 5 */
  bytes[8] = (bytes[8] & 0x3f) | 0x80; /* RFC 4122 variant */

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Square requires an `idempotency_key` on every write so a retried request does
 * not create a second payment link or a second inventory change. A caller that
 * can supply a STABLE key (a cart hash, an order id) should: a random key on a
 * retry defeats the mechanism it is there for.
 */
export function idempotencyKey(seed) {
  return seed === undefined ? newId() : derivedId(NS_SQUARE_INVENTORY_CHANGE, `idem:${seed}`);
}

/*
 * A URL-safe handle from a title, for `mirror_product.handle`.
 *
 * Handles are stable URLs (Test-PRD-P0-26-owned_storefront: "keeps our handles
 * as stable URLs across a provider switch"), so a handle is derived ONCE, on
 * first sight of a product, and never recomputed from a later title. mirror.js
 * enforces that; this function only proposes the first one.
 */
export function handleFrom(title, fallback) {
  const slug = String(title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `item-${String(fallback ?? newId()).slice(0, 12).toLowerCase()}`;
}
