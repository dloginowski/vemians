-- Smoke tests for the portability and safety guarantees in schema.sql.
-- Run against a scratch database:
--   psql -f schema.sql && psql -f verify.sql
-- Every block marked EXPECT ERROR must fail. Silence where an error is expected
-- is itself a failure.

\set ON_ERROR_STOP off

INSERT INTO employee (id,email,name)
  VALUES ('11111111-1111-1111-1111-111111111111','a@vemians.com','Ana');
INSERT INTO shift (employee_id,starts_at,ends_at)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-09-08 09:00Z','2026-09-08 17:00Z');

\echo '== 1. EXPECT ERROR: an agent must not double-book an employee'
INSERT INTO shift (employee_id,starts_at,ends_at)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-09-08 16:00Z','2026-09-08 20:00Z');

\echo '== 2. EXPECT OK: back-to-back shifts are not an overlap'
INSERT INTO shift (employee_id,starts_at,ends_at)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-09-08 17:00Z','2026-09-08 20:00Z');

\echo '== 3. EXPECT OK: a cancelled shift frees its slot'
UPDATE shift SET status='cancelled' WHERE starts_at='2026-09-08 09:00Z';
INSERT INTO shift (employee_id,starts_at,ends_at)
  VALUES ('11111111-1111-1111-1111-111111111111','2026-09-08 10:00Z','2026-09-08 12:00Z');

\echo '== 4. THE VENDOR-SWAP DRILL: catalog must survive dropping a channel'
INSERT INTO product (id,handle,title,status)
  VALUES ('22222222-2222-2222-2222-222222222222','bone-tee','Bone Tee','active');
INSERT INTO product_variant (id,product_id,sku,title,price_minor,currency)
  VALUES ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222',
          'TEE-M-BONE','M / Bone',4500,'USD');
INSERT INTO channel (id,kind,name)
  VALUES ('44444444-4444-4444-4444-444444444444','shopify','Shopify US');
INSERT INTO external_ref (channel_id,entity_type,entity_id,external_id) VALUES
  ('44444444-4444-4444-4444-444444444444','product','22222222-2222-2222-2222-222222222222',
   'gid://shopify/Product/998877'),
  ('44444444-4444-4444-4444-444444444444','variant','33333333-3333-3333-3333-333333333333',
   'gid://shopify/ProductVariant/554433');

DELETE FROM channel WHERE kind='shopify';

\echo '   -> EXPECT products=1 variants=1 refs=0'
SELECT (SELECT count(*) FROM product)         AS products,
       (SELECT count(*) FROM product_variant) AS variants,
       (SELECT count(*) FROM external_ref)    AS refs;

\echo '== 5. Audit log is append-only, even for the owning role'
INSERT INTO audit_log (actor,tool,result) VALUES ('agent:s1','catalog.update','ok');
\echo '   EXPECT ERROR: delete'
DELETE FROM audit_log;
\echo '   EXPECT ERROR: update'
UPDATE audit_log SET result='ok';
\echo '   -> EXPECT rows=1'
SELECT count(*) AS rows FROM audit_log;
