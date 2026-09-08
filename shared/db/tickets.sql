-- D1: tickets  -- company-wide issues.
--
-- Its own store rather than a table in another, on the ADR-002 rule: tickets
-- are read and written by everyone, while the stores they point AT are scoped
-- tightly. A ticket referencing an order must not drag commerce access along
-- with it, so links are id + label, resolved by a separate tool call the
-- caller's role may or may not be allowed to make.
--
-- WHY NOT GITHUB ISSUES
--   Tempting - free, notifications, a mobile app - and right for engineering
--   work. Wrong here: a ticket about a customer complaint will accumulate
--   names in its body, and GitHub issue history cannot be erased on request
--   any more than a Git commit can (ADR-001). Operational tickets stay where
--   erasure works. Engineering tickets can live in GitHub; nothing here stops
--   that.
--
-- NON-DESTRUCTIVE
--   Nothing is deleted. Tickets move through status; comments are append-only.
--   "Closing" is a status, not a removal, so a closed ticket is still evidence.

CREATE TABLE ticket (
  id          TEXT PRIMARY KEY,
  number      INTEGER UNIQUE,               -- human reference, e.g. VEM-114
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'other'
                CHECK (category IN ('stock','fulfilment','customer','site','supplier','facilities','other')),
  priority    TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low','normal','high','urgent')),
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_progress','blocked','resolved','closed')),
  created_by  TEXT NOT NULL,                -- Access identity; never a tool argument
  assigned_to TEXT,                         -- Access identity
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  archived_at TEXT                            -- rolled off the working set, never deleted
);
CREATE INDEX idx_ticket_status ON ticket (status, priority, created_at DESC);
CREATE INDEX idx_ticket_assignee ON ticket (assigned_to, status);

-- The working set: what an agent reads unless it asks for history.
CREATE VIEW ticket_index AS
SELECT id, number, title, category, priority, status, created_by, assigned_to, created_at
FROM ticket
WHERE archived_at IS NULL;

-- An open ticket cannot be quietly rolled off. Archiving is for settled work.
CREATE TRIGGER ticket_archive_only_settled BEFORE UPDATE OF archived_at ON ticket
WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
     AND NEW.status NOT IN ('resolved','closed')
BEGIN
  SELECT RAISE(ABORT, 'only a resolved or closed ticket can be rolled off');
END;

CREATE TABLE ticket_comment (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES ticket(id),
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comment_ticket ON ticket_comment (ticket_id, created_at);

-- Cross-store links. Id plus a label, never a foreign key: the referenced row
-- lives in another database and may be legitimately gone (an erased customer).
CREATE TABLE ticket_link (
  ticket_id   TEXT NOT NULL REFERENCES ticket(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('order','customer','product','sku','shift','expense')),
  entity_id   TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',     -- non-identifying, e.g. "order #1183"
  PRIMARY KEY (ticket_id, entity_type, entity_id)
);

CREATE TRIGGER ticket_no_delete BEFORE DELETE ON ticket
BEGIN SELECT RAISE(ABORT, 'tickets are closed, never deleted'); END;

CREATE TRIGGER comment_no_delete BEFORE DELETE ON ticket_comment
BEGIN SELECT RAISE(ABORT, 'ticket comments are append-only'); END;

CREATE TRIGGER comment_no_edit BEFORE UPDATE ON ticket_comment
BEGIN SELECT RAISE(ABORT, 'ticket comments are append-only; add another'); END;

-- A resolved or closed ticket must carry a timestamp, so "when was this dealt
-- with" is answerable without reading the comment history.
CREATE TRIGGER ticket_resolved_needs_time BEFORE UPDATE ON ticket
WHEN NEW.status IN ('resolved','closed') AND NEW.resolved_at IS NULL
BEGIN SELECT RAISE(ABORT, 'resolving a ticket requires resolved_at'); END;
