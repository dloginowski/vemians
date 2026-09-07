-- D1: customers  -- customer profiles, clienteling data, consent.
--
-- WHY THIS IS NOT IN GIT (see ADR-003)
--   Git history is immutable: deleting a file leaves the content retrievable
--   forever, in every clone and fork. This store holds name, phone, age and
--   body measurements, all subject to erasure requests under GDPR Art.17 and
--   CCPA. A repository cannot honour those. Deletes here are real deletes.
--
-- WHY IT IS SEPARATE FROM commerce
--   Erasure and tax retention pull in opposite directions: the profile must be
--   destroyable on request, while order records must be retained for tax. With
--   the PII isolated here, erasing a customer deletes this row and leaves the
--   orders intact and anonymous. That is only possible because they are split.

CREATE TABLE customer (
  id            TEXT PRIMARY KEY,           -- app-minted uuid; opaque everywhere
  -- NO name, email or phone. Direct identifiers live only in the `identity`
  -- store, so most tools can be bound here and see a customer's profile
  -- without ever seeing who they are.
  -- Store a birth year, not a full date of birth: enough for segmentation,
  -- materially less identifying, and less to lose. See ADR-003 on minimisation.
  birth_year    INTEGER CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100),
  notes         TEXT NOT NULL DEFAULT '',   -- clienteling notes; see ADR-004 warning
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fitting profile. Intimate personal data - kept in its own table so it can be
-- dropped independently of the contact record, and so tools can be bound to one
-- without the other.
CREATE TABLE customer_fit (
  customer_id  TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  garment      TEXT NOT NULL,               -- 'tops' | 'trousers' | 'shoes' | ...
  size_label   TEXT,                        -- 'IT 42', 'EU 38'
  measurements TEXT NOT NULL DEFAULT '{}',  -- JSON; optional, often absent
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (customer_id, garment)
);

-- Consent is per-purpose and must be evidenced with a timestamp and source.
CREATE TABLE customer_consent (
  customer_id  TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('marketing','profiling','fit_profile')),
  granted      INTEGER NOT NULL,
  source       TEXT NOT NULL,               -- 'checkout' | 'in_store' | 'email'
  recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (customer_id, purpose)
);

-- Erasure requests are logged so we can evidence compliance. The log holds the
-- id only - never a copy of what was erased, which would defeat the point.
CREATE TABLE erasure_request (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,               -- deliberately no FK: outlives the row
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  method       TEXT NOT NULL DEFAULT 'request' CHECK (method IN ('request','retention'))
);

CREATE TRIGGER erasure_log_append_only BEFORE DELETE ON erasure_request
BEGIN SELECT RAISE(ABORT, 'erasure_request is evidence and cannot be deleted'); END;


-- Reversibility WITHOUT immutability.
--
-- The requirement was that employee edits be non-destructive and revertible,
-- like a git commit. That is a property of the data model, not of the storage
-- engine: an append-only change log gives undo and full history here, while
-- still allowing a real delete when erasure is required. Git gives the first
-- and forecloses the second.
CREATE TABLE customer_version (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,                          -- non-identifying fields only
  new_value   TEXT,
  actor       TEXT NOT NULL,                 -- Workspace identity via Access
  reverts     INTEGER REFERENCES customer_version(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_version_customer ON customer_version (customer_id, created_at DESC);

CREATE TRIGGER version_no_update BEFORE UPDATE ON customer_version
BEGIN SELECT RAISE(ABORT, 'customer_version is append-only; append a revert instead'); END;

-- Erasure is the ONE permitted deletion: a right-to-erasure request must reach
-- the change history too, or old values survive the erasure.
CREATE TRIGGER version_delete_only_for_erasure BEFORE DELETE ON customer_version
WHEN NOT EXISTS (SELECT 1 FROM erasure_request
                  WHERE customer_id = OLD.customer_id AND completed_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'history is deletable only under an open erasure request'); END;
