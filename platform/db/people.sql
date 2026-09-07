-- D1: people  -- employees and scheduling.
-- The most sensitive store. Gated behind its own Cloudflare Access policy,
-- separate from general staff access. Payroll is NOT here - it stays with the
-- payroll provider.

CREATE TABLE employee (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- matches the Access identity
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'staff'
               CHECK (role IN ('staff','manager','owner')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shift (
  id          TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employee(id) ON DELETE SET NULL,
  location_id TEXT,                          -- commerce.location; id only, no FK
  starts_at   TEXT NOT NULL,                 -- ISO-8601 UTC
  ends_at     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled','confirmed','cancelled','completed')),
  notes       TEXT NOT NULL DEFAULT '',
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_shift_start ON shift (starts_at);

-- Postgres would express this as EXCLUDE USING gist. SQLite has no such
-- constraint, but D1 serialises writes to a single writer, so a trigger check
-- is race-free here in a way an application-level read-then-write is not.
-- This is what stops the agent double-booking someone (PRD R4.2).
CREATE TRIGGER shift_no_overlap_insert BEFORE INSERT ON shift
WHEN NEW.status IN ('scheduled','confirmed')
BEGIN
  SELECT RAISE(ABORT, 'shift overlaps an existing booking for this employee')
  WHERE EXISTS (
    SELECT 1 FROM shift
    WHERE employee_id = NEW.employee_id
      AND status IN ('scheduled','confirmed')
      AND id <> NEW.id
      AND NEW.starts_at < ends_at
      AND NEW.ends_at > starts_at          -- half-open: back-to-back is legal
  );
END;

CREATE TRIGGER shift_no_overlap_update BEFORE UPDATE ON shift
WHEN NEW.status IN ('scheduled','confirmed')
BEGIN
  SELECT RAISE(ABORT, 'shift overlaps an existing booking for this employee')
  WHERE EXISTS (
    SELECT 1 FROM shift
    WHERE employee_id = NEW.employee_id
      AND status IN ('scheduled','confirmed')
      AND id <> NEW.id
      AND NEW.starts_at < ends_at
      AND NEW.ends_at > starts_at
  );
END;
