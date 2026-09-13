/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * Test-PRD-P0-77-chat_attachments. The row of icons under the chat input,
 * driven the way media-new.test.mjs and assets-route.test.mjs drive their own
 * routes: a real Worker fetch, a real-shaped Access assertion. NO NETWORK
 * CALL IS INVOLVED — ANTHROPIC_API_KEY is unset throughout, so every check
 * here exercises the STUB path (agentTurn's early return) plus the real
 * storage side-effect (ingestAgentAttachment), which is exactly the half of
 * this feature that does not need a live model to prove: the photo (or file)
 * actually lands where it says it lands, before the agent ever sees it.
 * `buildUserContent`'s own shape — what the model WOULD be shown — is
 * checked directly, as a pure function, in the second half of this file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const worker = (await import("../src/index.js")).default;
const { buildUserContent } = await import("../src/agent.js");
const { CAPS } = await import("../src/tools/caps.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const STAFF_POLICY = "f6e1649c-0000-4000-8000-000000000002";
const STAFF = { email: "ana@example.test", policy_id: STAFF_POLICY };

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

/* ── fakes, same shape as media-backfill.test.mjs's and assets-route.test.mjs's own ── */

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

function fakeKv() {
  const store = new Map();
  return {
    async put(key, value) {
      store.set(key, value instanceof Uint8Array ? value.slice() : value);
    },
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (type === "arrayBuffer") return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      return v;
    },
    _store: store,
  };
}

function assetsDb() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "db", "assets.sql"), "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const wrap = (text) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async all() {
        return { success: true, results: db.prepare(text).all(...bound) };
      },
      async first(column) {
        const row = db.prepare(text).get(...bound);
        if (row === undefined) return null;
        return column === undefined ? row : row[column];
      },
      async run() {
        const r = db.prepare(text).run(...bound);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db };
}

function env(overrides = {}) {
  return { SURFACE: "ops", STAFF_POLICY_ID: STAFF_POLICY, ...overrides };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

function postAttachment(e, { q = "", filename = "coat.png", bytes = PNG_BYTES, type = "image/png" } = {}) {
  const form = new FormData();
  if (q) form.set("q", q);
  form.set("file", new File([bytes], filename, { type }));
  return worker.fetch(
    new Request("http://localhost/agent", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(STAFF) },
      body: form,
    }),
    e,
  );
}

/* ── the route: a photo ─────────────────────────────────────────────────── */

check("test_PRD_P0_77_chat_attachments__a_photo_is_stored_in_the_media_bucket_before_the_agent_sees_it", async () => {
  const e = env({ MEDIA: fakeBucket() });
  const res = await postAttachment(e, { q: "what is this" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "stub", "no ANTHROPIC_API_KEY in this test — the stub path, on purpose");
  assert.match(data.reply, /coat\.png/, "the stub reply must name what was attached");
  assert.equal(e.MEDIA._store.size, 1, "the photo must actually be in the bucket, not only referenced");
});

check("test_PRD_P0_77_chat_attachments__no_text_at_all_is_still_a_valid_message_with_just_a_photo", async () => {
  const e = env({ MEDIA: fakeBucket() });
  const res = await postAttachment(e, { q: "" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "stub");
  assert.equal(e.MEDIA._store.size, 1);
});

check("test_PRD_P0_77_chat_attachments__an_oversized_photo_is_refused_before_it_is_stored", async () => {
  const e = env({ MEDIA: fakeBucket() });
  const big = new Uint8Array(CAPS.ORIGINAL_IMAGE_MAX_BYTES + 1);
  big.set(PNG_BYTES);
  const res = await postAttachment(e, { bytes: big });
  assert.equal(res.status, 413);
  assert.equal(e.MEDIA._store.size, 0);
});

check("test_PRD_P0_77_chat_attachments__no_media_store_configured_refuses_plainly_rather_than_throwing", async () => {
  /* No MEDIA bucket and no SQUARE_ACCESS_TOKEN — mediaStoreFor's Square
     fallback would throw constructing an uploader; ingestAgentAttachment
     must turn that into a clean refusal, not a 500. */
  const res = await postAttachment(env());
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.match(data.error, /not configured/);
});

/* ── the route: a non-photo file ─────────────────────────────────────────── */

check("test_PRD_P0_77_chat_attachments__a_text_file_is_stored_as_an_asset_with_its_text_extracted", async () => {
  const e = env({ ASSETS: assetsDb(), ASSET_FILES: fakeKv() });
  const res = await postAttachment(e, {
    q: "what does this say",
    filename: "vendor-notes.txt",
    bytes: new TextEncoder().encode("Ships net 30."),
    type: "text/plain",
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "stub");
  assert.match(data.reply, /vendor-notes\.txt/);
  const row = await e.ASSETS.prepare("SELECT filename, extracted_text FROM asset").first();
  assert.equal(row.filename, "vendor-notes.txt");
  assert.equal(row.extracted_text, "Ships net 30.");
});

check("test_PRD_P0_77_chat_attachments__an_unrecognised_file_type_is_refused_before_it_is_stored", async () => {
  const e = env({ ASSETS: assetsDb(), ASSET_FILES: fakeKv() });
  const res = await postAttachment(e, { filename: "install.exe", bytes: new Uint8Array([1, 2, 3]), type: "application/octet-stream" });
  assert.equal(res.status, 415);
  assert.equal(await e.ASSETS.prepare("SELECT count(*) AS n FROM asset").first("n"), 0);
});

check("test_PRD_P0_77_chat_attachments__no_file_at_all_is_a_normal_text_only_turn", async () => {
  const res = await worker.fetch(
    new Request("http://localhost/agent", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(STAFF), "content-type": "application/json" },
      body: JSON.stringify({ q: "how many black coats are in stock" }),
    }),
    env(),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "stub");
  assert.match(data.reply, /how many black coats are in stock/);
});

/* ── buildUserContent: what the model would actually be shown ───────────── */

check("test_PRD_P0_77_chat_attachments__no_attachment_sends_a_plain_string_unchanged", () => {
  assert.equal(buildUserContent("how many black coats are in stock", null), "how many black coats are in stock");
});

check("test_PRD_P0_77_chat_attachments__a_small_photo_becomes_a_real_vision_block_plus_the_stored_key", () => {
  const content = buildUserContent("what is this", {
    kind: "photo",
    key: "catalog/originals/2026/09/abc.png",
    filename: "coat.png",
    image: { mediaType: "image/png", base64: "AAAA" },
  });
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /what is this/);
  assert.match(content[0].text, /catalog\/originals\/2026\/09\/abc\.png/, "the model must be told the key, to reuse rather than re-upload");
  assert.match(content[0].text, /do not call catalog\.upload_image/i);
  assert.equal(content[1].type, "image");
  assert.deepEqual(content[1].source, { type: "base64", media_type: "image/png", data: "AAAA" });
});

check("test_PRD_P0_77_chat_attachments__a_photo_too_large_to_preview_still_names_its_key_as_plain_text", () => {
  const content = buildUserContent("", { kind: "photo", key: "catalog/originals/2026/09/big.jpg", filename: "big.jpg", image: null });
  assert.equal(typeof content, "string", "no image block at all when the copy for vision was skipped");
  assert.match(content, /too large to preview/);
  assert.match(content, /catalog\/originals\/2026\/09\/big\.jpg/);
});

check("test_PRD_P0_77_chat_attachments__a_file_with_extracted_text_hands_it_over_verbatim", () => {
  const content = buildUserContent("", { kind: "file", id: "ast_1", filename: "notes.txt", extractedText: "Ships net 30." });
  assert.equal(typeof content, "string");
  assert.match(content, /ast_1/);
  assert.match(content, /Ships net 30\./);
});

check("test_PRD_P0_77_chat_attachments__a_file_with_no_extractable_text_says_so_rather_than_pretending", () => {
  const content = buildUserContent("", { kind: "file", id: "ast_2", filename: "diagram.dwg", extractedText: null });
  assert.match(content, /no text could be extracted/i);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const prd = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "PRD.md"),
    "utf8",
  );
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
