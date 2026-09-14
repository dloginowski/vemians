/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *   * A behaviour change moves the PRD feature and its labeled check together.
 *
 * The fetch-and-store backfill (Test-PRD-P0-73-real_photography). NO NETWORK
 * CALL IS INVOLVED — `fetchImpl` is a stub answering canned bytes, and the R2
 * side is a plain in-memory Map behind the same shape the real bucket binding
 * has. What is under test is the real `backfillMedia` and the real
 * `createMediaStore`, over the real mirror schema — what is faked is only the
 * far side of the wire, exactly as catalog-write.test.mjs's own stub Square
 * does for the catalog-authoring suite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { backfillMedia } = await import("../src/media-backfill.js");
const { createMediaStore, isOurMediaKey } = await import("../src/tools/media.js");
const { CAPS } = await import("../src/tools/caps.js");
const { d1FromSql } = await import("../../shared/test/d1.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const MIRROR_SQL = fs.readFileSync(path.join(REPO, "shared", "commerce", "square", "schema.sql"), "utf8");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* ── the in-memory bucket ─────────────────────────────────────────────────
 * The same narrow surface bucket.put/head/get uses — a Map, not R2, because
 * the point here is `createMediaStore`'s own contract (already proven against
 * the real binding shape by media-square.test.mjs's sibling suite), not R2
 * itself. */
function fakeBucket() {
  const store = new Map();
  return {
    async put(key, body, opts = {}) {
      store.set(key, { body, httpMetadata: opts.httpMetadata ?? {} });
    },
    async head(key) {
      const o = store.get(key);
      return o ? { size: o.body.byteLength, httpMetadata: o.httpMetadata, uploaded: new Date() } : null;
    },
    async get(key) {
      const o = store.get(key);
      return o ? { httpMetadata: o.httpMetadata, async arrayBuffer() { return o.body.buffer; } } : null;
    },
    _store: store,
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4]);

/* A mirror seeded with one product and however many image rows the caller
   asks for — `sourceUrl: null` marks a row already backfilled by giving it a
   media_key directly, so a test can assert those are left alone. */
function seededMirror(images) {
  const db = d1FromSql(MIRROR_SQL);
  db._raw.prepare("INSERT INTO mirror_category (id, external_ref, name) VALUES ('cat-1','SQ_CAT_1','Clothing')").run();
  db._raw
    .prepare(
      "INSERT INTO mirror_product (id, external_ref, handle, title, status, channel, category_id) VALUES ('prod-1','SQ_ITEM_1','coat','Coat','active','website','cat-1')",
    )
    .run();
  images.forEach((img, i) => {
    db._raw
      .prepare(
        "INSERT INTO mirror_image (id, external_ref, product_id, source_url, ordinal, media_key) VALUES (?, ?, 'prod-1', ?, ?, ?)",
      )
      .run(`img-${i}`, `SQ_IMG_${i}`, img.sourceUrl, i, img.mediaKey ?? null);
  });
  return db;
}

function stubFetch(byUrl) {
  return async (url) => {
    const found = byUrl[url];
    if (!found) return { ok: false, status: 404 };
    return {
      ok: true,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? found.contentType : null) },
      async arrayBuffer() {
        return found.bytes.buffer;
      },
    };
  };
}

/* ── behaviour ────────────────────────────────────────────────────────────── */

check("test_PRD_P0_73_real_photography__a_synced_image_with_no_media_key_is_fetched_and_stored", async () => {
  const db = seededMirror([{ sourceUrl: "https://square-cdn.example/a.jpg" }]);
  const bucket = fakeBucket();
  const media = createMediaStore(bucket, {});
  const fetchImpl = stubFetch({
    "https://square-cdn.example/a.jpg": { bytes: JPEG, contentType: "image/jpeg" },
  });

  const out = await backfillMedia(
    { CATALOG_MIRROR: db },
    { media, fetchImpl, now: () => new Date("2026-09-13T00:00:00Z") },
  );
  assert.deepEqual(out, { attempted: 1, backfilled: 1, failed: 0 });

  const row = db._raw.prepare("SELECT media_key FROM mirror_image WHERE id = 'img-0'").get();
  assert.ok(isOurMediaKey(row.media_key), `not one of our keys: ${row.media_key}`);
  assert.match(row.media_key, /^catalog\/originals\/2026\/09\//);

  const stored = await bucket.get(row.media_key);
  assert.ok(stored, "the bytes must actually be in the bucket, not only the key recorded");
});

check("test_PRD_P0_73_real_photography__an_already_backfilled_row_is_left_alone", async () => {
  const db = seededMirror([{ sourceUrl: "https://square-cdn.example/a.jpg", mediaKey: "catalog/originals/2026/01/existing.jpg" }]);
  const media = createMediaStore(fakeBucket(), {});
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, headers: { get: () => "image/jpeg" }, async arrayBuffer() { return JPEG.buffer; } };
  };

  const out = await backfillMedia({ CATALOG_MIRROR: db }, { media, fetchImpl });
  assert.deepEqual(out, { attempted: 0, backfilled: 0, failed: 0 });
  assert.equal(called, false, "a row that already has a media_key must never be re-fetched");
  const row = db._raw.prepare("SELECT media_key FROM mirror_image WHERE id = 'img-0'").get();
  assert.equal(row.media_key, "catalog/originals/2026/01/existing.jpg", "the existing key must survive untouched");
});

check("test_PRD_P0_73_real_photography__one_failed_fetch_does_not_stop_the_rest", async () => {
  const db = seededMirror([
    { sourceUrl: "https://square-cdn.example/broken.jpg" },
    { sourceUrl: "https://square-cdn.example/good.jpg" },
  ]);
  const media = createMediaStore(fakeBucket(), {});
  const fetchImpl = stubFetch({
    "https://square-cdn.example/good.jpg": { bytes: JPEG, contentType: "image/jpeg" },
    /* broken.jpg is deliberately absent from the map, so stubFetch 404s it. */
  });

  const out = await backfillMedia({ CATALOG_MIRROR: db }, { media, fetchImpl });
  assert.deepEqual(out, { attempted: 2, backfilled: 1, failed: 1 });

  const broken = db._raw.prepare("SELECT media_key FROM mirror_image WHERE id = 'img-0'").get();
  assert.equal(broken.media_key, null, "a failed fetch must not record a key — the next run has to retry it");
  const good = db._raw.prepare("SELECT media_key FROM mirror_image WHERE id = 'img-1'").get();
  assert.ok(isOurMediaKey(good.media_key));
});

check("test_PRD_P0_73_real_photography__no_r2_bound_is_a_silent_no_op_not_an_error", async () => {
  const db = seededMirror([{ sourceUrl: "https://square-cdn.example/a.jpg" }]);
  /* Square's own media store, `.kind === "square"` — the exact state the
     production deployment is in before bootstrap-media.yml has ever run. */
  const squareStore = { kind: "square", put: async () => { throw new Error("must never be called"); } };

  const out = await backfillMedia({ CATALOG_MIRROR: db }, { media: squareStore, fetchImpl: async () => { throw new Error("must never be called"); } });
  assert.deepEqual(out, { attempted: 0, backfilled: 0, failed: 0 });

  const withNoMediaAtAll = await backfillMedia({ CATALOG_MIRROR: db }, {});
  assert.deepEqual(withNoMediaAtAll, { attempted: 0, backfilled: 0, failed: 0 });
});

check("test_PRD_P0_73_real_photography__no_catalog_mirror_binding_is_a_silent_no_op", async () => {
  const out = await backfillMedia({}, { media: createMediaStore(fakeBucket(), {}) });
  assert.deepEqual(out, { attempted: 0, backfilled: 0, failed: 0 });
});

check("test_PRD_P0_73_real_photography__one_run_never_backfills_more_than_the_cap", async () => {
  const many = Array.from({ length: CAPS.MEDIA_BACKFILL_MAX_PER_RUN + 5 }, (_, i) => ({
    sourceUrl: `https://square-cdn.example/${i}.jpg`,
  }));
  const db = seededMirror(many);
  const media = createMediaStore(fakeBucket(), {});
  const byUrl = {};
  for (const img of many) byUrl[img.sourceUrl] = { bytes: JPEG, contentType: "image/jpeg" };

  const out = await backfillMedia({ CATALOG_MIRROR: db }, { media, fetchImpl: stubFetch(byUrl) });
  assert.equal(out.attempted, CAPS.MEDIA_BACKFILL_MAX_PER_RUN);
  assert.equal(out.backfilled, CAPS.MEDIA_BACKFILL_MAX_PER_RUN);

  const remaining = db._raw.prepare("SELECT COUNT(*) c FROM mirror_image WHERE media_key IS NULL").get().c;
  assert.equal(remaining, 5, "the overflow must still be there for the next scheduled run to pick up");
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const prd = fs.readFileSync(path.join(REPO, "docs", "PRD.md"), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
