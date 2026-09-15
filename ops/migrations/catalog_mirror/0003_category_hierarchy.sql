-- Nested categories/subcategories, backed by Square's own real category
-- hierarchy, plus OUR OWN 2-digit numeric_id used to build a product's own
-- style_id. See shared/commerce/square/schema.sql's own comment on
-- mirror_category for the full reasoning. This is the delta half of that
-- change; schema.sql is the canonical full description, kept in sync by
-- hand.

ALTER TABLE mirror_category ADD COLUMN parent_id TEXT REFERENCES mirror_category(id);
ALTER TABLE mirror_category ADD COLUMN numeric_id TEXT;

CREATE UNIQUE INDEX idx_mirror_category_toplevel_numeric_id
  ON mirror_category (numeric_id)
  WHERE parent_id IS NULL AND numeric_id IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX idx_mirror_category_sub_numeric_id
  ON mirror_category (numeric_id)
  WHERE parent_id IS NOT NULL AND numeric_id IS NOT NULL AND archived_at IS NULL;

-- mirror_category_index is a VIEW; SQLite compiles its own column list at
-- CREATE VIEW time, so the ALTER TABLE above does not reach it on its own
-- (the exact production incident P0-137's own error message now warns
-- about) — drop and recreate with the two new columns named.
DROP VIEW mirror_category_index;
CREATE VIEW mirror_category_index AS
SELECT id, external_ref, name, parent_id, numeric_id, synced_at
FROM mirror_category WHERE archived_at IS NULL;
