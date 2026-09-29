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

-- Durable bookkeeping for the chat agent's own in-progress batch-import
-- workflow (preview -> confirm -> checklist -> submit). Added after several
-- Worker redeploys in one real working session wiped this out from under the
-- owner mid-task -- "you should not be losing files like this," their own
-- words. The FILE itself was never actually lost (the `asset` table above is
-- durable and always was); what WAS lost was only the chat's own in-memory
-- notes of which asset was currently active and what its already-reviewed
-- row plan was, kept in a plain per-isolate Map that a redeploy (or any
-- ordinary isolate recycle) discards outright. These two tables replace
-- those two Maps with the identical shape, just durable.
--
-- UNLIKE `asset` ABOVE, THESE ARE NOT STRICTLY APPEND-ONLY.
--   `asset` is a business record of a file someone dropped; these are this
--   Worker's own internal notes about an in-progress chat turn, closer in
--   kind to the in-memory approval/rate-limit state elsewhere in this
--   codebase than to a record anything downstream reads. `agent_batch_plan`
--   rows ARE updated in place as a person submits checklist rows one at a
--   time (the previous in-memory shape spliced `plan.rows` the same way) --
--   but a fully-submitted plan is never deleted, only left with an empty
--   `rows` array: "these are small spreadsheet files, so it's better to just
--   have them than get rid of them every time," the owner's own words.

-- Which asset an actor most recently previewed, per batch kind ("products" or
-- "customers") -- catalog_add_product_batch/catalog_update_product_batch/
-- customer_draft_customer_batch all resolve "the file this draft call means"
-- from this, never the model's own (easily forgotten) copy of the asset id.
-- INSERT-ONLY: a fresh preview never erases an earlier one, it simply becomes
-- the new most-recent row for that actor+kind (MAX(created_at), or just
-- MAX(id) -- cheaper, and id is already monotonic). "We want to make sure
-- that we keep track of at least a few files... in sequence... it's better
-- to just have them than get rid of them every time" -- the owner's own
-- words: nothing here ever deletes an older preview record.
CREATE TABLE agent_last_preview (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  batch_kind TEXT NOT NULL CHECK (batch_kind IN ('products', 'customers')),
  asset_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_last_preview_lookup ON agent_last_preview (actor, batch_kind, id DESC);

-- A stashed catalog_add_product_batch/catalog_update_product_batch plan --
-- the reviewed checklist a person is submitting row by row
-- (submitBatchPlanRow, agent.js). `rows` is the JSON-encoded array of
-- not-yet-submitted rows, shrinking (never growing) as each is picked up and
-- spent -- the exact in-place mutation the previous in-memory Map's own
-- `plan.rows.splice(...)` already did, just persisted here instead of lost
-- the moment the isolate holding it goes away. `rate` is deliberately NOT
-- stored: it is a live, in-memory call-rate counter with no serializable
-- shape (createRateLimiter, tools/rate.js), and a plan resuming after a
-- fresh isolate simply gets a fresh one -- a strictly more permissive reset,
-- never a less safe one, for a limiter whose whole job is bounding one
-- isolate's own retry storms, not a security boundary.
CREATE TABLE agent_batch_plan (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  role       TEXT NOT NULL,
  rows       TEXT NOT NULL,   -- JSON array, planProductBatch's own row shape
  done       INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_batch_plan_actor ON agent_batch_plan (actor, created_at DESC);
