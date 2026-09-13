/*
 * The fetch-and-store job schema.sql already left a column for:
 *
 *   -- The URL is Square's CDN. We hold the reference so the mirror is
 *   -- complete; the originals we serve are ours in R2 (Test-PRD-P0-28-
 *   -- image_contract), and `media_key` is where the R2 key lands once the
 *   -- fetch-and-store job runs.
 *
 * `syncCatalog` (shared/commerce/square/mirror.js) writes `source_url` for
 * every photograph Square has and never names `media_key` in its own
 * INSERT/UPDATE, on purpose — a value this file sets survives every future
 * re-sync untouched, the same guarantee `channel` and `handle` already rely
 * on. This is that job: for every mirrored image with a `source_url` and no
 * `media_key` yet, fetch the bytes off Square's CDN once and store OUR OWN
 * copy under OUR OWN key, then record the key. Test-PRD-P0-73-real_photography.
 *
 * ─── WHY THIS RUNS HERE, AND NOT INSIDE mirror.js ───────────────────────────
 * `syncCatalog` maps Square's API shape onto our rows; it holds no R2 binding
 * and makes no fetch of its own beyond the provider's API, and mixing "what
 * Square just told us" with "go fetch a photograph from a URL Square handed
 * back" would blur the one thing that file exists to keep narrow. This job
 * runs AFTER a sync, over whatever the mirror now holds, from `ops/src/index.js`'s
 * `scheduled` handler — a second, independent step with its own failure mode:
 * a photograph that fails to backfill must never mark the catalog sync itself
 * as failed, and the next run just tries it again.
 *
 * ─── SILENT NO-OP WITHOUT A BUCKET ──────────────────────────────────────────
 * Exactly like `mediaStoreFor` (tools/index.js) picks Square when `MEDIA` is
 * unbound, this job picks "do nothing" — not an error, because a Square-only
 * deployment (ADR-013's original default) is a valid, supported state and a
 * cron line should not read as broken every fifteen minutes because of it.
 *
 * ─── ONE FETCH FAILURE NEVER TAKES DOWN THE BATCH ───────────────────────────
 * Square's CDN can 404, time out or return something odd for any one
 * photograph without that being true of the rest — the same reasoning
 * batch.js applies to a bad spreadsheet row: report it, keep going, let the
 * next run try again since `media_key IS NULL` still selects it.
 */
import { contentTypeFor, mediaKey } from "./tools/media.js";
import { CAPS } from "./tools/caps.js";

/**
 * @param env    CATALOG_MIRROR. Read only if `mirrorDb` is not supplied.
 * @param opts   { mirrorDb, media, fetchImpl, now } — injection seams for
 *               tests; `media` is the store `mediaStoreFor(env)` already
 *               built (tools/index.js), so this file never constructs one
 *               itself and never decides R2-vs-Square on its own.
 * @returns {Promise<{attempted: number, backfilled: number, failed: number}>}
 */
export async function backfillMedia(env, opts = {}) {
  const db = opts.mirrorDb ?? env?.CATALOG_MIRROR ?? null;
  const zero = { attempted: 0, backfilled: 0, failed: 0 };

  if (!db?.prepare) {
    console.warn("WARNING media-backfill: no CATALOG_MIRROR binding — nothing to back-fill");
    return zero;
  }

  const media = opts.media;
  if (!media || media.kind !== "r2") {
    /* Square-only (no MEDIA bucket bound): source_url already points at a
       real, working Square CDN url. There is nowhere of ours to copy it to
       yet, so store/src/catalog.js keeps serving the placeholder for these —
       correct, not a failure. */
    console.info("INFO media-backfill: no R2-backed media store bound — photographs stay Square-hosted for now");
    return zero;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());

  let rows;
  try {
    rows = (
      await db
        .prepare(
          `SELECT id, external_ref, source_url FROM mirror_image
             WHERE media_key IS NULL AND archived_at IS NULL AND source_url != ''
             ORDER BY synced_at LIMIT ?`,
        )
        .bind(CAPS.MEDIA_BACKFILL_MAX_PER_RUN)
        .all()
    )?.results ?? [];
  } catch (err) {
    console.error(`ERROR media-backfill: could not read mirror_image — ${err.message}`);
    return zero;
  }

  let backfilled = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const res = await fetchImpl(row.source_url);
      if (!res.ok) throw new Error(`Square's CDN answered HTTP ${res.status}`);
      const contentType = contentTypeFor(row.source_url, res.headers.get("content-type"));
      if (!contentType) throw new Error(`could not tell what image type ${row.source_url} is`);
      const bytes = new Uint8Array(await res.arrayBuffer());

      const key = mediaKey(contentType, { now });
      await media.put(key, bytes, { contentType, actor: "system:media-backfill" });
      await db.prepare("UPDATE mirror_image SET media_key = ? WHERE id = ?").bind(key, row.id).run();
      backfilled += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `ERROR media-backfill: ${row.external_ref} (${row.source_url}) did not back fill — ${err.message}. ` +
          "Will retry on the next scheduled run.",
      );
    }
  }

  console.info(
    `INFO media-backfill: ${backfilled} backfilled, ${failed} failed, of ${rows.length} attempted this run`,
  );
  return { attempted: rows.length, backfilled, failed };
}
