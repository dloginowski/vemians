-- "When I set sets for a category, all subcategories inherit the sets
-- unless I specify different selections for the subcategories" — the
-- owner's own words. See shared/commerce/square/schema.sql's own comment
-- on mirror_category.item_options_set_at for the full reasoning; this is
-- the delta half of that change.

ALTER TABLE mirror_category ADD COLUMN item_options_set_at TEXT;

-- mirror_category_index is a VIEW; SQLite compiles its own column list at
-- CREATE VIEW time, so the ALTER TABLE above does not reach it on its own
-- (the same production incident 0003_category_hierarchy.sql's own comment
-- already warns about) — drop and recreate with the new column named.
DROP VIEW mirror_category_index;
CREATE VIEW mirror_category_index AS
SELECT id, external_ref, name, parent_id, numeric_id, item_options_set_at, synced_at
FROM mirror_category WHERE archived_at IS NULL;
