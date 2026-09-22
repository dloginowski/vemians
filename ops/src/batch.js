/*
 * "Add products/customers from a spreadsheet" — one CSV row in, one T2
 * approval out.
 *
 * DELIBERATELY NOT A NEW WRITE PATH, for either kind. Every row this mints an
 * approval for goes through the exact same tool a chat agent's own draft
 * would — catalog.create_product for merchandise, customer.create for
 * customers — so the closed category set, the price caps, "Square needs at
 * least one of these fields": none of that is re-checked here, because
 * re-checking it here is how the two checks eventually disagree. A row this
 * cannot even attempt (an unparsable price, a category that matches nothing)
 * is reported before runTool ever sees it, because runTool has no way to say
 * "not a number" — everything else is left to the tool's own check(), and its
 * refusal text becomes the row's skip reason verbatim.
 *
 * ONE RECORD PER ROW. A spreadsheet cell cannot describe a garment with three
 * sizes at three prices, or a customer with two phone numbers, without a
 * schema of its own — that stays the chat tools' job. PHOTOS ARE NOT IN
 * SCOPE for the same reason a cell cannot hold image bytes; added afterward
 * through /media/new, same as a one-off product.
 */
import { runTool } from "./tools/index.js";
import { listCategories, categoryProductCounts } from "./tools/catalog-writer.js";
import { parkForApproval } from "./approvals.js";
import { csvRecords, parseCsv } from "./tools/csv.js";
import { CAPS } from "./tools/caps.js";

/* Letters and digits only, so "Item Name", "item_name", "Item-Name:" and
   "ITEM NAME" all match the same synonym — a coworker's spreadsheet was not
   typed to a spec, and punctuation or an underscore is not a different
   column. */
function normalizeKey(k) {
  return String(k ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function pick(record, keys) {
  const normalized = {};
  for (const [k, v] of Object.entries(record)) normalized[normalizeKey(k)] = v;
  for (const k of keys) {
    const v = normalized[normalizeKey(k)];
    if (v) return v;
  }
  return "";
}

/*
 * Turn parsed CSV rows into parked T2 approvals, one runTool call at a time.
 * `rows` is already the shape each kind below builds: [{rowNumber, title,
 * args}]. Shared because parking is parking regardless of what the tool is —
 * only how a row becomes `args` differs between kinds.
 */
async function parkRows(env, { actor, role, toolName }, rows) {
  const parked = [];
  const skipped = [];
  for (const { rowNumber, title, args } of rows) {
    const gate = await runTool(toolName, args, { actor, role, env });
    if (!gate?.needsApproval) {
      skipped.push({ row: rowNumber, title, reason: gate?.error || "could not be validated" });
      continue;
    }
    const { url } = await parkForApproval(env, { name: toolName, args, actor, role, tier: "T2", summary: gate.data.would });
    parked.push({ row: rowNumber, title, url, summary: gate.data.would });
  }
  return { parked, skipped };
}

/* ── merchandise ──────────────────────────────────────────────────────── */

const TITLE_KEYS = [
  "title", "name", "product", "product title", "product name",
  "item", "item name", "item title", "style", "style name",
];
const DESCRIPTION_KEYS = ["description", "desc", "details", "product description", "copy"];
const CATEGORY_KEYS = ["category", "category name", "type", "product type", "collection", "department"];
/* "cost" is deliberately NOT a price synonym. The owner's own words: "Every
   product has a price and a unit cost" — two different numbers (what a
   customer pays vs. what we paid), and a sheet with its own "Cost" column
   was previously read as the SALE price, silently discarding the actual
   retail price synonym sitting next to it. A "Cost" column now falls
   through to custom_fields below instead, preserved rather than
   misinterpreted. */
const PRICE_KEYS = ["price", "price (usd)", "retail price", "unit price", "sale price", "msrp"];
const CURRENCY_KEYS = ["currency"];
const SKU_KEYS = ["sku", "style number", "item number", "product code"];
/* style_id, vendor and commission are Square's own Custom Attributes now
   (Test-PRD-P0-136-square_custom_attributes), not a custom_fields example —
   recognized here so a sheet carrying them reaches catalog.create_product as
   real arguments rather than inert text, and its own check() can flag the
   owner's own rules before a row is ever parked: "we always need to have a
   style ID," and — separately — a vendor NAME with no commission on file
   yet (mirror_vendor.commission_pct — brand new to this shop, or a vendor
   Square already knew about that was never given a rate) needs one given
   in the same row. REVISED: "let's not force vendor's commission to be
   stated out loud [on every row]... we store it in essential locations
   per vendor so their commission is recorded in a central location and
   automatically applied" — a vendor with a rate already on file needs
   nothing repeated here at all; catalog.create_product's own check()
   copies that rate onto the row's own product automatically. Deliberately
   NOT "style number"/"item number" (SKU_KEYS above): those already mean
   the SKU, a wholly different identifier from this shop's own style_id
   (see catalog-write.js's own STYLE_ID_FORMAT comment). A row that gives
   one here is always kept verbatim, real stock's own real SKU; a row that
   does not is no longer left blank either — catalog-writer.js's own
   generateSku() mints one, the same as any other variation created with
   none (REVISED: "SKU should be auto generated when adding variants or
   options — Square does that," the owner's own words, on discovering
   Square only does this for a Dashboard/POS-created item, never one this
   codebase creates through the Catalog API). */
const STYLE_ID_KEYS = ["style id", "style_id"];
const VENDOR_KEYS = ["vendor", "vendor name", "supplier"];
/* The vendor's OWN SKU/product code for this item — "an invoice-like
   identifier," the owner's own words — a real field on Square's own Vendor
   association now (vendor_code), never Square's own `sku` above, never
   this shop's own `style_id`. */
const VENDOR_CODE_KEYS = ["vendor code", "vendor sku", "vendor item number", "supplier sku"];
const COMMISSION_KEYS = ["commission", "commission %", "commission pct", "commission percent", "commission rate"];
/* unit cost is NOT one of Square's own Custom Attributes — the owner's own
   words, correcting an earlier plan to add a dedicated "cogs" attribute:
   "we don't need to do cogs, there is a unit cost, we just use the unit
   cost." So this is deliberately left OUT of PRODUCT_KNOWN_KEYS below: a
   "Unit Cost"/"Cost"/"COGS" column still falls through to custom_fields via
   extraFields exactly as it always has, preserved verbatim. It is listed
   here ONLY so this file can check whether a value was actually GIVEN, for
   the "no vendor needs a unit cost" rule immediately below. */
const UNIT_COST_KEYS = ["unit cost", "cost", "cogs", "cost of goods", "wholesale cost"];

/* "If we are adding a set of items and we specify its size or color, and
   this size or color is not already defined in our option, add this size
   or color to the option list and update it so that this item can still
   be added as a SKU" — the owner's own words. A CSV column name here maps
   straight to catalog.create_product's own variations[].option_values —
   an Option Set NAME ("Size") -> the value this row's own variation is
   ("XL") — never guessed at beyond these two, the two the owner actually
   named; a real third option (Material, say) still falls through to
   custom_fields via extraFields exactly as any other unrecognized column
   already does, rather than this file inventing a new Option Set nobody
   asked for. */
const OPTION_KEYS = {
  Size: ["size", "size name"],
  Color: ["color", "colour", "color name", "colour name"],
};

/* Every column name draftProductBatch/previewBatch already knows what to do
   with. Anything else in the sheet is CUSTOM — ours, not Square's, and not
   dropped just because neither of us has a named field for it yet. */
const PRODUCT_KNOWN_KEYS = [
  ...TITLE_KEYS, ...DESCRIPTION_KEYS, ...CATEGORY_KEYS, ...PRICE_KEYS, ...CURRENCY_KEYS, ...SKU_KEYS,
  ...STYLE_ID_KEYS, ...VENDOR_KEYS, ...VENDOR_CODE_KEYS, ...COMMISSION_KEYS, ...Object.values(OPTION_KEYS).flat(),
];

/* {Size: "XL", Color: "Red"} from whichever of OPTION_KEYS' own columns this
   row actually filled in — empty ones (no column, or the cell was blank)
   are left out entirely rather than sent as "". */
function optionValues(record) {
  const values = {};
  for (const [optionName, keys] of Object.entries(OPTION_KEYS)) {
    const value = pick(record, keys);
    if (value) values[optionName] = value;
  }
  return values;
}

/*
 * "I want to preserve all fields when ingesting spreadsheets. Even if they
 * are not surfaced in square or ui for now... Our workers need more data
 * tracking than square offers" — the owner's own words. Whatever a row
 * carries beyond the columns above (a unit cost, a vendor, a fabric note —
 * anything) is captured here and becomes catalog.create_product's
 * `custom_fields`. Keyed by the header text csvRecords() already handed us
 * (trimmed and lowercased, spaces and punctuation intact) rather than the
 * further alphanumeric-only form `pick()` matches synonyms against below —
 * still human-readable ("unit cost", not "unitcost"), just not the exact
 * original capitalization from the file, which csvRecords() never keeps
 * either. Capped the same way every other free-text field in this codebase
 * is: silently, rather than failing the whole row over one long note or an
 * unusually wide sheet.
 */
function extraFields(record, knownKeys) {
  const known = new Set(knownKeys.map(normalizeKey));
  const seen = new Set();
  const extra = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim();
    const normalized = normalizeKey(key);
    if (!key || known.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    const value = String(rawValue ?? "").trim();
    if (!value) continue;
    if (Object.keys(extra).length >= CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS) break;
    extra[key.slice(0, CAPS.CATALOG_CUSTOM_FIELD_KEY_MAX)] = value.slice(0, CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX);
  }
  return extra;
}

/*
 * "45", "45.00", "$45.00", "1,045.50" — never a float multiplication, which
 * turns 45.00 into 4499.999999999999 as often as not. Refuses anything with
 * more than two decimal places rather than rounding it, because a rounded
 * price and a mistyped one look identical on the confirmation page.
 */
export function parsePriceToMinor(raw) {
  const cleaned = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/*
 * "20", "20%", " 20 " -> 20. Whole numbers only, same reasoning as
 * parsePriceToMinor above: runTool has no way to say "not a number", so a
 * sheet cell that is not one is reported here, before a row is ever parked.
 * The 0-100 range itself is catalog.create_product's own business rule, not
 * repeated here — same division of labor the rest of this file already
 * uses for category and price.
 */
function parseCommission(raw) {
  const cleaned = String(raw ?? "").trim().replace(/%$/, "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Case- and whitespace-insensitive; the closed set's real names, never guessed. */
function matchCategory(name, categories) {
  const key = name.trim().toLowerCase();
  return categories.find((c) => c.name.trim().toLowerCase() === key) ?? null;
}

/*
 * "I don't think we need to have [a name] as a requirement. I think that the
 * name should be auto-generated based on its category and its position in
 * the category index" — the owner's own words. A row with no title is no
 * longer a skip; it becomes "<category name> <n>", n being this item's own
 * position within that category — one past however many products already
 * sit there, counting up across the rest of this same batch as more
 * title-less rows for the same category are minted. Returns a fresh
 * closure per draftProductBatch call, so two unrelated batches never share
 * a counter.
 */
function autoTitler(existingCounts) {
  const next = new Map();
  return (category) => {
    const n = next.has(category.id) ? next.get(category.id) : (existingCounts.get(category.id) ?? 0) + 1;
    next.set(category.id, n + 1);
    return `${category.name} ${n}`;
  };
}

/**
 * Parse a CSV, mint one catalog.create_product approval per row that
 * resolves cleanly, and report the rest with a plain reason.
 *
 * @param env   CATALOG_MIRROR, and whatever runTool's own resources need.
 * @param actor, role  the uploader's own verified Access identity.
 * @returns { ready: [{row, title, url, summary}], skipped: [{row, title, reason}], tooMany?: number }
 */
export async function draftProductBatch(env, { text, actor, role }) {
  const records = csvRecords(parseCsv(text));
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { ready: [], skipped: [], tooMany: records.length };
  }
  const categories = await listCategories(env.CATALOG_MIRROR);
  const nextAutoTitle = autoTitler(await categoryProductCounts(env.CATALOG_MIRROR));

  const rows = [];
  const skipped = [];

  records.forEach((record, i) => {
    const rowNumber = i + 2; /* +1 for the header, +1 for 1-based rows */
    const rawTitle = pick(record, TITLE_KEYS).slice(0, 200);
    const categoryName = pick(record, CATEGORY_KEYS);
    const priceRaw = pick(record, PRICE_KEYS);
    const currency = (pick(record, CURRENCY_KEYS) || "USD").toUpperCase();

    /* Category is resolved before the title, now — an auto-generated title
       is spelled from the category's own name, so there is no title left
       to fall back to until the category itself is known. */
    const category = categoryName ? matchCategory(categoryName, categories) : null;
    if (!category) {
      const known = categories.map((c) => c.name).join(", ") || "none yet";
      skipped.push({
        row: rowNumber,
        title: rawTitle || "(no title)",
        reason: categoryName
          ? `category "${categoryName}" does not exist — it must be exactly one of: ${known}`
          : `no category column, or it was empty — it must be exactly one of: ${known}`,
      });
      return;
    }
    const title = rawTitle || nextAutoTitle(category);
    const priceMinor = parsePriceToMinor(priceRaw);
    if (priceMinor === null) {
      skipped.push({ row: rowNumber, title, reason: `price "${priceRaw}" is not a plain number like 45.00` });
      return;
    }

    /* "We always need to have a style ID" — the owner's own words, walked
       through a final time. Presence only: format and cross-catalog
       uniqueness are catalog.create_product's own check() (STYLE_ID_FORMAT),
       relayed the same way a bad category or price already is. */
    const styleId = pick(record, STYLE_ID_KEYS);
    if (!styleId) {
      skipped.push({ row: rowNumber, title, reason: "no style ID column, or it was empty — every product needs a style ID" });
      return;
    }

    const vendor = pick(record, VENDOR_KEYS);
    const commissionRaw = pick(record, COMMISSION_KEYS);
    let commission;
    if (commissionRaw) {
      commission = parseCommission(commissionRaw);
      if (commission === null) {
        skipped.push({ row: rowNumber, title, reason: `commission "${commissionRaw}" is not a plain whole number like 20` });
        return;
      }
    }
    const unitCostRaw = pick(record, UNIT_COST_KEYS);
    const hasUnitCost = Boolean(unitCostRaw);
    /* The owner's own words, walked through a final time, then revised: "if
       we don't have a vendor name, then we must have a cost of goods... if
       we're adding a product that has a price, no vendor, and no cogs,
       that's a problem too" — still enforced below. A vendor row with no
       commission of its own is a normal row too — the same
       catalog.create_product's own check() already allows, REVISED once
       more: only when that vendor already has a rate ON FILE centrally.
       One with nothing on file at all (brand new, or one Square already
       knew about) is not a normal row — catalog.create_product's own
       check() refuses it, and that refusal is relayed as this row's own
       skip reason exactly like a bad category or price already is. */
    if (!vendor && !hasUnitCost) {
      skipped.push({
        row: rowNumber,
        title,
        reason: "no vendor and no unit cost — a product needs a vendor or a unit cost",
      });
      return;
    }

    /* WITH a vendor, "unit cost" is Square's own real unit_cost_minor now
       (Retail Plus/Premium) — the same UNIT_COST_KEYS synonyms, but parsed
       as money and sent as a real argument rather than left as opaque
       custom_fields text. WITHOUT a vendor there is still no Square-native
       home for it (unit_cost_money lives inside vendor_information, which
       needs a vendor to attach to), so it stays exactly as it always has:
       an opaque custom_fields entry, via extraFields below. */
    let unitCostMinor;
    if (vendor && hasUnitCost) {
      unitCostMinor = parsePriceToMinor(unitCostRaw);
      if (unitCostMinor === null) {
        skipped.push({ row: rowNumber, title, reason: `unit cost "${unitCostRaw}" is not a plain number like 45.00` });
        return;
      }
    }
    const vendorCode = pick(record, VENDOR_CODE_KEYS);
    if (vendorCode && !vendor) {
      skipped.push({
        row: rowNumber,
        title,
        reason: `vendor code "${vendorCode}" was given without a vendor — it is the VENDOR's own SKU for this product`,
      });
      return;
    }

    const description = pick(record, DESCRIPTION_KEYS);
    /* vendor's own UNIT_COST_KEYS column is excluded from custom_fields
       ONLY when it just became a real argument above — a vendor-less row
       still preserves it verbatim, unchanged from before this feature. */
    const knownKeys = vendor ? [...PRODUCT_KNOWN_KEYS, ...UNIT_COST_KEYS] : PRODUCT_KNOWN_KEYS;
    const customFields = extraFields(record, knownKeys);
    const optValues = optionValues(record);
    rows.push({
      rowNumber,
      title,
      args: {
        title,
        ...(description ? { description } : {}),
        category_id: category.id,
        style_id: styleId,
        ...(vendor ? { vendor } : {}),
        ...(vendorCode ? { vendor_code: vendorCode } : {}),
        ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
        ...(commission !== undefined ? { commission } : {}),
        variations: [
          {
            title,
            price_minor: priceMinor,
            currency,
            ...(pick(record, SKU_KEYS) ? { sku: pick(record, SKU_KEYS) } : {}),
            ...(Object.keys(optValues).length ? { option_values: optValues } : {}),
          },
        ],
        ...(Object.keys(customFields).length ? { custom_fields: customFields } : {}),
      },
    });
  });

  const { parked, skipped: refused } = await parkRows(env, { actor, role, toolName: "catalog.create_product" }, rows);
  return { ready: parked, skipped: [...skipped, ...refused].sort((a, b) => a.row - b.row) };
}

/* ── customers ────────────────────────────────────────────────────────── */

/*
 * Square's own field names first, because that is the point — a spreadsheet
 * exported from Square, or typed to match the till, already has these exact
 * headers. A couple of plain-English aliases ride along for a spreadsheet
 * someone built by hand.
 */
const GIVEN_NAME_KEYS = ["given_name", "given name", "first name", "first"];
const FAMILY_NAME_KEYS = ["family_name", "family name", "last name", "last", "surname"];
const EMAIL_KEYS = ["email_address", "email"];
const PHONE_KEYS = ["phone_number", "phone"];
const NOTE_KEYS = ["note", "notes"];
const REFERENCE_KEYS = ["reference_id", "reference", "member id", "loyalty id"];

/**
 * Parse a CSV, mint one customer.create approval per row, and report the
 * rest with a plain reason. "At least one of given_name, family_name,
 * email_address, phone_number" is Square's own rule and customer.create's
 * own check() already says so — this function does not repeat it, it just
 * relays whatever runTool refuses with, the same way draftProductBatch
 * relays a category-outside-the-set refusal it does not compose itself.
 *
 * @returns { ready: [{row, title, url, summary}], skipped: [{row, title, reason}], tooMany?: number }
 */
export async function draftCustomerBatch(env, { text, actor, role }) {
  const records = csvRecords(parseCsv(text));
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { ready: [], skipped: [], tooMany: records.length };
  }

  const rows = records.map((record, i) => {
    const rowNumber = i + 2;
    const given_name = pick(record, GIVEN_NAME_KEYS);
    const family_name = pick(record, FAMILY_NAME_KEYS);
    const email_address = pick(record, EMAIL_KEYS);
    const phone_number = pick(record, PHONE_KEYS);
    const note = pick(record, NOTE_KEYS);
    const reference_id = pick(record, REFERENCE_KEYS);
    const title = [given_name, family_name].filter(Boolean).join(" ") || email_address || phone_number || "(blank row)";
    return {
      rowNumber,
      title,
      args: {
        ...(given_name ? { given_name } : {}),
        ...(family_name ? { family_name } : {}),
        ...(email_address ? { email_address } : {}),
        ...(phone_number ? { phone_number } : {}),
        ...(note ? { note } : {}),
        ...(reference_id ? { reference_id } : {}),
      },
    };
  });

  const { parked, skipped } = await parkRows(env, { actor, role, toolName: "customer.create" }, rows);
  return { ready: parked, skipped: skipped.sort((a, b) => a.row - b.row) };
}

/* ── preview, before anything is parked ──────────────────────────────────
 *
 * "The agent should confirm with me about its selections if it is unsure...
 * a brief preview of the first row and headings before generating the
 * actual [batch]" — then, once that preview was actually in front of them:
 * "Don't need to see it all. Just top 2 or 3 rows to see the headings," and
 * later, once the chat card still didn't fit even that: "I already need to
 * really see just one — two rows, one for the headings and one row of
 * data. I don't need to see three of them." One sample row plus its own
 * header is enough to confirm the column mapping; PREVIEW_SAMPLE_ROWS at 1
 * also lets the chat card itself grow to fit the whole thing without an
 * inner scrollbar (views.js's own TABLE_CARD_CSS, .table-card.preview).
 * Neither draftProductBatch nor draftCustomerBatch is safe to call
 * speculatively — both mint real T2 approval links the moment a row
 * resolves cleanly. This reads the same columns the same way (same key
 * lists, same `pick`), on the first row only, and mints nothing: no
 * listCategories call, no runTool, no parkForApproval. A wrong column match
 * is corrected here, before it becomes 400 approval links to click through
 * or cancel one at a time.
 *
 * @returns { headers: string[], rowCount: number, sampleRows: object[] }
 *   sampleRows has at most PREVIEW_SAMPLE_ROWS entries (fewer if the sheet
 *   itself has fewer data rows), each mapped the same way one draft row is.
 */
const PREVIEW_SAMPLE_ROWS = 1;

/* Extra columns are spread in AFTER the known ones, so the preview table
   shows exactly what draftProductBatch will actually keep as custom_fields
   — "preserve all fields" means visible before confirming, not just kept
   silently in the background. */
function mapProductRow(record) {
  return {
    title: pick(record, TITLE_KEYS) || null,
    category: pick(record, CATEGORY_KEYS) || null,
    price: pick(record, PRICE_KEYS) || null,
    currency: (pick(record, CURRENCY_KEYS) || "USD").toUpperCase(),
    description: pick(record, DESCRIPTION_KEYS) || null,
    sku: pick(record, SKU_KEYS) || null,
    style_id: pick(record, STYLE_ID_KEYS) || null,
    vendor: pick(record, VENDOR_KEYS) || null,
    vendor_code: pick(record, VENDOR_CODE_KEYS) || null,
    commission: pick(record, COMMISSION_KEYS) || null,
    ...Object.fromEntries(Object.keys(OPTION_KEYS).map((name) => [name.toLowerCase(), optionValues(record)[name] ?? null])),
    ...extraFields(record, PRODUCT_KNOWN_KEYS),
  };
}

function mapCustomerRow(record) {
  return {
    given_name: pick(record, GIVEN_NAME_KEYS) || null,
    family_name: pick(record, FAMILY_NAME_KEYS) || null,
    email_address: pick(record, EMAIL_KEYS) || null,
    phone_number: pick(record, PHONE_KEYS) || null,
  };
}

export function previewBatch(text, kind) {
  const records = csvRecords(parseCsv(text));
  if (!records.length) return { headers: [], rowCount: 0, sampleRows: [] };

  const headers = Object.keys(records[0]);
  const mapRow = kind === "customers" ? mapCustomerRow : mapProductRow;
  const mapped = records.slice(0, PREVIEW_SAMPLE_ROWS).map(mapRow);

  /* mapProductRow's extra (custom) fields are per-row: a sheet's own extra
     columns are normally consistent, but one row missing a value nobody
     else left blank must not shift what column N means in the table.
     Every sampled row gets the SAME keys, in the SAME order, so
     previewTable()'s columns (this file's own first row's keys) describe
     every row correctly — a key a later row lacks reads "(not found)",
     the same as a known field that was left blank, not a raw "undefined". */
  const allKeys = [...new Set(mapped.flatMap((row) => Object.keys(row)))];
  const sampleRows = mapped.map((row) => Object.fromEntries(allKeys.map((k) => [k, k in row ? row[k] : null])));

  return { headers, rowCount: records.length, sampleRows };
}
