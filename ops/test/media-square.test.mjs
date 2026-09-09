/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *   * A behaviour change moves the PRD feature and its labeled check together.
 *
 * The Square-backed media store (ADR-013). Square is stubbed at the uploader
 * seam — no network — but the store under test is the real one, and the
 * comparison against the R2 store is the point: two implementations of one
 * contract is how this repository has produced its last three bugs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { createSquareMediaStore, createMediaStore, mediaKey } = await import("../src/tools/media.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const ENV = { MEDIA_SIGNING_KEY: "test-signing-key", OPS_HOST: "ops.vemians.com" };

/* A Square that remembers, so name-as-index can actually be exercised. */
function stubUploader() {
  const byName = new Map();
  let n = 0;
  return {
    calls: [],
    async upload({ name, bytes, contentType, caption }) {
      this.calls.push({ name, bytes: bytes.byteLength, contentType, caption });
      const imageRef = `SQIMG${++n}`;
      const rec = { imageRef, url: `https://items.sq/${imageRef}.jpg`, name };
      byName.set(name, rec);
      return rec;
    },
    async findByName(name) {
      return byName.get(name) ?? null;
    },
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

check("test_PRD_P0_55_square_held_media__an_upload_goes_to_square_tagged_with_our_key", async () => {
  const up = stubUploader();
  const store = createSquareMediaStore(up, ENV);
  const key = mediaKey("image/jpeg");

  const out = await store.put(key, JPEG, { contentType: "image/jpeg", actor: "d@vemians.com" });

  assert.equal(store.kind, "square");
  assert.equal(out.key, key);
  assert.equal(out.image_ref, "SQIMG1");
  assert.match(out.url, /^https:\/\//);
  /* THE mechanism: Square is told our key as the image's name, which is what
     makes a local mapping table unnecessary. */
  assert.equal(up.calls[0].name, key, "Square must be told our key as the image name");
});

check("test_PRD_P0_55_square_held_media__square_is_the_index_so_head_finds_it_again", async () => {
  const store = createSquareMediaStore(stubUploader(), ENV);
  const key = mediaKey("image/jpeg");

  assert.equal(await store.head(key), null, "nothing before the upload");
  await store.put(key, JPEG, { contentType: "image/jpeg", actor: "d@vemians.com" });

  const found = await store.head(key);
  assert.equal(found.image_ref, "SQIMG1");
  assert.equal(found.key, key);
  assert.match(found.url, /^https:\/\//);
});

check("test_PRD_P0_55_square_held_media__an_original_is_never_overwritten", async () => {
  const up = stubUploader();
  const store = createSquareMediaStore(up, ENV);
  const key = mediaKey("image/jpeg");
  await store.put(key, JPEG, { contentType: "image/jpeg", actor: "d@vemians.com" });

  await assert.rejects(
    () => store.put(key, JPEG, { contentType: "image/jpeg", actor: "someone@vemians.com" }),
    /already exists/,
    "the bucket refuses this and so must Square",
  );
  assert.equal(up.calls.length, 1, "and the second attempt must not reach Square at all");
});

check("test_PRD_P0_55_square_held_media__bytes_refuses_by_name_rather_than_returning_empty", async () => {
  const store = createSquareMediaStore(stubUploader(), ENV);
  await assert.rejects(
    () => store.bytes("anything"),
    /url/i,
    "a caller wanting pixels must be told where they are, not handed nothing",
  );
});

check("test_PRD_P0_55_square_held_media__both_stores_mint_the_same_upload_link", async () => {
  /* THE REGRESSION THIS FILE EXISTS FOR. The browser posts the bytes to the
     route in this link; the agent minted the ticket through the other store.
     If the two disagree on the path, the parameter names or the date format,
     the upload lands nowhere and the failure looks like a bad photograph. */
  const bucket = {
    async head() { return null; },
    async put() {},
  };
  const r2 = createMediaStore(bucket, ENV);
  const sq = createSquareMediaStore(stubUploader(), ENV);

  const key = mediaKey("image/jpeg");
  const args = { key, actor: "d@vemians.com", now: 1_757_000_000_000 };

  const a = await r2.uploadUrl(args);
  const b = await sq.uploadUrl(args);

  assert.deepEqual(a, b, "the two stores must mint byte-identical upload links");
  assert.match(a.url, /\/media\/upload\?/);
  assert.match(a.expires_at, /^\d{4}-\d{2}-\d{2}T/, "an ISO timestamp, on both");
});

check("test_PRD_P0_55_square_held_media__a_key_we_did_not_mint_is_refused", async () => {
  const store = createSquareMediaStore(stubUploader(), ENV);
  await assert.rejects(
    () => store.put("../../etc/passwd", JPEG, { contentType: "image/jpeg", actor: "x@vemians.com" }),
    /not a key this application mints/,
  );
  assert.equal(await store.head("../../etc/passwd"), null);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
