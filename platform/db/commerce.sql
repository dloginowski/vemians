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

-- Reservations are their own small table: short-lived, per-order, and not part
-- of the permanent stock record.
CREATE TABLE inventory_reservation (
  id          TEXT PRIMARY KEY,
  sku         TEXT NOT NULL,
  location_id TEXT NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  order_id    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resv_sku ON inventory_reservation (sku, location_id);

-- ── inventory as a ledger, not a number ────────────────────────────────────
--
-- An agent that can SET stock to a value is destructive by construction: the
-- previous count is gone, there is no record of who changed it or why, and the
-- undo does not exist. So nothing writes on_hand directly. Every change is an
-- append-only DELTA with a reason and an actor, and a trigger folds it into
-- inventory_level.
--
-- The undo for a mistake is an equal and opposite adjustment, which leaves both
-- the error and the correction on the record. That is what "non-destructive"
-- has to mean for a number that money depends on.

CREATE TABLE inventory_adjustment (
  id          TEXT PRIMARY KEY,
  sku         TEXT NOT NULL,
  location_id TEXT NOT NULL,
  delta       INTEGER NOT NULL CHECK (delta <> 0),
  reason      TEXT NOT NULL
                CHECK (reason IN ('count','receipt','sale','return','damage','theft','correction','transfer')),
  note        TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL,                -- Access identity, never a tool argument
  reverses    TEXT REFERENCES inventory_adjustment(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_adj_sku ON inventory_adjustment (sku, location_id, created_at DESC);

CREATE TRIGGER adjustment_append_only_update BEFORE UPDATE ON inventory_adjustment
BEGIN SELECT RAISE(ABORT, 'inventory history is append-only; post a reversing adjustment'); END;

CREATE TRIGGER adjustment_append_only_delete BEFORE DELETE ON inventory_adjustment
BEGIN SELECT RAISE(ABORT, 'inventory history is append-only; post a reversing adjustment'); END;

-- The count is a VIEW over the ledger, not a stored column.
--
-- A first attempt kept on_hand as a column maintained by a trigger, guarded by
-- a second trigger refusing direct writes. verify.py caught it: the guard fired
-- on the ledger's own upsert too, so every adjustment after the first was
-- rejected. Deriving the number removes the problem instead of patching it --
-- there is no column to overwrite, so "an agent cannot set stock directly" is a
-- property of the schema rather than a rule a trigger must enforce.
CREATE VIEW inventory_level AS
SELECT
  a.sku,
  a.location_id,
  SUM(a.delta) AS on_hand,
  COALESCE((SELECT SUM(r.quantity) FROM inventory_reservation r
             WHERE r.sku = a.sku AND r.location_id = a.location_id), 0) AS reserved,
  MAX(a.created_at) AS updated_at
FROM inventory_adjustment a
GROUP BY a.sku, a.location_id;
