-- "I want inside of that header to have an upload button on the right
-- side so I can click on it and just upload an image specifically for
-- that option, for, like, for that variant" -- the owner's own words.
-- See shared/commerce/square/schema.sql's own comment on mirror_image
-- for the full reasoning; this is the delta half of that change.

ALTER TABLE mirror_image ADD COLUMN variant_id TEXT REFERENCES mirror_variant(id);

CREATE INDEX idx_mirror_image_variant ON mirror_image (variant_id);

-- mirror_image_index is a VIEW; SQLite compiles its own column list at
-- CREATE VIEW time, so the ALTER TABLE above does not reach it on its own
-- (0003_category_hierarchy.sql's own comment already warns about this) --
-- drop and recreate with the new column named.
DROP VIEW mirror_image_index;
CREATE VIEW mirror_image_index AS
SELECT id, external_ref, product_id, variant_id, source_url, caption, ordinal, media_key, synced_at
FROM mirror_image WHERE archived_at IS NULL;
