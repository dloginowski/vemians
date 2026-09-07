-- D1: audit  -- append-only record of every agent action, across all domains.
-- Separate so it survives a mistake in any other store, and so the application
-- can hold insert-only credentials here.

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor        TEXT NOT NULL,               -- Google Workspace identity via Access
  on_behalf_of TEXT,                        -- the human, when the actor is an agent
  domain       TEXT NOT NULL                -- which store the action touched
                 CHECK (domain IN ('catalog','commerce','people','finance','knowledge')),
  tool         TEXT NOT NULL,
  arguments    TEXT NOT NULL DEFAULT '{}',  -- JSON
  result       TEXT NOT NULL
                 CHECK (result IN ('ok','error','denied','pending_approval')),
  detail       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log (actor, created_at DESC);
CREATE INDEX idx_audit_domain ON audit_log (domain, created_at DESC);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted'); END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not permitted'); END;
