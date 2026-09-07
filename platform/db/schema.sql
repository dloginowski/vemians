-- Vemians — portable core schema (PostgreSQL)
--
-- Design rules, in priority order:
--   1. Vendor identifiers are NEVER primary keys. We mint our own UUIDs.
--   2. Vendor-specific data lives ONLY in `channel` and `external_ref`.
--      Dropping a sales channel is a DELETE on those two tables.
--   3. Money is integer minor units + an explicit currency. Never floats.
--   4. Nothing here references Shopify. Shopify is one row in `channel`.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- shift overlap exclusion

-- ---------------------------------------------------------------- catalog

CREATE TABLE product (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle       text NOT NULL UNIQUE,           -- URL slug; ours, stable, never vendor's
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','active','archived')),
  tags         text[] NOT NULL DEFAULT '{}',
  attributes   jsonb  NOT NULL DEFAULT '{}',   -- open-ended; avoids schema churn
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_variant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  sku           text UNIQUE,                   -- our SKU, the cross-vendor anchor
  title         text NOT NULL,
  options       jsonb NOT NULL DEFAULT '{}',   -- {"size":"M","colour":"bone"}
  price_minor   bigint NOT NULL CHECK (price_minor >= 0),
  currency      char(3) NOT NULL,
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON product_variant (product_id);

CREATE TABLE media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid REFERENCES product(id) ON DELETE CASCADE,
  variant_id  uuid REFERENCES product_variant(id) ON DELETE SET NULL,
  r2_key      text NOT NULL UNIQUE,            -- WE hold the original, always
  kind        text NOT NULL DEFAULT 'image' CHECK (kind IN ('image','video','model')),
  alt         text NOT NULL DEFAULT '',
  width       int,
  height      int,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON media (product_id);

CREATE TABLE collection (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle      text NOT NULL UNIQUE,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_collection (
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  position      int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, collection_id)
);

-- ------------------------------------------------------------- inventory

CREATE TABLE location (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  address    jsonb NOT NULL DEFAULT '{}',
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE inventory_level (
  variant_id   uuid NOT NULL REFERENCES product_variant(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  on_hand      int NOT NULL DEFAULT 0,
  reserved     int NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, location_id),
  CHECK (reserved >= 0)
);

-- ---------------------------------------------------------------- channels
-- A sales channel is a row. Shopify is a row. So is whatever replaces it.

CREATE TABLE channel (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,                   -- 'shopify' | 'medusa' | 'pos' | ...
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}',     -- NON-SECRET config only
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN channel.config IS
  'Non-secret configuration only. API tokens live in Workers Secrets, never here.';

-- THE portability table. Every vendor identifier in the system is one row here.
CREATE TABLE external_ref (
  channel_id   uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,                  -- 'product' | 'variant' | 'order' | ...
  entity_id    uuid NOT NULL,                  -- OUR id
  external_id  text NOT NULL,                  -- THEIR id (e.g. a Shopify GID)
  synced_at    timestamptz,
  PRIMARY KEY (channel_id, entity_type, entity_id),
  UNIQUE (channel_id, entity_type, external_id)
);
CREATE INDEX ON external_ref (entity_type, entity_id);

-- ------------------------------------------------------------------ sales

CREATE TABLE customer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext UNIQUE,
  name        text,
  attributes  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "order" (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number   bigserial UNIQUE,             -- ours; independent of any vendor numbering
  channel_id     uuid REFERENCES channel(id) ON DELETE SET NULL,
  customer_id    uuid REFERENCES customer(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','paid','fulfilled','cancelled','refunded')),
  subtotal_minor bigint NOT NULL DEFAULT 0,
  tax_minor      bigint NOT NULL DEFAULT 0,
  total_minor    bigint NOT NULL DEFAULT 0,
  currency       char(3) NOT NULL,
  placed_at      timestamptz NOT NULL DEFAULT now(),
  raw_payload    jsonb                          -- vendor webhook, kept verbatim for replay
);
CREATE INDEX ON "order" (placed_at DESC);
CREATE INDEX ON "order" (customer_id);
COMMENT ON COLUMN "order".raw_payload IS
  'Original vendor payload, retained so ingest can be re-run after a mapping bug.';

CREATE TABLE order_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  variant_id       uuid REFERENCES product_variant(id) ON DELETE SET NULL,
  -- Snapshots: an order line must stay readable after the product is edited or deleted.
  title_snapshot   text NOT NULL,
  sku_snapshot     text,
  quantity         int NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL,
  currency         char(3) NOT NULL
);
CREATE INDEX ON order_line (order_id);

-- --------------------------------------------------------------- operations

CREATE TABLE employee (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext NOT NULL UNIQUE,          -- matches the Cloudflare Access identity
  name        text NOT NULL,
  role        text NOT NULL DEFAULT 'staff',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE employee IS
  'Employment PII. Encrypt sensitive columns at rest; gate behind a dedicated Access group. '
  'Payroll is NOT stored here - it belongs in the payroll provider.';

CREATE TABLE shift (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid REFERENCES employee(id) ON DELETE SET NULL,
  location_id  uuid REFERENCES location(id) ON DELETE SET NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled','confirmed','cancelled','completed')),
  notes        text NOT NULL DEFAULT '',
  CHECK (ends_at > starts_at)
);
CREATE INDEX ON shift (starts_at);
-- Prevents an agent double-booking someone, at the database rather than in the prompt.
ALTER TABLE shift ADD CONSTRAINT shift_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('scheduled','confirmed'));

-- Append-only. Written for EVERY agent action, before any write tool ships.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor        text NOT NULL,                  -- Access identity, or 'agent:<session>'
  on_behalf_of text,                           -- human, when the actor is an agent
  tool         text NOT NULL,
  arguments    jsonb NOT NULL DEFAULT '{}',
  result       text NOT NULL CHECK (result IN ('ok','error','denied','pending_approval')),
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (created_at DESC);
CREATE INDEX ON audit_log (actor, created_at DESC);

-- Append-only, enforced. A plain REVOKE is not enough: it does not constrain the
-- table owner, so the role running migrations could still delete history. The
-- trigger holds for every role, owner included.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- Defence in depth: the application must connect as a NON-OWNER role, so that
-- disabling the trigger above requires a separate, privileged, auditable step.
-- Provision before first deploy:
--   CREATE ROLE vemians_app LOGIN PASSWORD '...';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vemians_app;
--   REVOKE UPDATE, DELETE ON audit_log FROM vemians_app;
