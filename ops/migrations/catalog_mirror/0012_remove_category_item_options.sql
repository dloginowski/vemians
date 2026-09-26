-- Category-level Option Set ASSIGNMENT -- the "Sets"/"Inherit" dropdowns on
-- a category in the admin panel, and the bulk "apply to items" tool that
-- retroactively generated/retagged variations for a whole category -- is
-- removed outright (Test-PRD-P0-178-remove_category_item_options). The
-- owner's own words, having watched CSV/agent ingestion auto-create every
-- size/color an item actually needs on the fly: "I don't think we need to
-- have this idea of option sets with dropdowns in our admin panel... this
-- whole thing is completely unnecessary and just adds complexity."
--
-- This is ONLY the category-level assignment mechanism. mirror_item_option/
-- mirror_item_option_value (the shop-wide Option Set catalog, P0-141) and
-- mirror_product_item_option (a real Square fact -- which Option Sets an
-- ITEM itself currently declares, mirrored on every sync regardless of how
-- it got set, P0-143) are both untouched: catalog.update_product's own
-- "resend the whole thing or it vanishes" fallback for item_options reads
-- mirror_product_item_option unconditionally, for ANY product with real
-- item_option_values on its variations -- not only ones the now-removed
-- bulk-apply tool ever touched -- so dropping that table would silently
-- wipe a perfectly ordinary CSV-created product's own Option Set
-- declaration the next time someone edited its title or price.

DROP VIEW mirror_category_item_option_index;
DROP TABLE mirror_category_item_option;

-- mirror_category_index is a VIEW; SQLite compiles its own column list at
-- CREATE VIEW time, so the ALTER TABLE below does not reach it on its own
-- (the same warning 0003_category_hierarchy.sql/0009_category_item_options_
-- inherit.sql already gave) -- drop and recreate without the retired column.
DROP VIEW mirror_category_index;
ALTER TABLE mirror_category DROP COLUMN item_options_set_at;
CREATE VIEW mirror_category_index AS
SELECT id, external_ref, name, parent_id, numeric_id, synced_at
FROM mirror_category WHERE archived_at IS NULL;
