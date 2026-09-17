-- A vendor's own commission rate, centralized. OURS, not Square's — the
-- same reasoning mirror_product.commission_pct's own comment already
-- gives. See shared/commerce/square/schema.sql's own comment on
-- mirror_vendor for the full reasoning. This is the delta half of that
-- change; schema.sql is the canonical full description, kept in sync by
-- hand.

ALTER TABLE mirror_vendor ADD COLUMN commission_pct INTEGER;

-- mirror_vendor_index is a VIEW; SQLite compiles its own column list at
-- CREATE VIEW time, so the ALTER TABLE above does not reach it on its own
-- (the same P0-137 incident 0003_category_hierarchy.sql's own comment
-- warns about) — drop and recreate with the new column named.
DROP VIEW mirror_vendor_index;
CREATE VIEW mirror_vendor_index AS
SELECT id, external_ref, name, status, commission_pct, synced_at
FROM mirror_vendor WHERE archived_at IS NULL;
