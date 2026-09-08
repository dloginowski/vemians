/*
 * CreateCatalogImage — the one Square endpoint that is not JSON.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT A METHOD ON client.js
 *
 * `client.js` speaks `application/json`: it stringifies every body and sets the
 * header unconditionally. `POST /v2/catalog/images` is `multipart/form-data`
 * with two parts — a JSON `request` part and an `image_file` part carrying the
 * bytes — so it cannot go through `request()` without changing what `request()`
 * means for every other caller. It gets its own module instead, in this
 * directory, because Test-PRD-P0-16-commerce_port says a Square URL and a
 * Square identifier appear inside `shared/commerce/square/` and nowhere else.
 * It reuses `resolveBaseUrl`, `backoffMs`, `SQUARE_VERSION` and `SquareError`
 * from client.js so there is one retry policy and one pinned API version.
 *
 * WHAT THIS IS AND IS NOT AUTHORITATIVE FOR
 *
 * It is not. The ORIGINAL lives in our R2 bucket under our own key
 * (Test-PRD-P0-28-image_contract; Test-PRD-P0-29-exit_test: "deleting a
 * provider must leave catalog, media ... intact"). What goes to Square is a
 * COPY, so the item looks right on the till and in the Square dashboard.
 * Losing Square loses the copy and nothing else; that asymmetry is the whole
 * design, and it is why this module uploads bytes it is handed rather than
 * ever fetching a photograph back from Square's CDN.
 *
 * FORMATS
 *
 * Square accepts JPEG, PJPEG, PNG and GIF for catalog images, up to 15 MB. Our
 * bucket takes a wider set — WebP, AVIF and HEIC all arrive from phones and
 * browsers — so a format Square will not take is STORED and simply not copied,
 * with the reason returned to the caller. Refusing to keep a photograph
 * because a till cannot display it would be the tail wagging the dog.
 */
import { SQUARE_VERSION, SquareError, resolveBaseUrl, backoffMs } from "./client.js";
import { idempotencyKey } from "./ids.js";

/** Square's documented catalog-image ceiling. */
export const SQUARE_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** Square's documented catalog-image content types. */
export const SQUARE_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/pjpeg",
  "image/png",
  "image/gif",
]);

/** Everything our own bucket will hold. A superset, deliberately. */
export const STORABLE_IMAGE_TYPES = Object.freeze([
  ...SQUARE_IMAGE_TYPES,
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
]);

export function squareAcceptsType(contentType) {
  return SQUARE_IMAGE_TYPES.includes(String(contentType || "").toLowerCase());
}

const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "no error detail";
  return errors
    .map((e) => `${e.category ?? "?"}/${e.code ?? "?"}${e.detail ? `: ${e.detail}` : ""}`)
    .join("; ");
}

/**
 * @param env   SQUARE_ACCESS_TOKEN, SQUARE_ENV
 * @param opts  fetchImpl / sleep / random — the same injection seams client.js has.
 */
export function createImageUploader(env, opts = {}) {
  const { fetchImpl = globalThis.fetch, sleep = defaultSleep, random = Math.random } = opts;

  const token = env?.SQUARE_ACCESS_TOKEN;
  if (!token) {
    console.error("ERROR square/images: SQUARE_ACCESS_TOKEN is unset — refusing to construct an uploader");
    throw new SquareError("SQUARE_ACCESS_TOKEN is unset");
  }
  if (typeof fetchImpl !== "function") {
    console.error("ERROR square/images: no fetch implementation available");
    throw new SquareError("no fetch implementation");
  }
  const baseUrl = resolveBaseUrl(env);

  /**
   * Attach one image to one catalog object.
   *
   * @param objectId        the Square ITEM id the image belongs to
   * @param bytes           Uint8Array / ArrayBuffer of the ORIGINAL, read from R2
   * @param contentType     the stored original's type
   * @param filename        for the multipart part; Square ignores it, humans do not
   * @param caption         alt text, mirrored back by catalog.js
   * @param idempotencySeed a stable seed — our R2 key — so a retry does not
   *                        create a second IMAGE object for one photograph
   * @returns {Promise<{ imageRef: string, url: string }>}
   */
  async function attach({
    objectId,
    bytes,
    contentType,
    filename = "image.jpg",
    caption = "",
    idempotencySeed,
  }) {
    if (!objectId) throw new SquareError("attach: no catalog object id");
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    if (body.byteLength === 0) throw new SquareError("attach: no image bytes");
    if (body.byteLength > SQUARE_IMAGE_MAX_BYTES) {
      throw new SquareError(
        `attach: ${body.byteLength} bytes exceeds Square's ${SQUARE_IMAGE_MAX_BYTES}-byte catalog image limit`,
      );
    }
    if (!squareAcceptsType(contentType)) {
      throw new SquareError(`attach: Square does not accept ${contentType} as a catalog image`);
    }

    const request = {
      idempotency_key: idempotencyKey(`image:${idempotencySeed ?? objectId}`),
      object_id: objectId,
      image: {
        type: "IMAGE",
        /* A client-supplied temp id; Square answers with the real one. */
        id: "#new-image",
        image_data: { caption: String(caption ?? "").slice(0, 255) },
      },
    };

    const url = new URL("/v2/catalog/images", baseUrl).toString();
    let attempt = 0;
    for (;;) {
      attempt += 1;

      /* Rebuilt per attempt: a FormData carrying a Blob is single-use once its
         stream has been read, so a retry on a shared instance sends nothing. */
      const form = new FormData();
      form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
      form.append("image_file", new Blob([body], { type: contentType }), filename);

      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Square-Version": SQUARE_VERSION,
            Accept: "application/json",
            /* Content-Type is set BY FormData, boundary included. Setting it
               by hand here is the classic way to make this endpoint 400. */
          },
          body: form,
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          console.error(
            `ERROR square/images: POST /v2/catalog/images unreachable after ${attempt} attempts — ${err.message}`,
          );
          throw new SquareError(`Square unreachable: ${err.message}`, {
            requestPath: "/v2/catalog/images",
            attempts: attempt,
          });
        }
        console.warn(`WARNING square/images: transport error, retrying — ${err.message}`);
        await sleep(backoffMs(attempt, null, random));
        continue;
      }

      const text = await res.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = {};
        }
      }

      if (res.ok) {
        const image = payload.image ?? payload.catalog_object ?? null;
        if (!image?.id) {
          console.error("ERROR square/images: upload returned 200 with no image id");
          throw new SquareError("Square returned no image id", {
            status: res.status,
            requestPath: "/v2/catalog/images",
          });
        }
        return { imageRef: image.id, url: image.image_data?.url ?? "" };
      }

      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
        const wait = backoffMs(attempt, res.headers?.get?.("Retry-After"), random);
        console.warn(
          `WARNING square/images: ${res.status}, retrying in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
        );
        await sleep(wait);
        continue;
      }

      console.error(
        `ERROR square/images: POST /v2/catalog/images failed ${res.status} after ${attempt} attempt(s) — ${describeErrors(errors)}`,
      );
      throw new SquareError(`Square image upload failed with ${res.status}`, {
        status: res.status,
        errors,
        requestPath: "/v2/catalog/images",
        attempts: attempt,
      });
    }
  }

  return { attach, baseUrl, version: SQUARE_VERSION };
}
