/*
 * A thin Square REST client. Nothing above this file knows Square exists as a
 * network destination; nothing below it knows what our catalog looks like.
 *
 * ADR-009 makes Square authoritative for stock and for the commercial facts of
 * the catalog, which makes this file a SERVICE BOUNDARY in the sense RULES.md
 * §14 cares about: an outage here is logged loudly and degrades checkout, never
 * browsing. The storefront reads the mirror (mirror.js); Square is called for
 * exactly one thing on the public path — minting a payment link.
 *
 * Test-PRD-P0-16-commerce_port: everything here is adapter-internal. A Square
 * identifier or a Square URL must not appear outside shared/commerce/square/.
 */

/*
 * SQUARE-VERSION — pinned deliberately, never "latest".
 *
 * Square versions its API by date through the `Square-Version` request header
 * (YYYY-MM-DD). An application is otherwise pinned to whatever version was
 * current when it was created in the Square dashboard, which makes behaviour a
 * property of an account setting rather than of this repository. Sending the
 * header on every request moves that decision into version control.
 *
 * EVIDENCE FOR THIS VALUE. developer.squareup.com and connect.squareup.com are
 * both blocked by this environment's egress proxy (CONNECT tunnel 403), so the
 * version was established from Square's own published SDK artifacts rather than
 * from the docs:
 *
 *   - rubygems `square.rb` 46.1.0.20260819, published 2026-08-18. Square's gem
 *     versioning appends the pinned API version, so the suffix IS the version.
 *   - npm `square` 45.1.0, published 2026-08-18. Its tarball carries the string
 *     "2026-08-19" as the default Square-Version (341 occurrences in-package).
 *
 * Two independently published registries agree, so this is the current version
 * as of 2026-09-08. Bumping it is a deliberate change with a changelog read,
 * not a default.
 */
export const SQUARE_VERSION = "2026-08-19";

/* Sandbox and production are different hosts, not a path or a query flag. */
const BASE_URLS = Object.freeze({
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
});

/* Retried: Square's rate limiter, and its 5xx. Nothing else. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8000;

/*
 * A Square failure, carrying Square's own error array. The category/code pair
 * is what makes a failure actionable ("RATE_LIMITED" vs "UNAUTHORIZED"), so it
 * is preserved rather than flattened into a string.
 */
export class SquareError extends Error {
  constructor(message, { status = 0, errors = [], requestPath = "", attempts = 1 } = {}) {
    super(message);
    this.name = "SquareError";
    this.status = status;
    this.errors = errors;
    this.requestPath = requestPath;
    this.attempts = attempts;
  }

  /* Retryable in principle; the client has already exhausted its attempts. */
  get rateLimited() {
    return this.status === 429;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Backoff with full jitter. Without jitter every Worker isolate that took a 429
 * retries at the same instant and rebuilds the burst that caused it.
 * `Retry-After` wins when Square sends one — that is not a guess.
 */
export function backoffMs(attempt, retryAfterHeader, random = Math.random) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(Math.round(retryAfter * 1000), MAX_BACKOFF_MS);
  }
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/*
 * The token never appears in a log line, an error message or a thrown object.
 * `safeArguments` in ops/src/tools/audit.js redacts on the way into the audit
 * store; this is the same rule one layer lower, where the secret actually is.
 */
function describeErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "no error detail";
  return errors
    .map((e) => `${e.category ?? "?"}/${e.code ?? "?"}${e.detail ? `: ${e.detail}` : ""}`)
    .join("; ");
}

export function resolveBaseUrl(env) {
  const mode = String(env?.SQUARE_ENV ?? "sandbox").toLowerCase();
  const base = BASE_URLS[mode];
  if (!base) {
    console.error(
      `ERROR square/client: SQUARE_ENV="${mode}" is not one of ${Object.keys(BASE_URLS).join("|")}`,
    );
    throw new SquareError(`unknown SQUARE_ENV: ${mode}`);
  }
  return base;
}

/**
 * @param env  Worker env. Reads SQUARE_ACCESS_TOKEN, SQUARE_ENV, SQUARE_LOCATION_ID.
 * @param opts Injection seams for tests: fetchImpl, sleep, random, maxAttempts.
 */
export function createSquareClient(env, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = opts;

  const token = env?.SQUARE_ACCESS_TOKEN;
  if (!token) {
    /* A startup failure, per RULES.md §14: refuse here rather than fail
       per-request further in with a 401 nobody traces back to a missing var. */
    console.error(
      "ERROR square/client: SQUARE_ACCESS_TOKEN is unset — refusing to construct a client",
    );
    throw new SquareError("SQUARE_ACCESS_TOKEN is unset");
  }
  if (typeof fetchImpl !== "function") {
    console.error("ERROR square/client: no fetch implementation available");
    throw new SquareError("no fetch implementation");
  }

  const baseUrl = resolveBaseUrl(env);

  /* ONE location (ADR-009 open question 2, answered: one). Configuration, not
     a dimension in the model — so it lives here, never in a row. */
  const locationId = env?.SQUARE_LOCATION_ID ?? null;

  async function request(method, path, { body, query, headers } = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }

    let attempt = 0;
    let lastStatus = 0;
    let lastErrors = [];

    while (attempt < maxAttempts) {
      attempt += 1;

      let res;
      try {
        res = await fetchImpl(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Square-Version": SQUARE_VERSION,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        /* Transport failure: DNS, TLS, the Worker subrequest budget. Square
           being unreachable is the outage ADR-009 says must degrade checkout
           and not browsing, so it is logged and rethrown — never swallowed
           into a silent empty result that reads as "no products". */
        if (attempt >= maxAttempts) {
          console.error(
            `ERROR square/client: ${method} ${path} unreachable after ${attempt} attempts — ${err.message}`,
          );
          throw new SquareError(`Square unreachable: ${err.message}`, {
            requestPath: path,
            attempts: attempt,
          });
        }
        console.warn(
          `WARNING square/client: ${method} ${path} transport error, retrying — ${err.message}`,
        );
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
        /* Square answers 200 with an `errors` array for partial failures. */
        if (Array.isArray(payload.errors) && payload.errors.length > 0) {
          console.error(
            `ERROR square/client: ${method} ${path} returned 200 with errors — ${describeErrors(payload.errors)}`,
          );
        }
        return payload;
      }

      lastStatus = res.status;
      lastErrors = Array.isArray(payload.errors) ? payload.errors : [];

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
        const wait = backoffMs(attempt, res.headers?.get?.("Retry-After"), random);
        /* WARNING, not ERROR: a retried 429 is the rate limiter working. */
        console.warn(
          `WARNING square/client: ${method} ${path} ${res.status}, retrying in ${wait}ms (attempt ${attempt}/${maxAttempts})`,
        );
        await sleep(wait);
        continue;
      }

      console.error(
        `ERROR square/client: ${method} ${path} failed ${res.status} after ${attempt} attempt(s) — ${describeErrors(lastErrors)}`,
      );
      throw new SquareError(`Square ${method} ${path} failed with ${res.status}`, {
        status: res.status,
        errors: lastErrors,
        requestPath: path,
        attempts: attempt,
      });
    }

    console.error(
      `ERROR square/client: ${method} ${path} exhausted ${maxAttempts} attempts (last status ${lastStatus})`,
    );
    throw new SquareError(`Square ${method} ${path} exhausted ${maxAttempts} attempts`, {
      status: lastStatus,
      errors: lastErrors,
      requestPath: path,
      attempts: maxAttempts,
    });
  }

  /*
   * Square paginates everything with an opaque `cursor`, in two shapes:
   * ListCatalog carries it in the query string, the search and batch-retrieve
   * endpoints carry it in the body. One generator handles both, so no caller
   * writes its own `while (cursor)` and forgets the terminating case.
   */
  async function* paginate(method, path, { body, query, cursorIn = "query" } = {}) {
    let cursor;
    let pages = 0;
    for (;;) {
      const page = await request(method, path, {
        query: cursorIn === "query" ? { ...query, cursor } : query,
        body: cursorIn === "body" ? { ...body, cursor } : body,
      });
      pages += 1;
      yield page;
      cursor = page.cursor ?? undefined;
      if (!cursor) return;
      if (pages >= 1000) {
        /* A cursor that never terminates is a bug on one side or the other,
           and a Worker that loops on it burns the whole subrequest budget. */
        console.error(`ERROR square/client: ${path} exceeded 1000 pages — refusing to loop further`);
        return;
      }
    }
  }

  return {
    baseUrl,
    locationId,
    version: SQUARE_VERSION,
    request,
    paginate,
    get: (path, o) => request("GET", path, o),
    post: (path, body, o) => request("POST", path, { ...o, body }),
    put: (path, body, o) => request("PUT", path, { ...o, body }),
  };
}
