-- A subcategory's numeric_id is now unique only among its OWN siblings (the
-- subcategories under the same parent), not across every subcategory in the
-- whole tree. The owner's own words: "subcategory IDs need to match the style
-- IDs. They need to be exactly the same" -- and the spreadsheets number
-- subcategories separately inside each top-level category (001-004 and
-- 003-004 are both real), so a tree-wide pool could never equal the sheet's
-- own middle number. A style_id (NN-NN-NNN) stays unique because it also
-- carries the top-level category's number. See shared/commerce/square/
-- schema.sql's own comment on mirror_category for the full reasoning; this is
-- the delta half of that change. It only relaxes a rule, so no existing row
-- can violate it.
DROP INDEX IF EXISTS idx_mirror_category_sub_numeric_id;
CREATE UNIQUE INDEX idx_mirror_category_sub_numeric_id
  ON mirror_category (parent_id, numeric_id)
  WHERE parent_id IS NOT NULL AND numeric_id IS NOT NULL AND archived_at IS NULL;
