/*
 * Square's Vendor object — a wholly separate API surface from the Catalog API
 * (/v2/vendors/* rather than /v2/catalog/*), so it needs its own thin client
 * here rather than living in catalog.js. NOTHING HERE WRITES a Vendor's
 * association to a product — that is catalog-writer.js's job, on
 * item_variation_data.vendor_information. This file only knows Vendor objects
 * themselves: list them, create one.
 *
 * Retail Plus/Premium (or Restaurants Plus/Premium) required to WRITE a
 * vendor onto a catalog item's vendor_information; reading Vendor objects
 * themselves has no such gate.
 */
import { idempotencyKey } from "./ids.js";

/**
 * SearchVendors, paginated, with no filter — the full list. A boutique's
 * vendor roster is small (unlike the catalog itself), so "fetch everything,
 * match in JS" is the same trade categories already make (catalog-write.js's
 * own `matchCategory`), not a shortcut taken only here.
 *
 * @returns {Promise<{externalRef: string, name: string, status: string}[]>}
 */
export async function listVendors(client) {
  const vendors = [];
  for await (const page of client.paginate("POST", "/v2/vendors/search", {
    /* A real bug, caught live from the owner's own copied errors — TWICE.
       First: "Square POST /v2/vendors/search failed with 400 —
       INVALID_REQUEST_ERROR/VALUE_EMPTY (field: filter): Value for filter
       should not be empty." SearchVendors used to accept an unfiltered {}
       body for "everything"; misread as needing a `query.filter` wrapper
       (a documented example this environment could not verify directly,
       since developer.squareup.com is unreachable here) — WRONG, and the
       live account said so immediately: "Square POST /v2/vendors/search
       failed with 400 — INVALID_REQUEST_ERROR/BAD_REQUEST (field: query):
       The field named "query" is unrecognized." Both real errors actually
       named `filter` itself as the field, never `query` — this account's
       real API takes `filter` FLAT, at the top level, no wrapper at all.
       A live 400 from the real account is ground truth a search result
       is not; trust it over anything this environment cannot verify
       directly. Filtering on BOTH statuses is still "the full list" this
       function's own doc comment promises — status is mapped to
       "inactive"/"active" right below, so an inactive vendor still needs
       to come back, not be excluded by the fix. */
    body: { filter: { status: ["ACTIVE", "INACTIVE"] } },
    cursorIn: "body",
  })) {
    for (const v of page.vendors ?? []) {
      if (!v?.id) continue;
      vendors.push({
        externalRef: v.id,
        name: v.name ?? "",
        status: v.status === "INACTIVE" ? "inactive" : "active",
      });
    }
  }
  return vendors;
}

/**
 * CreateVendor. Square assigns the id; there is no client-chosen id the way
 * catalog objects get a `#temp` reference, so this is a plain create-and-read-
 * the-response, not an upsert. The idempotency key is derived from the name,
 * not random, so a retried "create this vendor" never mints a second one.
 *
 * @returns {Promise<{externalRef: string, name: string, status: string}>}
 */
export async function createVendor(client, name) {
  const res = await client.post("/v2/vendors/create", {
    idempotency_key: idempotencyKey(`vendor:${name}`),
    vendor: { name },
  });
  const vendor = res?.vendor;
  if (!vendor?.id) {
    console.error("ERROR square/vendors: Square accepted the create but returned no vendor id");
    throw new Error("Square returned no vendor id for the new vendor");
  }
  return { externalRef: vendor.id, name: vendor.name ?? name, status: "active" };
}
