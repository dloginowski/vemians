/*
 * The upload ledger: one ingest_job per uploaded file being applied, one
 * ingest_row per row in it, each with its own "submitted" check.
 *
 *   "We need to have an upload database, like an ingest table that matches,
 *    that is based on file name that's being uploaded. And it needs to have
 *    its own submitted check field. And so every time you hit submit, it goes
 *    through this once... as it finishes the job, it checks off every one of
 *    these fields, and then you know the job is done. But it will never run
 *    more than once per submit click." -- the owner's own words.
 *
 * THE RULES THIS FILE ENFORCES, so no caller has to remember them:
 *
 *   - One live job per file. createJob supersedes any other open job for the
 *     same person and file name, and findOpenJob lets the caller reuse the
 *     open job for the same upload instead of planning it all over again.
 *   - A run is one Submit click. startRun mints a run id and selects the rows
 *     that click asked for; a row can only be claimed under the CURRENT run id,
 *     so a stale tab, a retry or a second click can never run rows a newer
 *     click owns.
 *   - A row runs at most once, ever. claimRow is a single conditional UPDATE
 *     (claimed_at IS NULL) -- the claim IS the lock -- and a claimed row is
 *     never selected by a later click, whatever happened to it afterwards.
 *   - A row is "submitted" (the check) only once it has finished and its
 *     outcome is written. A row that was claimed but never finished stays
 *     claimed and unchecked -- shown honestly as "outcome unknown", never
 *     retried automatically, because it may well have been applied.
 *   - The job is "done" when no unclaimed row is left; until then it is
 *     "ready" between clicks and "running" during one.
 *
 * WHY A TABLE PER ROW AND NOT ONE JSON BLOB (what this replaces,
 * agent_batch_plan): every row finishing used to rewrite the whole remaining
 * plan as a single value, hundreds of KB for a big sheet. Now it is a handful
 * of tiny single-row statements, and a failed one costs one row's bookkeeping
 * rather than a whole plan's.
 *
 * THE SCHEMA CREATES ITSELF. The assets database has no automated migration
 * (wrangler.toml: only the catalog mirror does), so a table added here would
 * otherwise need a person to run a one-off command before the first upload
 * after deploy. Every statement is CREATE ... IF NOT EXISTS and is only run
 * when a query reports a missing ingest table, so the normal path pays
 * nothing. shared/db/assets.sql holds the same definitions for a fresh
 * database; a test pins the two to the same columns.
 */

export const INGEST_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ingest_job (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  role       TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  filename   TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('add', 'update')),
  status     TEXT NOT NULL DEFAULT 'ready'
               CHECK (status IN ('ready', 'running', 'done', 'cancelled', 'superseded')),
  run_id     TEXT,
  runs       INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  "CREATE INDEX IF NOT EXISTS idx_ingest_job_file ON ingest_job (actor, filename, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_ingest_job_asset ON ingest_job (actor, asset_id, mode, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS ingest_row (
  job_id             TEXT NOT NULL REFERENCES ingest_job (id),
  row_key            INTEGER NOT NULL,
  display_row        INTEGER NOT NULL,
  title              TEXT NOT NULL,
  sheet_style_id     TEXT NOT NULL DEFAULT '',
  category           TEXT NOT NULL DEFAULT '',
  subcategory        TEXT NOT NULL DEFAULT '',
  changes            TEXT NOT NULL DEFAULT '',
  summary            TEXT NOT NULL DEFAULT '',
  flag               TEXT CHECK (flag IN ('duplicate', 'confirm')),
  flag_reason        TEXT,
  payload            TEXT NOT NULL,
  queued_run         TEXT,
  claimed_at         TEXT,
  submitted          INTEGER NOT NULL DEFAULT 0 CHECK (submitted IN (0, 1)),
  outcome            TEXT CHECK (outcome IN ('created', 'updated', 'unchanged', 'parked', 'skipped', 'failed')),
  detail             TEXT,
  result_style_id    TEXT,
  result_category    TEXT,
  result_subcategory TEXT,
  submitted_at       TEXT,
  PRIMARY KEY (job_id, row_key)
)`,
  "CREATE INDEX IF NOT EXISTS idx_ingest_row_open ON ingest_row (job_id, claimed_at)",
];

export async function ensureIngestSchema(db) {
  for (const statement of INGEST_SCHEMA) await db.prepare(statement).run();
}

const MISSING_TABLE = /no such table:?\s*ingest_/i;
const isMissingTable = (err) => MISSING_TABLE.test(String(err?.message ?? err));

/* Writes: if the ingest tables are not there yet, create them and try once more. */
async function withSchema(db, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    await ensureIngestSchema(db);
    return fn();
  }
}

/* Reads: no ingest tables yet simply means nothing has ever been ingested. */
async function readOr(empty, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isMissingTable(err)) return empty;
    throw err;
  }
}

/* A run that has made no progress for this long is treated as abandoned (a
   closed tab, a phone that went to sleep), so a person is never locked out of
   their own upload by a run that is not actually running. */
export const RUN_STALE_SECONDS = 120;

const flagOf = (r) => (r.possibleDuplicate ? "duplicate" : r.needsConfirmation ? "confirm" : null);
const flagReasonOf = (r) => (r.possibleDuplicate ? (r.duplicateReason ?? null) : r.needsConfirmation ? (r.confirmReason ?? null) : null);

const rowRecord = (r) => ({
  key: r.rowNumber,
  display: r.displayRow ?? r.rowNumber,
  title: r.title ?? "",
  style: r.sheetStyleId ?? "",
  category: r.category ?? "",
  subcategory: r.subcategory ?? "",
  changes: r.changes ?? "",
  summary: r.summary ?? "",
  flag: flagOf(r),
  flagReason: flagReasonOf(r),
  payload: r,
});

const INSERT_COLUMNS =
  "job_id, row_key, display_row, title, sheet_style_id, category, subcategory, changes, summary, flag, flag_reason, payload";

async function insertRows(db, jobId, rows) {
  const records = rows.map(rowRecord);
  /* One statement for the whole sheet: the plan request that makes this
     already spends most of its per-request query budget, so it must not add
     a query per row. */
  try {
    await db
      .prepare(
        `INSERT INTO ingest_row (${INSERT_COLUMNS})
         SELECT ?, json_extract(value, '$.key'), json_extract(value, '$.display'), json_extract(value, '$.title'),
                json_extract(value, '$.style'), json_extract(value, '$.category'), json_extract(value, '$.subcategory'),
                json_extract(value, '$.changes'), json_extract(value, '$.summary'), json_extract(value, '$.flag'),
                json_extract(value, '$.flagReason'), json_extract(value, '$.payload')
           FROM json_each(?)`,
      )
      .bind(jobId, JSON.stringify(records))
      .run();
    return;
  } catch (err) {
    if (isMissingTable(err)) throw err;
    console.error(`ERROR ingest: bulk row insert failed, falling back to one statement per row -- ${err.message}`);
  }
  /* Slower, never wrong: the same rows, one statement each. A partial failure
     part-way through leaves some rows behind, which the caller's own failure
     handling (createJob) cancels as a whole. */
  for (const r of records) {
    await db
      .prepare(`INSERT INTO ingest_row (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(jobId, r.key, r.display, r.title, r.style, r.category, r.subcategory, r.changes, r.summary, r.flag, r.flagReason, JSON.stringify(r.payload))
      .run();
  }
}

/*
 * A new job for a planned sheet. Any OTHER open job for the same person and
 * file name is superseded -- there is only ever one live job per file -- but
 * only after this one is safely in, so a failed insert never costs a person
 * the job they already had.
 */
export async function createJob(db, { actor, role, assetId, filename, mode, rows }) {
  const id = crypto.randomUUID();
  await withSchema(db, async () => {
    await db
      .prepare("INSERT INTO ingest_job (id, actor, role, asset_id, filename, mode, total) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, actor, role, assetId, filename, mode, rows.length)
      .run();
    try {
      await insertRows(db, id, rows);
    } catch (err) {
      await db.prepare("UPDATE ingest_job SET status = 'cancelled' WHERE id = ?").bind(id).run().catch(() => {});
      throw err;
    }
    await db
      .prepare(
        "UPDATE ingest_job SET status = 'superseded', run_id = NULL, updated_at = datetime('now')" +
          " WHERE actor = ? AND filename = ? AND id <> ? AND status IN ('ready', 'running')",
      )
      .bind(actor, filename, id)
      .run();
  });
  return id;
}

/* The open job (if any) for exactly this upload: same person, same stored
   file, same mode, with at least one row nobody has claimed yet. */
export async function findOpenJob(db, { actor, assetId, mode }) {
  const row = await readOr(null, () =>
    db
      .prepare(
        `SELECT j.id FROM ingest_job j
          WHERE j.actor = ? AND j.asset_id = ? AND j.mode = ? AND j.status IN ('ready', 'running')
            AND EXISTS (SELECT 1 FROM ingest_row r WHERE r.job_id = j.id AND r.claimed_at IS NULL)
          ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1`,
      )
      .bind(actor, assetId, mode)
      .first(),
  );
  return row?.id ?? null;
}

/* The checklist a person sees for a job: every row nobody has claimed yet,
   plus how far the job already got. Same shape whether freshly planned or
   found again after a reload. */
export async function checklistFor(db, id) {
  const job = await db.prepare("SELECT id, total FROM ingest_job WHERE id = ?").bind(id).first();
  if (!job) return null;
  const claimed = await db
    .prepare("SELECT COUNT(*) AS n FROM ingest_row WHERE job_id = ? AND claimed_at IS NOT NULL")
    .bind(id)
    .first();
  const res = await db
    .prepare(
      `SELECT row_key, display_row, title, summary, sheet_style_id, category, subcategory, changes, flag, flag_reason
         FROM ingest_row WHERE job_id = ? AND claimed_at IS NULL ORDER BY rowid`,
    )
    .bind(id)
    .all();
  return {
    id: job.id,
    done: Number(claimed?.n ?? 0),
    total: job.total,
    rows: (res.results ?? []).map((r) => ({
      row: r.row_key,
      displayRow: r.display_row,
      title: r.title,
      summary: r.summary,
      sheetStyleId: r.sheet_style_id,
      category: r.category,
      subcategory: r.subcategory,
      changes: r.changes,
      possibleDuplicate: r.flag === "duplicate",
      duplicateReason: r.flag === "duplicate" ? (r.flag_reason ?? undefined) : undefined,
      needsConfirmation: r.flag === "confirm",
      confirmReason: r.flag === "confirm" ? (r.flag_reason ?? undefined) : undefined,
    })),
  };
}

/*
 * This person's own unfinished upload, if there is one worth showing again on
 * a page load -- the same job a reload used to find, with the same
 * Test-PRD-P0-196 rule: once something has been done from it, a job whose
 * every remaining row is one nobody checks by default (a possible duplicate,
 * a stock correction awaiting confirmation) is settled, not paused, and is
 * not shown again.
 */
export async function openJobFor(db, actor) {
  const found = await readOr(null, () =>
    db
      .prepare(
        `SELECT j.id,
                (SELECT COUNT(*) FROM ingest_row r WHERE r.job_id = j.id AND r.claimed_at IS NOT NULL) AS claimed,
                (SELECT COUNT(*) FROM ingest_row r WHERE r.job_id = j.id AND r.claimed_at IS NULL AND r.flag IS NULL) AS plain
           FROM ingest_job j
          WHERE j.actor = ? AND j.status IN ('ready', 'running')
            AND EXISTS (SELECT 1 FROM ingest_row r WHERE r.job_id = j.id AND r.claimed_at IS NULL)
          ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1`,
      )
      .bind(actor)
      .first(),
  );
  if (!found) return null;
  if (Number(found.claimed) > 0 && Number(found.plain) === 0) return null;
  return checklistFor(db, found.id);
}

const refusal = (httpStatus, reply) => ({ ok: false, httpStatus, reply });

/* Select the rows a click asked for. One statement over the whole list; if
   that is refused, the same selection in chunks of plain IN lists (a
   statement may bind only so many parameters), which every SQLite speaks. */
async function selectRows(db, { id, runId, keys }) {
  if (keys.length === 0) return 0;
  try {
    const res = await db
      .prepare(
        "UPDATE ingest_row SET queued_run = ? WHERE job_id = ? AND claimed_at IS NULL AND row_key IN (SELECT value FROM json_each(?))",
      )
      .bind(runId, id, JSON.stringify(keys))
      .run();
    return Number(res?.meta?.changes ?? 0);
  } catch (err) {
    if (isMissingTable(err)) throw err;
    console.error(`ERROR ingest: selecting rows with json_each failed, falling back to chunked IN lists -- ${err.message}`);
  }
  let count = 0;
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const res = await db
      .prepare(
        `UPDATE ingest_row SET queued_run = ? WHERE job_id = ? AND claimed_at IS NULL AND row_key IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(runId, id, ...chunk)
      .run();
    count += Number(res?.meta?.changes ?? 0);
  }
  return count;
}

/*
 * One Submit click. Clears whatever the previous click had selected, then
 * selects exactly the rows this one asked for (rows already claimed are never
 * selected -- a row is never run twice). Refuses while a fresh run is still
 * going, so a double tap or a second tab cannot start a second one.
 */
export async function startRun(db, { id, actor, keys }) {
  return withSchema(db, async () => {
    const job = await db
      .prepare("SELECT actor, status FROM ingest_job WHERE id = ?")
      .bind(id)
      .first();
    if (!job) return refusal(404, "That batch is unknown or has expired. Nothing was run.");
    if (job.actor !== actor) return refusal(403, "That batch belongs to a different person.");
    if (job.status !== "ready" && job.status !== "running") {
      return refusal(404, "That batch is finished or was cancelled. Nothing was run.");
    }

    const runId = crypto.randomUUID();
    /* The conditional UPDATE is the real guard: only a job that is idle, or
       whose last run has gone quiet, can be taken over -- and exactly one of
       two simultaneous clicks can win it. A run is "quiet" when neither the
       job nor any of its rows has moved for RUN_STALE_SECONDS. */
    const taken = await db
      .prepare(
        `UPDATE ingest_job
            SET status = 'running', run_id = ?, runs = runs + 1, updated_at = datetime('now')
          WHERE id = ?
            AND (status = 'ready'
                 OR (status = 'running'
                     AND updated_at <= datetime('now', '-${RUN_STALE_SECONDS} seconds')
                     AND NOT EXISTS (SELECT 1 FROM ingest_row r
                                      WHERE r.job_id = ingest_job.id AND r.claimed_at > datetime('now', '-${RUN_STALE_SECONDS} seconds'))))`,
      )
      .bind(runId, id)
      .run();
    if (Number(taken?.meta?.changes ?? 0) !== 1) {
      return refusal(
        409,
        "A run is already in progress for this file, so nothing new was started. If that tab is gone, press Submit again in a couple of minutes.",
      );
    }

    await db.prepare("UPDATE ingest_row SET queued_run = NULL WHERE job_id = ? AND queued_run IS NOT NULL").bind(id).run();
    const count = await selectRows(db, { id, runId, keys });
    if (count === 0) await settleRun(db, { id, runId });
    return { ok: true, httpStatus: 200, runId, queued: count };
  });
}

/*
 * Claim one row for the current run, atomically: a single UPDATE that only
 * succeeds if the row was selected by THIS run, nobody has claimed it, and
 * the run is still the job's current one. On success it hands back the
 * planned row to execute. When it does not succeed, a second, read-only
 * lookup says why (the common path stays one query).
 */
export async function claimRow(db, { id, runId, key, actor }) {
  return withSchema(db, async () => {
    const res = await db
      .prepare(
        `UPDATE ingest_row SET claimed_at = datetime('now')
          WHERE job_id = ? AND row_key = ? AND queued_run = ? AND claimed_at IS NULL
            AND EXISTS (SELECT 1 FROM ingest_job j
                         WHERE j.id = ingest_row.job_id AND j.actor = ? AND j.status = 'running' AND j.run_id = ?)
        RETURNING payload`,
      )
      .bind(id, key, runId, actor, runId)
      .all();
    const claimed = (res.results ?? [])[0];
    if (claimed) return { ok: true, payload: JSON.parse(claimed.payload) };

    const job = await db.prepare("SELECT actor, status, run_id FROM ingest_job WHERE id = ?").bind(id).first();
    if (!job) return refusal(404, "That batch is unknown or has expired. Nothing was run.");
    if (job.actor !== actor) return refusal(403, "That batch belongs to a different person.");
    if (job.status !== "running" || job.run_id !== runId) {
      return refusal(409, "That run is over -- a newer Submit click replaced it, or the batch was cancelled. Nothing was run.");
    }
    return refusal(404, "That row is unknown, already submitted, or was never part of this run.");
  });
}

/* The row's own outcome, and the check. Written after the row has run. */
export async function finishRow(db, { id, key, outcome, detail, styleId, category, subcategory }) {
  await withSchema(db, () =>
    db
      .prepare(
        `UPDATE ingest_row
            SET submitted = 1, outcome = ?, detail = ?, result_style_id = ?, result_category = ?, result_subcategory = ?,
                submitted_at = datetime('now')
          WHERE job_id = ? AND row_key = ?`,
      )
      .bind(outcome, detail ?? null, styleId ?? null, category ?? null, subcategory ?? null, id, key)
      .run(),
  );
}

/* The run is over once every row it selected has been checked off: the job is
   "done" if nothing is left unclaimed, otherwise "ready" for another click.
   A no-op until the last selected row finishes. */
export async function settleRun(db, { id, runId }) {
  await withSchema(db, () =>
    db
      .prepare(
        `UPDATE ingest_job
            SET status = CASE WHEN EXISTS (SELECT 1 FROM ingest_row WHERE job_id = ? AND claimed_at IS NULL)
                              THEN 'ready' ELSE 'done' END,
                run_id = NULL, updated_at = datetime('now')
          WHERE id = ? AND run_id = ? AND status = 'running'
            AND NOT EXISTS (SELECT 1 FROM ingest_row WHERE job_id = ? AND queued_run = ? AND submitted = 0)`,
      )
      .bind(id, id, runId, id, runId)
      .run(),
  );
}

/* Cancel keeps the rows (the history of what was in the file stays); the job
   simply stops being open, so nothing resumes it and no run can claim from it. */
export async function cancelJob(db, { id, actor }) {
  return withSchema(db, async () => {
    const job = await db.prepare("SELECT actor FROM ingest_job WHERE id = ?").bind(id).first();
    if (!job) return { ok: true, httpStatus: 200 };
    if (job.actor !== actor) return refusal(403, "That batch belongs to a different person.");
    await db
      .prepare(
        "UPDATE ingest_job SET status = 'cancelled', run_id = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('ready', 'running')",
      )
      .bind(id)
      .run();
    return { ok: true, httpStatus: 200 };
  });
}
