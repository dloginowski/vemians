-- Which Option Sets an ITEM itself declares (Square's own item_data.
-- item_options). See shared/commerce/square/schema.sql's own comment on
-- mirror_product_item_option for the full reasoning; this is the delta
-- half of that change.

CREATE TABLE mirror_product_item_option (
  product_id      TEXT NOT NULL REFERENCES mirror_product(id),
  item_option_id  TEXT NOT NULL REFERENCES mirror_item_option(id),
  archived_at     TEXT,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, item_option_id)
);

CREATE VIEW mirror_product_item_option_index AS
SELECT product_id, item_option_id, synced_at
FROM mirror_product_item_option WHERE archived_at IS NULL;

CREATE TRIGGER mirror_product_item_option_no_delete BEFORE DELETE ON mirror_product_item_option
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;
