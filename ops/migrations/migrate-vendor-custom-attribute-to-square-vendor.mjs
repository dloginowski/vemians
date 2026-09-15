#!/usr/bin/env node
/*
 * One-time: move every product's OLD plain-text "vendor" Custom Attribute
 * value (Test-PRD-P0-136-square_custom_attributes, as first shipped) onto a
 * real Square Vendor entity's vendor_information (the same feature,
 * revised once the owner got Retail Plus — see catalog-writer.js's own
 * vendorRef/vendorInformationFor). Without this, a product whose vendor was
 * set BEFORE this revision keeps its vendor invisible to the app: the code
 * no longer reads the old custom attribute at all.
 *
 * Run this ONCE per Square account that has real "vendor" custom attribute
 * VALUES already set (sandbox and production are separate accounts) — by a
 * human who holds the real SQUARE_ACCESS_TOKEN, same reasoning
 * create-square-custom-attributes.sh and apply-local.sh both give for why
 * there is no unattended equivalent: this is a real, permanent write to
 * every affected product, typed by a person who means it.
 *
 *   SQUARE_ACCESS_TOKEN=... SQUARE_ENV=production node migrate-vendor-custom-attribute-to-square-vendor.mjs [--dry-run]
 *
 * Idempotent in the sense that matters: re-running it finds nothing left to
 * migrate, since every affected item now has vendor_information set and no
 * longer needs it (this script does not re-check or overwrite an item that
 * already has vendor_information — see SKIPPING below).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: clear the OLD "vendor" custom
 * attribute value afterward. Square's own docs do not make it unambiguous
 * enough to trust an automated "unset just this one key and leave every
 * other custom_attribute_value alone" — getting that wrong risks wiping a
 * sibling attribute (style_id, commission) on the same UpsertCatalogObject
 * call. The stale value is harmless: nothing in this codebase reads the
 * "vendor" custom attribute any more, by key, ever. A human can clear it
 * by hand in Square's Dashboard if they want the Item editor tidy.
 */
import { createSquareClient } from "../../shared/commerce/square/client.js";
import { CATALOG_TYPES, listCatalog, normaliseCatalog } from "../../shared/commerce/square/catalog.js";
import { listVendors, createVendor } from "../../shared/commerce/square/vendors.js";

const DRY_RUN = process.argv.includes("--dry-run");

const env = {
  SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN,
  SQUARE_ENV: process.env.SQUARE_ENV,
};
if (!env.SQUARE_ACCESS_TOKEN) {
  console.error("ERROR: SQUARE_ACCESS_TOKEN must be set to a real Square access token");
  process.exit(1);
}
if (!["sandbox", "production"].includes(env.SQUARE_ENV)) {
  console.error(`ERROR: SQUARE_ENV must be 'sandbox' or 'production', got '${env.SQUARE_ENV}'`);
  process.exit(1);
}

const client = createSquareClient(env);

/* The OLD custom attribute value, read the same way catalog.js's own
   customAttr() does — by key, STRING type only. */
function oldVendorAttr(itemData) {
  const value = itemData?.custom_attribute_values?.vendor;
  const s = value?.string_value;
  return typeof s === "string" && s ? s : null;
}

async function main() {
  console.log(`── listing the full catalog (${env.SQUARE_ENV}) ──`);
  const objects = await listCatalog(client, { types: CATALOG_TYPES });
  const { products } = normaliseCatalog(objects);

  const items = new Map(objects.filter((o) => o.type === "ITEM").map((o) => [o.id, o]));

  const candidates = products.filter((p) => {
    const raw = items.get(p.externalRef);
    return oldVendorAttr(raw?.item_data) && !p.variants.some((v) => v.vendorExternalRef);
  });

  console.log(`── ${candidates.length} product(s) have an old vendor custom attribute and no vendor_information yet ──`);
  if (candidates.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  console.log(`── existing Square Vendors on this account ──`);
  const vendors = await listVendors(client);
  const byName = new Map(vendors.map((v) => [v.name.trim().toLowerCase(), v]));
  for (const v of vendors) console.log(`  ${v.externalRef}  ${v.name}`);

  let migrated = 0;
  let vendorsCreated = 0;
  for (const p of candidates) {
    const raw = items.get(p.externalRef);
    const vendorName = oldVendorAttr(raw.item_data);
    console.log(`\n── ${p.title} (${p.handle}) — vendor "${vendorName}" ──`);

    if (DRY_RUN) {
      console.log(`  [dry run] would resolve-or-create Vendor "${vendorName}" and set vendor_information on ${p.variants.length} variation(s)`);
      continue;
    }

    let vendor = byName.get(vendorName.trim().toLowerCase());
    if (!vendor) {
      vendor = await createVendor(client, vendorName);
      byName.set(vendorName.trim().toLowerCase(), vendor);
      vendorsCreated += 1;
      console.log(`  created Vendor ${vendor.externalRef} for "${vendorName}"`);
    } else {
      console.log(`  reusing existing Vendor ${vendor.externalRef} for "${vendorName}"`);
    }

    /* Resend item_data WHOLESALE (UpsertCatalogObject replaces it), exactly
       the discipline catalog-writer.js's own itemData() documents — every
       variation gets the SAME vendor_information entry uniformly ("one
       vendor per product," the same simplification the live write path
       uses), and every other field (custom_attribute_values, variations'
       own price/sku/etc.) is resent verbatim from what Square already has,
       untouched. */
    const body = {
      idempotency_key: `migrate-vendor:${p.externalRef}:${raw.version}`,
      object: {
        type: "ITEM",
        id: p.externalRef,
        version: raw.version,
        present_at_all_locations: true,
        item_data: {
          ...raw.item_data,
          variations: raw.item_data.variations.map((v) => ({
            ...v,
            item_variation_data: {
              ...v.item_variation_data,
              vendor_information: [{ vendor_id: vendor.externalRef }],
            },
          })),
        },
      },
    };
    await client.post("/v2/catalog/object", body);
    migrated += 1;
    console.log(`  vendor_information set on ${body.object.item_data.variations.length} variation(s)`);
  }

  console.log(`\n── done: ${migrated} product(s) migrated, ${vendorsCreated} new Vendor(s) created ──`);
  if (!DRY_RUN) {
    console.log("Run this app's normal Square sync (or wait for the next scheduled one) to pick these up in the mirror.");
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
