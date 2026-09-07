-- D1: commerce  -- orders and stock.
-- Holds NO customer PII - profiles live in the `customers` store and are
-- referenced by id only, so an erasure there leaves orders intact and
-- anonymous. Cross-domain references are id + snapshot, never a foreign key.

CREATE TABLE "order" (
  id             TEXT PRIMARY KEY,
  order_number   INTEGER UNIQUE,            -- ours, independent of any vendor numbering
  channel        TEXT NOT NULL,             -- 'shopify' | ...
  external_id    TEXT,                      -- vendor order id; the ONLY vendor field
  -- Pseudonymous reference into the `customers` store. NO customer PII may be
  -- stored here: erasing a profile must leave these rows intact but anonymous,
  -- because tax rules require the order to be retained.
  customer_id    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','paid','fulfilled','cancelled','refunded')),
  total_minor    INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL,
  placed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  raw_payload    TEXT                       -- vendor webhook, kept for replay
);
CREATE INDEX idx_order_placed ON "order" (placed_at DESC);
CREATE UNIQUE INDEX idx_order_external ON "order" (channel, external_id)
  WHERE external_id IS NOT NULL;            -- webhook idempotency

CREATE TABLE order_line (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  -- The catalog lives in Git, so there is no FK to follow. Snapshots make the
  -- line permanently readable regardless of what the catalog does later.
  product_handle   TEXT NOT NULL,
  sku_snapshot     TEXT,
  title_snapshot   TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL,
  currency         TEXT NOT NULL
);
CREATE INDEX idx_line_order ON order_line (order_id);

CREATE TABLE location (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE inventory_level (
  sku          TEXT NOT NULL,               -- joins to Git catalog by SKU
  location_id  TEXT NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  on_hand      INTEGER NOT NULL DEFAULT 0,
  reserved     INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sku, location_id)
);
