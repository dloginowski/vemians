/*
 * The scheduled mirror sync — PRD-backed regression checks.
 *
 *     Run: node --test test/sync.test.mjs        (from ops/)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD / TEST CONTRACT — read before editing this file
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/PRD.md` is the driving design document. Every check here exists to
 * enforce a NUMBERED PRD FEATURE as written there — not an implementation
 * detail, and not "a thing the code happens to do".
 *
 *   * Each check is named  test_PRD_P0_NN_short_id__specific_behaviour  and so
 *     carries the visible label  Test-PRD-P0-NN-short_id.
 *   * That label MUST exist in docs/PRD.md. The last check in this file
 *     (P0-30) parses THIS FILE's own check names and asserts it, so an invented
 *     or renamed label fails the run instead of drifting silently.
 *   * UNLABELED CHECKS ARE NOT ACCEPTABLE. A new guarantee needs a PRD feature
 *     first; if there is no feature for it, write the feature. This handler had
 *     none, so Test-PRD-P0-48-scheduled_mirror_sync was written into
 *     docs/PRD.md §3.3 in the same change as the code below.
 *   * When behaviour changes, the PRD feature and its labeled check move in the
 *     SAME change as the code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT PROVEN HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The REAL mirror schema (shared/commerce/square/schema.sql) and the REAL
 * commerce schema are loaded into node:sqlite through shared/test/d1.mjs, and
 * the REAL adapter runs against them. What is stubbed is exactly one thing: the
 * network. `fakeFetch` serves the same handwritten Square fixtures the adapter's
 * own suite uses.
 *
 * NO SQUARE ACCOUNT, TOKEN OR NETWORK CALL IS INVOLVED, and none is claimed.
 * connect.squareup.com is egress-blocked from this environment; there is no
 * token here and nothing below asks for one. So these checks prove the
 * ORCHESTRATION — which sweep is chosen, what is logged, what is recorded, what
 * happens when the credential is missing or refused — and deliberately not that
 * Square's live payloads match the fixtures, which only a sandbox token could.
 *
 * The mapping, the upserts, the archiving and the idempotency are the adapter's
 * and are covered by shared/commerce/square/test/square.test.mjs. They are not
 * re-asserted here; this file would only be re-testing someone else's module.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

import { d1FromSql } from "../../shared/test/d1.mjs";

/* Text modules, as the Worker sees them: src/index.js reaches views.js, which
   imports the design tokens as text exactly as wrangler's Text rule serves
   them. Must run before anything under src/ is imported, hence register() plus
   dynamic import rather than a static one. */
register("../../shared/test/text-modules.mjs", import.meta.url);

const { describeFailure, SYNC_CRON, syncFromSquare } = await import("../src/sync.js");
const worker = (await import("../src/index.js")).default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.join(HERE, "..");
const REPO = path.join(OPS, "..");
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");

const PRD = read("docs", "PRD.md");
const MIRROR_SQL = read("shared", "commerce", "square", "schema.sql");
const COMMERCE_SQL = read("shared", "db", "commerce.sql");
const SQUARE_FIXTURES = path.join(REPO, "shared", "commerce", "square", "test", "fixtures");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(SQUARE_FIXTURES, name), "utf8"));

/* OUR location uuid. Square's location id is configuration and never a row. */
const OUR_LOCATION = "0d0b6a2e-9f43-4c8e-9a0a-2f6f1c4e77aa";
const SQUARE_LOCATION = "LOC_SQUARE_MAIN";

/* ── labels, for the P0-30 traceability check ───────────────────────────── */
const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* ── the stores, and a Square that is a fixture rather than a host ──────── */

function stores() {
  const mirrorDb = d1FromSql(MIRROR_SQL);
  const commerceDb = d1FromSql(COMMERCE_SQL);
  commerceDb._raw.exec(`INSERT INTO location(id, name) VALUES ('${OUR_LOCATION}', 'Vemians');`);
  return { mirrorDb, commerceDb };
}

/* Records every call, so "the sync asked Square for a full list" is an
   assertion about a URL rather than a hope. */
function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) {
      return new Response(JSON.stringify({ objects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const answer = typeof routes[key] === "function" ? routes[key](calls.length) : routes[key];
    return new Response(JSON.stringify(answer.body ?? answer), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  impl.calls = calls;
  return impl;
}

const CATALOG_ROUTES = {
  "/v2/catalog/list": { objects: fixture("catalog-list.json").objects },
  "/v2/catalog/search": { objects: fixture("catalog-list.json").objects },
  "/v2/inventory/changes/batch-retrieve": fixture("inventory-changes.json"),
};

function env(extra = {}, { mirrorDb, commerceDb } = {}) {
  return {
    SQUARE_ACCESS_TOKEN: "fixture-token",
    SQUARE_ENV: "sandbox",
    SQUARE_LOCATION_ID: SQUARE_LOCATION,
    LOCATION_ID: OUR_LOCATION,
    CATALOG_MIRROR: mirrorDb,
    COMMERCE: commerceDb,
    ...extra,
  };
}

/* Capture console output so a check can assert WHAT WAS SAID, which for this
   feature is half the behaviour: "one ERROR that says plainly which failure it
   was" is not testable by looking at a return value. */
function captureConsole(fn) {
  const lines = { error: [], warn: [], info: [] };
  const real = { error: console.error, warn: console.warn, info: console.info };
  console.error = (...a) => lines.error.push(a.join(" "));
  console.warn = (...a) => lines.warn.push(a.join(" "));
  console.info = (...a) => lines.info.push(a.join(" "));
  const restore = () => Object.assign(console, real);
  return Promise.resolve()
    .then(() => fn(lines))
    .finally(restore)
    .then(() => lines);
}

const rows = (db, sql) => db._raw.prepare(sql).all();

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-48-scheduled_mirror_sync
   A cron pulls the provider through the adapter and writes the mirror.
   ═══════════════════════════════════════════════════════════════════════════ */

check("test_PRD_P0_48_scheduled_mirror_sync__a_run_fills_the_mirror_through_the_adapter", async () => {
  const s = stores();
  const fetchImpl = fakeFetch(CATALOG_ROUTES);

  const out = await syncFromSquare(env({}, s), { clientOptions: { fetchImpl } });

  assert.equal(out.ok, true, `sync refused: ${out.reason}`);
  /* The mirror is no longer empty, and it was filled by the adapter — the
     products carry OUR uuids with Square's id in external_ref, which is the
     adapter's mapping and not something this handler could have written. */
  const products = rows(s.mirrorDb, "SELECT * FROM mirror_product_index");
  assert.ok(products.length > 0, "the sync wrote no products");
  for (const p of products) {
    assert.match(p.id, /^[0-9a-f-]{36}$/, "primary keys are our uuids");
    assert.ok(p.external_ref.startsWith("ITEM"), "Square's id belongs in external_ref");
  }
  assert.ok(rows(s.mirrorDb, "SELECT * FROM mirror_variant_index").length > 0, "no variants mirrored");

  /* And it actually spoke to (the stub for) Square rather than inventing rows. */
  assert.ok(fetchImpl.calls.some((c) => c.url.includes("/v2/catalog/")), "no catalog call was made");
});

check("test_PRD_P0_48_scheduled_mirror_sync__the_first_sweep_is_full_and_the_next_is_incremental", async () => {
  const s = stores();
  const fetchImpl = fakeFetch(CATALOG_ROUTES);
  const e = env({}, s);

  const first = await syncFromSquare(e, { clientOptions: { fetchImpl } });
  assert.equal(first.full, true, "the first run must be the full sweep that can archive on absence");
  assert.ok(fetchImpl.calls.some((c) => c.url.includes("/v2/catalog/list")));

  const before = fetchImpl.calls.length;
  const second = await syncFromSquare(e, { clientOptions: { fetchImpl } });
  assert.equal(second.ok, true);
  assert.equal(second.full, false, "a run with a recorded cursor must search, not re-list");
  const after = fetchImpl.calls.slice(before);
  assert.ok(after.some((c) => c.url.includes("/v2/catalog/search")), "the second run did not use the cursor");
  assert.ok(!after.some((c) => c.url.includes("/v2/catalog/list")), "the second run re-listed the whole catalog");
});

check("test_PRD_P0_48_scheduled_mirror_sync__every_run_records_its_outcome", async () => {
  const s = stores();
  await syncFromSquare(env({}, s), { clientOptions: { fetchImpl: fakeFetch(CATALOG_ROUTES) } });

  const state = rows(s.mirrorDb, "SELECT * FROM mirror_sync");
  const ids = state.map((r) => r.id).sort();
  assert.deepEqual(ids, ["catalog", "inventory"], "both halves must leave a receipt");
  for (const r of state) {
    assert.equal(r.ok, 1, `${r.id} recorded a failure on a clean run`);
    assert.ok(r.cursor, `${r.id} recorded no cursor, so the next run cannot resume`);
  }
});

check("test_PRD_P0_48_scheduled_mirror_sync__an_unset_token_is_logged_as_unset_and_not_as_an_outage", async () => {
  const s = stores();
  const lines = await captureConsole(async () => {
    const out = await syncFromSquare(env({ SQUARE_ACCESS_TOKEN: undefined }, s), {
      clientOptions: { fetchImpl: fakeFetch(CATALOG_ROUTES) },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "credential_unset", "an unset credential must be its own reason");
  });

  const ours = lines.error.filter((l) => l.startsWith("ERROR ops/sync:"));
  assert.equal(ours.length, 1, `expected exactly one ERROR from the sync, got ${ours.length}`);
  assert.match(ours[0], /SQUARE_ACCESS_TOKEN is not set/, "the log must say the token is UNSET");
  assert.match(ours[0], /wrangler secret put/, "and how to repair it");
  assert.doesNotMatch(ours[0], /unreachable|rejected/, "an unset token is not an outage and not a refusal");
});

check("test_PRD_P0_48_scheduled_mirror_sync__a_rejected_token_is_logged_as_rejected", async () => {
  const s = stores();
  const refuse = {
    status: 401,
    body: { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }] },
  };
  const lines = await captureConsole(async () => {
    const out = await syncFromSquare(env({}, s), {
      clientOptions: { fetchImpl: fakeFetch({ "/v2/catalog/list": refuse }), maxAttempts: 1 },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "credential_rejected", "a 401 is a refused credential, not an outage");
  });

  const ours = lines.error.filter((l) => l.startsWith("ERROR ops/sync:"));
  assert.equal(ours.length, 1);
  assert.match(ours[0], /REJECTED SQUARE_ACCESS_TOKEN with HTTP 401/);
  /* The three failures are three different repairs, and the log distinguishes
     them — that is the whole point of the feature. */
  assert.doesNotMatch(ours[0], /is not set/);
});

check("test_PRD_P0_48_scheduled_mirror_sync__no_failure_log_carries_the_credential", async () => {
  const s = stores();
  const SECRET = "EAAAl-this-is-the-token-value-and-must-never-be-logged";
  const lines = await captureConsole(async () => {
    await syncFromSquare(env({ SQUARE_ACCESS_TOKEN: SECRET }, s), {
      clientOptions: {
        fetchImpl: fakeFetch({ "/v2/catalog/list": { status: 403, body: { errors: [] } } }),
        maxAttempts: 1,
      },
    });
  });
  const all = [...lines.error, ...lines.warn, ...lines.info].join("\n");
  assert.ok(all.length > 0, "the run logged nothing at all");
  assert.ok(!all.includes(SECRET), "the credential appeared in a log line");
});

check("test_PRD_P0_48_scheduled_mirror_sync__a_failed_run_is_recorded_and_leaves_the_mirror_standing", async () => {
  const s = stores();
  const e = env({}, s);

  /* A good run first: this is the mirror the shop is currently serving. */
  await syncFromSquare(e, { clientOptions: { fetchImpl: fakeFetch(CATALOG_ROUTES) } });
  const good = rows(s.mirrorDb, "SELECT id, handle, title FROM mirror_product_index");
  assert.ok(good.length > 0);

  /* Then Square falls over. */
  const out = await captureConsole(() =>
    syncFromSquare(e, {
      clientOptions: {
        fetchImpl: fakeFetch({ "/v2/catalog/search": { status: 503, body: { errors: [] } } }),
        maxAttempts: 1,
        sleep: async () => {},
      },
    }),
  );
  assert.ok(out.error.some((l) => l.startsWith("ERROR ops/sync:")), "a provider failure must be logged");

  /* Not one row was lost, and the failure is on the record with ok = 0. */
  assert.deepEqual(rows(s.mirrorDb, "SELECT id, handle, title FROM mirror_product_index"), good);
  const state = s.mirrorDb._raw.prepare("SELECT * FROM mirror_sync WHERE id = 'catalog'").get();
  assert.equal(state.ok, 0, "the failed run must be recorded as a failure");
  assert.ok(state.note.length > 0, "and say what the failure was");
});

check("test_PRD_P0_48_scheduled_mirror_sync__an_unbound_mirror_is_a_deployment_failure_not_a_square_one", async () => {
  const lines = await captureConsole(async () => {
    const out = await syncFromSquare({ SQUARE_ACCESS_TOKEN: "t" }, {});
    assert.equal(out.ok, false);
    assert.equal(out.reason, "binding_missing");
  });
  assert.equal(lines.error.length, 1);
  assert.match(lines.error[0], /no CATALOG_MIRROR binding/);
  assert.match(lines.error[0], /wrangler d1 create/, "the log must say how to repair it");
});

check("test_PRD_P0_48_scheduled_mirror_sync__the_worker_exposes_the_handler_and_the_cron_is_declared", async () => {
  /* A handler with no trigger is the bug this whole change exists to fix: the
     adapter was complete, tested, and called by nothing. */
  assert.equal(typeof worker.scheduled, "function", "the ops Worker exports no scheduled handler");

  const toml = read("ops", "wrangler.toml");
  const crons = /\[triggers\]\s*\ncrons\s*=\s*\[([^\]]*)\]/.exec(toml);
  assert.ok(crons, "ops/wrangler.toml declares no [triggers] crons");
  assert.ok(crons[1].includes(SYNC_CRON), `the declared cron must match SYNC_CRON (${SYNC_CRON})`);
  /* Frequent enough to be observable now, with the intent to slow down written
     down rather than remembered. */
  assert.match(toml, /DROP IT TO NIGHTLY/, "the cron must say it is a starting value");

  /* And the store it writes to is actually bound on this Worker. */
  assert.match(toml, /binding\s*=\s*"CATALOG_MIRROR"/);
});

check("test_PRD_P0_48_scheduled_mirror_sync__the_scheduled_handler_runs_a_real_sync", async () => {
  const s = stores();
  /* Through the Worker's own entry point, not the module underneath it: the
     wiring is the thing that was missing, so the wiring is what is asserted. */
  const waited = [];
  /* The handler takes no injection seam — a cron fires it with (event, env, ctx)
     and nothing else — so the stub goes where the Worker runtime's own fetch
     would be. Nothing reaches the network: `fakeFetch` answers from the
     fixtures, and connect.squareup.com is egress-blocked from here anyway. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(CATALOG_ROUTES);
  try {
    await captureConsole(() =>
      worker.scheduled({ cron: SYNC_CRON }, env({}, s), { waitUntil: (p) => waited.push(p) }),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(waited.length, 1, "the handler must hand its promise to waitUntil");
  assert.ok(
    rows(s.mirrorDb, "SELECT * FROM mirror_product_index").length > 0,
    "the scheduled handler wrote nothing to the mirror",
  );
});

check("test_PRD_P0_48_scheduled_mirror_sync__each_failure_maps_to_its_own_reason", () => {
  /* The classifier in isolation: three failures that look identical from the
     outside and need three different repairs. */
  const configured = { SQUARE_ACCESS_TOKEN: "t", SQUARE_ENV: "sandbox" };
  assert.equal(describeFailure({}, new Error("anything")).reason, "credential_unset");
  assert.equal(describeFailure(configured, { status: 401 }).reason, "credential_rejected");
  assert.equal(describeFailure(configured, { status: 403 }).reason, "credential_rejected");
  assert.equal(describeFailure(configured, { status: 429 }).reason, "rate_limited");
  assert.equal(describeFailure(configured, { status: 503 }).reason, "provider_error");
  assert.equal(describeFailure(configured, { message: "fetch failed" }).reason, "provider_unreachable");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-16-commerce_port
   The handler is orchestration. It holds no vendor knowledge of its own.
   ═══════════════════════════════════════════════════════════════════════════ */

check("test_PRD_P0_16_commerce_port__the_scheduled_handler_holds_no_square_identifier_or_url", () => {
  const src = read("ops", "src", "sync.js").replace(/\/\*[\s\S]*?\*\//g, "");
  /* Every Square endpoint, id prefix and SDK call lives behind the adapter. The
     handler names the adapter's methods and the env var, and nothing else — so
     a second provider is a different import here and no other change. */
  assert.doesNotMatch(src, /connect\.square|squareup\.com|\/v2\//, "a Square URL escaped the adapter");
  assert.doesNotMatch(src, /catalog_object_id|ITEM_VARIATION|CatalogObject/, "a Square object shape escaped the adapter");
  assert.match(src, /adapter\.pullCatalog/);
  assert.match(src, /adapter\.pullInventory/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-37-mirror_is_ours
   The mirror is filled by us, in our shape, and a re-run does not duplicate.
   ═══════════════════════════════════════════════════════════════════════════ */

check("test_PRD_P0_37_mirror_is_ours__rerunning_the_cron_changes_no_row_counts", async () => {
  /* The adapter's suite proves idempotency at the mirror level; what is proven
     HERE is that the cron does not defeat it — a fifteen-minute schedule is only
     safe if the fourth run of the hour is a no-op. */
  const s = stores();
  const e = env({}, s);
  const opts = () => ({ clientOptions: { fetchImpl: fakeFetch(CATALOG_ROUTES) } });

  await syncFromSquare(e, opts());
  const after1 = {
    products: rows(s.mirrorDb, "SELECT * FROM mirror_product").length,
    variants: rows(s.mirrorDb, "SELECT * FROM mirror_variant").length,
    adjustments: rows(s.commerceDb, "SELECT * FROM inventory_adjustment").length,
  };

  await syncFromSquare(e, opts());
  await syncFromSquare(e, opts());
  const after3 = {
    products: rows(s.mirrorDb, "SELECT * FROM mirror_product").length,
    variants: rows(s.mirrorDb, "SELECT * FROM mirror_variant").length,
    adjustments: rows(s.commerceDb, "SELECT * FROM inventory_adjustment").length,
  };

  assert.deepEqual(after3, after1, "a re-run duplicated rows or double-counted stock");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-PRD-P0-30-prd_traceability
   ═══════════════════════════════════════════════════════════════════════════ */

test("test_PRD_P0_30_prd_traceability__every_label_here_exists_in_the_prd", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const labels = new Set();
  for (const m of source.matchAll(/\btest_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__/g)) {
    labels.add(`Test-PRD-${m[1]}-${m[2]}-${m[3]}`);
  }
  assert.ok(labels.size >= 3, "expected this file to carry labeled checks");
  assert.deepEqual([...labels].filter((l) => !PRD.includes(l)), [], "labels absent from docs/PRD.md");
  assert.deepEqual([...usedLabels].filter((l) => !labels.has(l)), []);
});
