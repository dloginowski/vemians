/*
 * assets.* — the employee asset drop site. Inherits agent-tool-contract.
 *
 * A coworker drops a working document at /assets/new (browser only, no
 * assistant needed — same shape as /media/new); an agent reads it back
 * through assets.list / assets.read. Nothing here is T1 or T2: dropping a
 * file changes nothing else in the business, so there is no proposal to
 * approve and no write for a human to confirm.
 *
 * TWO STORES, ONE OF WHICH NO TOOL EVER TOUCHES
 *   ASSET_FILES (R2) holds the original bytes and is bound only in
 *   src/index.js, for the upload and download routes a human's browser hits
 *   directly. `assets` (D1, this file's `stores: ["assets"]`) is the index —
 *   filename, uploader, size, and whatever text extraction produced at
 *   upload time. assets.list and assets.read hold no R2 binding at all, so
 *   an agent tool call can never touch a raw file's bytes, only what was
 *   already extracted as text and written into a column.
 *
 * EXTRACTION IS HONEST ABOUT ITS OWN LIMITS
 *   Only formats with no ambiguity about what "text" means are extracted
 *   today: .txt, .md, .csv, .json are UTF-8 already. A PDF, a spreadsheet
 *   workbook or a Word document is accepted, stored and listed — nothing is
 *   refused for being one of those — but `extracted_text` stays NULL and
 *   assets.read says so plainly, pointing at the download link instead of
 *   returning nothing or guessing at content it never parsed. Extending
 *   extraction to those formats needs a real parser this environment could
 *   not vet against the Workers runtime; deferred on purpose, not forgotten.
 */
import { CAPS } from "./caps.js";

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

const TYPE_BY_EXT = Object.freeze({
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
});

const ACCEPTED_CONTENT_TYPES = new Set(Object.values(TYPE_BY_EXT));

/* The browser's own type is preferred when it sends a recognised one; the
   extension is the fallback for a bare filename, same convention as
   media.js's contentTypeFor. */
export function contentTypeForAsset(filename, declared) {
  const given = String(declared ?? "").toLowerCase().split(";")[0].trim();
  if (ACCEPTED_CONTENT_TYPES.has(given)) return given;
  const ext = String(filename ?? "").toLowerCase().split(".").pop();
  return TYPE_BY_EXT[ext] ?? null;
}

/*
 * Best-effort text extraction, run once at upload time so assets.read never
 * needs the bytes again. Returns null for a type with no extraction yet —
 * never a guess, never an error; "no text" is a legitimate, expected answer.
 */
export function extractText(contentType, bytes) {
  if (!TEXT_TYPES.has(contentType)) return null;
  const full = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const truncated = full.length > CAPS.ASSET_TEXT_MAX_CHARS;
  return { text: truncated ? full.slice(0, CAPS.ASSET_TEXT_MAX_CHARS) : full, truncated };
}

/*
 * The bytes, in KV — src/index.js only, never a tool (see the file header).
 * One request does the whole upload (pick a file, POST, done), so unlike
 * media.js there is no ticket to mint ahead of the bytes arriving.
 */
export function createAssetFileStore(kv) {
  if (!kv || typeof kv.put !== "function") {
    console.error("ERROR assets: no ASSET_FILES (KV) binding — refusing to construct an asset file store");
    throw new Error("binding ASSET_FILES is not attached to this Worker");
  }
  return {
    /** Refuses an occupied key rather than replacing what is there — keys
        carry a uuid, so a collision means a bug, not a re-upload. */
    async put(key, bytes) {
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      if (body.byteLength === 0) throw new Error("refusing to store zero bytes as a file");
      if (body.byteLength > CAPS.ASSET_MAX_BYTES) {
        throw new Error(`larger than the ${CAPS.ASSET_MAX_BYTES}-byte limit for one file`);
      }
      const existing = await kv.get(key, "arrayBuffer");
      if (existing !== null) throw new Error(`${key} already holds bytes`);
      await kv.put(key, body);
      return { key, bytes: body.byteLength };
    },
    async bytes(key) {
      const buf = await kv.get(key, "arrayBuffer");
      return buf === null ? null : new Uint8Array(buf);
    },
  };
}

export const assetTools = {
  "assets.list": {
    tier: "T0",
    domain: "assets",
    stores: ["assets"],
    minRole: "staff",
    describe:
      "List files staff have dropped at /assets/new for the team — filename, uploader, when, " +
      "and whether the text is readable yet. Does not return file contents; call assets.read for that.",
    undo: null,
    schema: {},
    async run(_args, t) {
      const { results } = await t.db.assets
        .prepare(
          "SELECT id, filename, content_type, size_bytes, uploaded_by, uploaded_at," +
            " (extracted_text IS NOT NULL) AS has_text FROM asset ORDER BY uploaded_at DESC LIMIT ?",
        )
        .bind(CAPS.ASSET_LIST_MAX_ROWS)
        .all();
      return {
        assets: (results ?? []).map((r) => ({
          id: r.id,
          filename: r.filename,
          content_type: r.content_type,
          size_bytes: r.size_bytes,
          uploaded_by: r.uploaded_by,
          uploaded_at: r.uploaded_at,
          has_text: Boolean(r.has_text),
          path: `/assets/${r.id}`,
        })),
      };
    },
  },

  "assets.read": {
    tier: "T0",
    domain: "assets",
    stores: ["assets"],
    minRole: "staff",
    describe:
      "Read one dropped file's extracted text — works today for .txt, .md, .csv and .json. " +
      "Any other type (a PDF, a spreadsheet, a Word document) returns its metadata and a download " +
      "link instead: there is no text extraction for it yet, and this tool says so rather than " +
      "guessing at content it never parsed.",
    undo: null,
    schema: { asset_id: { type: "string", required: true, format: "id" } },
    async run(args, t) {
      const row = await t.db.assets
        .prepare(
          "SELECT id, filename, content_type, size_bytes, uploaded_by, uploaded_at," +
            " extracted_text, text_truncated FROM asset WHERE id = ?",
        )
        .bind(args.asset_id)
        .first();
      if (!row) return { error: `no asset '${args.asset_id}'` };

      const base = {
        id: row.id,
        filename: row.filename,
        content_type: row.content_type,
        size_bytes: row.size_bytes,
        uploaded_by: row.uploaded_by,
        uploaded_at: row.uploaded_at,
        path: `/assets/${row.id}`,
      };
      if (row.extracted_text === null) {
        return {
          ...base,
          text: null,
          note: `no text extraction for ${row.content_type} yet — open ${base.path} instead`,
        };
      }
      return { ...base, text: row.extracted_text, truncated: Boolean(row.text_truncated) };
    },
  },
};
