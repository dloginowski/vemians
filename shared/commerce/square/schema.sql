-- D1: catalog_mirror  --  our full copy of Square's authoritative catalog.
--
-- WHY THIS STORE EXISTS
--
-- ADR-009 reverses ADR-001: Square is the system of record for stock and for
-- the commercial facts of the catalog, because a till changes both without
-- asking us. The concession the ADR refuses to make is our copy of the data:
-- "We still hold a full mirror. Square's catalog and stock are mirrored into
-- our stores on webhook and on a nightly reconcile. If Square goes away we keep
-- the data; we lose the till."  This is that mirror.
--
-- It is also what makes the storefront's contract holdable. ADR-009's
-- anti-patterns table forbids "storefront reading Square live per request";
-- Test-PRD-P0-26-owned_storefront requires ZERO calls to a commerce provider
-- except to mint a checkout URL. A read path can only be that if there is
-- something local to read. A Square outage must degrade checkout, not browsing.
--
-- WHY IT IS A SEPARATE STORE FROM `commerce`
--
-- shared/db/commerce.sql holds exactly one vendor-shaped column,
-- `order.external_id`, and shared/db/verify.py asserts that as a hard
-- invariant (Test-PRD-P0-16-commerce_port). Mirroring a vendor catalog into
-- that schema would put `external_ref` on four more tables and break it. Per
-- ADR-002 the boundary rule is blast radius and retention, and this store is
-- both: it is disposable and rebuildable from Square, whereas orders are not.
-- No foreign key and no transaction crosses to `commerce` (ADR-002); the join
-- from a mirrored variation to a stock ledger row is by `sku` plus a snapshot,
-- exactly as every other cross-store reference in this repository.
--
-- WHAT IS OURS AND WHAT IS SQUARE'S
--
--   * Every primary key is OUR uuid. ADR-009 anti-pattern: "Square ids as our
--     primary keys reinstates exactly the lock-in this design avoids."
--   * `external_ref` is the ONLY column that holds a Square identifier, in this
--     store and in every other. It is UNIQUE, which is what makes a re-sync
--     idempotent rather than duplicating.
--   * Editorial copy, ordering and imagery selection are NOT mirrored back from
--     Square (ADR-009 anti-pattern: "editorial copy in Square item
--     descriptions"). Square's description is kept as `source_description` so a
--     reconcile can diff it; presentation stays in Git, keyed by handle.
--
-- NOTHING IS EVER DELETED (ADR-008, Test-PRD-P0-36-working_set_index)
--
-- A product withdrawn in Square is ARCHIVED here — `archived_at` set, row kept,
-- still queryable by explicit call. Deletion is refused by trigger rather than
-- by convention, so the guarantee is a property of the schema and not of the
-- adapter remembering. Each table has an `*_index` view over unarchived rows,
-- and that is what a read returns by default.
--
-- MONEY (Test-PRD-P0-15-money_minor_units)
--
-- Integer minor units plus an explicit currency. No REAL, FLOAT or NUMERIC
-- column exists in this file, and every `*_minor` column is INTEGER NOT NULL.

-- ── categories ─────────────────────────────────────────────────────────────

CREATE TABLE mirror_category (
  id           TEXT PRIMARY KEY,              -- ours
  external_ref TEXT NOT NULL UNIQUE,          -- Square CATEGORY id
  name         TEXT NOT NULL,
  archived_at  TEXT,                          -- rolled off the working set, never deleted
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW mirror_category_index AS
SELECT id, external_ref, name, synced_at
FROM mirror_category WHERE archived_at IS NULL;

-- ── products  (Square ITEM) ────────────────────────────────────────────────

CREATE TABLE mirror_product (
  id                 TEXT PRIMARY KEY,        -- ours
  external_ref       TEXT NOT NULL UNIQUE,    -- Square ITEM id
  -- Derived once, on first sight, and never recomputed from a later title:
  -- a handle is a public URL (Test-PRD-P0-26-owned_storefront) and a title
  -- edited at the counter must not silently 404 the shop.
  handle             TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  source_description TEXT NOT NULL DEFAULT '',-- Square's copy, for reconciliation only
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('draft','active','archived')),
  category_id        TEXT REFERENCES mirror_category(id),
  source_version     INTEGER NOT NULL DEFAULT 0,  -- Square's optimistic-concurrency version
  archived_at        TEXT,
  synced_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_product_active ON mirror_product (archived_at, handle);

CREATE VIEW mirror_product_index AS
SELECT id, external_ref, handle, title, source_description, status,
       category_id, source_version, synced_at
FROM mirror_product WHERE archived_at IS NULL;

-- ── variants  (Square ITEM_VARIATION) ──────────────────────────────────────
--
-- ADR-009: "Square ITEM -> our product, ITEM_VARIATION -> our variant, with
-- stock tracked at the variation level, exactly where we track it."
--
-- `sku` is the join to the stock ledger in the `commerce` store. It is NOT
-- unique here: Square permits a blank or repeated SKU, and refusing to mirror a
-- product because staff left the SKU empty at the counter would make the mirror
-- lie about what is for sale. A variation with no SKU is mirrored and simply
-- carries no stock ledger; mirror.js logs it rather than inventing one.

CREATE TABLE mirror_variant (
  id             TEXT PRIMARY KEY,            -- ours
  external_ref   TEXT NOT NULL UNIQUE,        -- Square ITEM_VARIATION id
  product_id     TEXT NOT NULL REFERENCES mirror_product(id),
  sku            TEXT,
  title          TEXT NOT NULL,
  ordinal        INTEGER NOT NULL DEFAULT 0,
  price_minor    INTEGER NOT NULL DEFAULT 0,  -- integer minor units, never a float
  currency       TEXT NOT NULL,
  options        TEXT NOT NULL DEFAULT '{}',  -- JSON: option name -> value
  tracks_stock   INTEGER NOT NULL DEFAULT 0,  -- Square location_overrides.track_inventory
  source_version INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,
  synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_variant_product ON mirror_variant (product_id, ordinal);
CREATE INDEX idx_mirror_variant_sku ON mirror_variant (sku) WHERE sku IS NOT NULL;

CREATE VIEW mirror_variant_index AS
SELECT id, external_ref, product_id, sku, title, ordinal,
       price_minor, currency, options, tracks_stock, source_version, synced_at
FROM mirror_variant WHERE archived_at IS NULL;

-- ── images  (Square IMAGE) ─────────────────────────────────────────────────
--
-- The URL is Square's CDN. We hold the reference so the mirror is complete;
-- the originals we serve are ours in R2 (Test-PRD-P0-28-image_contract), and
-- `media_key` is where the R2 key lands once the fetch-and-store job runs.

CREATE TABLE mirror_image (
  id           TEXT PRIMARY KEY,
  external_ref TEXT NOT NULL UNIQUE,          -- Square IMAGE id
  product_id   TEXT NOT NULL REFERENCES mirror_product(id),
  source_url   TEXT NOT NULL,
  caption      TEXT NOT NULL DEFAULT '',
  ordinal      INTEGER NOT NULL DEFAULT 0,
  media_key    TEXT,                          -- our R2 key, once mirrored
  archived_at  TEXT,
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_image_product ON mirror_image (product_id, ordinal);

CREATE VIEW mirror_image_index AS
SELECT id, external_ref, product_id, source_url, caption, ordinal, media_key, synced_at
FROM mirror_image WHERE archived_at IS NULL;

-- ── the inventory-change ledger mirror ─────────────────────────────────────
--
-- ADR-009: "Square's inventory model is already a ledger --
-- InventoryPhysicalCount (provided) and InventoryCount (computed), with
-- adjustments between them. That is precisely the design in ADR-008... Our
-- inventory_adjustment table becomes a mirror of Square's changes rather than a
-- competing ledger."
--
-- This table is the RECEIPT for that ingest, and the single place a Square
-- inventory-change id is stored. The stock number itself lives where it always
-- did: `inventory_adjustment` in the `commerce` store, folded up by the
-- `inventory_level` VIEW (Test-PRD-P0-31-inventory_ledger).
--
-- `external_ref` UNIQUE is one of the two idempotency guarantees. The other is
-- that `adjustment_id` is DERIVED from `external_ref` (a v5 uuid, see ids.js),
-- so the commerce-side INSERT OR IGNORE is idempotent on its own. Two are
-- needed because the two stores are different databases and ADR-002 forbids a
-- transaction across them: a crash between the two writes must not double-count
-- on the retry, whichever one landed first.

CREATE TABLE mirror_inventory_change (
  id            TEXT PRIMARY KEY,             -- ours
  external_ref  TEXT NOT NULL UNIQUE,         -- Square inventory-change id
  variant_id    TEXT REFERENCES mirror_variant(id),
  sku           TEXT NOT NULL,                -- snapshot; the commerce store has no FK to follow
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,                -- already in our vocabulary; see inventory.js
  kind          TEXT NOT NULL                 -- Square's own change type, kept verbatim
                  CHECK (kind IN ('PHYSICAL_COUNT','ADJUSTMENT','TRANSFER')),
  adjustment_id TEXT NOT NULL,                -- the commerce inventory_adjustment.id we wrote
  occurred_at   TEXT NOT NULL,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_change_sku ON mirror_inventory_change (sku, occurred_at DESC);

-- ── sync bookkeeping ───────────────────────────────────────────────────────
--
-- Square's catalog webhook (`catalog.version.updated`) says only that SOMETHING
-- changed, never what. So the cursor here is what makes the follow-up a
-- SearchCatalogObjects since a timestamp rather than a full re-list every time.

CREATE TABLE mirror_sync (
  id          TEXT PRIMARY KEY               -- 'catalog' | 'inventory'
                CHECK (id IN ('catalog','inventory')),
  cursor      TEXT,
  ran_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ok          INTEGER NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT ''
);

-- ── nothing is deleted, and the database is what says so ───────────────────
--
-- ADR-008: "Deleting instead of archiving destroys evidence... Nothing
-- deletes; erasure is separate and narrow." A withdrawn product is a marker,
-- not a missing row, and a marker only holds if DELETE is refused rather than
-- merely avoided. Erasure (ADR-004) does not reach this store: it holds no
-- customer data at all.

CREATE TRIGGER mirror_product_no_delete BEFORE DELETE ON mirror_product
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_variant_no_delete BEFORE DELETE ON mirror_variant
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_image_no_delete BEFORE DELETE ON mirror_image
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_category_no_delete BEFORE DELETE ON mirror_category
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

-- The ingest receipt is append-only for the same reason inventory_adjustment
-- is: editing it would let a re-sync double-count, and deleting it would let a
-- re-sync re-apply history that has already been applied.

CREATE TRIGGER mirror_change_append_only_update BEFORE UPDATE ON mirror_inventory_change
BEGIN SELECT RAISE(ABORT, 'inventory ingest receipts are append-only'); END;

CREATE TRIGGER mirror_change_append_only_delete BEFORE DELETE ON mirror_inventory_change
BEGIN SELECT RAISE(ABORT, 'inventory ingest receipts are append-only'); END;
