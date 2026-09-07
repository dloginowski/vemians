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
  id            TEXT PRIMARY KEY,           -- app-minted uuid; the ONLY id orders keep
  email         TEXT UNIQUE COLLATE NOCASE,
  phone         TEXT,
  name          TEXT,
  -- Store a birth year, not a full date of birth: enough for segmentation,
  -- materially less identifying, and less to lose. See ADR-003 on minimisation.
  birth_year    INTEGER CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100),
  notes         TEXT NOT NULL DEFAULT '',   -- clienteling notes
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
