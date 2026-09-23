/*
 * The Square adapter — PRD-backed regression checks.
 *
 *     Run: node --test shared/commerce/square/test/square.test.mjs   (from the repo root)
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
 *     first; if there is no feature for it, write the feature.
 *   * When behaviour changes, the PRD feature and its labeled check move in the
 *     SAME change as the code. An adapter edit with a stale PRD is a process
 *     failure, not a follow-up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MECHANICS, AND WHAT IS AND IS NOT PROVEN HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The REAL schemas are loaded into in-memory node:sqlite databases — D1 IS
 * SQLite, and half the guarantees in this repository live in triggers and
 * views, so a check against a fake store proves nothing. `shared/db/commerce.sql`
 * is loaded unmodified, which is itself the proof that this adapter needed no
 * migration to it.
 *
 * NO SQUARE ACCOUNT, TOKEN OR NETWORK CALL IS INVOLVED, and none is claimed.
 * Square's endpoints are unreachable from this environment anyway — the egress
 * proxy refuses connect.squareup.com and developer.squareup.com with a 403. So
 * every Square response is a HANDWRITTEN fixture in ./fixtures, written against
 * Square's published object shapes, and `fakeFetch` serves them. What that
 * proves is the mapping, the arithmetic, the idempotency and the signature
 * algebra. What it CANNOT prove is that Square's live payloads match the
 * fixtures; only a sandbox token can, and there is none here.
 *
 * The one thing not faked is cryptography: webhook signatures are computed with
 * node:crypto from a fixture key, because a recorded signature string would
 * only prove that a constant equals itself.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { d1FromSql } from "../../../test/d1.mjs";

import { createSquareClient, SQUARE_VERSION, SquareError } from "../client.js";
import { normaliseCatalog, isWithdrawn } from "../catalog.js";
import { normaliseChanges, normaliseCounts, reasonForTransition } from "../inventory.js";
import { createPaymentLink } from "../checkout.js";
import { normaliseWebhook, verifyWebhook, SIGNATURE_HEADER, LEGACY_SIGNATURE_HEADER } from "../webhooks.js";
import { createMirror, SYNC_ACTOR } from "../mirror.js";
import { createSquareAdapter, orderFromSquare } from "../index.js";
import { moneyFromSquare, MoneyError } from "../money.js";
import { listVendors } from "../vendors.js";
import { derivedId, NS_SQUARE_INVENTORY_CHANGE } from "../ids.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQUARE_DIR = path.join(HERE, "..");
const REPO = path.join(SQUARE_DIR, "..", "..", "..");
const DB_DIR = path.join(REPO, "shared", "db");
const PRD = path.join(REPO, "docs", "PRD.md");
const FIXTURES = path.join(HERE, "fixtures");

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

/* ── labels, for the P0-30 traceability check ───────────────────────────── */

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

/* Every check registers through here, so nothing unlabeled can run. */
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* A D1 binding over the REAL schemas, loaded into node:sqlite (shared/test/d1.mjs). */

const MIRROR_SQL = fs.readFileSync(path.join(SQUARE_DIR, "schema.sql"), "utf8");
const COMMERCE_SQL = fs.readFileSync(path.join(DB_DIR, "commerce.sql"), "utf8");

/* OUR location uuid. Square's location id is configuration and never a row. */
const OUR_LOCATION = "0d0b6a2e-9f43-4c8e-9a0a-2f6f1c4e77aa";
const SQUARE_LOCATION = "LOC_SQUARE_MAIN";

const SIGNING_KEY = "fixture-signature-key-not-a-real-one";
const NOTIFICATION_URL = "https://ops.vemians.com/webhooks/square";

function stores() {
  const mirrorDb = d1FromSql(MIRROR_SQL);
  const commerceDb = d1FromSql(COMMERCE_SQL);
  commerceDb._raw.exec(
    `INSERT INTO location(id, name) VALUES ('${OUR_LOCATION}', 'Vemians');`,
  );
  const mirror = createMirror(mirrorDb, { commerce: commerceDb, locationId: OUR_LOCATION });
  return { mirrorDb, commerceDb, mirror };
}

function squareEnv(extra = {}) {
  return {
    SQUARE_ACCESS_TOKEN: "fixture-token",
    SQUARE_ENV: "sandbox",
    SQUARE_LOCATION_ID: SQUARE_LOCATION,
    SQUARE_WEBHOOK_SIGNATURE_KEY: SIGNING_KEY,
    SQUARE_WEBHOOK_URL: NOTIFICATION_URL,
    ...extra,
  };
}

/*
 * A fetch that serves fixtures and RECORDS every call, so "the storefront makes
 * no Square call" is an assertion about a counter rather than a hope.
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

/* Mirror the standard catalog fixture into a fresh pair of stores. */
async function seededCatalog(fixtureName = "catalog-list.json") {
  const s = stores();
  const normalised = normaliseCatalog(fixture(fixtureName).objects, { locationId: SQUARE_LOCATION });
  const counts = await s.mirror.syncCatalog(normalised, { full: true });
  return { ...s, normalised, counts };
}

const rows = (db, sql, ...params) => db._raw.prepare(sql).all(...params);
const one = (db, sql, ...params) => db._raw.prepare(sql).get(...params);

/* ─────────────────────────────────────────────────────────────────────────
 * P0-15 — money is an integer minor amount plus an explicit currency
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_15_money_minor_units__a_square_price_maps_to_an_integer_minor_bigint", () => {
  const { products } = normaliseCatalog(fixture("catalog-list.json").objects, {
    locationId: SQUARE_LOCATION,
  });
  const coat = products.find((p) => p.externalRef === "ITEM_COAT");
  const price = coat.variants[0].price;

  /* Square's money is {amount, currency} in minor units and so is ours; the
     only job here is that it stays an INTEGER on the way across. */
  assert.equal(typeof price.amountMinor, "bigint", "amountMinor must be a bigint, never a float");
  assert.equal(price.amountMinor, 560000n, "$5,600.00 is 560000 minor units");
  assert.equal(price.currency, "USD", "currency is explicit, never implied");

  for (const p of products) {
    for (const v of p.variants) {
      assert.equal(typeof v.price.amountMinor, "bigint");
      assert.ok(/^[A-Z]{3}$/.test(v.price.currency), "ISO-4217 or nothing");
    }
  }
});

check("test_PRD_P0_15_money_minor_units__a_fractional_amount_is_refused_rather_than_rounded", () => {
  /* The one dangerous case: a provider that promised integers sends 10.99.
     Rounding it silently is how a shop charges the wrong price for a year. */
  assert.throws(
    () => moneyFromSquare({ amount: 10.99, currency: "USD" }),
    MoneyError,
    "a float amount must throw, not round",
  );
  assert.throws(() => moneyFromSquare({ amount: 1099 }), MoneyError, "a missing currency must throw");
  assert.throws(() => moneyFromSquare({ amount: 1099, currency: "dollars" }), MoneyError);

  /* Integers in every legal JSON encoding still work. */
  assert.equal(moneyFromSquare({ amount: 1099, currency: "USD" }).amountMinor, 1099n);
  assert.equal(moneyFromSquare({ amount: "1099", currency: "USD" }).amountMinor, 1099n);
});

check("test_PRD_P0_15_money_minor_units__the_mirror_stores_an_integer_price_and_a_currency", async () => {
  const { mirrorDb } = await seededCatalog();
  const variant = one(mirrorDb, "SELECT * FROM mirror_variant_index WHERE sku = 'VEM-COAT-40'");

  assert.equal(variant.price_minor, 560000);
  assert.equal(Number.isInteger(variant.price_minor), true, "the stored price is an integer");
  assert.equal(variant.currency, "USD");

  /* And SQLite agrees about the storage class, which is the part a JS number
     comparison would not catch. */
  const type = one(mirrorDb, "SELECT typeof(price_minor) AS t FROM mirror_variant LIMIT 1");
  assert.equal(type.t, "integer", "price_minor is stored as an INTEGER, not a REAL");
});

check("test_PRD_P0_15_money_minor_units__no_column_in_the_mirror_schema_is_a_floating_point_type", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(MIRROR_SQL);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.length >= 6, `expected the mirror tables, found ${tables.length}`);

  for (const t of tables) {
    for (const col of db.prepare(`PRAGMA table_info('${t}')`).all()) {
      const decl = String(col.type ?? "").toUpperCase();
      assert.ok(
        !["REAL", "FLOAT", "DOUBLE", "NUMERIC"].includes(decl),
        `${t}.${col.name} is ${decl}: money must be integer minor units`,
      );
      if (col.name.endsWith("_minor")) {
        assert.equal(decl, "INTEGER", `${t}.${col.name} is ${decl}, not INTEGER`);
        assert.equal(col.notnull, 1, `${t}.${col.name} must be NOT NULL`);
      }
    }
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-16 — one adapter interface; the vendor id lives in one field
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_16_commerce_port__a_square_catalog_payload_maps_to_our_products_and_variants", async () => {
  const { mirrorDb, normalised } = await seededCatalog();

  /* ITEM -> product, ITEM_VARIATION -> variant, at the variation level. */
  assert.equal(normalised.products.length, 2);
  const coat = normalised.products.find((p) => p.externalRef === "ITEM_COAT");
  assert.equal(coat.title, "Shearling-trimmed wool-blend coat");
  assert.equal(coat.handle, "shearling-trimmed-wool-blend-coat");
  assert.equal(coat.variants.length, 2);
  assert.deepEqual(
    coat.variants.map((v) => v.sku),
    ["VEM-COAT-40", "VEM-COAT-42"],
  );

  /* Square's option ids resolved to human names, not stored as ids. */
  assert.deepEqual(coat.variants[0].options, { Size: "IT 40" });
  assert.deepEqual(coat.variants[1].options, { Size: "IT 42" });

  /* IMAGE and CATEGORY carried across and joined by OUR ids. */
  assert.equal(coat.media[0].externalRef, "IMG_COAT_FRONT");
  assert.equal(normalised.categories[0].name, "Outerwear");

  const product = one(mirrorDb, "SELECT * FROM mirror_product_index WHERE handle = 'shearling-trimmed-wool-blend-coat'");
  const category = one(mirrorDb, "SELECT * FROM mirror_category_index");
  assert.equal(product.category_id, category.id, "joined by our uuid, not by Square's id");
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_variant_index").length, 3);
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_image_index").length, 1);
});

check("test_PRD_P0_16_commerce_port__square_ids_appear_only_in_external_ref_columns", async () => {
  const { mirrorDb, commerceDb, mirror } = await seededCatalog();
  await mirror.syncInventoryChanges(
    normaliseChanges(fixture("inventory-changes.json").changes, { locationId: SQUARE_LOCATION }),
  );

  /* Every Square identifier the fixtures contain. If one of these strings turns
     up in a column that is not named external_ref, the vendor has leaked into
     our schema and the port has stopped being a boundary. */
  const squareIds = [
    "ITEM_COAT", "ITEM_SCARF", "VAR_COAT_IT40", "VAR_COAT_IT42", "VAR_SCARF_ONE",
    "IMG_COAT_FRONT", "CAT_OUTERWEAR", "OPT_SIZE", "OPTVAL_IT40", "OPTVAL_IT42",
    "ADJ_RECEIPT_COAT40", "ADJ_SALE_COAT40_A", "ADJ_SALE_COAT40_B", "PC_COAT42_STOCKTAKE",
    SQUARE_LOCATION,
  ];

  const leaks = [];
  for (const db of [mirrorDb, commerceDb]) {
    const tables = db._raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    for (const t of tables) {
      const cols = db._raw.prepare(`PRAGMA table_info('${t}')`).all().map((c) => c.name);
      for (const row of db._raw.prepare(`SELECT * FROM "${t}"`).all()) {
        for (const col of cols) {
          if (col === "external_ref") continue;
          const value = row[col];
          if (typeof value !== "string") continue;
          if (squareIds.some((id) => value.includes(id))) leaks.push(`${t}.${col} = ${value}`);
        }
      }
    }
  }
  assert.deepEqual(leaks, [], "Square identifiers outside external_ref");

  /* And they really are in external_ref — this is not passing by writing nothing. */
  const refs = rows(mirrorDb, "SELECT external_ref FROM mirror_product").map((r) => r.external_ref);
  assert.deepEqual(refs.sort(), ["ITEM_COAT", "ITEM_SCARF"]);
  assert.ok(
    rows(mirrorDb, "SELECT external_ref FROM mirror_inventory_change").length > 0,
    "the Square change ids are recorded, in external_ref",
  );

  /* Our location uuid is on the ledger; Square's location id is not. */
  const ledger = rows(commerceDb, "SELECT DISTINCT location_id FROM inventory_adjustment");
  assert.deepEqual(ledger.map((r) => r.location_id), [OUR_LOCATION]);
});

check("test_PRD_P0_37_mirror_is_ours__every_primary_key_in_the_mirror_is_our_own_uuid", async () => {
  const { mirrorDb, commerceDb, mirror } = await seededCatalog();
  await mirror.syncInventoryChanges(
    normaliseChanges(fixture("inventory-changes.json").changes, { locationId: SQUARE_LOCATION }),
  );
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  for (const t of ["mirror_product", "mirror_variant", "mirror_image", "mirror_category", "mirror_inventory_change"]) {
    for (const row of rows(mirrorDb, `SELECT id FROM ${t}`)) {
      assert.match(row.id, uuid, `${t}.id must be our uuid, not a Square id`);
    }
  }
  for (const row of rows(commerceDb, "SELECT id FROM inventory_adjustment")) {
    assert.match(row.id, uuid);
  }
});

check("test_PRD_P0_38_webhook_authenticity__a_tampered_webhook_body_fails_signature_verification", async () => {
  const body = JSON.stringify(fixture("webhooks.json").inventoryCountUpdated);
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(NOTIFICATION_URL + body, "utf8")
    .digest("base64");
  const opts = { signatureKey: SIGNING_KEY, notificationUrl: NOTIFICATION_URL };

  /* The genuine article verifies. */
  assert.equal(
    await verifyWebhook({ [SIGNATURE_HEADER]: signature }, body, opts),
    true,
    "a correctly signed body must verify",
  );

  /* One character changed in the payload — a quantity of 3 becomes 300. */
  const tampered = body.replace('"quantity":"3"', '"quantity":"300"');
  assert.notEqual(tampered, body, "the tamper must actually change the body");
  assert.equal(
    await verifyWebhook({ [SIGNATURE_HEADER]: signature }, tampered, opts),
    false,
    "a tampered body must NOT verify",
  );

  /* A forged signature, a wrong key, and a wrong notification URL all fail. */
  assert.equal(await verifyWebhook({ [SIGNATURE_HEADER]: "AAAA" }, body, opts), false);
  assert.equal(
    await verifyWebhook({ [SIGNATURE_HEADER]: signature }, body, { ...opts, signatureKey: "other-key" }),
    false,
  );
  assert.equal(
    await verifyWebhook({ [SIGNATURE_HEADER]: signature }, body, {
      ...opts,
      notificationUrl: "https://ops.vemians.com/webhooks/square/",
    }),
    false,
    "the notification URL is part of the signed message",
  );

  /* Fails closed when the key is missing, rather than accepting everything. */
  assert.equal(
    await verifyWebhook({ [SIGNATURE_HEADER]: signature }, body, { ...opts, signatureKey: undefined }),
    false,
  );

  /* The legacy SHA-1 header is refused: honouring a weaker algorithm alongside
     a strong one lets an attacker choose the weak one. */
  assert.equal(await verifyWebhook({ [LEGACY_SIGNATURE_HEADER]: signature }, body, opts), false);
});

check("test_PRD_P0_38_webhook_authenticity__an_unhandled_event_normalises_to_null_rather_than_a_guess", () => {
  const w = fixture("webhooks.json");
  assert.equal(normaliseWebhook(w.unhandledEvent), null, "an unhandled type returns null");
  assert.equal(normaliseWebhook(null), null);
  assert.equal(normaliseWebhook({ type: "order.created", data: { object: {} } }), null);
  assert.equal(normaliseWebhook({ type: "inventory.count.updated", data: { object: {} } }), null);

  /* The three we do handle each normalise into our shape. */
  const cat = normaliseWebhook(w.catalogVersionUpdated);
  assert.equal(cat.kind, "catalog.updated");
  assert.equal(cat.resyncSince, "2026-09-03T08:31:02.000Z");

  const inv = normaliseWebhook(w.inventoryCountUpdated, { locationId: SQUARE_LOCATION });
  assert.equal(inv.kind, "inventory.updated");
  assert.equal(inv.counts.length, 1, "the other location's count is dropped, not merged");
  assert.equal(inv.counts[0].variantExternalRef, "VAR_COAT_IT40");

  const ord = normaliseWebhook(w.orderCreatedEnvelope);
  assert.equal(ord.kind, "order.created");
  assert.equal(ord.externalId, "ORDER_FIXTURE_1");
  assert.equal(ord.needsFetch, true, "an envelope says fetch the order, it does not invent one");
});

check("test_PRD_P0_16_commerce_port__the_pinned_api_version_and_bearer_token_go_on_every_request", async () => {
  const f = fakeFetch({ "/v2/catalog/list": { objects: [] } });
  const client = createSquareClient(squareEnv(), { fetchImpl: f });
  await client.get("/v2/catalog/list");

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers["Square-Version"], SQUARE_VERSION);
  assert.match(SQUARE_VERSION, /^\d{4}-\d{2}-\d{2}$/, "Square versions by date");
  assert.equal(f.calls[0].headers.Authorization, "Bearer fixture-token");
  assert.ok(f.calls[0].url.startsWith("https://connect.squareupsandbox.com/"), "SQUARE_ENV=sandbox");

  /* production is a different host, not a flag. */
  const prod = createSquareClient(squareEnv({ SQUARE_ENV: "production" }), { fetchImpl: fakeFetch() });
  assert.equal(prod.baseUrl, "https://connect.squareup.com");

  /* No token is a refusal at construction, not a 401 somewhere later. */
  assert.throws(() => createSquareClient({ SQUARE_ENV: "sandbox" }, { fetchImpl: f }), SquareError);
});

check("test_PRD_P0_16_commerce_port__a_pasted_token_with_stray_whitespace_is_trimmed_not_sent_verbatim", async () => {
  /* A real incident: SQUARE_ACCESS_TOKEN_CONTACT was rotated to a genuine
     production token and every submission still got a flat 401 from Square
     — AUTHENTICATION_ERROR, the exact response an embedded newline or space
     from a copy-paste produces, since Square cannot "loosely match" a
     credential. Nothing upstream of this file strips that whitespace, and a
     Worker secret set via `wrangler secret put` carries whatever was pasted
     into its prompt byte for byte. */
  const f = fakeFetch({ "/v2/catalog/list": { objects: [] } });
  const client = createSquareClient(squareEnv({ SQUARE_ACCESS_TOKEN: "  fixture-token\n" }), { fetchImpl: f });
  await client.get("/v2/catalog/list");
  assert.equal(f.calls[0].headers.Authorization, "Bearer fixture-token", "no leading/trailing whitespace reaches Square");
});

check("test_PRD_P0_39_provider_rate_limits__a_rate_limited_request_backs_off_and_then_succeeds", async () => {
  const waits = [];
  let n = 0;
  const impl = async () => {
    n += 1;
    if (n <= 2) {
      return new Response(JSON.stringify({ errors: [{ category: "RATE_LIMIT_ERROR", code: "RATE_LIMITED" }] }), {
        status: 429,
        headers: { "content-type": "application/json", "Retry-After": "1" },
      });
    }
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  };
  const client = createSquareClient(squareEnv(), {
    fetchImpl: impl,
    sleep: async (ms) => waits.push(ms),
    random: () => 0.5,
  });

  const out = await client.get("/v2/catalog/list");
  assert.deepEqual(out, { objects: [] }, "the third attempt succeeds");
  assert.equal(n, 3, "two 429s were retried");
  assert.deepEqual(waits, [1000, 1000], "Retry-After is honoured rather than guessed at");

  /* And an unending 429 gives up loudly instead of hanging the Worker. */
  const always = async () =>
    new Response(JSON.stringify({ errors: [{ category: "RATE_LIMIT_ERROR", code: "RATE_LIMITED" }] }), {
      status: 429,
    });
  const stubborn = createSquareClient(squareEnv(), {
    fetchImpl: always,
    sleep: async () => {},
    maxAttempts: 3,
  });
  await assert.rejects(() => stubborn.get("/v2/catalog/list"), (err) => {
    assert.ok(err instanceof SquareError);
    assert.equal(err.rateLimited, true);
    assert.equal(err.attempts, 3);
    return true;
  });
});

check("test_PRD_P0_16_commerce_port__the_adapter_provides_every_method_the_port_declares", async () => {
  const { mirrorDb, commerceDb } = stores();
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl: fakeFetch() },
  });

  /* Read the port itself rather than a copy of its member list, so a method
     added to the interface fails here instead of being quietly unimplemented. */
  const port = fs.readFileSync(path.join(SQUARE_DIR, "..", "port.ts"), "utf8");
  const body = port.slice(port.indexOf("export interface CommerceAdapter"));
  const declared = [...body.matchAll(/^\s{2}([a-zA-Z]+)\s*\(/gm)].map((m) => m[1]);
  assert.ok(declared.includes("createCheckoutUrl"), `parsed the port: ${declared.join(", ")}`);

  for (const method of declared) {
    assert.equal(typeof adapter[method], "function", `SquareAdapter is missing ${method}`);
  }
  assert.equal(adapter.channelKind, "square", "a new channel is a new `channel` value");
});

check("test_PRD_P0_37_mirror_is_ours__a_paginated_sync_follows_every_cursor_and_stays_idempotent", async () => {
  /* The checks above exercise the pure normalisers. This one drives the whole
     adapter through the CLIENT, because Square paginates everything and it
     paginates in two different shapes — ListCatalog carries the cursor in the
     query string, the batch-retrieve endpoints carry it in the body. A sync
     that followed only the first page would mirror a partial catalog and look
     perfectly healthy doing it. */
  const objects = fixture("catalog-list.json").objects;
  const changes = fixture("inventory-changes.json").changes;
  const seen = [];

  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const queryCursor = new URL(url).searchParams.get("cursor");
    seen.push({ url, queryCursor, bodyCursor: body?.cursor ?? null });

    if (url.includes("/v2/catalog/list")) {
      return new Response(
        JSON.stringify(
          queryCursor
            ? { objects: objects.slice(3) }
            : { objects: objects.slice(0, 3), cursor: "PAGE2" },
        ),
      );
    }
    if (url.includes("/v2/inventory/changes/batch-retrieve")) {
      return new Response(
        JSON.stringify(
          body?.cursor ? { changes: changes.slice(3) } : { changes: changes.slice(0, 3), cursor: "C2" },
        ),
      );
    }
    if (url.includes("/v2/vendors/search")) {
      /* pullCatalog syncs vendors first, on every call — empty here since
         this test is exercising pagination, not vendors. */
      return new Response(JSON.stringify({ vendors: [] }));
    }
    return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
  };

  const { mirrorDb, commerceDb } = stores();
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl },
  });

  const catalog = await adapter.pullCatalog({ full: true });
  assert.equal(catalog.productsInserted, 2);
  assert.equal(catalog.variantsInserted, 3, "the second page was fetched, not dropped");
  assert.deepEqual(
    seen.filter((c) => c.url.includes("catalog/list")).map((c) => c.queryCursor),
    [null, "PAGE2"],
    "ListCatalog's cursor goes in the query string",
  );

  const inventory = await adapter.pullInventory({ since: "2026-09-01T00:00:00Z" });
  assert.equal(inventory.applied, 4, "changes from both pages reached the ledger");
  assert.deepEqual(
    seen.filter((c) => c.url.includes("changes/batch-retrieve")).map((c) => c.bodyCursor),
    [null, "C2"],
    "batch-retrieve's cursor goes in the body",
  );
  assert.equal(await adapter.mirror.onHand("VEM-COAT-40"), 3);

  /* And the same run again, through the same client, changes nothing. */
  const replay = await adapter.pullInventory({ since: "2026-09-01T00:00:00Z" });
  assert.equal(replay.applied, 0);
  assert.equal(rows(commerceDb, "SELECT id FROM inventory_adjustment").length, 4);
  assert.equal(await adapter.mirror.onHand("VEM-COAT-40"), 3, "stock not double-counted");

  const catalogReplay = await adapter.pullCatalog({ full: true });
  assert.equal(catalogReplay.productsInserted, 0, "no duplicate products on a re-sync");
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_product").length, 2);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-31 — stock is a ledger, not a number
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_31_inventory_ledger__square_changes_become_append_only_adjustments_with_a_derived_count", async () => {
  const { commerceDb, mirror } = await seededCatalog();
  const changes = normaliseChanges(fixture("inventory-changes.json").changes, {
    locationId: SQUARE_LOCATION,
  });

  /* Square's SOLD -> NONE tidy-up moves nothing we count, and the other
     location's +99 is dropped: one location, so it cannot be folded in. */
  assert.deepEqual(
    changes.map((c) => c.externalRef),
    ["ADJ_RECEIPT_COAT40", "ADJ_SALE_COAT40_A", "ADJ_SALE_COAT40_B", "PC_COAT42_STOCKTAKE"],
  );
  assert.deepEqual(
    changes.map((c) => [c.reason, c.delta]),
    [["receipt", 6], ["sale", -1], ["sale", -2], ["count", null]],
  );

  const result = await mirror.syncInventoryChanges(changes);
  assert.equal(result.applied, 4);

  /* Square's HISTORY, not just its latest number: four rows, each with the
     reason it happened and a system actor. */
  const ledger = rows(
    commerceDb,
    "SELECT sku, delta, reason, actor, created_at FROM inventory_adjustment ORDER BY created_at",
  );
  assert.equal(ledger.length, 4);
  assert.deepEqual(ledger.map((r) => r.reason), ["receipt", "sale", "sale", "count"]);
  assert.ok(ledger.every((r) => r.actor === SYNC_ACTOR), "a machine sync is not attributed to a person");
  assert.equal(ledger[0].created_at, "2026-09-04T09:00:00.000Z", "Square's own timestamp is kept");

  /* And the count is the VIEW folding the ledger up: 6 - 1 - 2 = 3. */
  const level = one(commerceDb, `SELECT on_hand FROM inventory_level WHERE sku = 'VEM-COAT-40'`);
  assert.equal(level.on_hand, 3);
  assert.equal(await mirror.onHand("VEM-COAT-40"), 3);
});

check("test_PRD_P0_31_inventory_ledger__a_physical_count_becomes_a_delta_against_our_derived_count", async () => {
  const { commerceDb, mirror } = await seededCatalog();
  const changes = normaliseChanges(fixture("inventory-changes.json").changes, {
    locationId: SQUARE_LOCATION,
  });

  /* Square's physical count is ABSOLUTE ("there are 3 on the shelf"); our
     ledger is deltas with CHECK (delta <> 0). We hold 0, so it is +3 —
     NOT a row saying 3, and not a second +3 on the next run. */
  const stocktake = changes.find((c) => c.kind === "PHYSICAL_COUNT");
  assert.equal(stocktake.quantity, 3);
  assert.equal(stocktake.delta, null, "the absolute number is not a delta");

  await mirror.syncInventoryChanges(changes);
  const row = one(commerceDb, "SELECT delta, reason FROM inventory_adjustment WHERE sku = 'VEM-COAT-42'");
  assert.deepEqual([row.delta, row.reason], [3, "count"]);
  assert.equal(await mirror.onHand("VEM-COAT-42"), 3);
});

check("test_PRD_P0_31_inventory_ledger__re_running_the_sync_does_not_duplicate_rows_or_double_count_stock", async () => {
  const { commerceDb, mirrorDb, mirror } = await seededCatalog();
  const changes = normaliseChanges(fixture("inventory-changes.json").changes, {
    locationId: SQUARE_LOCATION,
  });

  const first = await mirror.syncInventoryChanges(changes);
  const afterFirst = {
    ledger: rows(commerceDb, "SELECT id FROM inventory_adjustment").length,
    receipts: rows(mirrorDb, "SELECT id FROM mirror_inventory_change").length,
    coat40: await mirror.onHand("VEM-COAT-40"),
    coat42: await mirror.onHand("VEM-COAT-42"),
  };
  assert.deepEqual(afterFirst, { ledger: 4, receipts: 4, coat40: 3, coat42: 3 });
  assert.equal(first.applied, 4);

  /* THE CHECK: replay the identical batch twice more, as a redelivered webhook
     and a re-run nightly job would. */
  const second = await mirror.syncInventoryChanges(changes);
  const third = await mirror.syncInventoryChanges(changes);

  assert.equal(second.applied, 0, "nothing new on a replay");
  assert.equal(second.duplicates + second.skipped, 4);
  assert.equal(third.applied, 0);

  assert.deepEqual(
    {
      ledger: rows(commerceDb, "SELECT id FROM inventory_adjustment").length,
      receipts: rows(mirrorDb, "SELECT id FROM mirror_inventory_change").length,
      coat40: await mirror.onHand("VEM-COAT-40"),
      coat42: await mirror.onHand("VEM-COAT-42"),
    },
    afterFirst,
    "row counts identical and stock not double-counted",
  );

  /* The mechanism, asserted rather than assumed: the ledger id is DERIVED from
     the Square change id, so the second insert collides and is ignored. */
  const expected = derivedId(NS_SQUARE_INVENTORY_CHANGE, "ADJ_RECEIPT_COAT40");
  assert.ok(
    one(commerceDb, `SELECT id FROM inventory_adjustment WHERE id = '${expected}'`),
    "the adjustment id is derived from the Square change id",
  );
});

check("test_PRD_P0_31_inventory_ledger__history_cannot_be_edited_or_deleted", async () => {
  const { commerceDb, mirrorDb, mirror } = await seededCatalog();
  await mirror.syncInventoryChanges(
    normaliseChanges(fixture("inventory-changes.json").changes, { locationId: SQUARE_LOCATION }),
  );

  assert.throws(
    () => commerceDb._raw.exec("UPDATE inventory_adjustment SET delta = 99"),
    /append-only/,
    "the stock ledger refuses an edit",
  );
  assert.throws(
    () => commerceDb._raw.exec("DELETE FROM inventory_adjustment"),
    /append-only/,
    "the stock ledger refuses a delete",
  );
  /* And so does the mirror's ingest receipt, for the same reason: deleting one
     would let a replay re-apply history that has already been applied. */
  assert.throws(() => mirrorDb._raw.exec("DELETE FROM mirror_inventory_change"), /append-only/);

  /* The undo is an equal and opposite adjustment, and both stay on the record. */
  const before = await mirror.onHand("VEM-COAT-40");
  commerceDb._raw.exec(
    `INSERT INTO inventory_adjustment(id, sku, location_id, delta, reason, actor)
     VALUES ('11111111-2222-4333-8444-555555555555', 'VEM-COAT-40', '${OUR_LOCATION}', -3, 'correction', 'manager@vemians.com')`,
  );
  assert.equal(await mirror.onHand("VEM-COAT-40"), before - 3);
  assert.equal(rows(commerceDb, "SELECT id FROM inventory_adjustment").length, 5, "the error stays on the record");
});

check("test_PRD_P0_31_inventory_ledger__an_unmirrored_variation_is_refused_not_invented", async () => {
  const { commerceDb, mirror } = await seededCatalog();
  const orphan = [
    {
      kind: "ADJUSTMENT",
      externalRef: "ADJ_GHOST",
      variantExternalRef: "VAR_NEVER_MIRRORED",
      delta: 5,
      quantity: null,
      reason: "receipt",
      occurredAt: "2026-09-07T09:00:00.000Z",
    },
  ];
  const result = await mirror.syncInventoryChanges(orphan);
  assert.equal(result.skipped, 1);
  assert.equal(result.applied, 0);
  assert.equal(
    rows(commerceDb, "SELECT id FROM inventory_adjustment").length,
    0,
    "real stock is not attached to a product we have never seen",
  );
});

check("test_PRD_P0_31_inventory_ledger__squares_state_machine_maps_onto_our_eight_reasons", () => {
  /* The schema CHECKs the right-hand side, so an unmapped transition must land
     on a legal value rather than being dropped or inventing one. */
  const legal = new Set(["count", "receipt", "sale", "return", "damage", "theft", "correction", "transfer"]);
  assert.equal(reasonForTransition("NONE", "IN_STOCK"), "receipt");
  assert.equal(reasonForTransition("IN_STOCK", "SOLD"), "sale");
  assert.equal(reasonForTransition("RETURNED_BY_CUSTOMER", "IN_STOCK"), "return");
  assert.equal(reasonForTransition("IN_STOCK", "WASTE"), "damage");
  assert.equal(reasonForTransition("SOMETHING", "NEW_IN_2027"), "correction");
  for (const [from, to] of [["NONE", "IN_STOCK"], ["IN_STOCK", "SOLD"], ["X", "Y"]]) {
    assert.ok(legal.has(reasonForTransition(from, to)));
  }

  /* A fractional quantity (goods sold by weight) is refused, not rounded into
     a whole-unit ledger. */
  const weighed = normaliseChanges(
    [{ type: "ADJUSTMENT", adjustment: { id: "A", from_state: "NONE", to_state: "IN_STOCK", quantity: "1.5", catalog_object_id: "V" } }],
    {},
  );
  assert.deepEqual(weighed, []);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-36 — index the working set, archive the rest, delete nothing
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_36_working_set_index__a_product_withdrawn_in_square_is_archived_and_not_deleted", async () => {
  const { mirrorDb, mirror } = await seededCatalog();
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_product_index").length, 2);
  const scarfBefore = one(mirrorDb, "SELECT id, handle FROM mirror_product WHERE external_ref = 'ITEM_SCARF'");

  /* The next night, the scarf is withdrawn at the counter. */
  await mirror.syncCatalog(
    normaliseCatalog(fixture("catalog-list-withdrawn.json").objects, { locationId: SQUARE_LOCATION }),
    { full: true },
  );

  /* Gone from the working set... */
  const index = rows(mirrorDb, "SELECT external_ref FROM mirror_product_index");
  assert.deepEqual(index.map((r) => r.external_ref), ["ITEM_COAT"]);

  /* ...but the ROW is still there, with the same id and the same handle. */
  const scarfAfter = one(mirrorDb, "SELECT * FROM mirror_product WHERE external_ref = 'ITEM_SCARF'");
  assert.ok(scarfAfter, "the withdrawn product row still exists");
  assert.equal(scarfAfter.id, scarfBefore.id, "one row, one id, one lifetime");
  assert.equal(scarfAfter.handle, scarfBefore.handle);
  assert.ok(scarfAfter.archived_at, "archived_at is set");
  assert.equal(scarfAfter.status, "archived");

  /* The variant went with it, so nothing sellable dangles. */
  const variant = one(mirrorDb, "SELECT * FROM mirror_variant WHERE external_ref = 'VAR_SCARF_ONE'");
  assert.ok(variant.archived_at);
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_variant_index").length, 2);

  /* Total rows unchanged: nothing was removed, only marked. */
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_product").length, 2);
});

check("test_PRD_P0_36_working_set_index__archived_rows_stay_queryable_by_an_explicit_call", async () => {
  const { mirror } = await seededCatalog();
  await mirror.syncCatalog(
    normaliseCatalog(fixture("catalog-list-withdrawn.json").objects, { locationId: SQUARE_LOCATION }),
    { full: true },
  );

  const working = await mirror.productIndex();
  assert.deepEqual(working.map((p) => p.external_ref), ["ITEM_COAT"], "the default read is the working set");

  const archived = await mirror.archivedProducts();
  assert.equal(archived.length, 1, "reaching further is a deliberate, separate act");
  assert.equal(archived[0].external_ref, "ITEM_SCARF");
  assert.equal(archived[0].title, "Double-face cashmere scarf", "the data survived, it did not just persist as a stub");
});

check("test_PRD_P0_36_working_set_index__the_database_refuses_a_delete_outright", async () => {
  const { mirrorDb } = await seededCatalog();
  /* Archiving must be a property of the schema, not of the adapter remembering
     to call UPDATE instead of DELETE. */
  for (const t of [
    "mirror_product",
    "mirror_variant",
    "mirror_image",
    "mirror_category",
    "mirror_item_option",
    "mirror_item_option_value",
    "mirror_product_item_option",
  ]) {
    assert.throws(
      () => mirrorDb._raw.exec(`DELETE FROM ${t}`),
      /archive-only/,
      `${t} must refuse DELETE`,
    );
  }
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_product").length, 2, "nothing was removed");
});

check("test_PRD_P0_36_working_set_index__re_running_the_catalog_sync_does_not_duplicate_rows", async () => {
  const { mirrorDb, mirror, normalised } = await seededCatalog();
  const snapshot = () => ({
    products: rows(mirrorDb, "SELECT id, external_ref, handle FROM mirror_product ORDER BY external_ref"),
    variants: rows(mirrorDb, "SELECT id, external_ref, price_minor FROM mirror_variant ORDER BY external_ref"),
    images: rows(mirrorDb, "SELECT id, external_ref FROM mirror_image ORDER BY external_ref"),
    categories: rows(mirrorDb, "SELECT id, external_ref FROM mirror_category ORDER BY external_ref"),
  });
  const before = snapshot();
  assert.equal(before.products.length, 2);
  assert.equal(before.variants.length, 3);

  /* Re-run the identical sweep twice. */
  await mirror.syncCatalog(normalised, { full: true });
  await mirror.syncCatalog(normalised, { full: true });

  assert.deepEqual(snapshot(), before, "identical rows, identical ids, no duplicates");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-26 — the storefront is ours, and calls a provider only for checkout
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_37_mirror_is_ours__browsing_reads_the_mirror_and_makes_zero_square_calls", async () => {
  const { mirrorDb, commerceDb, mirror } = await seededCatalog();
  await mirror.syncInventoryChanges(
    normaliseChanges(fixture("inventory-changes.json").changes, { locationId: SQUARE_LOCATION }),
  );

  /* A client whose fetch THROWS: Square is down, or the token is revoked. */
  const dead = async () => {
    throw new Error("Square is unreachable");
  };
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl: dead, sleep: async () => {}, maxAttempts: 1 },
  });

  /* The shop still browses. This is the whole contract: an outage degrades
     checkout, not browsing. */
  const products = await adapter.mirror.productIndex();
  assert.equal(products.length, 2);
  const coat = await adapter.mirror.productByHandle("shearling-trimmed-wool-blend-coat");
  assert.equal(coat.title, "Shearling-trimmed wool-blend coat");
  const variants = await adapter.mirror.variantsFor(coat.id);
  assert.equal(variants.length, 2);
  assert.equal(variants[0].price_minor, 560000);
  assert.equal(await adapter.mirror.onHand("VEM-COAT-40"), 3, "stock reads from our ledger too");

  /* And checkout is the thing that degrades. */
  await assert.rejects(
    () => adapter.createCheckoutUrl([{ variantId: variants[0].id, quantity: 1 }]),
    /unreachable/,
  );
});

check("test_PRD_P0_37_mirror_is_ours__minting_a_checkout_url_is_the_only_live_square_call", async () => {
  const { mirrorDb, commerceDb, mirror } = await seededCatalog();
  const f = fakeFetch({ "/v2/online-checkout/payment-links": fixture("payment-link.json") });
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl: f },
  });

  const coat = await mirror.productByHandle("shearling-trimmed-wool-blend-coat");
  const [it40] = await mirror.variantsFor(coat.id);

  /* A whole browse: index, product page, variants, stock. */
  await adapter.mirror.productIndex();
  await adapter.mirror.variantsFor(coat.id);
  await adapter.mirror.onHand("VEM-COAT-40");
  assert.equal(f.calls.length, 0, "browsing made ZERO calls to Square");

  /* Then checkout — our uuid in, a Square-hosted URL out. */
  const url = await adapter.createCheckoutUrl([{ variantId: it40.id, quantity: 1 }], { cartId: "cart-1" });
  assert.equal(url, "https://square.link/u/FIXTURE1");
  assert.equal(f.calls.length, 1, "exactly one Square call, and it is the payment link");
  assert.ok(f.calls[0].url.endsWith("/v2/online-checkout/payment-links"));

  /* The caller never saw a Square id; the adapter resolved it from the mirror. */
  const sent = JSON.parse(f.calls[0].body);
  assert.deepEqual(sent.order.line_items, [{ catalog_object_id: "VAR_COAT_IT40", quantity: "1" }]);
  assert.equal(sent.order.location_id, SQUARE_LOCATION);
  assert.match(it40.id, /^[0-9a-f-]{36}$/, "the caller passed one of OUR uuids");
});

check("test_PRD_P0_37_mirror_is_ours__a_handle_is_stable_when_the_title_is_retyped_in_square", async () => {
  const { mirrorDb, mirror } = await seededCatalog();
  const before = one(mirrorDb, "SELECT id, handle, title FROM mirror_product WHERE external_ref = 'ITEM_COAT'");
  assert.equal(before.handle, "shearling-trimmed-wool-blend-coat");

  /* Staff rename the item at the counter. The URL must not move: a handle is a
     public link, and re-deriving it from the new title would 404 it. */
  await mirror.syncCatalog(
    normaliseCatalog(fixture("catalog-list-withdrawn.json").objects, { locationId: SQUARE_LOCATION }),
    { full: true },
  );
  const after = one(mirrorDb, "SELECT id, handle, title FROM mirror_product WHERE external_ref = 'ITEM_COAT'");

  assert.equal(after.handle, before.handle, "the handle survived the rename");
  assert.equal(after.id, before.id);
  assert.equal(after.title, "Shearling coat (AW26)", "but the title did update");
  assert.ok(await mirror.productByHandle(before.handle), "the old URL still resolves");
});

check("test_PRD_P0_31_inventory_ledger__push_inventory_posts_a_physical_count_and_the_sync_ledgers_it", async () => {
  /* inventory.adjust (ops/src/tools/commerce.js) computes a resulting
     ABSOLUTE count and hands it here — pushInventory's own job is only to
     tell Square what that count now is, as a PHYSICAL_COUNT event, using
     SQUARE's own location id (client.locationId), never ours. Square is
     still the one true count (ADR-009): this never writes our own ledger
     directly, so the second half of this test proves the SAME sync path
     any other Square-side stock event already goes through
     (syncInventoryChanges) is what actually turns this into a row. */
  const { mirrorDb, commerceDb, mirror } = await seededCatalog();
  const pushed = [];
  const retrieved = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.includes("/v2/inventory/changes/batch-create")) {
      pushed.push(body);
      return new Response(JSON.stringify({ counts: [] }));
    }
    if (url.includes("/v2/inventory/changes/batch-retrieve")) {
      retrieved.push(body);
      return new Response(
        JSON.stringify({
          changes: [
            {
              type: "PHYSICAL_COUNT",
              physical_count: {
                id: "SQ_PC_1",
                catalog_object_id: "VAR_COAT_IT40",
                state: "IN_STOCK",
                location_id: SQUARE_LOCATION,
                quantity: "9",
                occurred_at: "2026-01-01T00:00:00Z",
              },
            },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
  };
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl },
  });

  await adapter.pushInventory([{ externalRef: "VAR_COAT_IT40", onHand: 9 }]);
  assert.equal(pushed.length, 1);
  const change = pushed[0].changes[0];
  assert.equal(change.type, "PHYSICAL_COUNT");
  assert.equal(change.physical_count.catalog_object_id, "VAR_COAT_IT40");
  assert.equal(change.physical_count.location_id, SQUARE_LOCATION, "Square's own location id, not ours");
  assert.equal(change.physical_count.quantity, "9", "a decimal STRING, the same shape Square's own reads use");
  assert.equal(change.physical_count.state, "IN_STOCK");

  const result = await adapter.pullInventory({ catalogObjectIds: ["VAR_COAT_IT40"] });
  assert.equal(result.applied, 1, "the same sync path every other Square-side stock event already goes through");
  const row = one(
    commerceDb,
    "SELECT sku, delta, reason FROM inventory_adjustment WHERE sku = 'VEM-COAT-40'",
  );
  assert.equal(row.delta, 9, "0 on hand -> 9 counted is a +9 delta, never the raw 9 written as an overwrite");
  assert.equal(row.reason, "count");

  /* Regression: Square's own InventoryChangeType enum for THIS endpoint has
     no TRANSFER value at all — asking for it is a 400, not an empty
     result (a real production incident this exact request shape caused).
     retrieved[0] is the batch-retrieve call the pullInventory above just made. */
  assert.deepEqual(retrieved[0].types, ["PHYSICAL_COUNT", "ADJUSTMENT"], "never ask Square for a TRANSFER type here");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-138 — nested categories, backed by Square's own real hierarchy
 * ───────────────────────────────────────────────────────────────────────── */

const rawCategory = (id, name, parentId = null) => ({
  type: "CATEGORY",
  id,
  category_data: { name, ...(parentId ? { parent_category: { id: parentId } } : {}) },
});

check("test_PRD_P0_138_nested_categories__parent_id_resolves_regardless_of_list_order", async () => {
  /* A child can arrive before its own parent in Square's own list order —
     the second pass (mirror.js's own syncCatalog) must not care which came
     first within the SAME sync call. */
  const { mirrorDb, mirror } = stores();

  const childFirst = normaliseCatalog([rawCategory("CAT_CHILD", "Casual", "CAT_PARENT"), rawCategory("CAT_PARENT", "Outerwear")]);
  await mirror.syncCatalog(childFirst, { full: true });
  const parentRow = mirrorDb._raw.prepare("SELECT id FROM mirror_category WHERE external_ref = 'CAT_PARENT'").get();
  const childRow = mirrorDb._raw.prepare("SELECT parent_id FROM mirror_category WHERE external_ref = 'CAT_CHILD'").get();
  assert.equal(childRow.parent_id, parentRow.id, "child-before-parent in the same batch still resolves");
});

const rawItemIn = (id, name, { reportingCategory = null, categories = [] } = {}) => ({
  type: "ITEM",
  id,
  updated_at: "2026-09-02T11:02:00.000Z",
  version: 1,
  is_deleted: false,
  item_data: {
    name,
    ...(reportingCategory ? { reporting_category: { id: reportingCategory } } : {}),
    ...(categories.length ? { categories: categories.map((catId, ordinal) => ({ id: catId, ordinal })) } : {}),
  },
});

check("test_PRD_P0_138_nested_categories__a_stale_reporting_category_falls_through_to_a_live_categories_membership", async () => {
  /* Square does not require reporting_category to be cleared or updated
     when an item's real categories[] membership changes — a merchant who
     re-files an item purely through the plain category browser (never
     revisiting "Reporting category" explicitly) ends up with a
     reporting_category still pointing at a category the item no longer
     belongs to, or one Square has since deleted outright. CAT_DELETED here
     is never itself synced as a CATEGORY object, standing in for exactly
     that: a reference to nothing we hold. The item's LIVE assignment
     (CAT_COCKTAIL, nested under CAT_DRESSES) must still resolve. */
  const { mirrorDb, mirror } = stores();
  const objects = [
    rawCategory("CAT_DRESSES", "Dresses"),
    rawCategory("CAT_COCKTAIL", "Cocktail", "CAT_DRESSES"),
    rawItemIn("ITEM_BLACK_DRESS", "Black Dress", {
      reportingCategory: "CAT_DELETED",
      categories: ["CAT_COCKTAIL"],
    }),
  ];
  const normalised = normaliseCatalog(objects);
  assert.deepEqual(
    normalised.products[0].categoryExternalRefs,
    ["CAT_DELETED", "CAT_COCKTAIL"],
    "candidates offered in priority order, stale one first",
  );

  await mirror.syncCatalog(normalised, { full: true });
  const product = one(mirrorDb, "SELECT * FROM mirror_product_index WHERE external_ref = 'ITEM_BLACK_DRESS'");
  const cocktail = one(mirrorDb, "SELECT id FROM mirror_category_index WHERE external_ref = 'CAT_COCKTAIL'");
  assert.equal(
    product.category_id,
    cocktail.id,
    "a dead reporting_category must not blank out a real, current categories[] membership",
  );
});

check("test_PRD_P0_138_nested_categories__an_incremental_sync_of_just_the_child_still_finds_its_parent", async () => {
  /* The realistic incremental case: the parent synced in an EARLIER call,
     the child (a rename, say) syncs alone later. categoryIdByRef only ever
     holds rows touched in THIS call, so this must fall back to a DB
     lookup — never NULL out an already-known parent link. */
  const { mirrorDb, mirror } = stores();
  await mirror.syncCatalog(normaliseCatalog([rawCategory("CAT_PARENT", "Outerwear")]), { full: true });
  await mirror.syncCatalog(normaliseCatalog([rawCategory("CAT_CHILD", "Casual", "CAT_PARENT")]), { full: false });

  const parentRow = mirrorDb._raw.prepare("SELECT id FROM mirror_category WHERE external_ref = 'CAT_PARENT'").get();
  const childRow = mirrorDb._raw.prepare("SELECT parent_id FROM mirror_category WHERE external_ref = 'CAT_CHILD'").get();
  assert.equal(childRow.parent_id, parentRow.id);

  /* And re-syncing the child AGAIN, alone, a third time (e.g. its name
     changed once more) must not lose that link either. */
  await mirror.syncCatalog(normaliseCatalog([rawCategory("CAT_CHILD", "Smart Casual", "CAT_PARENT")]), { full: false });
  const childAgain = mirrorDb._raw.prepare("SELECT parent_id, name FROM mirror_category WHERE external_ref = 'CAT_CHILD'").get();
  assert.equal(childAgain.parent_id, parentRow.id, "a later sync of the child alone must not NULL an already-known parent");
  assert.equal(childAgain.name, "Smart Casual");
});

check("test_PRD_P0_138_nested_categories__numeric_id_survives_every_re_sync_untouched", async () => {
  /* OURS, not Square's — the same "never named in mirror.js's own UPDATE"
     convention channel/custom_fields already establish on mirror_product,
     extended here to mirror_category's own numeric_id. */
  const { mirrorDb, mirror } = stores();
  await mirror.syncCatalog(normaliseCatalog([rawCategory("CAT_PARENT", "Outerwear")]), { full: true });
  const row = mirrorDb._raw.prepare("SELECT id FROM mirror_category WHERE external_ref = 'CAT_PARENT'").get();
  mirrorDb._raw.prepare("UPDATE mirror_category SET numeric_id = '01' WHERE id = ?").run(row.id);

  await mirror.syncCatalog(normaliseCatalog([rawCategory("CAT_PARENT", "Outerwear (renamed)")]), { full: false });
  const after = mirrorDb._raw.prepare("SELECT name, numeric_id FROM mirror_category WHERE id = ?").get(row.id);
  assert.equal(after.name, "Outerwear (renamed)", "the sync still updates what Square DOES own");
  assert.equal(after.numeric_id, "01", "but never touches what it does not");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-137 — archiving/restoring a product must never destroy it
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_137_item_active_toggle__retract_round_trips_the_whole_object_never_a_bare_presence_patch", async () => {
  /* The bug this guards: UpsertCatalogObject is FULL-REPLACEMENT, not a
     patch — Square's own API description says a field absent from the
     request is an intentional clear, "omitting inlined children like
     variations will delete them." The original retractProduct sent only
     { type, id, present_at_all_locations }, which would have silently
     wiped the item's own name and variations the first time it ever ran
     for real. The fix: GET the object whole first, flip only the
     presence fields, send the SAME object back with its own item_data
     and version intact. */
  const { mirrorDb, commerceDb } = await seededCatalog();
  const coat = fixture("catalog-list.json").objects.find((o) => o.id === "ITEM_COAT");
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "GET" || !init.method) {
      if (url.includes("/v2/catalog/object/ITEM_COAT")) {
        return new Response(JSON.stringify({ object: coat }));
      }
    }
    if (url.includes("/v2/catalog/object") && init.method === "POST") {
      posted.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ catalog_object: { id: "ITEM_COAT" } }));
    }
    return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
  };
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl },
  });

  await adapter.retractProduct("shearling-trimmed-wool-blend-coat");

  assert.equal(posted.length, 1);
  const sent = posted[0].object;
  assert.deepEqual(sent.item_data, coat.item_data, "item_data must round-trip untouched, never omitted");
  assert.equal(sent.version, coat.version, "Square's own optimistic-concurrency version, unchanged");
  assert.equal(sent.present_at_all_locations, false);
  assert.deepEqual(sent.present_at_location_ids, []);
});

check("test_PRD_P0_137_item_active_toggle__restore_is_the_same_safe_shape_in_reverse", async () => {
  const { mirrorDb, commerceDb, mirror } = await seededCatalog();
  /* Archive it in the mirror directly (as a real retract's own later sync
     would) so productByHandleAny can find it by handle while it is archived
     — mirror.productByHandle (index-only) would not. */
  await mirrorDb
    .prepare("UPDATE mirror_product SET archived_at = datetime('now'), status = 'archived' WHERE external_ref = 'ITEM_COAT'")
    .run();
  assert.equal(await mirror.productByHandle("shearling-trimmed-wool-blend-coat"), null);

  const coat = fixture("catalog-list.json").objects.find((o) => o.id === "ITEM_COAT");
  const archivedCoat = { ...coat, present_at_all_locations: false, present_at_location_ids: [] };
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    if ((init.method === "GET" || !init.method) && url.includes("/v2/catalog/object/ITEM_COAT")) {
      return new Response(JSON.stringify({ object: archivedCoat }));
    }
    if (url.includes("/v2/catalog/object") && init.method === "POST") {
      posted.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ catalog_object: { id: "ITEM_COAT" } }));
    }
    return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
  };
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl },
  });

  await adapter.restoreProduct("shearling-trimmed-wool-blend-coat");

  assert.equal(posted.length, 1);
  const sent = posted[0].object;
  assert.deepEqual(sent.item_data, coat.item_data, "item_data must round-trip untouched here too");
  assert.equal(sent.present_at_all_locations, true);
  assert.equal(sent.present_at_location_ids, undefined, "omitted entirely, not an empty list, once present everywhere");
});

check("test_PRD_P0_137_item_active_toggle__the_idempotency_key_varies_with_the_objects_own_version", async () => {
  /* A deterministic handle+action-only key would make archiving the SAME
     item a SECOND time (after a restore undid the first archive) collide
     with Square's own dedup window and silently replay the FIRST archive's
     cached response instead of applying the new one. Keying on the
     object's own CURRENT version (which only changes after a real
     successful upsert) makes each genuine attempt distinct, the same
     content-keyed idea pushInventory's own idempotency_key already uses. */
  const { mirrorDb, commerceDb } = await seededCatalog();
  const coat = fixture("catalog-list.json").objects.find((o) => o.id === "ITEM_COAT");
  const keys = [];
  const fetchImpl = async (url, init = {}) => {
    if ((init.method === "GET" || !init.method) && url.includes("/v2/catalog/object/ITEM_COAT")) {
      return new Response(JSON.stringify({ object: coat }));
    }
    if (url.includes("/v2/catalog/object") && init.method === "POST") {
      keys.push(JSON.parse(init.body).idempotency_key);
      return new Response(JSON.stringify({ catalog_object: { id: "ITEM_COAT" } }));
    }
    return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
  };
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl },
  });

  await adapter.retractProduct("shearling-trimmed-wool-blend-coat");
  await adapter.restoreProduct("shearling-trimmed-wool-blend-coat");
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "retract and restore of the same object must never share a key");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-17 — a channel is an adapter and a `channel` value; no card data
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_17_channel_agnostic_orders__checkout_is_hosted_so_no_card_data_can_reach_us", async () => {
  const f = fakeFetch({ "/v2/online-checkout/payment-links": fixture("payment-link.json") });
  const client = createSquareClient(squareEnv(), { fetchImpl: f });

  const link = await createPaymentLink(client, {
    lineItems: [{ externalRef: "VAR_COAT_IT40", quantity: 1 }],
    idempotencySeed: "cart-1",
  });
  assert.equal(link.url, "https://square.link/u/FIXTURE1");

  /* What we SEND has no card field, and what we GET BACK is a URL. ADR-009
     chose Payment Links precisely so no code path here could hold a PAN. */
  const sent = JSON.parse(f.calls[0].body);
  const flat = JSON.stringify(sent) + JSON.stringify(fixture("payment-link.json"));
  for (const forbidden of ["card_number", "cvv", "card_nonce", "source_id", "pan", "expiry"]) {
    assert.ok(!flat.includes(forbidden), `${forbidden} must not appear anywhere near checkout`);
  }

  /* Price is not sent at all: Square prices from its own catalog, so a client
     that edits a price in a cart payload changes nothing. */
  assert.equal(JSON.stringify(sent.order.line_items).includes("price"), false);

  /* Retrying the same cart reuses the idempotency key rather than minting a
     second link for one basket. */
  const again = await createPaymentLink(client, {
    lineItems: [{ externalRef: "VAR_COAT_IT40", quantity: 1 }],
    idempotencySeed: "cart-1",
  });
  assert.equal(again.url, link.url);
  assert.equal(
    JSON.parse(f.calls[1].body).idempotency_key,
    sent.idempotency_key,
    "a stable seed gives a stable idempotency key",
  );

  /* A zero or fractional quantity is refused before it reaches Square. */
  await assert.rejects(
    () => createPaymentLink(client, { lineItems: [{ externalRef: "V", quantity: 0 }], idempotencySeed: "c" }),
    /positive integer/,
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-13 / P0-14 — order ingest is idempotent and replayable; lines snapshot
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_13_webhook_idempotency__a_replayed_order_webhook_yields_the_same_external_id", async () => {
  const w = fixture("webhooks.json");
  const body = JSON.stringify(w.orderCreatedEnvelope);

  /* The idempotency key is (channel, external_id), and the adapter's job is to
     produce a stable external_id from a redelivered payload — the UNIQUE index
     in commerce.sql does the rest. */
  const a = normaliseWebhook(JSON.parse(body));
  const b = normaliseWebhook(JSON.parse(body));
  assert.deepEqual(a, b, "normalising is deterministic");
  assert.equal(a.externalId, "ORDER_FIXTURE_1");

  /* Proven against the real schema: the second insert for the same
     (channel, external_id) is refused. */
  const { commerceDb } = stores();
  const insert = (n) =>
    commerceDb._raw.exec(
      `INSERT INTO "order"(id, order_number, channel, external_id, currency)
       VALUES ('ord-${n}', ${n}, 'square', '${a.externalId}', 'USD')`,
    );
  insert(1);
  assert.throws(() => insert(2), /UNIQUE/, "a replayed webhook cannot create a second order");
  assert.equal(rows(commerceDb, `SELECT id FROM "order"`).length, 1);
});

check("test_PRD_P0_13_webhook_idempotency__normalising_never_writes_so_a_stored_payload_replays", async () => {
  const { mirrorDb, commerceDb } = stores();
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl: fakeFetch() },
  });
  const body = JSON.stringify(fixture("webhooks.json").orderCreatedEnvelope);

  /* port.ts: parseOrderWebhook "MUST NOT write to the database - the caller
     persists, so ingest stays replayable from `order.raw_payload`". */
  const out = await adapter.parseOrderWebhook({ [SIGNATURE_HEADER]: "x" }, body);
  assert.equal(out, null, "an envelope carries no lines and no total; it is not invented");
  assert.equal(rows(commerceDb, `SELECT id FROM "order"`).length, 0, "nothing was written");
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_product").length, 0);

  /* A malformed body is null, not a throw that loses the delivery. */
  assert.equal(await adapter.parseOrderWebhook({}, "{not json"), null);
});

check("test_PRD_P0_14_order_line_snapshot__lines_carry_snapshots_and_no_catalog_foreign_key", async () => {
  const order = orderFromSquare(fixture("webhooks.json").retrievedOrder.order);

  assert.equal(order.externalId, "ORDER_FIXTURE_1");
  assert.equal(order.status, "paid");
  assert.equal(order.lines.length, 2);
  assert.equal(order.total.amountMinor, 664000n);
  assert.equal(typeof order.total.amountMinor, "bigint");

  const [coat, scarf] = order.lines;
  assert.equal(coat.titleSnapshot, "Shearling-trimmed wool-blend coat");
  assert.equal(coat.skuSnapshot, "IT 40");
  assert.equal(coat.quantity, 1);
  assert.equal(coat.unitPrice.amountMinor, 560000n);
  assert.equal(scarf.quantity, 2);
  assert.equal(scarf.unitPrice.amountMinor, 52000n);

  /* No variation we hold, so no id to point at — and the line is still fully
     readable, which is the point of a snapshot. */
  assert.equal(coat.variantId, null);

  /* The schema agrees: order_line has no FK to a catalog. */
  const { commerceDb } = stores();
  const ddl = one(commerceDb, "SELECT sql FROM sqlite_master WHERE name = 'order_line'").sql;
  assert.ok(/REFERENCES "order"/.test(ddl));
  assert.ok(!/REFERENCES\s+(product|variant|mirror_)/i.test(ddl), "no catalog foreign key to follow");
});

/* ─────────────────────────────────────────────────────────────────────────
 * P1-05 / P1-07 — a second adapter with no migration; nightly reconciliation
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P1_05_second_adapter__square_ships_with_no_migration_to_an_existing_schema", () => {
  /* The real test of P0-16: the commerce schema this adapter writes into is
     loaded from shared/db/commerce.sql byte for byte, and it contains no Square
     column, no `square` channel value and no mirror table. */
  assert.ok(!/square/i.test(COMMERCE_SQL), "commerce.sql knows nothing about Square");

  const db = new DatabaseSync(":memory:");
  db.exec(COMMERCE_SQL);
  const vendorish = /external|vendor|shopify|square|provider|gid/i;
  const found = [];
  for (const t of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)) {
    for (const col of db.prepare(`PRAGMA table_info('${t}')`).all()) {
      if (vendorish.test(col.name)) found.push(`${t}.${col.name}`);
    }
  }
  assert.deepEqual(found, ["order.external_id"], "still exactly one vendor field in commerce");

  /* `channel` is a value, not a schema change. */
  assert.ok(/channel\s+TEXT NOT NULL/.test(COMMERCE_SQL));
  assert.ok(!/CHECK\s*\(\s*channel\s+IN/.test(COMMERCE_SQL), "channel is not an enum that a new adapter must widen");
});

check("test_PRD_P1_07_projection_reconciliation__drift_from_squares_count_becomes_a_correcting_adjustment", async () => {
  const { commerceDb, mirror } = await seededCatalog();
  await mirror.syncInventoryChanges(
    normaliseChanges(fixture("inventory-changes.json").changes, { locationId: SQUARE_LOCATION }),
  );
  assert.equal(await mirror.onHand("VEM-COAT-40"), 3);

  /* Square's nightly computed counts say 2 for the coat — a sale we never saw.
     SOLD-state counts are not ours and must not be folded in. */
  const counts = normaliseCounts(fixture("inventory-counts.json").counts, { locationId: SQUARE_LOCATION });
  assert.equal(counts.length, 2, "only IN_STOCK counts, for our one location");

  const result = await mirror.reconcileCounts(counts);
  assert.equal(result.corrected, 1, "one variation had drifted");
  assert.equal(result.inAgreement, 1);

  /* Corrected by a REVERSING adjustment, so the drift and the fix both stay on
     the record. Nothing overwrote a number, because there is no number. */
  const correction = one(
    commerceDb,
    "SELECT delta, reason, actor FROM inventory_adjustment WHERE reason = 'count' AND sku = 'VEM-COAT-40'",
  );
  assert.deepEqual([correction.delta, correction.reason], [-1, "count"]);
  assert.equal(correction.actor, SYNC_ACTOR);
  assert.equal(await mirror.onHand("VEM-COAT-40"), 2, "we now agree with the till");
  assert.equal(rows(commerceDb, "SELECT id FROM inventory_adjustment").length, 5, "history grew, nothing was edited");
});

check("test_PRD_P1_07_projection_reconciliation__re_running_the_reconcile_corrects_nothing_further", async () => {
  const { commerceDb, mirror } = await seededCatalog();
  await mirror.syncInventoryChanges(
    normaliseChanges(fixture("inventory-changes.json").changes, { locationId: SQUARE_LOCATION }),
  );
  const counts = normaliseCounts(fixture("inventory-counts.json").counts, { locationId: SQUARE_LOCATION });

  await mirror.reconcileCounts(counts);
  const after = rows(commerceDb, "SELECT id FROM inventory_adjustment").length;
  const stock = await mirror.onHand("VEM-COAT-40");

  /* Self-cancelling: once corrected, the delta is zero and nothing is written.
     A reconcile that stacked a second -1 every night would drain the shop. */
  const second = await mirror.reconcileCounts(counts);
  const third = await mirror.reconcileCounts(counts);

  assert.equal(second.corrected, 0);
  assert.equal(second.inAgreement, 2);
  assert.equal(third.corrected, 0);
  assert.equal(rows(commerceDb, "SELECT id FROM inventory_adjustment").length, after);
  assert.equal(await mirror.onHand("VEM-COAT-40"), stock);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-29 — provider independence is a check, not a claim
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_29_exit_test__dropping_every_square_id_leaves_the_catalog_and_the_ledger_intact", async () => {
  const { mirrorDb, commerceDb, mirror } = await seededCatalog();
  await mirror.syncInventoryChanges(
    normaliseChanges(fixture("inventory-changes.json").changes, { locationId: SQUARE_LOCATION }),
  );

  /* Delete the provider: every vendor identifier goes. `external_ref` is the
     only column that has to be cleared, which is the property under test. */
  mirrorDb._raw.exec(`
    UPDATE mirror_product  SET external_ref = 'exit-' || id;
    UPDATE mirror_variant  SET external_ref = 'exit-' || id;
    UPDATE mirror_image    SET external_ref = 'exit-' || id;
    UPDATE mirror_category SET external_ref = 'exit-' || id;
  `);

  /* Catalog, prices, handles, stock and history all survive. */
  const products = await mirror.productIndex();
  assert.equal(products.length, 2);
  assert.equal(products.find((p) => p.handle === "shearling-trimmed-wool-blend-coat").title,
    "Shearling-trimmed wool-blend coat");
  const variants = rows(mirrorDb, "SELECT sku, price_minor, currency FROM mirror_variant_index ORDER BY sku")
    .map((r) => ({ ...r }));
  assert.deepEqual(variants, [
    { sku: "VEM-COAT-40", price_minor: 560000, currency: "USD" },
    { sku: "VEM-COAT-42", price_minor: 560000, currency: "USD" },
    { sku: "VEM-SCARF-OS", price_minor: 52000, currency: "USD" },
  ]);
  assert.equal(await mirror.onHand("VEM-COAT-40"), 3, "the stock ledger never held a Square id to lose");
  assert.equal(rows(commerceDb, "SELECT id FROM inventory_adjustment").length, 4);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-136 — style_id and commission, Square's own Custom Attributes; vendor,
 * a real Square Vendor entity (revised once the owner got Retail Plus: "I
 * don't want to be duplicating that... use everything that's available in
 * Retail Plus"). style_id/commission are read by the well-known `key` this
 * codebase's own attribute definitions use, never Square's own opaque
 * definition id. vendor is read off item_variation_data.vendor_information,
 * Square's own array (this shop only ever uses entry 0).
 * ───────────────────────────────────────────────────────────────────────── */

function itemWithAttrs(attrs, { variations = [] } = {}) {
  return {
    id: "ITEM_ATTR_1",
    type: "ITEM",
    version: 7,
    item_data: {
      name: "Cocktail Dress",
      custom_attribute_values: attrs,
      variations,
    },
  };
}

function variationWithVendorInfo(id, vendorInfo) {
  return {
    id,
    type: "ITEM_VARIATION",
    version: 3,
    item_variation_data: {
      item_id: "ITEM_ATTR_1",
      name: "One size",
      sku: "VEM-DRESS-1",
      ...(vendorInfo ? { vendor_information: [vendorInfo] } : {}),
    },
  };
}

check("test_PRD_P0_136_square_custom_attributes__normalisecatalog_reads_style_id_by_key", () => {
  const { products } = normaliseCatalog([
    itemWithAttrs({ style_id: { key: "style_id", type: "STRING", string_value: "01-04-001" } }),
  ]);
  assert.equal(products.length, 1);
  assert.equal(products[0].styleId, "01-04-001");
});

check("test_PRD_P0_136_square_custom_attributes__normalisecatalog_reads_vendor_information_off_the_variation", () => {
  const { products } = normaliseCatalog([
    itemWithAttrs(undefined, {
      variations: [
        variationWithVendorInfo("VAR_1", {
          vendor_id: "SQ_VENDOR_1",
          vendor_code: "ACME-4471",
          unit_cost_money: { amount: 4200, currency: "USD" },
        }),
      ],
    }),
  ]);
  const [v] = products[0].variants;
  assert.equal(v.vendorExternalRef, "SQ_VENDOR_1");
  assert.equal(v.vendorCode, "ACME-4471");
  assert.deepEqual(v.unitCost, { amountMinor: 4200n, currency: "USD" });
});

check("test_PRD_P0_136_square_custom_attributes__absent_or_non_string_is_null_not_guessed_at", () => {
  const noAttrsAtAll = normaliseCatalog([itemWithAttrs(undefined)]).products[0];
  assert.equal(noAttrsAtAll.styleId, null);

  /* A BOOLEAN- or NUMBER-typed value at this key (some other use of the same
     key, or a malformed payload) has no string_value at all — treated as
     absent, not coerced into a string. */
  const wrongType = normaliseCatalog([
    itemWithAttrs({ style_id: { key: "style_id", type: "BOOLEAN", boolean_value: true } }),
  ]).products[0];
  assert.equal(wrongType.styleId, null);

  /* No vendor_information at all on the variation — zero-with-a-currency,
     the same honest default variationPrice() already uses, not null, so
     unit_cost_minor stays a NOT NULL column like every other `_minor`
     column (Test-PRD-P0-15-money_minor_units). */
  const noVendor = normaliseCatalog([
    itemWithAttrs(undefined, { variations: [variationWithVendorInfo("VAR_1", null)] }),
  ]).products[0].variants[0];
  assert.equal(noVendor.vendorExternalRef, null);
  assert.equal(noVendor.vendorCode, null);
  assert.deepEqual(noVendor.unitCost, { amountMinor: 0n, currency: "USD" });
});

check("test_PRD_P0_136_square_custom_attributes__a_resync_overwrites_style_id_and_commission_unlike_channel_or_custom_fields", async () => {
  const s = stores();
  const first = normaliseCatalog([
    itemWithAttrs({
      style_id: { key: "style_id", type: "STRING", string_value: "01-04-001" },
      commission: { key: "commission", type: "STRING", string_value: "20" },
    }),
  ]);
  await s.mirror.syncCatalog(first, { full: true });
  assert.deepEqual({ ...rows(s.mirrorDb, "SELECT style_id, commission_pct FROM mirror_product")[0] }, {
    style_id: "01-04-001",
    commission_pct: 20,
  });

  /* Square is authoritative for these now — a later sync with a DIFFERENT
     value overwrites the mirror, the opposite of channel/custom_fields,
     which mirror.js never even names in its own UPDATE. */
  const second = normaliseCatalog([
    itemWithAttrs({
      style_id: { key: "style_id", type: "STRING", string_value: "01-04-002" },
      commission: { key: "commission", type: "STRING", string_value: "35" },
    }),
  ]);
  await s.mirror.syncCatalog(second, { full: true });
  assert.deepEqual({ ...rows(s.mirrorDb, "SELECT style_id, commission_pct FROM mirror_product")[0] }, {
    style_id: "01-04-002",
    commission_pct: 35,
  });
});

check("test_PRD_P0_136_square_custom_attributes__syncing_a_vendor_lets_a_variants_vendor_id_resolve", async () => {
  const s = stores();
  await s.mirror.syncVendors([{ externalRef: "SQ_VENDOR_1", name: "Acme Mills", status: "active" }]);

  const normalised = normaliseCatalog([
    itemWithAttrs(undefined, {
      variations: [
        variationWithVendorInfo("VAR_1", {
          vendor_id: "SQ_VENDOR_1",
          unit_cost_money: { amount: 4200, currency: "USD" },
        }),
      ],
    }),
  ]);
  await s.mirror.syncCatalog(normalised, { full: true });

  const vendorRow = rows(s.mirrorDb, "SELECT id, name FROM mirror_vendor WHERE external_ref = 'SQ_VENDOR_1'")[0];
  const variantRow = rows(s.mirrorDb, "SELECT vendor_id, unit_cost_minor, unit_cost_currency FROM mirror_variant")[0];
  assert.equal(variantRow.vendor_id, vendorRow.id, "the variant's vendor_id resolves to OUR mirror_vendor row");
  assert.equal(variantRow.unit_cost_minor, 4200);
  assert.equal(variantRow.unit_cost_currency, "USD");

  /* Re-syncing the SAME vendor (a later pullCatalog) upserts rather than
     duplicating — external_ref is UNIQUE, the same idempotency every other
     mirror_* table gets from it. */
  await s.mirror.syncVendors([{ externalRef: "SQ_VENDOR_1", name: "Acme Mills Inc.", status: "active" }]);
  const vendorRows = rows(s.mirrorDb, "SELECT name FROM mirror_vendor WHERE external_ref = 'SQ_VENDOR_1'");
  assert.equal(vendorRows.length, 1, "one row, not two");
  assert.equal(vendorRows[0].name, "Acme Mills Inc.", "Square is authoritative for the vendor's own name too");
});

/* A fake that mirrors what the REAL account actually enforces (confirmed
   live, twice, over two different wrong guesses): filter must be present
   and non-empty, AND flat at the top level -- a query wrapper around it is
   itself refused as an unrecognised field, not merely ignored. Shared by
   both tests below so this account's exact rules are asserted in one
   place. */
function vendorSearchFake(onBody) {
  return async (url, init = {}) => {
    if (!url.includes("/v2/vendors/search")) return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
    const body = init.body ? JSON.parse(init.body) : {};
    onBody?.(body);
    if (body.query !== undefined) {
      return new Response(
        JSON.stringify({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", field: "query", detail: 'The field named "query" is unrecognized.' }] }),
        { status: 400 },
      );
    }
    if (!body?.filter || Object.keys(body.filter).length === 0) {
      return new Response(
        JSON.stringify({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "VALUE_EMPTY", field: "filter" }] }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ vendors: [{ id: "SQ_VENDOR_1", name: "Acme Mills", status: "ACTIVE" }] }));
  };
}

check("test_PRD_P0_136_square_custom_attributes__list_vendors_sends_a_flat_non_empty_filter_this_account_actually_accepts", async () => {
  /* A real bug, caught live from the owner's own copied errors -- TWICE.
     First: "Square POST /v2/vendors/search failed with 400 —
     INVALID_REQUEST_ERROR/VALUE_EMPTY (field: filter): Value for filter
     should not be empty." listVendors used to send a bare {} body for
     "everything". Fixed by wrapping filter in a query object, going by a
     documented example this environment could not verify directly
     (developer.squareup.com is unreachable here) — WRONG, and the real
     account said so immediately: "INVALID_REQUEST_ERROR/BAD_REQUEST
     (field: query): The field named "query" is unrecognized." Both real
     errors actually named `filter` itself, never `query` — this account's
     real API takes filter FLAT. A live 400 is ground truth a search
     result is not. */
  const seenBodies = [];
  const fetchImpl = vendorSearchFake((body) => seenBodies.push(body));
  const client = createSquareClient(squareEnv(), { fetchImpl });

  const vendors = await listVendors(client);
  assert.equal(vendors.length, 1);
  assert.equal(seenBodies[0]?.query, undefined, "no query wrapper -- this account refuses it as an unrecognised field");
  assert.deepEqual(
    seenBodies[0]?.filter?.status?.slice().sort(),
    ["ACTIVE", "INACTIVE"],
    "both statuses, matching this function's own \"the full list\" contract — an inactive vendor must not be excluded by the fix",
  );
});

check("test_PRD_P0_136_square_custom_attributes__a_full_catalog_pull_does_not_die_on_the_vendor_list_first", async () => {
  /* listVendors runs FIRST, unconditionally, inside pullCatalog
     (shared/commerce/square/index.js), with no try/catch around it — the
     real bug above meant EVERY pullCatalog call, cron-scheduled or
     manual, threw before ever reaching a single catalog object. Proven
     here the same way P0-37's own pagination test proves the whole
     adapter, not just the pure normaliser: a fake server that enforces
     this account's own real current validation on /v2/vendors/search, and
     a full sweep that must still complete against it. */
  const fetchImpl = async (url, init = {}) => {
    if (url.includes("/v2/vendors/search")) return vendorSearchFake()(url, init);
    if (url.includes("/v2/catalog/list")) return new Response(JSON.stringify({ objects: [] }));
    return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
  };
  const { mirrorDb, commerceDb } = stores();
  const adapter = createSquareAdapter(squareEnv(), {
    mirrorDb,
    commerceDb,
    locationId: OUR_LOCATION,
    clientOptions: { fetchImpl },
  });

  const counts = await adapter.pullCatalog({ full: true });
  assert.equal(counts.productsInserted, 0, "an empty catalog, but a COMPLETED one -- not a throw");
});

check("test_PRD_P0_136_square_custom_attributes__an_unsynced_vendor_id_resolves_to_null_not_a_guess", async () => {
  /* Square knows about a vendor our own vendor sync has not seen yet — left
     null rather than invented, and the next vendor sync catches it up
     (index.js's own pullCatalog always syncs vendors before syncCatalog). */
  const s = stores();
  const normalised = normaliseCatalog([
    itemWithAttrs(undefined, {
      variations: [variationWithVendorInfo("VAR_1", { vendor_id: "SQ_VENDOR_UNKNOWN" })],
    }),
  ]);
  await s.mirror.syncCatalog(normalised, { full: true });
  const variantRow = rows(s.mirrorDb, "SELECT vendor_id FROM mirror_variant")[0];
  assert.equal(variantRow.vendor_id, null);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-141 — Option Sets (ITEM_OPTION/ITEM_OPTION_VAL) mirrored as their own
 * first-class entity, independent of whether any item currently uses them.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_141_item_option_sets_mirrored__normalisecatalog_extracts_option_sets_and_their_values", () => {
  const { itemOptions } = normaliseCatalog(fixture("catalog-list.json").objects, { locationId: SQUARE_LOCATION });
  assert.equal(itemOptions.length, 1);
  const size = itemOptions[0];
  assert.equal(size.externalRef, "OPT_SIZE");
  assert.equal(size.name, "Size");
  assert.equal(size.withdrawn, false);
  assert.deepEqual(
    size.values.map((v) => ({ externalRef: v.externalRef, name: v.name, ordinal: v.ordinal })),
    [
      { externalRef: "OPTVAL_IT40", name: "IT 40", ordinal: 0 },
      { externalRef: "OPTVAL_IT42", name: "IT 42", ordinal: 1 },
    ],
    "no ordinal on the fixture's own values falls back to array position, not alphabetical order",
  );
});

check("test_PRD_P0_141_item_option_sets_mirrored__syncing_the_catalog_upserts_the_option_set_and_its_values", async () => {
  const { mirrorDb, counts } = await seededCatalog();
  assert.equal(counts.itemOptionsUpserted, 1);
  assert.equal(counts.itemOptionValuesUpserted, 2);

  const option = one(mirrorDb, "SELECT * FROM mirror_item_option_index WHERE external_ref = 'OPT_SIZE'");
  assert.equal(option.name, "Size");
  const values = rows(mirrorDb, "SELECT * FROM mirror_item_option_value_index WHERE item_option_id = ? ORDER BY ordinal", option.id);
  assert.deepEqual(
    values.map((v) => [v.name, v.ordinal]),
    [
      ["IT 40", 0],
      ["IT 42", 1],
    ],
  );
  assert.equal(values[0].item_option_id, option.id, "joined by our uuid, not by Square's id");
});

check("test_PRD_P0_141_item_option_sets_mirrored__an_option_set_with_no_item_using_it_yet_still_lands_in_the_mirror", async () => {
  /* This is the exact gap the owner's own question exposed: an option set
     created in Square but not yet assigned to any item used to be invisible
     to this mirror entirely, since the old code only ever resolved a
     value already sitting on a synced variation. */
  const s = stores();
  const normalised = normaliseCatalog(
    [
      {
        type: "ITEM_OPTION",
        id: "OPT_COLOR",
        is_deleted: false,
        item_option_data: { name: "Color", values: [{ type: "ITEM_OPTION_VAL", id: "OPTVAL_RED", item_option_value_data: { name: "Red" } }] },
      },
    ],
    { locationId: SQUARE_LOCATION },
  );
  assert.equal(normalised.products.length, 0, "no item references it, and none is needed to");
  await s.mirror.syncCatalog(normalised, { full: true });
  const option = one(s.mirrorDb, "SELECT * FROM mirror_item_option_index WHERE external_ref = 'OPT_COLOR'");
  assert.equal(option.name, "Color");
});

check("test_PRD_P0_141_item_option_sets_mirrored__a_resync_does_not_duplicate_the_option_set_or_its_values", async () => {
  const { mirrorDb, mirror, normalised } = await seededCatalog();
  await mirror.syncCatalog(normalised, { full: true });
  await mirror.syncCatalog(normalised, { full: true });
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_item_option").length, 1);
  assert.equal(rows(mirrorDb, "SELECT id FROM mirror_item_option_value").length, 2);
});

check("test_PRD_P0_141_item_option_sets_mirrored__withdrawing_an_option_set_in_square_archives_it_here_never_deletes_it", async () => {
  const s = stores();
  const objects = () => [
    {
      type: "ITEM_OPTION",
      id: "OPT_SIZE",
      is_deleted: false,
      item_option_data: { name: "Size", values: [{ type: "ITEM_OPTION_VAL", id: "OPTVAL_S", item_option_value_data: { name: "S" } }] },
    },
  ];
  await s.mirror.syncCatalog(normaliseCatalog(objects(), { locationId: SQUARE_LOCATION }), { full: true });
  assert.equal(one(s.mirrorDb, "SELECT archived_at FROM mirror_item_option WHERE external_ref = 'OPT_SIZE'").archived_at, null);

  const withdrawn = objects();
  withdrawn[0].is_deleted = true;
  await s.mirror.syncCatalog(normaliseCatalog(withdrawn, { locationId: SQUARE_LOCATION }), { full: true });
  const row = one(s.mirrorDb, "SELECT archived_at FROM mirror_item_option WHERE external_ref = 'OPT_SIZE'");
  assert.ok(row.archived_at, "withdrawn is a marker, archived_at is set");
  assert.throws(() => s.mirrorDb._raw.exec("DELETE FROM mirror_item_option"), /archive-only/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-143 — which Option Sets an ITEM itself declares (item_data.
 * item_options), mirrored separately from a category's own P0-142 offer.
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_143_product_item_options_mirrored__normalisecatalog_extracts_the_items_own_declared_option_sets", () => {
  const { products } = normaliseCatalog(fixture("catalog-list.json").objects, { locationId: SQUARE_LOCATION });
  const coat = products.find((p) => p.externalRef === "ITEM_COAT");
  assert.deepEqual(coat.itemOptionExternalRefs, ["OPT_SIZE"]);
});

check("test_PRD_P0_143_product_item_options_mirrored__syncing_the_catalog_links_the_product_to_its_own_item_option", async () => {
  const { mirrorDb } = await seededCatalog();
  const coat = one(mirrorDb, "SELECT id FROM mirror_product_index WHERE handle = 'shearling-trimmed-wool-blend-coat'");
  const option = one(mirrorDb, "SELECT id FROM mirror_item_option_index WHERE external_ref = 'OPT_SIZE'");
  const row = one(
    mirrorDb,
    "SELECT * FROM mirror_product_item_option_index WHERE product_id = ? AND item_option_id = ?",
    coat.id,
    option.id,
  );
  assert.ok(row, "the coat's own declared option set must be mirrored, joined by our uuids");
});

check("test_PRD_P0_143_product_item_options_mirrored__a_resync_does_not_duplicate_the_link", async () => {
  const { mirrorDb, mirror, normalised } = await seededCatalog();
  await mirror.syncCatalog(normalised, { full: true });
  await mirror.syncCatalog(normalised, { full: true });
  assert.equal(rows(mirrorDb, "SELECT * FROM mirror_product_item_option").length, 1);
});

check("test_PRD_P0_143_product_item_options_mirrored__removal_is_only_caught_by_a_full_sweep_same_latency_as_a_variation", async () => {
  /* "A variation deleted from an item that itself survives... only a
     full sweep can tell 'removed' from 'just not in this incremental
     page'" — mirror.js's own comment on seenVariants; item_options
     accept the identical latency, on purpose, for the identical reason. */
  const s = stores();
  const withOption = [
    {
      type: "ITEM_OPTION",
      id: "OPT_SIZE",
      is_deleted: false,
      item_option_data: { name: "Size", values: [{ type: "ITEM_OPTION_VAL", id: "OPTVAL_S", item_option_value_data: { name: "S" } }] },
    },
    {
      type: "ITEM",
      id: "ITEM_1",
      is_deleted: false,
      item_data: {
        name: "A Product",
        item_options: [{ item_option_id: "OPT_SIZE" }],
        variations: [
          {
            type: "ITEM_VARIATION",
            id: "VAR_1",
            item_variation_data: { name: "S", sku: "SKU-1", pricing_type: "FIXED_PRICING", price_money: { amount: 1000, currency: "USD" } },
          },
        ],
      },
    },
  ];
  await s.mirror.syncCatalog(normaliseCatalog(withOption, { locationId: SQUARE_LOCATION }), { full: true });
  const product = one(s.mirrorDb, "SELECT id FROM mirror_product_index WHERE external_ref = 'ITEM_1'");
  const option = one(s.mirrorDb, "SELECT id FROM mirror_item_option_index WHERE external_ref = 'OPT_SIZE'");
  assert.equal(
    one(s.mirrorDb, "SELECT archived_at FROM mirror_product_item_option WHERE product_id = ? AND item_option_id = ?", product.id, option.id)
      .archived_at,
    null,
  );

  const withoutOption = JSON.parse(JSON.stringify(withOption));
  withoutOption[1].item_data.item_options = [];
  await s.mirror.syncCatalog(normaliseCatalog(withoutOption, { locationId: SQUARE_LOCATION }), { full: false });
  assert.equal(
    one(s.mirrorDb, "SELECT archived_at FROM mirror_product_item_option WHERE product_id = ? AND item_option_id = ?", product.id, option.id)
      .archived_at,
    null,
    "an incremental sync alone must not archive it",
  );

  await s.mirror.syncCatalog(normaliseCatalog(withoutOption, { locationId: SQUARE_LOCATION }), { full: true });
  assert.ok(
    one(s.mirrorDb, "SELECT archived_at FROM mirror_product_item_option WHERE product_id = ? AND item_option_id = ?", product.id, option.id)
      .archived_at,
    "a full sweep must archive it",
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-30 — traceability, enforced by this file against the PRD
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", () => {
  assert.ok(fs.existsSync(PRD), `${PRD} not found: PRD-backed checks cannot be traced`);
  const prd = fs.readFileSync(PRD, "utf8");

  /* Read this file's own check names rather than trusting the running set. */
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const names = [...source.matchAll(/^check\("(test_PRD_[A-Za-z0-9_]+)"/gm)].map((m) => m[1]);
  assert.ok(names.length >= 25, `expected a real suite, found ${names.length} checks`);

  const labels = new Set();
  for (const name of names) {
    const m = NAME.exec(name);
    assert.ok(m, `${name} is not a PRD-labeled check`);
    labels.add(`Test-PRD-${m[1]}-${m[2]}-${m[3]}`);
  }
  const missing = [...labels].filter((label) => !prd.includes(label));
  assert.deepEqual(missing, [], "labels absent from docs/PRD.md");

  /* And every label that ran is one of them. */
  assert.deepEqual([...usedLabels].filter((l) => !labels.has(l)), []);
});
