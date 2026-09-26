-- D1: catalog_mirror  --  our full copy of Square's authoritative catalog.
--
-- WHY THIS STORE EXISTS
--
-- ADR-009 reverses ADR-001: Square is the system of record for stock and for
-- the commercial facts of the catalog, because a till changes both without
-- asking us. The concession the ADR refuses to make is our copy of the data:
-- "We still hold a full mirror. Square's catalog and stock are mirrored into
-- our stores on webhook and on a nightly reconcile. If Square goes away we keep
-- the data; we lose the till."  This is that mirror.
--
-- It is also what makes the storefront's contract holdable. ADR-009's
-- anti-patterns table forbids "storefront reading Square live per request";
-- Test-PRD-P0-26-owned_storefront requires ZERO calls to a commerce provider
-- except to mint a checkout URL. A read path can only be that if there is
-- something local to read. A Square outage must degrade checkout, not browsing.
--
-- WHY IT IS A SEPARATE STORE FROM `commerce`
--
-- shared/db/commerce.sql holds exactly one vendor-shaped column,
-- `order.external_id`, and shared/db/verify.py asserts that as a hard
-- invariant (Test-PRD-P0-16-commerce_port). Mirroring a vendor catalog into
-- that schema would put `external_ref` on four more tables and break it. Per
-- ADR-002 the boundary rule is blast radius and retention, and this store is
-- both: it is disposable and rebuildable from Square, whereas orders are not.
-- No foreign key and no transaction crosses to `commerce` (ADR-002); the join
-- from a mirrored variation to a stock ledger row is by `sku` plus a snapshot,
-- exactly as every other cross-store reference in this repository.
--
-- WHAT IS OURS AND WHAT IS SQUARE'S
--
--   * Every primary key is OUR uuid. ADR-009 anti-pattern: "Square ids as our
--     primary keys reinstates exactly the lock-in this design avoids."
--   * `external_ref` is the ONLY column that holds a Square identifier, in this
--     store and in every other. It is UNIQUE, which is what makes a re-sync
--     idempotent rather than duplicating.
--   * Editorial copy, ordering and imagery selection are NOT mirrored back from
--     Square (ADR-009 anti-pattern: "editorial copy in Square item
--     descriptions"). Square's description is kept as `source_description` so a
--     reconcile can diff it; presentation stays in Git, keyed by handle.
--
-- NOTHING IS EVER DELETED (ADR-008, Test-PRD-P0-36-working_set_index)
--
-- A product withdrawn in Square is ARCHIVED here — `archived_at` set, row kept,
-- still queryable by explicit call. Deletion is refused by trigger rather than
-- by convention, so the guarantee is a property of the schema and not of the
-- adapter remembering. Each table has an `*_index` view over unarchived rows,
-- and that is what a read returns by default.
--
-- MONEY (Test-PRD-P0-15-money_minor_units)
--
-- Integer minor units plus an explicit currency. No REAL, FLOAT or NUMERIC
-- column exists in this file, and every `*_minor` column is INTEGER NOT NULL.

-- ── categories ─────────────────────────────────────────────────────────────
--
-- NESTED, backed by Square's own real category hierarchy (GA, not a beta) —
-- category_data.parent_category on the Square side, mirrored here as
-- parent_id (OUR OWN uuid, never a Square id — same convention every other
-- FK in this schema already follows). A row with parent_id NULL is a
-- top-level category; any other row is a "subcategory" at whatever depth,
-- with no structural difference between one level of nesting and five.
--
-- numeric_id is OURS, not Square's — a 2-digit "00".."99" code this shop
-- assigns, later embedded in a product's own style_id (NN-NN-NNN: the first
-- NN is a top-level category's own numeric_id, the second is a
-- SUBCATEGORY's). The owner's own words: "there's only up to 100
-- categories... zero to 99... it doesn't matter how deep the levels are...
-- once an ID is used by any subcategory, it stops being available" — ONE
-- shared 00-99 pool across every subcategory in the WHOLE tree regardless
-- of nesting depth or parent (the two partial unique indexes below), kept
-- SEPARATE from top-level categories' own 00-99 pool, so the style_id
-- format itself never has to change to accommodate nesting. A subcategory
-- NAME may repeat elsewhere in the tree (the owner's own words: "a
-- subcategory name can be used more than once, the ID cannot") — what
-- disambiguates two same-named subcategories is their own parent chain
-- (path_to_root), not the name; the UI shows only a node's own leaf name.
CREATE TABLE mirror_category (
  id                   TEXT PRIMARY KEY,              -- ours
  external_ref         TEXT NOT NULL UNIQUE,          -- Square CATEGORY id
  name                 TEXT NOT NULL,
  parent_id            TEXT REFERENCES mirror_category(id), -- NULL = top-level
  numeric_id           TEXT,                          -- ours; "00".."99", NULL until assigned
  -- ours; when a subcategory INHERITS its parent's own option sets rather
  -- than naming its own (Test-PRD-P0-142-category_item_options' own REVISED
  -- entry: "all subcategories inherit the sets unless I specify different
  -- selections"). NULL means "never explicitly set here, keep inheriting";
  -- set the moment catalog.set_category_item_options is ever called for
  -- this category, EVEN to an empty list — an empty EXPLICIT set (opting
  -- out of everything the parent offers) is not the same fact as "never
  -- touched, still inheriting," and mirror_category_item_option's own rows
  -- alone cannot tell the two apart (both look like zero active rows).
  item_options_set_at  TEXT,
  archived_at          TEXT,                          -- rolled off the working set, never deleted
  synced_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Two SEPARATE pools, not one: a top-level category's own numeric_id must
-- be unique only among OTHER top-level categories, and a subcategory's
-- must be unique among EVERY subcategory regardless of depth or parent —
-- never against a top-level category's own numbers, which the style_id's
-- own first-segment/second-segment split keeps structurally apart anyway.
CREATE UNIQUE INDEX idx_mirror_category_toplevel_numeric_id
  ON mirror_category (numeric_id)
  WHERE parent_id IS NULL AND numeric_id IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX idx_mirror_category_sub_numeric_id
  ON mirror_category (numeric_id)
  WHERE parent_id IS NOT NULL AND numeric_id IS NOT NULL AND archived_at IS NULL;

CREATE VIEW mirror_category_index AS
SELECT id, external_ref, name, parent_id, numeric_id, item_options_set_at, synced_at
FROM mirror_category WHERE archived_at IS NULL;

-- ── item options  ("Option Sets" in the dashboard, "variant sets" in the ──
--    owner's own words) — Square's own ITEM_OPTION/ITEM_OPTION_VAL Catalog
--    objects, the attributes (Size, Color, ...) a variation is built from.
--
-- Mirrored as a first-class entity in its own right, independent of whether
-- any item actually uses it — the owner's own question ("do you have access
-- to these option sets?") exposed that this codebase used to resolve an
-- option/value pair on an ALREADY-SYNCED VARIATION into a human name, but
-- never fetched the option SET itself: one created in Square and not yet
-- assigned to anything was invisible to this mirror entirely. catalog.js's
-- own CATALOG_TYPES now requests ITEM_OPTION directly, the same way it
-- already requests CATEGORY, so the full list (and every one of its own
-- values) lands here regardless.
CREATE TABLE mirror_item_option (
  id           TEXT PRIMARY KEY,              -- ours
  external_ref TEXT NOT NULL UNIQUE,          -- Square ITEM_OPTION id
  name         TEXT NOT NULL,
  archived_at  TEXT,                          -- rolled off the working set, never deleted
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW mirror_item_option_index AS
SELECT id, external_ref, name, synced_at
FROM mirror_item_option WHERE archived_at IS NULL;

-- A value's own ordinal is Square's own sort order within its option set
-- (e.g. Small/Medium/Large, not alphabetical) — read straight off
-- CatalogItemOptionValue.ordinal, OURS to reorder never. catalog-writer.js's
-- own ensureItemOptionValue() can APPEND a new value (or a whole new option)
-- when a CSV/agent product names a Size/Color this shop has not used
-- before; there is still no path here to reorder or rename an existing one.
CREATE TABLE mirror_item_option_value (
  id              TEXT PRIMARY KEY,              -- ours
  external_ref    TEXT NOT NULL UNIQUE,          -- Square ITEM_OPTION_VAL id
  item_option_id  TEXT NOT NULL REFERENCES mirror_item_option(id),
  name            TEXT NOT NULL,
  ordinal         INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW mirror_item_option_value_index AS
SELECT id, external_ref, item_option_id, name, ordinal, synced_at
FROM mirror_item_option_value WHERE archived_at IS NULL;

-- Which option sets a category offers, so a product filed under it will one
-- day know which variation dropdowns to show ("I don't want to be adding
-- the same option sets to every single category, because certain categories
-- might not have the same option sets" — the owner's own words). Purely
-- OURS, like mirror_custom_field_name above: Square has no category-level
-- default/inheritance mechanism for item options at all, so this link exists
-- nowhere but here. Unassigning is an UPDATE setting archived_at, never a
-- literal DELETE — this codebase's own tool layer refuses to contain that
-- statement AT ALL (Test-PRD-P0-25-write_approval_gate), not only against
-- Square-sourced tables, so a plain many-to-many join still follows the
-- same archive-only shape every mirror_* table uses, even though nothing
-- here is a mirror of anything Square holds.
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

-- ── vendors  (Square's own Vendor object, Vendors API — NOT the Catalog API) ─
--
-- Retail Plus/Premium territory (Test-PRD-P0-136-square_custom_attributes,
-- revised): `vendor` used to be a plain-text Square Custom Attribute on
-- mirror_product, until the owner pointed out Square already has a real
-- Vendor entity, tied to a real per-variation `unit_cost_money` — "I don't
-- want to be duplicating that... use everything that's available in Retail
-- Plus." A Vendor lives at a wholly separate Square API (/v2/vendors/*, not
-- /v2/catalog/*), so it needs its own sync pass and its own mirror table,
-- the same reason mirror_category exists for CATEGORY. NOT a closed set the
-- way categories are, though: a new vendor is created in Square on demand
-- (ops/src/tools/catalog-writer.js's own resolve-or-create), because an
-- evolving supplier list is exactly what this feature is for.
-- commission_pct: OURS, not Square's — the same reasoning mirror_product's
-- own commission_pct comment already gives ("Square has no concept of a
-- resale commission at all"), moved up a level. REVISED: "let's not force
-- vendor's commission to be stated out loud [on every item]... we store it
-- in essential locations per vendor so that their commission is recorded
-- in a central location and automatically applied" — the owner's own
-- words. A vendor's own rate lives HERE now, the one place it is actually
-- given or changed; a product's own commission_pct (mirror_product, above)
-- is still what Square's own per-item Custom Attribute actually holds, but
-- it is now populated FROM this column whenever a caller does not name one
-- explicitly (ops/src/tools/catalog-write.js), rather than left blank or
-- demanded again for every single item. Square's own Vendors sync
-- (syncVendors, mirror.js) never names this column in its own UPSERT, on
-- purpose — the same "named exception the sync job must never touch"
-- convention channel/custom_fields already established on mirror_product —
-- so a rate set here survives every future vendor re-sync untouched.
CREATE TABLE mirror_vendor (
  id             TEXT PRIMARY KEY,              -- ours
  external_ref   TEXT NOT NULL UNIQUE,          -- Square Vendor id
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  commission_pct INTEGER,
  archived_at    TEXT,                          -- same archive-only convention as every mirror_* table
  synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW mirror_vendor_index AS
SELECT id, external_ref, name, status, commission_pct, synced_at
FROM mirror_vendor WHERE archived_at IS NULL;

-- ── products  (Square ITEM) ────────────────────────────────────────────────

CREATE TABLE mirror_product (
  id                 TEXT PRIMARY KEY,        -- ours
  external_ref       TEXT NOT NULL UNIQUE,    -- Square ITEM id
  -- Derived once, on first sight, and never recomputed from a later title:
  -- a handle is a public URL (Test-PRD-P0-26-owned_storefront) and a title
  -- edited at the counter must not silently 404 the shop.
  handle             TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  source_description TEXT NOT NULL DEFAULT '',-- Square's copy, for reconciliation only
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('draft','active','archived')),
  -- WHICH AUDIENCE BROWSES THIS, NOT WHETHER IT EXISTS. `status` is Square's
  -- own publish lifecycle (P0-53-ish: draft/active/archived); `channel` is
  -- ours — Square has no concept of "our storefront" at all, so this is NOT a
  -- fact synced from Square and the sync job (mirror.js) never names this
  -- column in its UPDATE, on purpose: a value set here survives every re-sync
  -- untouched, the same way `handle` already does. The owner's own words:
  -- "everything is in our database is accessible through a direct link — we
  -- only need the checkbox for whether it's ALSO on the website," so there is
  -- no third "not reachable at all" state left to default-closed against —
  -- every product already has a working page.
  --   direct_link  has its own page, but excluded from the grid/nav — for
  --                someone with the link, not for browsing (the default)
  --   website      ALSO shown in the grid, for browsing
  channel            TEXT NOT NULL DEFAULT 'direct_link'
                       CHECK (channel IN ('website','direct_link')),
  -- WHATEVER A SPREADSHEET IMPORT CARRIED THAT SQUARE HAS NO FIELD FOR AT
  -- ALL. The owner's own words: "I want to preserve all fields when
  -- ingesting spreadsheets. Even if they are not surfaced in square or ui
  -- for now... Our workers need more data tracking than square offers."
  -- A fabric note, a reorder date, anything ad hoc — none of it is a Square
  -- catalog concept, so there is no second writer for it to diverge from,
  -- the same argument `channel` above already rests on. (style_id and
  -- vendor below used to be examples of this; they moved to Square's own
  -- Custom Attributes instead — see their own comments.) A flat JSON object
  -- of field name -> string value, not a fixed set of named columns: the
  -- whole point is that neither this schema nor the ops UI has to know a
  -- field's name in advance to keep it. The sync job (mirror.js) never
  -- names this column in its UPDATE, on purpose, so a value set here
  -- survives every future re-sync untouched, exactly like `channel`.
  -- ops-only: the public storefront's own read of this mirror (P0-24) has
  -- no reason to select it, and never should.
  custom_fields      TEXT NOT NULL DEFAULT '{}',
  -- THE OPPOSITE OF channel/custom_fields ABOVE: Square's own Custom
  -- Attributes (Test-PRD-P0-136-square_custom_attributes), so Square IS
  -- authoritative for these and the sync job DOES overwrite them on every
  -- re-sync, the same as `title`. The owner's own words, having weighed
  -- "ours, not Square's" against Square's own built-in mechanism: "why do
  -- we need to have our own custom fields then? It doesn't make sense. If
  -- it already exists in Square, why invent something extra? ... we don't
  -- mind having our stuff being stored completely in Square." style_id is
  -- read from item_data.custom_attribute_values by the well-known `key`
  -- "style_id" this codebase defines once via Square's own
  -- CatalogCustomAttributeDefinition — no opaque Square-assigned id is ever
  -- stored here, because the API lets an app address its own attribute by
  -- that key directly. style_id follows the owner's own nomenclature —
  -- 2 digits (category) - 2 digits (subcategory) - 3 digits (item number),
  -- e.g. "01-04-001" — validated and checked for conflicts in
  -- ops/src/tools/catalog-write.js, never auto-generated yet (that needs
  -- the category/subcategory table this schema does not have yet). It is
  -- deliberately NOT the same thing as a variation's own `sku` on
  -- mirror_variant below: "SKUs are generated automatically by Square, and
  -- we don't want to mess with them... we still want to use SKUs for
  -- linking, but we don't want to actually touch them or generate them at
  -- all" — sku stays exactly as it always has, read-only, Square's own.
  style_id           TEXT,
  -- `vendor` used to live HERE as a plain-text Custom Attribute. It moved to
  -- mirror_variant (vendor_id, referencing mirror_vendor) once the owner
  -- got Retail Plus and pointed out Square already has a real Vendor entity
  -- with real per-variation cost tracking: "I don't want to be duplicating
  -- that." A product's own "vendor" for display is now resolved by joining
  -- its ordinal-0 variation's vendor_id — see catalog-writer.js's
  -- listAllProducts/productByHandle — the same "one vendor per product,
  -- applied uniformly to every variation" simplification the owner chose
  -- over per-variation vendors (Square supports the latter; this shop
  -- does not need it).
  --
  -- commission stays HERE, unmoved: a plain integer 0-100, never a decimal
  -- percentage — the owner's own words: "commission, that's a custom
  -- field, zero to a hundred, integer... that's only for vendors —
  -- anything that has a vendor, it has a commission." Square has no
  -- concept of a resale commission at all, so unlike vendor/cost there is
  -- nothing of Square's to move this onto. The vendor-requires-commission
  -- rule is checked in catalog.set_square_attributes and
  -- catalog.create_product rather than as a CHECK constraint here (a
  -- constraint cannot see "the OTHER value this same call is also
  -- setting").
  --
  -- REVISED: mirror_vendor's OWN commission_pct (above) is now the central
  -- rate for a given vendor — an item's own value here still mirrors
  -- whatever Square's own per-ITEM Custom Attribute actually holds (that is
  -- the fact this column exists to reflect), but an item that names a
  -- vendor and no commission of its own gets the vendor's own on-file rate
  -- copied in here automatically, rather than being asked to restate it.
  --
  -- REVISED YET AGAIN, THEN WALKED BACK — a real transcript: "you created a
  -- cost USD [custom field] instead of putting it into the actual cost
  -- attribute that already exists for all items." That round introduced
  -- item_unit_cost_minor, a vendor-independent Square Custom Attribute
  -- (key "unit_cost"), read ONLY for a product with no vendor at all. The
  -- owner rejected that mechanism outright on the very next pass: "cost
  -- must always be a built-in attribute we serve, not a custom attribute —
  -- this has nothing to do with vendors [conceptually], but every item
  -- must have one associated with it." The fix is not a fourth mechanism —
  -- it retires the third: every product with no REAL vendor is now, by
  -- construction, assigned the built-in "In-house" vendor
  -- (ops/src/tools/catalog-writer.js's own INHOUSE_VENDOR_NAME, resolved/
  -- created in Square exactly like any other vendor name). "No vendor at
  -- all" is no longer a state this shop's own data can be in — a product
  -- either has a real external vendor, or it has "In-house" — so cost
  -- ALWAYS lives on vendor_information.unit_cost_money (mirror_variant,
  -- below), the one real, pre-existing, per-variation Square mechanism,
  -- with no second code path and no column here to keep in sync with it.
  -- item_unit_cost_minor and its custom attribute are gone; nothing reads
  -- or writes them any more.
  commission_pct     INTEGER,
  category_id        TEXT REFERENCES mirror_category(id),
  source_version     INTEGER NOT NULL DEFAULT 0,  -- Square's optimistic-concurrency version
  archived_at        TEXT,
  synced_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_product_active ON mirror_product (archived_at, handle);
CREATE INDEX idx_mirror_product_style_id ON mirror_product (style_id);

CREATE VIEW mirror_product_index AS
SELECT id, external_ref, handle, title, source_description, status, channel,
       custom_fields, style_id, commission_pct, category_id, source_version, synced_at
FROM mirror_product WHERE archived_at IS NULL;

-- Which Option Sets an ITEM itself declares (Square's own item_data.
-- item_options, an array of {item_option_id} pairs) — a real Square fact,
-- mirrored the same way variations/media are: replaced wholesale on every
-- full sync of this product, never invented by us. Separate from
-- mirror_variant.options (a VARIATION's own resolved name->value display
-- blob) and from mirror_category_item_option (which option sets a
-- CATEGORY offers, ours alone, with its own inherit-vs-explicit rule) —
-- this table is what "which option sets does this ITEM currently support"
-- actually means on Square's side, one row per item/option-set pair.
CREATE TABLE mirror_product_item_option (
  product_id      TEXT NOT NULL REFERENCES mirror_product(id),
  item_option_id  TEXT NOT NULL REFERENCES mirror_item_option(id),
  archived_at     TEXT,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, item_option_id)
);

CREATE VIEW mirror_product_item_option_index AS
SELECT product_id, item_option_id, synced_at
FROM mirror_product_item_option WHERE archived_at IS NULL;

-- A style_id, once given to ANY product, is never handed to a different one
-- — the owner's own words: "we want that style number to be held, so that
-- you don't overwrite that style number and reuse it for something else."
-- mirror_product.style_id above is only ever the CURRENT value for a
-- product; editing it away (a typo fix, a re-categorisation) would silently
-- free the old number for reuse by someone else's next product if that were
-- the only record of it. This table is the permanent one: a row is
-- inserted the first time a style_id is ever seen synced onto a product
-- (mirror.js) and never updated or deleted after that, even once the
-- product itself moves on to a different style_id or is withdrawn — the
-- same "archive, never delete" convention every other ledger in this
-- schema already follows (Test-PRD-P0-31-inventory_ledger's own header).
-- catalog.create_product/set_square_attributes check THIS table for a
-- conflict, not just mirror_product's own current column.
CREATE TABLE mirror_style_id_ledger (
  style_id     TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES mirror_product(id),
  assigned_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER trg_style_id_ledger_no_update
BEFORE UPDATE ON mirror_style_id_ledger
BEGIN
  SELECT RAISE(ABORT, 'mirror_style_id_ledger is append-only — a style_id is never reassigned once recorded');
END;
CREATE TRIGGER trg_style_id_ledger_no_delete
BEFORE DELETE ON mirror_style_id_ledger
BEGIN
  SELECT RAISE(ABORT, 'mirror_style_id_ledger is append-only — a style_id is never freed once recorded');
END;

-- ── custom field names  (P0-71, revised) ────────────────────────────────────
--
-- The owner's own words: "remove add fields from items. I don't want to be
-- adding fields per item. If I'm adding custom fields, I'm adding them to
-- all items. And this is done inside of the admin panel, not inside of the
-- item panel." mirror_product.custom_fields (above) stays exactly what it
-- always was — a flat, freeform JSON blob, no schema of its own, "neither
-- this schema nor the ops UI has to know a field's name in advance to keep
-- it." What changes is DISCOVERY: a field's NAME is now administered once,
-- globally, here — never invented ad hoc while editing one product — and
-- the Items tab renders one value row per name in this table (plus any
-- name a product already happens to carry, so nothing already set ever
-- silently disappears from view just because it was never registered
-- here). Purely OURS, no Square correlate at all — unlike every other
-- table in this schema, this one is not a mirror of anything Square holds.
CREATE TABLE mirror_custom_field_name (
  name        TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── variants  (Square ITEM_VARIATION) ──────────────────────────────────────
--
-- ADR-009: "Square ITEM -> our product, ITEM_VARIATION -> our variant, with
-- stock tracked at the variation level, exactly where we track it."
--
-- `sku` is the join to the stock ledger in the `commerce` store. It is NOT
-- unique here: Square permits a blank or repeated SKU, and refusing to mirror a
-- product because staff left the SKU empty at the counter would make the mirror
-- lie about what is for sale. A variation with no SKU is mirrored and simply
-- carries no stock ledger; mirror.js logs it rather than inventing one.

CREATE TABLE mirror_variant (
  id             TEXT PRIMARY KEY,            -- ours
  external_ref   TEXT NOT NULL UNIQUE,        -- Square ITEM_VARIATION id
  product_id     TEXT NOT NULL REFERENCES mirror_product(id),
  sku            TEXT,
  title          TEXT NOT NULL,
  ordinal        INTEGER NOT NULL DEFAULT 0,
  price_minor    INTEGER NOT NULL DEFAULT 0,  -- integer minor units, never a float
  currency       TEXT NOT NULL,
  options        TEXT NOT NULL DEFAULT '{}',  -- JSON: option name -> value
  tracks_stock   INTEGER NOT NULL DEFAULT 0,  -- Square location_overrides.track_inventory
  -- Square's own CatalogItemVariationVendorInformation
  -- (item_variation_data.vendor_information[0] — Square allows an array,
  -- this shop only ever uses one entry per variation, applied uniformly
  -- across every variation of a product by catalog-writer.js's own write
  -- path). Retail-Plus-gated to WRITE; readable on any plan.
  --   vendor_id         our mirror_vendor.id, resolved from vendor_information's
  --                     own vendor_id the same way category_id is resolved
  --                     from a category's external_ref (mirror.js's syncCatalog)
  --   vendor_code       the VENDOR's own SKU/product code for this item — "an
  --                     invoice-like identifier," the owner's own words — never
  --                     Square's own `sku` above, never this shop's `style_id`
  --   unit_cost_minor / unit_cost_currency
  --                     integer minor units, never a float (Test-PRD-P0-15-
  --                     money_minor_units) — Square's own `unit_cost_money`,
  --                     what this shop PAID the vendor, as opposed to `price_minor`,
  --                     what a customer pays. Zero-with-a-currency for "no cost
  --                     entered yet", the same honest-default `price_minor`
  --                     already uses for VARIABLE_PRICING (catalog.js's own
  --                     variationPrice) — not NULL, so every `_minor` column
  --                     in this schema stays NOT NULL (Test-PRD-P0-15's own rule).
  vendor_id           TEXT REFERENCES mirror_vendor(id),
  vendor_code         TEXT,
  unit_cost_minor     INTEGER NOT NULL DEFAULT 0,
  unit_cost_currency  TEXT NOT NULL DEFAULT 'USD',
  source_version INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,
  synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_variant_product ON mirror_variant (product_id, ordinal);
CREATE INDEX idx_mirror_variant_sku ON mirror_variant (sku) WHERE sku IS NOT NULL;

CREATE VIEW mirror_variant_index AS
SELECT id, external_ref, product_id, sku, title, ordinal,
       price_minor, currency, options, tracks_stock,
       vendor_id, vendor_code, unit_cost_minor, unit_cost_currency,
       source_version, synced_at
FROM mirror_variant WHERE archived_at IS NULL;

-- ── images  (Square IMAGE) ─────────────────────────────────────────────────
--
-- The URL is Square's CDN. We hold the reference so the mirror is complete;
-- the originals we serve are ours in R2 (Test-PRD-P0-28-image_contract), and
-- `media_key` is where the R2 key lands once the fetch-and-store job runs.
--
-- variant_id: "upload an image specifically for that option, for, like, for
-- that variant" -- the owner's own words. Square's own catalog-image API
-- (and this codebase's own adapter, images.js) only ever attaches an image
-- to an ITEM, never to an ITEM_VARIATION, so a variant-tagged photo is never
-- one Square itself sent us -- it is added directly here, by a person, from
-- the Items tab (POST /items/<handle>/photo), and NEVER pushed to Square.
-- That is safe: mirror.js's own incremental sync only ever seenVariants-
-- style reconciles variants/item-options, never images (grep confirms no
-- seenImages set anywhere), and there is no periodic full-sweep archive
-- pass over mirror_image either -- a row this table did not get from Square
-- is never touched, let alone archived, by any sync this codebase runs.
-- Its own external_ref is synthesized locally ("ops-upload:<uuid>", never a
-- real Square IMAGE id) purely to satisfy the UNIQUE constraint above,
-- which every Square-sourced row also carries. NULL means "a general photo
-- of the product as a whole," same meaning ordinal 0 already carried before
-- this column existed.
CREATE TABLE mirror_image (
  id           TEXT PRIMARY KEY,
  external_ref TEXT NOT NULL UNIQUE,          -- Square IMAGE id, or ours
  product_id   TEXT NOT NULL REFERENCES mirror_product(id),
  variant_id   TEXT REFERENCES mirror_variant(id),
  source_url   TEXT NOT NULL,
  caption      TEXT NOT NULL DEFAULT '',
  ordinal      INTEGER NOT NULL DEFAULT 0,
  media_key    TEXT,                          -- our R2 key, once mirrored
  archived_at  TEXT,
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_image_product ON mirror_image (product_id, ordinal);
CREATE INDEX idx_mirror_image_variant ON mirror_image (variant_id);

CREATE VIEW mirror_image_index AS
SELECT id, external_ref, product_id, variant_id, source_url, caption, ordinal, media_key, synced_at
FROM mirror_image WHERE archived_at IS NULL;

-- ── the inventory-change ledger mirror ─────────────────────────────────────
--
-- ADR-009: "Square's inventory model is already a ledger --
-- InventoryPhysicalCount (provided) and InventoryCount (computed), with
-- adjustments between them. That is precisely the design in ADR-008... Our
-- inventory_adjustment table becomes a mirror of Square's changes rather than a
-- competing ledger."
--
-- This table is the RECEIPT for that ingest, and the single place a Square
-- inventory-change id is stored. The stock number itself lives where it always
-- did: `inventory_adjustment` in the `commerce` store, folded up by the
-- `inventory_level` VIEW (Test-PRD-P0-31-inventory_ledger).
--
-- `external_ref` UNIQUE is one of the two idempotency guarantees. The other is
-- that `adjustment_id` is DERIVED from `external_ref` (a v5 uuid, see ids.js),
-- so the commerce-side INSERT OR IGNORE is idempotent on its own. Two are
-- needed because the two stores are different databases and ADR-002 forbids a
-- transaction across them: a crash between the two writes must not double-count
-- on the retry, whichever one landed first.

CREATE TABLE mirror_inventory_change (
  id            TEXT PRIMARY KEY,             -- ours
  external_ref  TEXT NOT NULL UNIQUE,         -- Square inventory-change id
  variant_id    TEXT REFERENCES mirror_variant(id),
  sku           TEXT NOT NULL,                -- snapshot; the commerce store has no FK to follow
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,                -- already in our vocabulary; see inventory.js
  kind          TEXT NOT NULL                 -- Square's own change type, kept verbatim
                  CHECK (kind IN ('PHYSICAL_COUNT','ADJUSTMENT','TRANSFER')),
  adjustment_id TEXT NOT NULL,                -- the commerce inventory_adjustment.id we wrote
  occurred_at   TEXT NOT NULL,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mirror_change_sku ON mirror_inventory_change (sku, occurred_at DESC);

-- ── sync bookkeeping ───────────────────────────────────────────────────────
--
-- Square's catalog webhook (`catalog.version.updated`) says only that SOMETHING
-- changed, never what. So the cursor here is what makes the follow-up a
-- SearchCatalogObjects since a timestamp rather than a full re-list every time.
--
-- 'catalog_full' tracks the periodic FULL ListCatalog sweep's own timestamp
-- (ops/src/sync.js's own FULL_SWEEP_INTERVAL_MS), independent of 'catalog'
-- itself — an incremental SearchCatalogObjects only ever asks for objects
-- Square considers recently updated, so a real relationship Square already
-- holds (a category's own parent_category, set once and never touched
-- again) can never resurface on an incremental sweep alone, no matter how
-- many of them run; only a genuine full sweep re-reads it. This row is what
-- lets that full sweep keep happening on its own, without anyone needing to
-- notice and trigger one by hand.

CREATE TABLE mirror_sync (
  id          TEXT PRIMARY KEY               -- 'catalog' | 'inventory' | 'catalog_full'
                CHECK (id IN ('catalog','inventory','catalog_full')),
  cursor      TEXT,
  ran_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ok          INTEGER NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT ''
);

-- ── nothing is deleted, and the database is what says so ───────────────────
--
-- ADR-008: "Deleting instead of archiving destroys evidence... Nothing
-- deletes; erasure is separate and narrow." A withdrawn product is a marker,
-- not a missing row, and a marker only holds if DELETE is refused rather than
-- merely avoided. Erasure (ADR-004) does not reach this store: it holds no
-- customer data at all.

CREATE TRIGGER mirror_product_no_delete BEFORE DELETE ON mirror_product
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_variant_no_delete BEFORE DELETE ON mirror_variant
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_image_no_delete BEFORE DELETE ON mirror_image
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_category_no_delete BEFORE DELETE ON mirror_category
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_vendor_no_delete BEFORE DELETE ON mirror_vendor
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_item_option_no_delete BEFORE DELETE ON mirror_item_option
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_item_option_value_no_delete BEFORE DELETE ON mirror_item_option_value
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

CREATE TRIGGER mirror_product_item_option_no_delete BEFORE DELETE ON mirror_product_item_option
BEGIN SELECT RAISE(ABORT, 'catalog mirror is archive-only; set archived_at'); END;

-- The ingest receipt is append-only for the same reason inventory_adjustment
-- is: editing it would let a re-sync double-count, and deleting it would let a
-- re-sync re-apply history that has already been applied.

CREATE TRIGGER mirror_change_append_only_update BEFORE UPDATE ON mirror_inventory_change
BEGIN SELECT RAISE(ABORT, 'inventory ingest receipts are append-only'); END;

CREATE TRIGGER mirror_change_append_only_delete BEFORE DELETE ON mirror_inventory_change
BEGIN SELECT RAISE(ABORT, 'inventory ingest receipts are append-only'); END;
