-- Square's ITEM_OPTION/ITEM_OPTION_VAL ("Option Sets") mirrored as their own
-- first-class entity, independent of whether any item currently uses them.
-- See shared/commerce/square/schema.sql's own comment on mirror_item_option
-- for the full reasoning; this is the delta half of that change.

CREATE TABLE mirror_item_option (
  id           TEXT PRIMARY KEY,
  external_ref TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  archived_at  TEXT,
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW mirror_item_option_index AS
SELECT id, external_ref, name, synced_at
FROM mirror_item_option WHERE archived_at IS NULL;

CREATE TABLE mirror_item_option_value (
  id              TEXT PRIMARY KEY,
  external_ref    TEXT NOT NULL UNIQUE,
  item_option_id  TEXT NOT NULL REFERENCES mirror_item_option(id),
  name            TEXT NOT NULL,
  ordinal         INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW mirror_item_option_value_index AS
SELECT id, external_ref, item_option_id, name, ordinal, synced_at
FROM mirror_item_option_value WHERE archived_at IS NULL;

CREATE TRIGGER mirror_item_option_no_delete BEFORE DELETE ON mirror_item_option
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_item_option_value_no_delete BEFORE DELETE ON mirror_item_option_value
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;
