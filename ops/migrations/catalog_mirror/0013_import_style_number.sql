-- The spreadsheet's own style-number text, captured once at creation, so a
-- later resubmit of the same row updates this product instead of
-- duplicating it. See shared/commerce/square/schema.sql's own comment on
-- mirror_product.import_style_number for the full reasoning; this is the
-- delta half of that change.

ALTER TABLE mirror_product ADD COLUMN import_style_number TEXT;
CREATE INDEX idx_mirror_product_import_style_number ON mirror_product (import_style_number);

-- mirror_product_index is a VIEW; SQLite compiles its own column list at
-- CREATE VIEW time, so the ALTER TABLE above does not reach it on its own
-- (the same warning every earlier ALTER TABLE against mirror_category/
-- mirror_product already gave) -- drop and recreate with the new column
-- named.
DROP VIEW mirror_product_index;
CREATE VIEW mirror_product_index AS
SELECT id, external_ref, handle, title, source_description, status, channel,
       custom_fields, import_style_number, style_id, commission_pct, category_id, source_version, synced_at
FROM mirror_product WHERE archived_at IS NULL;
