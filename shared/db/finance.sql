-- D1: finance  -- expenses and budgets.
-- NOT a ledger of record. Books stay in the accounting provider; this store
-- exists so the agent can reason about spend and so expense reports have a home.
-- Retention is driven by tax rules (typically 7 years), which is why this is
-- separate from stores subject to erasure requests.

CREATE TABLE vendor (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE budget (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  period       TEXT NOT NULL,                -- '2026-Q3' | '2026-09'
  limit_minor  INTEGER NOT NULL CHECK (limit_minor >= 0),
  currency     TEXT NOT NULL,
  UNIQUE (name, period)
);

CREATE TABLE expense (
  id             TEXT PRIMARY KEY,
  budget_id      TEXT REFERENCES budget(id) ON DELETE SET NULL,
  vendor_id      TEXT REFERENCES vendor(id) ON DELETE SET NULL,
  -- people.employee lives in another database. Id for linking, name snapshot so
  -- the report stays readable without a cross-database read.
  employee_id    TEXT,
  employee_name  TEXT,
  description    TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  incurred_on    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','approved','rejected','reimbursed')),
  approved_by    TEXT,                       -- Access identity of the approver
  approved_at    TEXT,
  receipt_key TEXT,                       -- the RECEIPT_FILES (KV) key; receipts never live inline
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expense_budget ON expense (budget_id);
CREATE INDEX idx_expense_incurred ON expense (incurred_on DESC);

-- An approved expense is a financial record: it must not be edited in place.
CREATE TRIGGER expense_approved_immutable BEFORE UPDATE ON expense
WHEN OLD.status IN ('approved','reimbursed') AND NEW.status = OLD.status
BEGIN
  SELECT RAISE(ABORT, 'an approved expense cannot be edited; reverse it instead');
END;
