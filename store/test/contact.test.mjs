/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *   * A behaviour change moves the PRD feature and its labeled check together.
 *
 * The contact form (ADR-015): a submission becomes a Square customer record,
 * and is the first outbound call and the first secret the public storefront
 * Worker has ever held.
 *
 * NO SQUARE ACCOUNT, TOKEN OR NETWORK CALL IS INVOLVED, and none is claimed —
 * exactly the same disclaimer shared/commerce/square/test/square.test.mjs
 * carries, and for the same reason: Square's endpoints are unreachable from
 * this environment's egress proxy. `fakeFetch` below serves handwritten
 * responses shaped like Square's documented CreateCustomer contract. What this
 * proves is the mapping, the validation and the failure handling; only a
 * sandbox token against a live account could prove Square actually accepts
 * what is sent.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");

register("../../shared/test/text-modules.mjs", import.meta.url);

const worker = (await import("../src/index.js")).default;
const { SITE } = await import("../../shared/site.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const ENV = { SURFACE: "public", SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN_CONTACT: "fixture-contact-token" };

/*
 * A fetch that serves fixtures and RECORDS every call, so "the storefront
 * called Square exactly once, with this body" is an assertion about a
 * counter rather than a hope. Same shape as square.test.mjs's own fakeFetch —
 * kept local rather than shared because that file's version also plays back
 * mirror/webhook fixtures this one has no use for.
 */
function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) {
      return new Response(JSON.stringify({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const route = routes[key];
    const answer = typeof route === "function" ? route(calls.length) : route;
    return new Response(JSON.stringify(answer.body ?? answer), {
      status: answer.status ?? 200,
      headers: answer.headers ?? { "content-type": "application/json" },
    });
  };
  impl.calls = calls;
  return impl;
}

/* The Worker logs the catalog source and, on the honeypot path, the discard —
   swallowed so the run is readable. */
function quiet(fn) {
  const { info, error } = console;
  console.info = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.info = info;
    console.error = error;
  }
}

async function postContact(fields, env = ENV) {
  const body = new URLSearchParams(fields).toString();
  const request = new Request("https://vemians.com/contact", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const res = await quiet(() => worker.fetch(request, env));
  return { status: res.status, html: await res.text() };
}

const VALID = { name: "Priya Kapoor", email: "priya@example.test", message: "Do you carry a size UK 10 in the coat?" };

/* ─────────────────────────────────────────────────────────────────────────
 * P0-58 — a contact form submission becomes a Square customer record
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_58_square_contact_form__a_valid_submission_creates_one_square_customer", async () => {
  const f = fakeFetch({ "/v2/customers": { customer: { id: "CUST_1" } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const { status, html } = await postContact(VALID);
    assert.equal(status, 200);
    assert.match(html, /Thank you/i);

    assert.equal(f.calls.length, 1, "exactly one outbound call for one submission");
    const call = f.calls[0];
    assert.equal(call.method, "POST");
    assert.match(call.url, /\/v2\/customers$/);
    assert.equal(call.headers.Authorization, `Bearer ${ENV.SQUARE_ACCESS_TOKEN_CONTACT}`);

    const body = JSON.parse(call.body);
    assert.equal(body.given_name, "Priya");
    assert.equal(body.family_name, "Kapoor");
    assert.equal(body.email_address, VALID.email);
    assert.equal(body.phone_number, undefined, "phone was not supplied and must not be sent as empty");
    assert.ok(body.note.includes(VALID.message), "the message must reach Square, in the note field");
    assert.ok(body.idempotency_key, "every write to Square carries an idempotency key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_58_square_contact_form__only_phone_is_optional", async () => {
  const f = fakeFetch({ "/v2/customers": { customer: { id: "CUST_2" } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f;
  try {
    for (const missing of ["name", "email", "message"]) {
      const fields = { ...VALID };
      delete fields[missing];
      const { status, html } = await postContact(fields);
      assert.equal(status, 400, `missing ${missing} must be refused`);
      assert.doesNotMatch(html, /Thank you/i);
    }
    assert.equal(f.calls.length, 0, "nothing must reach Square for a rejected submission");

    /* Phone absent — the one field allowed to be. */
    const { status } = await postContact(VALID);
    assert.equal(status, 200);
    assert.equal(f.calls.length, 1);

    /* Phone present — carried through when it is. */
    const withPhone = await postContact({ ...VALID, phone: "+1 555 0100" });
    assert.equal(withPhone.status, 200);
    const body = JSON.parse(f.calls[1].body);
    assert.equal(body.phone_number, "+1 555 0100");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_58_square_contact_form__an_incomplete_email_is_refused_before_square_is_called", async () => {
  const f = fakeFetch({ "/v2/customers": { customer: { id: "CUST_3" } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const { status, html } = await postContact({ ...VALID, email: "not-an-email" });
    assert.equal(status, 400);
    assert.match(html, /email/i);
    assert.equal(f.calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_58_square_contact_form__the_honeypot_is_answered_but_never_sent", async () => {
  const f = fakeFetch({ "/v2/customers": { customer: { id: "CUST_4" } } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const { status, html } = await postContact({ ...VALID, company: "I am a robot" });
    /* Answered exactly like a real success — telling a robot it was caught is
       telling whoever wrote it what to change. */
    assert.equal(status, 200);
    assert.match(html, /Thank you/i);
    assert.equal(f.calls.length, 0, "a caught submission must never reach Square");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_58_square_contact_form__a_square_failure_is_answered_honestly_not_a_silent_success", async () => {
  const f = fakeFetch({
    "/v2/customers": { status: 401, body: { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }] } },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const { status, html } = await postContact(VALID);
    assert.equal(status, 502);
    assert.doesNotMatch(html, /Thank you/i, "a failed send must never read as a success");
    assert.match(html, /did not send/i);
    /* The honest failure still hands over a way to actually be reached. */
    assert.ok(html.includes(SITE.phone) || html.includes(SITE.email), "a fallback contact method must be offered");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_58_square_contact_form__with_no_token_configured_it_says_so_rather_than_pretending", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(); // must never be called
  try {
    const { status, html } = await postContact(VALID, { ...ENV, SQUARE_ACCESS_TOKEN_CONTACT: undefined });
    assert.equal(status, 503);
    assert.match(html, /not connected/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("test_PRD_P0_58_square_contact_form__a_get_reads_as_not_found_not_as_a_hint_the_route_exists", async () => {
  const res = await quiet(() =>
    worker.fetch(new Request("https://vemians.com/contact", { method: "GET" }), ENV),
  );
  assert.equal(res.status, 404, "a GET must not confirm a form lives at this address with a 405");
});

check("test_PRD_P0_58_square_contact_form__the_token_never_appears_in_a_log_line", async () => {
  const f = fakeFetch({
    "/v2/customers": { status: 401, body: { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }] } },
  });
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  globalThis.fetch = f;
  try {
    await worker.fetch(
      new Request("https://vemians.com/contact", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(VALID).toString(),
      }),
      ENV,
    );
    for (const line of lines) assert.doesNotMatch(line, new RegExp(ENV.SQUARE_ACCESS_TOKEN_CONTACT));
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * ADR-015 — the credential and the exception are both scoped to one file
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_37_mirror_is_ours__the_contact_exception_is_scoped_to_one_file", () => {
  /* The browsing path stays exactly as pure as the original P0-37 check
     required — this does not loosen that check, it narrows where the ONE
     permitted exception may live. */
  const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const catalogAndViews = bare(read("store", "src", "catalog.js")) + bare(read("store", "src", "views.js"));
  assert.doesNotMatch(catalogAndViews, /squareup|connect\.square|commerce\/square/i);
  assert.doesNotMatch(catalogAndViews, /(await|return|=)\s*fetch\(/);

  /* index.js may ROUTE to the exception but must not itself import Square. */
  const indexSrc = bare(read("store", "src", "index.js"));
  assert.doesNotMatch(indexSrc, /commerce\/square/, "index.js must route to contact.js, not import Square directly");

  /* The exception itself, named and alone. */
  const contactSrc = bare(read("store", "src", "contact.js"));
  assert.match(contactSrc, /commerce\/square\/client\.js/);
  assert.match(contactSrc, /SQUARE_ACCESS_TOKEN_CONTACT/, "the contact credential must have its own name");
  assert.doesNotMatch(contactSrc, /env\.SQUARE_ACCESS_TOKEN\b/, "must never read the name ops's token uses");
});

test("every label in this file is unique and named in the PRD", () => {
  const prd = read("docs", "PRD.md");
  assert.ok(usedLabels.size >= 2, `expected the P0-58 and P0-37 labels above to register, saw ${usedLabels.size}`);
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is not a numbered feature in docs/PRD.md`);
  }
});
