/*
 * Square webhooks: prove it, then normalise it.
 *
 * port.ts: "Verify webhook authenticity before anything else touches the
 * payload." Everything in this file is downstream of that sentence.
 *
 * HOW SQUARE SIGNS
 *
 * Square computes  base64( HMAC-SHA256( key = signature key,
 *                                       message = notificationUrl + rawBody ) )
 * and sends it in `x-square-hmacsha256-signature`.
 *
 * Two details are load-bearing and both are easy to get wrong:
 *
 *   * THE NOTIFICATION URL IS PART OF THE MESSAGE. It is the URL as registered
 *     in the Square dashboard, character for character — not the URL the
 *     request happens to arrive on. Behind Cloudflare those differ (scheme,
 *     trailing slash, a proxied hostname), so it is configuration
 *     (`SQUARE_WEBHOOK_URL`) rather than something reconstructed from the
 *     request. Reconstructing it is how signature verification passes in
 *     staging and fails in production.
 *
 *   * THE BODY MUST BE THE RAW BYTES. `JSON.parse` then `JSON.stringify`
 *     re-orders keys and re-spaces the text, and the HMAC of that is a
 *     different HMAC. So verification takes the string, and parsing happens
 *     only after it passes.
 *
 * There is an older `x-square-signature` header carrying an HMAC-SHA1 over the
 * same message. It is deliberately NOT accepted: honouring a legacy weaker
 * algorithm alongside a strong one lets an attacker choose the weak one.
 *
 * TIMING. The comparison is `crypto.timingSafeEqual` over decoded bytes, with
 * the length checked first (timingSafeEqual throws on a length mismatch, and
 * that throw is itself an early return, so the length is compared explicitly
 * and both branches end in the same place). `a === b` on base64 strings leaks
 * the position of the first differing character, and a forger who can measure
 * that can build a valid signature one byte at a time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-square-hmacsha256-signature";
export const LEGACY_SIGNATURE_HEADER = "x-square-signature";

/** The event types this adapter handles. Everything else normalises to null. */
export const HANDLED_EVENTS = Object.freeze([
  "catalog.version.updated",
  "inventory.count.updated",
  "order.created",
]);

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  /* A plain object, as a test fixture or a non-Fetch runtime supplies. */
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * Constant-time equality over the DECODED signature bytes.
 *
 * Decoding first matters as well as being tidy: base64 has multiple encodings
 * of the same bytes (padding, whitespace), and comparing the strings would
 * reject a signature that is in fact correct.
 */
function equalSignatures(expectedB64, providedB64) {
  let expected;
  let provided;
  try {
    expected = Buffer.from(expectedB64, "base64");
    provided = Buffer.from(String(providedB64), "base64");
  } catch {
    return false;
  }
  if (expected.length === 0 || expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * The signature check itself, over the raw body string.
 *
 * @returns {boolean} true only for a signature this key could have produced.
 */
export function verifySquareSignature({ body, signature, notificationUrl, signatureKey }) {
  if (!signatureKey) {
    /* Fail CLOSED and say why. A misconfigured key that silently accepted
       everything would turn the webhook endpoint into an unauthenticated write
       path into the stock ledger. */
    console.error(
      "ERROR square/webhooks: SQUARE_WEBHOOK_SIGNATURE_KEY is unset — rejecting the payload, nothing was read",
    );
    return false;
  }
  if (!notificationUrl) {
    console.error(
      "ERROR square/webhooks: SQUARE_WEBHOOK_URL is unset — the URL is part of the signed message, rejecting",
    );
    return false;
  }
  if (typeof signature !== "string" || signature.length === 0) return false;
  if (typeof body !== "string") {
    console.error("ERROR square/webhooks: body must be the raw request text, not a parsed object");
    return false;
  }

  const expected = createHmac("sha256", signatureKey)
    .update(notificationUrl + body, "utf8")
    .digest("base64");

  return equalSignatures(expected, signature);
}

/**
 * `CommerceAdapter.verifyWebhook` — headers + raw body -> boolean.
 * Nothing may parse the body until this has returned true.
 */
export async function verifyWebhook(headers, body, { signatureKey, notificationUrl } = {}) {
  const signature = headerValue(headers, SIGNATURE_HEADER);
  if (!signature) {
    if (headerValue(headers, LEGACY_SIGNATURE_HEADER)) {
      /* Present and refused, loudly: this is either a very old webhook
         subscription that needs re-registering, or someone downgrading. */
      console.error(
        `ERROR square/webhooks: only ${SIGNATURE_HEADER} is accepted; the legacy SHA-1 header was refused`,
      );
    }
    return false;
  }
  const ok = verifySquareSignature({ body, signature, notificationUrl, signatureKey });
  if (!ok) {
    console.error("ERROR square/webhooks: signature verification failed — payload rejected unread");
  }
  return ok;
}

/* ── normalisation ─────────────────────────────────────────────────────── */

/**
 * A verified Square event -> our shape, or null.
 *
 * port.ts: "Returns null for payloads this adapter does not handle." Null is
 * the answer for an unknown type, a malformed body and a handled type with a
 * body that does not carry what it should. Guessing at a half-present payload
 * is how a stock ledger acquires a movement that never happened.
 *
 * This function does NOT verify. Call verifyWebhook first; the caller has the
 * raw body and the headers, and this takes the parsed object so a stored
 * payload can be replayed through it.
 */
export function normaliseWebhook(event, { locationId = null } = {}) {
  if (!event || typeof event !== "object") return null;
  const type = event.type;
  if (!HANDLED_EVENTS.includes(type)) {
    /* Not an error: Square delivers whatever the subscription asked for, and
       an unhandled type is a normal, uninteresting thing. DEBUG-level noise at
       most, so it stays quiet — RULES.md §14, "do not spam benign fallbacks". */
    return null;
  }

  const occurredAt = event.created_at ?? null;
  const eventId = event.event_id ?? null;
  const object = event.data?.object ?? {};

  if (type === "catalog.version.updated") {
    /*
     * Square says only that the catalog version moved — never WHAT changed.
     * So the honest normalisation is "resync from this timestamp", which is
     * what SearchCatalogObjects(begin_time) is for. Pretending to know which
     * item changed would be inventing a fact.
     */
    const updatedAt = object.catalog_version?.updated_at ?? occurredAt;
    return {
      kind: "catalog.updated",
      eventId,
      occurredAt,
      /* The instruction to the sync job, not a claim about an entity. */
      resyncSince: updatedAt,
    };
  }

  if (type === "inventory.count.updated") {
    const raw = object.inventory_counts ?? [];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const counts = [];
    for (const c of raw) {
      if (locationId && c?.location_id && c.location_id !== locationId) {
        console.warn(
          `WARNING square/webhooks: inventory count at location ${c.location_id} ignored — one location only`,
        );
        continue;
      }
      if (!c?.catalog_object_id) continue;
      counts.push({
        variantExternalRef: c.catalog_object_id,
        state: c.state ?? null,
        /* Kept as Square sent it. inventory.js owns the parse, and a webhook
           must not become a second place quantities are interpreted. */
        quantity: c.quantity ?? null,
        calculatedAt: c.calculated_at ?? null,
      });
    }
    if (counts.length === 0) return null;
    return { kind: "inventory.updated", eventId, occurredAt, counts };
  }

  /* order.created */
  const created = object.order_created ?? null;
  const full = object.order ?? null;

  if (full?.id) {
    return {
      kind: "order.created",
      eventId,
      occurredAt,
      externalId: full.id,
      locationExternalRef: full.location_id ?? null,
      state: full.state ?? null,
      /* The whole order body was delivered; no follow-up fetch needed. */
      order: full,
      needsFetch: false,
    };
  }

  if (created?.order_id) {
    /*
     * The usual shape. `order.created` carries an ENVELOPE — order id, version,
     * location, state, created_at — and no line items and no total. So this
     * returns "an order exists, go and read it", and the caller does a
     * RetrieveOrder. Fabricating a zero-total order with no lines to satisfy a
     * type would put a false financial record in the store.
     */
    return {
      kind: "order.created",
      eventId,
      occurredAt,
      externalId: created.order_id,
      locationExternalRef: created.location_id ?? null,
      state: created.state ?? null,
      order: null,
      needsFetch: true,
    };
  }

  console.error("ERROR square/webhooks: order.created carried no order id — payload dropped");
  return null;
}
