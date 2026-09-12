/*
 * The scheduled mirror sync — the thing that actually runs the Square adapter.
 *
 * Test-PRD-P0-48-scheduled_mirror_sync.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * shared/commerce/square/ was complete and tested and NOTHING CALLED IT. A
 * mirror that nothing fills is not a mirror, it is an empty table with a good
 * schema, and ADR-009's central promise — "we still hold a full mirror... if
 * Square goes away we keep the data" — is only true of a mirror something
 * writes to on a schedule. This is that something: a `scheduled` handler on the
 * ops Worker plus a cron trigger in wrangler.toml, and nothing else.
 *
 * ─── AND WHY IT HOLDS NO MAPPING LOGIC ─────────────────────────────────────
 *
 * Every line below is orchestration: which sweep to ask for, what to log, what
 * to record. The pulling, normalising, upserting, archiving and ledger-writing
 * are `adapter.pullCatalog` and `adapter.pullInventory`, which the adapter's own
 * suite covers — including the idempotency this handler depends on and does not
 * re-implement. A cron that re-runs every fifteen minutes is safe because
 * `external_ref UNIQUE` and the derived adjustment uuid make a re-run a no-op
 * (shared/commerce/square/mirror.js), not because anything here checks.
 *
 * ─── FULL SWEEP OR INCREMENTAL ─────────────────────────────────────────────
 *
 * The first run, and any run after the cursor is lost, is a FULL ListCatalog:
 * that is the only sweep that can archive on absence, because absence is only
 * meaningful when you asked for everything. Afterwards it is a
 * SearchCatalogObjects since the last successful cursor, which is what keeps a
 * fifteen-minute cron cheap on a catalog of any size. A nightly full sweep is
 * the reconcile ADR-009 describes and is the schedule this trigger drops to
 * once it is trusted.
 *
 * ─── FAILURE, AND SAYING WHICH ONE IT WAS (RULES.md §14) ───────────────────
 *
 * Three failures look identical from the outside and need three different
 * repairs: the token is UNSET (nobody ran `wrangler secret put`), the token was
 * REJECTED (it is wrong, revoked, or pointed at the other Square environment),
 * or Square was UNREACHABLE (an outage, our egress, a rate limit that outlived
 * its retries). One ERROR line names which, so the log answers the question
 * instead of starting an investigation. The token itself is never in the line —
 * only its NAME — because a log is a place secrets leak from.
 *
 * Every outcome, failures included, lands in `mirror_sync` with `ok` and a
 * note. "The sync has not succeeded since Tuesday" is then a query rather than
 * a guess, and the storefront's fallback (Test-PRD-P0-49-mirror_or_seed) is
 * what makes a failed run survivable rather than fatal.
 */
import { createSquareAdapter } from "../../shared/commerce/square/index.js";
import { createMirror } from "../../shared/commerce/square/mirror.js";

/*
 * The cron, mirrored from wrangler.toml so a test can assert the two agree.
 * Every fifteen minutes to start with, because a sync nobody can observe is a
 * sync nobody trusts; see the comment on [triggers] there for when it drops to
 * nightly.
 */
export const SYNC_CRON = "*/15 * * * *";

/*
 * How far back an incremental sweep reaches beyond the recorded cursor.
 *
 * Square's `updated_at` is its clock, not ours, and a catalog write landing
 * mid-sweep can carry a timestamp fractionally before the cursor we then
 * record. Asking for a minute more than we need costs one page of results and
 * closes that window; the upsert absorbs the overlap.
 */
const OVERLAP_MS = 60_000;

/**
 * Classify a service-boundary failure into something a human can act on.
 *
 * Order matters: an unset credential is checked against the ENV rather than
 * against the error, because the client refuses to construct at all in that
 * case and its message is the least useful thing to relay.
 */
export function describeFailure(env, err) {
  if (!env?.SQUARE_ACCESS_TOKEN) {
    return {
      reason: "credential_unset",
      says:
        "SQUARE_ACCESS_TOKEN is not set on this Worker — set it with `npx wrangler secret put SQUARE_ACCESS_TOKEN`",
    };
  }
  const status = err?.status ?? 0;
  if (status === 401 || status === 403) {
    return {
      reason: "credential_rejected",
      says: `Square REJECTED SQUARE_ACCESS_TOKEN with HTTP ${status} — the token is wrong, revoked, or issued for the other SQUARE_ENV (currently "${env?.SQUARE_ENV ?? "unset"}")`,
    };
  }
  if (status === 429) {
    return {
      reason: "rate_limited",
      says: "Square rate-limited the sync and the retries did not outlast it",
    };
  }
  if (status >= 500) {
    return { reason: "provider_error", says: `Square answered HTTP ${status}` };
  }
  /* err.errors carries Square's own category/code/detail — the actual reason a
     400 was a 400 — but it never reaches err.message (client.js only puts the
     status there). Without this, every "provider_unreachable" note reads the
     same regardless of what Square actually objected to, and diagnosing one
     means reproducing it under `wrangler tail`, which this Worker's own logs
     do not retain. */
  const detail =
    Array.isArray(err?.errors) && err.errors.length > 0
      ? err.errors
          .map((e) => `${e.category ?? "?"}/${e.code ?? "?"}${e.detail ? `: ${e.detail}` : ""}`)
          .join("; ")
      : (err?.message ?? "no detail");
  return {
    reason: "provider_unreachable",
    says: `Square was unreachable or answered unusably — ${detail}`,
  };
}

/**
 * One sync run.
 *
 * @param env   CATALOG_MIRROR and COMMERCE bindings, SQUARE_ACCESS_TOKEN,
 *              SQUARE_ENV, SQUARE_LOCATION_ID, LOCATION_ID (OURS).
 * @param opts  Injection seams: { mirrorDb, commerceDb, adapter, client,
 *              clientOptions, now }. A stub Square client goes in through
 *              `opts.client` or `opts.clientOptions.fetchImpl`; nothing here
 *              reaches the network by itself.
 * @returns {Promise<{ok: boolean, reason: string, catalog?: object, inventory?: object}>}
 */
export async function syncFromSquare(env, opts = {}) {
  const mirrorDb = opts.mirrorDb ?? env?.CATALOG_MIRROR ?? null;
  if (!mirrorDb?.prepare) {
    /* A deployment failure, not a provider one: the cron is firing into a
       Worker with nowhere to write. Said separately so it is not mistaken for
       a Square outage. */
    console.error(
      "ERROR ops/sync: no CATALOG_MIRROR binding on this Worker — the scheduled sync has nowhere to write (create it with `npx wrangler d1 create vemians-catalog-mirror` and fill in the id in ops/wrangler.toml)",
    );
    return { ok: false, reason: "binding_missing" };
  }

  /* The mirror is built BEFORE the adapter, deliberately: a failure to reach
     Square must still be recordable, and the adapter constructs its client
     eagerly. */
  const mirror =
    opts.mirror ??
    createMirror(mirrorDb, {
      commerce: opts.commerceDb ?? env?.COMMERCE ?? null,
      locationId: opts.locationId ?? env?.LOCATION_ID ?? null,
    });

  const fail = async (err, phase) => {
    const { reason, says } = describeFailure(env, err);
    console.error(`ERROR ops/sync: the ${phase} sweep did not run — ${says}`);
    /* Best effort: a mirror that cannot even record the failure has a second,
       separate problem, and losing the first one to it helps nobody. */
    try {
      await mirror.recordSync(phase === "inventory" ? "inventory" : "catalog", {
        ok: false,
        note: `${reason}: ${says}`.slice(0, 500),
      });
    } catch (recordErr) {
      console.error(`ERROR ops/sync: could not record the failed run — ${recordErr.message}`);
    }
    return { ok: false, reason };
  };

  let adapter;
  try {
    adapter =
      opts.adapter ??
      createSquareAdapter(env, {
        mirror,
        client: opts.client,
        clientOptions: opts.clientOptions,
      });
  } catch (err) {
    return fail(err, "catalog");
  }

  const now = opts.now ?? (() => new Date());

  /* First run — or a lost cursor — is the full sweep that can archive on
     absence. Everything after is a search since the last good cursor. */
  let cursor = null;
  try {
    cursor = (await mirror.syncState("catalog"))?.cursor ?? null;
  } catch (err) {
    console.warn(
      `WARNING ops/sync: could not read the catalog cursor, falling back to a full sweep — ${err.message}`,
    );
  }
  const since = cursor ? new Date(Date.parse(cursor) - OVERLAP_MS).toISOString() : null;
  const full = !since;

  let catalog;
  try {
    catalog = await adapter.pullCatalog({ full, since });
  } catch (err) {
    return fail(err, "catalog");
  }

  /*
   * The stock half writes the LEDGER, which lives in the `commerce` store — a
   * different binding and a different failure. Checked here rather than left to
   * the mirror's own refusal, so an unbound COMMERCE is never reported as a
   * Square outage: they are the same log line's worth of noise and completely
   * different repairs.
   */
  const commerceDb = opts.commerceDb ?? env?.COMMERCE ?? null;
  const ourLocation = opts.locationId ?? env?.LOCATION_ID ?? null;
  if (!commerceDb?.prepare || !ourLocation) {
    const missing = !commerceDb?.prepare ? "the COMMERCE binding" : "LOCATION_ID (OUR location uuid)";
    console.error(
      `ERROR ops/sync: catalog synced but stock did not — ${missing} is not configured on this Worker`,
    );
    try {
      await mirror.recordSync("inventory", { ok: false, note: `unconfigured: ${missing} is missing` });
    } catch (recordErr) {
      console.error(`ERROR ops/sync: could not record the failed run — ${recordErr.message}`);
    }
    return { ok: false, reason: "unconfigured", catalog };
  }

  /* Inventory carries its own cursor: the two sweeps fail independently and a
     catalog that synced must not be re-run because stock did not. */
  let inventorySince = null;
  try {
    inventorySince = (await mirror.syncState("inventory"))?.cursor ?? null;
  } catch {
    inventorySince = null;
  }

  let inventory;
  try {
    inventory = await adapter.pullInventory({
      since: inventorySince ? new Date(Date.parse(inventorySince) - OVERLAP_MS).toISOString() : null,
    });
  } catch (err) {
    const out = await fail(err, "inventory");
    /* The catalog half DID land. Report it rather than throwing the whole run
       away, so the next run resumes from the cursor it earned. */
    return { ...out, catalog };
  }

  console.info(
    `INFO ops/sync: ${full ? "full" : "incremental"} sync ok at ${now().toISOString()} — ` +
      `catalog ${JSON.stringify(catalog)}, inventory ${JSON.stringify(inventory)}`,
  );
  return { ok: true, reason: "ok", full, catalog, inventory };
}
