-- D1: assets -- files staff drop for the team and for agents to read.
--
-- New store on the ADR-002 rule (blast radius, not topic): a dropped file is
-- not customer data, not commerce, not people -- a working document with no
-- other home. The bytes live in KV (bound as ASSET_FILES in wrangler.toml,
-- reached only by the browser upload/download routes in src/index.js -- NOT
-- R2: ADR-013 dropped this Worker's one R2 bucket, and KV is already proven
-- to work in this account); this table is the index an agent tool actually
-- reads, plus whatever text could be extracted from the file at upload time.
--
-- WHY EXTRACTED TEXT IS STORED HERE, NOT RE-READ FROM KV ON EVERY CALL
--   assets.read is a T0 tool and has no KV binding of its own (agent-tool-
--   contract: a tool holds only the bindings it declares). Extraction runs
--   once, in the upload route, which does hold KV -- so a plain-text file's
--   content is a column read away for any later assets.list/assets.read call,
--   and the tool layer never touches the bytes at all.
--
-- APPEND ONLY. A newer version of a document is a new row, never an edit to
-- an old one -- same discipline as every other store here.

CREATE TABLE asset (
  id             TEXT PRIMARY KEY,
  store_key      TEXT NOT NULL UNIQUE,       -- the ASSET_FILES (KV) key holding the bytes
  filename       TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (size_bytes > 0),
  uploaded_by    TEXT NOT NULL,               -- Access identity; never a tool argument
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  extracted_text TEXT,                        -- NULL when this content type has no extraction yet
  text_truncated INTEGER NOT NULL DEFAULT 0 CHECK (text_truncated IN (0, 1))
);
CREATE INDEX idx_asset_uploaded ON asset (uploaded_at DESC);

CREATE TRIGGER asset_no_delete BEFORE DELETE ON asset
BEGIN SELECT RAISE(ABORT, 'assets are never deleted -- drop a newer file instead'); END;

CREATE TRIGGER asset_no_edit BEFORE UPDATE ON asset
BEGIN SELECT RAISE(ABORT, 'an asset row is append-only'); END;
