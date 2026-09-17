-- Widen mirror_sync's own CHECK constraint to allow a third row,
-- 'catalog_full', tracking the periodic full-sweep timestamp
-- (ops/src/sync.js's own FULL_SWEEP_INTERVAL_MS) independently of the
-- plain incremental 'catalog' cursor. See shared/commerce/square/
-- schema.sql's own comment on mirror_sync for the full reasoning. This
-- is the delta half of that change; schema.sql is the canonical full
-- description, kept in sync by hand.
--
-- SQLite has no ALTER TABLE for a CHECK constraint, so this is the
-- standard rebuild: a new table with the widened constraint, every
-- existing row copied across unchanged, the old table dropped, the new
-- one renamed into its place.

CREATE TABLE mirror_sync_new (
  id          TEXT PRIMARY KEY
                CHECK (id IN ('catalog','inventory','catalog_full')),
  cursor      TEXT,
  ran_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ok          INTEGER NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT ''
);

INSERT INTO mirror_sync_new (id, cursor, ran_at, ok, note)
  SELECT id, cursor, ran_at, ok, note FROM mirror_sync;

DROP TABLE mirror_sync;
ALTER TABLE mirror_sync_new RENAME TO mirror_sync;
