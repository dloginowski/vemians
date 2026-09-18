-- Which option sets a category offers ("I don't want to be adding the same
-- option sets to every single category, because certain categories might
-- not have the same option sets" — the owner's own words). See
-- shared/commerce/square/schema.sql's own comment on
-- mirror_category_item_option for the full reasoning; this is the delta
-- half of that change. Purely OURS, like mirror_custom_field_name — but
-- unassigning is still an UPDATE setting archived_at, never a literal
-- DELETE, since the tool layer refuses to contain that statement at all.

CREATE TABLE mirror_category_item_option (
  category_id     TEXT NOT NULL REFERENCES mirror_category(id),
  item_option_id  TEXT NOT NULL REFERENCES mirror_item_option(id),
  archived_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (category_id, item_option_id)
);

CREATE VIEW mirror_category_item_option_index AS
SELECT category_id, item_option_id, created_at
FROM mirror_category_item_option WHERE archived_at IS NULL;
