-- A style_id, once given to ANY product, is never handed to a different one
-- — see shared/commerce/square/schema.sql's own comment on this table for
-- the full reasoning. This is the delta half of that change; schema.sql is
-- the canonical full description, kept in sync by hand.

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

-- Backfill: every style_id already live on a product today is retroactively
-- recorded as if it had always been ledgered, so this migration never opens
-- a window where a number already in active use could be claimed by a
-- second product. MIN(id) picks one arbitrarily on the vanishingly unlikely
-- chance two products already share a style_id from before this table
-- existed — the same conflict the live application code already prevents
-- going forward, so there is no "correct" one to prefer here.
INSERT INTO mirror_style_id_ledger (style_id, product_id, assigned_at)
SELECT style_id, MIN(id), datetime('now')
  FROM mirror_product
 WHERE style_id IS NOT NULL AND style_id != ''
 GROUP BY style_id;
