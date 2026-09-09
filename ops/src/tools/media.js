/*
 * Media — our originals, in our bucket, under our key.
 *
 * Test-PRD-P0-28-image_contract and Test-PRD-P0-29-exit_test. R2 is
 * AUTHORITATIVE for photography; Square gets a copy so the item looks right on
 * the till. Deleting the provider must leave the media intact, which is only
 * true if the original never lived only there.
 *
 * ─── HOW AN MCP CLIENT ACTUALLY GETS IMAGE BYTES TO A TOOL ─────────────────
 *
 * MCP tool arguments are JSON-RPC parameters. There is no binary frame and no
 * side channel: bytes in an argument means base64 inside a JSON string, and the
 * binding constraint is not the transport, it is the MODEL. Those characters
 * have to be EMITTED, token by token, by the model composing the tool call.
 *
 *   a 12 MP phone photo    ~3-6 MB JPEG
 *   base64 of that         ~4-8 MB of text
 *   as output tokens       ~1-2 million
 *   frontier output cap    ~64k tokens per response
 *
 * So the inline path is short by a factor of twenty to thirty, and no
 * engineering effort closes that gap — it is not slow or expensive, it is
 * arithmetically impossible. Anything that survives inline is a thumbnail.
 * `CAPS.INLINE_IMAGE_MAX_BYTES` (192 KiB) is set where the base64 is still a
 * meaningful fraction of one response rather than all of it, and the tool
 * refuses past it with the reason rather than truncating a photograph.
 *
 * The path that works is a SIGNED UPLOAD TICKET. `catalog.upload_image` mints
 * our R2 key up front, signs {key, actor, expiry} with a server-held secret,
 * and returns a URL on ops.vemians.com. The human opens it in the browser they
 * are already Access-authenticated in and picks the file; the bytes go
 * browser -> Worker -> R2 and never enter a model's context in either
 * direction. The key the tool already returned is the key the file lands on, so
 * the agent can carry on composing the product while the upload happens.
 *
 * TWO INDEPENDENT CHECKS ON THE UPLOAD ROUTE, ON PURPOSE
 *   1. the ticket signature — proves the key was minted by us, not guessed;
 *   2. the Cloudflare Access identity on the PUT — proves a person is on the
 *      other end of it, and the same person the ticket was minted for.
 * A ticket alone writes nothing. A leaked ticket is not a write capability.
 *
 * NOTHING HERE OVERWRITES. Keys carry a uuid, so a second upload is a second
 * object; `put` refuses a key that already holds bytes rather than replacing a
 * photograph in place (agent-tool-contract: every write is an append).
 */
import { CAPS } from "./caps.js";
import { STORABLE_IMAGE_TYPES, squareAcceptsType } from "../../../shared/commerce/square/images.js";

export { STORABLE_IMAGE_TYPES, squareAcceptsType };

/* filename extension -> content type. The browser's own type is preferred when
   it sends one; this is the fallback for a bare filename from a model. */
const TYPE_BY_EXT = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
});

const EXT_BY_TYPE = Object.freeze({
  "image/jpeg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
});

export function contentTypeFor(filename, declared) {
  const given = String(declared ?? "").toLowerCase().split(";")[0].trim();
  if (STORABLE_IMAGE_TYPES.includes(given)) return given;
  const ext = String(filename ?? "").toLowerCase().split(".").pop();
  return TYPE_BY_EXT[ext] ?? null;
}

/* Our key. A date prefix so a bucket listing is navigable by a human, a uuid so
   two photographs of the same coat never collide, and no part of it derived
   from anything Square knows. */
export function mediaKey(contentType, { now = () => new Date(), id = () => crypto.randomUUID() } = {}) {
  const d = now();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `catalog/originals/${yyyy}/${mm}/${id()}.${EXT_BY_TYPE[contentType] ?? "bin"}`;
}

/* Only keys we mint are readable or writable through these tools: a caller that
   can name an arbitrary key can read the whole bucket. */
const KEY_SHAPE = /^catalog\/originals\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export function isOurMediaKey(key) {
  return typeof key === "string" && KEY_SHAPE.test(key);
}

/* ── the signed ticket ──────────────────────────────────────────────────── */

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/* Constant time: a signature check that returns early leaks the signature one
   byte at a time, which is the same failure webhooks.js exists to avoid. */
function equalConstantTime(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const ticketMessage = (key, actor, expiresAt) => `v1.${key}.${actor}.${expiresAt}`;

/**
 * Mint an upload ticket for one key, for one person, for CAPS.MEDIA_TICKET_TTL_MS.
 * Fails closed with no secret: an unsigned ticket is not a ticket.
 */
export async function mintUploadTicket({ secret, key, actor, now = Date.now() }) {
  if (!secret) {
    console.error("ERROR media: MEDIA_SIGNING_KEY is unset — cannot mint an upload ticket, refusing");
    throw new Error("MEDIA_SIGNING_KEY is unset; a signed upload URL cannot be issued");
  }
  const expiresAt = now + CAPS.MEDIA_TICKET_TTL_MS;
  return { key, actor, expiresAt, signature: await hmac(secret, ticketMessage(key, actor, expiresAt)) };
}

/**
 * Verify one. Returns { ok } or { ok:false, reason }. The ACTOR is an input,
 * not an output: the route passes the Access identity it already verified, so a
 * ticket minted for one person cannot be spent by another.
 */
export async function verifyUploadTicket({ secret, key, actor, expiresAt, signature, now = Date.now() }) {
  if (!secret) return { ok: false, reason: "no signing key configured" };
  if (!isOurMediaKey(key)) return { ok: false, reason: "not a key this application mints" };
  const exp = Number(expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed expiry" };
  if (exp <= now) return { ok: false, reason: "the upload link has expired" };
  const expected = await hmac(secret, ticketMessage(key, actor, exp));
  if (!equalConstantTime(expected, signature)) {
    return { ok: false, reason: "signature does not match this key, person and expiry" };
  }
  return { ok: true };
}

/* ── the bucket ─────────────────────────────────────────────────────────── */

/**
 * A narrow view of the R2 binding. Tools get this, never the bucket itself, so
 * `delete` is not reachable: nothing in this application removes a photograph.
 *
 * @param bucket  the R2 binding (env.MEDIA)
 * @param env     read for MEDIA_SIGNING_KEY and OPS_HOST
 */
/*
 * The signed link the human opens, minted identically whichever store is
 * behind it. Shared rather than written twice: the two stores must agree on
 * the route, the parameter names and the date format, and the only way to
 * guarantee that is for there to be one of them.
 */
function ticketUrl(env, opsOrigin) {
  return async function uploadUrl({ key, actor, now = Date.now() }) {
    const ticket = await mintUploadTicket({ secret: env.MEDIA_SIGNING_KEY, key, actor, now });
    const url = new URL("/media/upload", opsOrigin());
    url.searchParams.set("key", ticket.key);
    url.searchParams.set("exp", String(ticket.expiresAt));
    url.searchParams.set("sig", ticket.signature);
    return { url: url.toString(), expires_at: new Date(ticket.expiresAt).toISOString() };
  };
}

/*
 * The same surface, backed by SQUARE instead of a bucket.
 *
 * Built after a deliberate decision to drop R2: "If we leave Square, we will
 * just download them when we're leaving." That trade is real and it is theirs
 * to make — what it costs is written down in ADR-013 rather than discovered.
 *
 * The trick that removes the need for a local mapping table: Square's
 * CatalogImage carries a searchable `name`, so we upload with `name` set to
 * OUR key and ask Square for it back later. Square is the store AND the index.
 * A table mapping our keys to Square ids would be a second thing to keep
 * correct, and the only place the bytes exist is Square either way.
 *
 * `bytes()` is deliberately absent-by-refusal rather than faked. R2 could hand
 * back the original; Square hands back a URL. Anything needing the actual
 * pixels must fetch that URL, and pretending otherwise would make a caller
 * think it held something it does not.
 */
export function createSquareMediaStore(uploader, env = {}) {
  if (!uploader || typeof uploader.upload !== "function") {
    console.error("ERROR media: no Square image uploader — refusing to construct a media store");
    throw new Error("no Square uploader available for media storage");
  }

  const opsOrigin = () => `https://${env.OPS_HOST || "ops.vemians.com"}`;

  return {
    kind: "square",

    /** Did that upload land? Asks Square, because Square is where it went. */
    async head(key) {
      if (!isOurMediaKey(key)) return null;
      const found = await uploader.findByName(key);
      if (!found) return null;
      return { key, image_ref: found.imageRef, url: found.url, kind: "square" };
    },

    /*
     * What the catalog writer needs to put this photograph on an item.
     *
     * The R2 store answers with BYTES, because Square has never seen them. This
     * one answers with an IMAGE REF, because the upload already went to Square
     * and re-sending the same pixels would create a second CatalogImage for one
     * photograph. The writer branches on which it got.
     */
    async attachable(key) {
      const found = await this.head(key);
      if (!found) return null;
      return { key, imageRef: found.image_ref, url: found.url, source: "square" };
    },

    async bytes(_key) {
      /* Named, not silent. A caller that wanted pixels gets told where they
         are rather than an empty result it might treat as "no image". */
      throw new Error(
        "this deployment stores photographs in Square, which returns a URL and not bytes — " +
          "fetch the url from head(key)",
      );
    },

    async put(key, bytes, { contentType, actor, caption = "" } = {}) {
      if (!isOurMediaKey(key)) throw new Error(`${key} is not a key this application mints`);
      if (!STORABLE_IMAGE_TYPES.includes(contentType)) {
        throw new Error(`${contentType} is not an image type this application stores`);
      }
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      if (body.byteLength === 0) throw new Error("refusing to store zero bytes as a photograph");
      if (body.byteLength > CAPS.ORIGINAL_IMAGE_MAX_BYTES) {
        throw new Error(
          `${body.byteLength} bytes exceeds the ${CAPS.ORIGINAL_IMAGE_MAX_BYTES}-byte original limit`,
        );
      }
      /* Originals are never overwritten — the same rule the bucket enforces,
         asked of Square instead. */
      if (await uploader.findByName(key)) {
        console.error(`ERROR media: ${key} already exists in Square — refusing to overwrite an original`);
        throw new Error(`${key} already exists; originals are never overwritten`);
      }

      const { imageRef, url } = await uploader.upload({
        name: key,
        bytes: body,
        contentType,
        filename: key.split("/").pop() || "image.jpg",
        caption,
      });
      console.info(
        `INFO media: ${key} -> Square image ${imageRef} by ${actor ?? "unknown"}. ` +
          "No local original is kept on this deployment (ADR-013).",
      );
      return { key, bytes: body.byteLength, content_type: contentType, image_ref: imageRef, url };
    },

    /* Byte-for-byte the bucket's, deliberately. The browser posts to the same
       route with the same ticket; only what the Worker does with the bytes
       afterwards differs. Two implementations of one contract that disagree on
       a path or a date format is the failure mode this repository has hit three
       times today, so this one is not re-derived. */
    uploadUrl: ticketUrl(env, opsOrigin),
  };
}

export function createMediaStore(bucket, env = {}) {
  if (!bucket || typeof bucket.put !== "function") {
    console.error("ERROR media: no MEDIA (R2) binding — refusing to construct a media store");
    throw new Error("binding MEDIA is not attached to this Worker");
  }

  const opsOrigin = () => `https://${env.OPS_HOST || "ops.vemians.com"}`;

  return {
    kind: "r2",

    /** Does this key already hold bytes? Used to verify an upload landed. */
    async head(key) {
      if (!isOurMediaKey(key)) return null;
      const meta = await bucket.head(key);
      if (!meta) return null;
      return {
        key,
        size: Number(meta.size ?? 0),
        contentType: meta.httpMetadata?.contentType ?? meta.contentType ?? null,
        uploaded: meta.uploaded ?? null,
      };
    },

    /** The ORIGINAL bytes, for the copy that goes to Square. */
    async bytes(key) {
      if (!isOurMediaKey(key)) throw new Error(`${key} is not a key this application mints`);
      const obj = await bucket.get(key);
      if (!obj) return null;
      const buf = await obj.arrayBuffer();
      return {
        key,
        bytes: new Uint8Array(buf),
        contentType: obj.httpMetadata?.contentType ?? obj.contentType ?? "application/octet-stream",
      };
    },

    /**
     * Store an original. Refuses an occupied key rather than replacing what is
     * there: keys carry a uuid, so a collision means a bug, not a re-upload.
     */
    /* See the Square store's note: this side hands over the bytes, because
       Square has not seen this photograph yet. */
    async attachable(key) {
      const original = await this.bytes(key);
      return original ? { ...original, source: "r2" } : null;
    },

    async put(key, bytes, { contentType, actor, caption = "" } = {}) {
      if (!isOurMediaKey(key)) throw new Error(`${key} is not a key this application mints`);
      if (!STORABLE_IMAGE_TYPES.includes(contentType)) {
        throw new Error(`${contentType} is not an image type this bucket stores`);
      }
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      if (body.byteLength === 0) throw new Error("refusing to store zero bytes as a photograph");
      if (body.byteLength > CAPS.ORIGINAL_IMAGE_MAX_BYTES) {
        throw new Error(
          `${body.byteLength} bytes exceeds the ${CAPS.ORIGINAL_IMAGE_MAX_BYTES}-byte original limit`,
        );
      }
      if (await bucket.head(key)) {
        console.error(`ERROR media: ${key} already holds bytes — refusing to overwrite an original`);
        throw new Error(`${key} already exists; originals are never overwritten`);
      }
      await bucket.put(key, body, {
        httpMetadata: { contentType },
        customMetadata: { actor: String(actor ?? ""), caption: String(caption ?? "").slice(0, 255) },
      });
      return { key, bytes: body.byteLength, content_type: contentType };
    },

    /** The link the human opens. Access gates the route; the ticket binds it. */
    uploadUrl: ticketUrl(env, opsOrigin),
  };
}
