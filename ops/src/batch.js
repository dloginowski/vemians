/*
 * "Add products/customers from a spreadsheet" — one CSV row in, one real
 * write out.
 *
 * DELIBERATELY NOT A NEW WRITE PATH, for either kind. Every row this writes
 * goes through the exact same tool a chat agent's own draft would —
 * catalog.create_product for merchandise, customer.create for customers —
 * so the closed category set, the price caps, "Square needs at least one of
 * these fields": none of that is re-checked here, because re-checking it
 * here is how the two checks eventually disagree.
 *
 * A PRODUCT row is created IMMEDIATELY (createRows) rather than parked as a
 * separate T2 approval — "you have all the information to create all of
 * them, so just make them. I don't want to sit here and approve them" — the
 * owner's own words — UNLESS this row hit a genuine CLASH: two real facts
 * disagreeing (a category name already numbered differently), a refusal
 * neither this file nor a person typing faster could have avoided (Square's
 * own near-duplicate-name check, a SKU already used by a different
 * product), or a value this file has no safe number to invent (an
 * unparsable price). "The only time you want to do an approval link is if
 * there's a clash and it has to be resolved by a person" — the owner's own
 * words. A clash parks an ordinary, EDITABLE T2 approval (createRows' own
 * header comment, and parkClashRows', have the full reasoning) — never a
 * bare skip, and never silently guessed at either. A CUSTOMER row still
 * parks the ordinary way (parkRows) for every T2 write, clash or not — this
 * finer created/clash/skip split was only ever asked for merchandise.
 *
 * ONE RECORD PER ROW, MOSTLY — a customer always is, and so is a product
 * with no style number at all (a sheet that names its column just "style
 * id" and gives nothing more). REVISED: "it's not one product, one line...
 * I gave you variations" — the owner's own words, for a sheet whose style
 * number encodes color and/or size too (parseStyleNumber): several rows
 * sharing the same category-subcategory-index base ARE one product, with
 * one variation per row (draftGroupedProduct) — the schema that decision
 * needed already exists, in the style number's own trailing segments.
 * PHOTOS ARE STILL NOT IN SCOPE for the same reason a cell cannot hold
 * image bytes; added afterward through /media/new, same as a one-off
 * product.
 */
import { runTool } from "./tools/index.js";
import {
  listCategories,
  listAllProducts,
  listMirrorVendors,
  categoryProductCounts,
  LEGACY_COST_FIELD_KEYS,
  LEGACY_MARGIN_FIELD_KEYS,
  productByHandle,
  productByImportStyleNumber,
  productByStyleId,
  productsByCategoryAndTitle,
  productsByTitle,
  productsInCategory,
  variantsWithOptionsOf,
  variantsWithOptionsOfMany,
  INHOUSE_VENDOR_NAME,
} from "./tools/catalog-writer.js";
import { nearestCategory } from "./tools/catalog-write.js";
import { parkForApproval } from "./approvals.js";
import { csvRecords, parseCsv, stringifyCsv } from "./tools/csv.js";
import { createRateLimiter } from "./tools/rate.js";
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
async function parkRows(env, { actor, role, toolName, rate, onProgress }, rows) {
  const parked = [];
  const skipped = [];
  for (const { rowNumber, title, args } of rows) {
    const gate = await runTool(toolName, args, { actor, role, env, rate });
    let status;
    if (!gate?.needsApproval) {
      skipped.push({ row: rowNumber, title, reason: gate?.error || "could not be validated" });
      status = "skipped";
    } else {
      const { url } = await parkForApproval(env, { name: toolName, args, actor, role, tier: "T2", summary: gate.data.would });
      parked.push({ row: rowNumber, title, url, summary: gate.data.would });
      status = "parked";
    }
    onProgress?.({ done: parked.length + skipped.length, total: rows.length, row: rowNumber, title, status });
  }
  return { parked, skipped };
}

/*
 * The PRODUCT equivalent of parkRows, above — creates immediately instead
 * of parking an approval link for later. "I expect you to create all of
 * the options and variations as needed. This should not be a separate
 * process or approval. You have all the information to create all of
 * them, so just make them. I don't want to sit here and approve them" —
 * the owner's own words. Uploading the spreadsheet already IS the
 * deliberate action a manager's own click would otherwise stand for — the
 * identical "check, then immediately re-run with the resulting token"
 * two-call dance every other inline write in this codebase already uses
 * (resolveOrCreateCategory/resolveCategoryByCode, above; the Admin panel's
 * own /admin/categories/create; /items/resync) — never a NEW write path,
 * never a weaker check: the same catalog.create_product tier, role gate
 * and business-rule refusals a chat agent's own draft would hit apply
 * here exactly as before, just spent in the same request instead of
 * waiting on a second human click.
 *
 * REVISED: "the only time you want to do an approval link is if there's a
 * clash and it has to be resolved by a person" — the owner's own words. A
 * refusal ONLY the tool's own check() could discover this late (a SKU
 * already used by a different product, a vendor with no commission on
 * file) is exactly such a clash — parked instead of skipped, via the same
 * parkForApproval every other T2 write already uses, so a person can open
 * it, fix what needs fixing, and say yes. A refusal that is NOT about this
 * row's own data at all (the actor's role, a rate cap, a malformed
 * argument this file itself built wrong) has nothing a person editing
 * THIS row could fix — those stay a plain skip, unchanged.
 */
const NOT_ROW_FIXABLE = /requires the .* role|^rate cap:|no tool '|cannot be passed as an argument|^bad_arguments/i;

/*
 * A real production bug, found live: the checklist/plan mechanism
 * (planProductBatch's own readyRows, stored as ingest_row records) addresses
 * ONE row for its own later, separate HTTP submission (POST /agent/batch-
 * submit-row) by `rowNumber` ALONE (submitBatchPlanRow's own
 * `rows.findIndex((r) => r.rowNumber === row)`, agent.js) -- fine as long as
 * every stashed row's own rowNumber is unique, true before a single CSV row
 * could ever produce more than one independent action. A matched row's own
 * quantity reconciliation (Test-PRD-P0-190-quantity_reconciliation_on_
 * resubmit) is the first thing that breaks that: its own inventory.adjust
 * row and the catalog.update_product row it rides alongside both come from
 * the SAME CSV line, so without this offset both would stash under the
 * IDENTICAL rowNumber -- submitting either one by number would silently
 * find and consume WHICHEVER of the two happens to still be first in the
 * stored array, not necessarily the one actually requested. Offset well
 * past CAPS.BATCH_MAX_ROWS, the largest a real CSV row number can ever be,
 * so a synthetic row's own rowNumber can never collide with a real one;
 * `displayRow` (set alongside, below) carries the ORIGINAL csv line back
 * through for anything that shows "Row N" to a person, so this offset is
 * never something they see. */
const EXTRA_ROW_ID_OFFSET = CAPS.BATCH_MAX_ROWS * 10;

/* "I think we should have two distinct commands. Add new products or
   update products" -- the owner's own words. Every caller into this
   file's own product-batch entry points (draftProductBatch, planProductBatch,
   previewBatch) must say up front which one this run is -- never a
   default, because a caller that forgot to pass one would otherwise
   silently behave as "add" (every `mode === "update"` check below simply
   fails closed), the exact silent-create-instead-of-update mistake this
   whole split exists to prevent. */
function assertBatchMode(mode) {
  if (mode !== "add" && mode !== "update") {
    throw new Error(`batch mode must be "add" or "update", got ${JSON.stringify(mode)}`);
  }
}

async function createRows(env, { actor, role, rate, onProgress }, rows) {
  const created = [];
  const parked = [];
  const skipped = [];
  const settle = async (displayRow, title, toolName, args, reason) => {
    if (NOT_ROW_FIXABLE.test(reason)) {
      skipped.push({ row: displayRow, title, reason });
      return "skipped";
    }
    const { url } = await parkForApproval(env, { name: toolName, args, actor, role, tier: "T2", summary: reason });
    parked.push({ row: displayRow, title, url, summary: reason });
    return "parked";
  };
  /* toolName is now PER-ROW, not shared for the whole call — a resubmit
     (Test-PRD-P0-179-import_style_number_matching) mints
     catalog.update_product for a row draftGroupedProduct already matched to
     an existing product, and catalog.create_product for every other row, in
     the very same batch. catalog.set_square_attributes joins those two
     (draftProductUpdate's own "make them all in-house and update their
     costs" fallback, when nothing on a resubmit's own sheet matched any
     existing variation at all) — an EXISTING handle, same as update_product,
     never a freshly created one, so `handle` falls back to `args.handle`
     rather than a `result.data.product` shape only create/update actually
     return. */
  for (const { rowNumber, displayRow, title, args, toolName, note } of rows) {
    const display = displayRow ?? rowNumber;
    let status;
    const gate = await runTool(toolName, args, { actor, role, env, rate });
    if (!gate?.needsApproval) {
      status = await settle(display, title, toolName, args, gate?.error || "could not be validated");
    } else {
      const result = await runTool(toolName, args, { actor, role, env, rate, approvalToken: gate.data.approval.token });
      if (result?.error || result?.denied) {
        status = await settle(display, title, toolName, args, result.error || result.denied || "was refused");
      } else {
        const action = toolName === "catalog.create_product" ? "created" : "updated";
        const summary = note ? `${gate.data.would} -- ${note}` : gate.data.would;
        created.push({ row: display, title, handle: result.data?.product?.handle ?? args.handle, summary, action });
        status = action;
      }
    }
    onProgress?.({ done: created.length + parked.length + skipped.length, total: rows.length, row: display, title, status });
  }
  return { created, parked, skipped };
}

/*
 * A CLASH batch.js itself already found, before ever reaching the tool (an
 * unresolvable category/subcategory, a price that will not parse) — parked
 * directly, with the reason this file already worked out as the summary,
 * rather than running it through runTool's own check() first (which would
 * only fail the exact same way, having nothing new to add). The person who
 * opens this link sees the same editable form every other approval already
 * gives, args and all, ready to fix and approve.
 *
 * A row's OWN category/subcategory resolution can still surface a
 * NOT_ROW_FIXABLE reason too (resolveCategoryByCode/resolveOrCreateCategory
 * both call runTool themselves, on this same actor/role) — a staff actor's
 * own category lookup is refused by role exactly like its product creation
 * would be. That is not a clash a person editing THIS row could resolve
 * either, so it is skipped, the same discriminator createRows' own
 * settle() already applies.
 */
/* The single park-or-skip decision every "this row cannot proceed as is"
   path needs — parkClashRows (below) and planProductBatch's own gate-check
   loop (further down) both reduce to exactly this once a reason is known. */
async function parkOrSkip(env, { actor, role }, { row, title, args, reason, toolName }) {
  if (NOT_ROW_FIXABLE.test(reason)) return { bucket: "skipped", entry: { row, title, reason } };
  const { url } = await parkForApproval(env, { name: toolName, args, actor, role, tier: "T2", summary: reason });
  return { bucket: "parked", entry: { row, title, url, summary: reason } };
}

async function parkClashRows(env, { actor, role }, rows) {
  const parked = [];
  const skipped = [];
  for (const { row, title, args, reason, toolName } of rows) {
    const outcome = await parkOrSkip(env, { actor, role }, { row, title, args, reason, toolName });
    (outcome.bucket === "skipped" ? skipped : parked).push(outcome.entry);
  }
  return { parked, skipped };
}

/* ── merchandise ──────────────────────────────────────────────────────── */

/* Bare "style" USED to be a title synonym too, on the theory that some shops
   call a garment's own descriptive name its "style" ("style name" still is,
   below). REVISED, hitting a real sheet: "Style #" and "Style" alike
   normalize (normalizeKey, above) to the same bare "style" this list used to
   claim for title — so a column of style NUMBERS ("001-001") was landing as
   the product's own TITLE, and a real style_id column right next to it went
   unrecognized. "You are mistaking style id with title" — the owner's own
   words. Removed here; STYLE_ID_KEYS (below) claims "style" instead. */
const TITLE_KEYS = [
  "title", "name", "product", "product title", "product name",
  "item", "item name", "item title", "style name",
];
const DESCRIPTION_KEYS = ["description", "desc", "details", "product description", "copy"];
const CATEGORY_KEYS = ["category", "category name", "type", "product type", "collection", "department"];
/* A SEPARATE column naming a SUBcategory to nest under whichever row this
   same record's own CATEGORY_KEYS column resolves to — "Jacket" / "Blazer"
   as two distinct cells, rather than one column and a slash or a colon
   this file would have to invent a convention for. Given with no category
   column at all, it is refused the same way a vendor code given with no
   vendor already is (this file's own VENDOR_CODE_KEYS check, below) —
   nothing real to nest it under. */
const SUBCATEGORY_KEYS = ["subcategory", "subcategory name", "sub category", "sub-category"];
/* "cost" is deliberately NOT a price synonym. The owner's own words: "Every
   product has a price and a unit cost" — two different numbers (what a
   customer pays vs. what we paid), and a sheet with its own "Cost" column
   was previously read as the SALE price, silently discarding the actual
   retail price synonym sitting next to it. A "Cost" column now falls
   through to custom_fields below instead, preserved rather than
   misinterpreted. */
const PRICE_KEYS = ["price", "price (usd)", "retail price", "unit price", "sale price", "msrp"];
const CURRENCY_KEYS = ["currency"];
/* REVISED, and REVISED AGAIN (Test-PRD-P0-177-fluid_style_id): "it should
   never be looking, expecting an SKU in our spreadsheets, because the SKU
   is something that is generated automatically" — the owner's own words —
   turned out to still be only half-applied: a style-numbered row's own
   full style number USED to become its real SKU verbatim. No longer. SKU
   is now a permanent, opaque, system-generated code with NO relationship
   to the sheet's own style number, or to style_id, or to category, ever —
   "just a hash... completely separately from the style ID," the owner's
   own words. Every row, style-numbered or not, sends no `sku` argument at
   all; catalog-writer.js's own generateSku() mints one, every time — "SKU
   should be auto generated when adding variants or options — Square does
   that," the owner's own words, on discovering Square only does this for a
   Dashboard/POS-created item, never one this codebase creates through the
   Catalog API. A column literally named "SKU" (or "item number", "product
   code") is not claimed at all — it falls through to custom_fields like
   any other unrecognized column, "preserve all fields" applying here too. */
/* vendor and commission are Square's own Custom Attribute/Vendor entity
   (Test-PRD-P0-136-square_custom_attributes), not a custom_fields example —
   recognized here so a sheet carrying them reaches catalog.create_product as
   real arguments rather than inert text. style_id is NOT one of these any
   more, REVISED (Test-PRD-P0-177-fluid_style_id): "changing a category of
   an item... actually changes its style ID" — the owner's own words —
   means style_id is never given by hand, from a sheet or anywhere else. A
   row's own style number (STYLE_ID_KEYS, below) still resolves WHICH
   category/subcategory the row belongs to (by matching numeric_id, or by a
   separate Category/Subcategory name column) — draftGroupedProduct's own
   comment has the full resolution order — but the literal digits are never
   sent as `style_id`; catalog.create_product's own resolveStyleId mints the
   real one automatically from whatever category_id the row actually lands
   on. Separately, a vendor NAME with no commission on file yet
   (mirror_vendor.commission_pct — brand new to this shop, or a vendor
   Square already knew about that was never given a rate) needs one given
   in the same row. REVISED: "let's not force vendor's commission to be
   stated out loud [on every row]... we store it in essential locations
   per vendor so their commission is recorded in a central location and
   automatically applied" — a vendor with a rate already on file needs
   nothing repeated here at all; catalog.create_product's own check()
   copies that rate onto the row's own product automatically. */
/* Bare "style"/"style #" claimed here. "style #", "style#" and "style"
   itself all normalize to the same "style" key.
   REVISED: this same cell may now carry the FULL style number — style_id
   plus a color and/or a size riding along after it, one dash each
   (parseStyleNumber, above) — not just the bare NN-NN-NNN this shop's own
   style_id nomenclature is on its own. */
/* "There is a style number column, the first column... the first three-digit
   sequences, that's the style ID. So you need to detect style IDs better" --
   the owner's own words, after a sheet whose header read "Style Number" was
   not recognised at all (normalizeKey folds "style id", "style_id" and
   "style #" onto the first two keys below, but "stylenumber" was never one of
   them), so every row on it reported "no style ID on the sheet" and was
   matched by title alone. detectStyleColumn (below) also finds the column by
   what its VALUES look like when no header says so. "style name" is a TITLE
   key and is deliberately not here. */
const STYLE_ID_KEYS = [
  "style id", "style_id", "style #", "style", "style number", "style no", "style num", "style nbr", "style code",
];
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
   the "no vendor needs a unit cost" rule immediately below. The actual key
   list (LEGACY_COST_FIELD_KEYS) now lives in catalog-writer.js, the one
   canonical copy catalog.strip_legacy_cost_fields (catalog-write.js) also
   reads from, rather than a second list here that could drift out of
   sync with it. */
/* "When quantity not specified use 1" — the owner's own words. A real
   catalog.create_product argument now (VARIATION_WITH_OPTIONS' own
   `quantity`), set as part of the same approved write, never a second
   inventory.adjust approval — there is no existing count for a freshly
   created row to protect. Blank is not an error here, the one field on
   this whole row that defaults rather than blocks or falls through to
   custom_fields, matching "quantity is not required at all... assume 1
   and adjust it later." */
const QUANTITY_KEYS = ["quantity", "qty", "stock", "initial quantity", "initial stock", "on hand", "units"];

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
   asked for.
   REVISED: a color and/or a size embedded in the full style number itself
   (parseStyleNumber, above) fill these same two option values too — an
   explicit Size/Color column here always wins when a row has both,
   the derived one only ever filling a gap the column itself left blank. */
const OPTION_KEYS = {
  Size: ["size", "size name"],
  Color: ["color", "colour", "color name", "colour name"],
};

/* Every column name draftProductBatch/previewBatch already knows what to do
   with. Anything else in the sheet is CUSTOM — ours, not Square's, and not
   dropped just because neither of us has a named field for it yet. */
const PRODUCT_KNOWN_KEYS = [
  ...TITLE_KEYS, ...DESCRIPTION_KEYS, ...CATEGORY_KEYS, ...SUBCATEGORY_KEYS, ...PRICE_KEYS, ...CURRENCY_KEYS,
  ...STYLE_ID_KEYS, ...VENDOR_KEYS, ...VENDOR_CODE_KEYS, ...COMMISSION_KEYS, ...QUANTITY_KEYS,
  ...Object.values(OPTION_KEYS).flat(),
];

/* The one deliberate exception to "preserve all fields" (PRODUCT_KNOWN_KEYS'
   own comment, above): "we don't need to have a margin... we don't need
   that," the owner's own words, looking at a real product's own stray
   "Margin" custom field. A margin is a derived number (price minus cost,
   already both real fields in their own right) with nowhere useful to
   go and nothing this shop asked to keep — genuinely dropped, not merely
   redirected the way a real cost column now is (unitCostRaw, above). Added
   to `knownKeys` alongside PRODUCT_KNOWN_KEYS so extraFields treats it as
   already-handled and never captures it at all, rather than inventing a
   `custom_fields` home for a value with none. The actual key list
   (LEGACY_MARGIN_FIELD_KEYS) now lives in catalog-writer.js, alongside
   LEGACY_COST_FIELD_KEYS above, for the same single-canonical-copy
   reason. */

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

/*
 * "5", " 5 " -> 5. Whole numbers only, same reasoning as parseCommission
 * above. Blank is handled by the CALLER, not here — this only ever runs
 * against a cell that actually has something in it, so an unparsable
 * value is always a real typo worth reporting, never the "not specified"
 * case "use 1" already covers.
 */
function parseQuantity(raw) {
  const cleaned = String(raw ?? "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/*
 * "We're now going to be providing you with the full style number... the
 * category first, this represents an ID that matches our existing
 * categories, then a subcategory ID, number dash number, and then the
 * actual index of the item. Then, if there's an option like a color,
 * that's going to be a dash and then an abbreviation for the color, and
 * then a dash for any sizes. OS size means all sizes, it fits all" — the
 * owner's own words. The style id/style number cell may carry a color
 * and/or a size riding along after its own base code, one dash each,
 * color before size — REVISED, once a real sheet showed the base itself
 * is not always this shop's own two-digit NN-NN-NNN shape (some sheets
 * pad category/subcategory to three digits of their own, "001" rather
 * than "01") — split purely on SEGMENT COUNT, never on digit width, so
 * whatever the base itself looks like, the trailing color/size are still
 * found the same way.
 *
 * A single trailing segment is always the SIZE, never a color standing
 * in alone — color is the segment that goes missing entirely when an
 * item has no color axis, while size is always given, "OS" being the
 * reserved value for an item that has no real size axis either ("it
 * fits all"). That is what keeps a FOUR-segment number from ever being
 * ambiguous about which one it is.
 *
 * Exactly 4 or 5 dash-separated segments split into a 3-segment `base`
 * plus a size, or a color and a size; anything else (3 segments, a
 * genuinely malformed cell, some other identifier entirely) is left
 * completely untouched as `base`, with no color or size at all — this
 * only ever EXTRACTS a trailing color/size when the segment count
 * actually says to, it never guesses at where the split should be.
 */
function parseStyleNumber(raw) {
  const trimmed = String(raw ?? "").trim();
  /* "The first three-digit sequences, that's the style ID" -- the owner's own
     words: the style ID is the first three runs of digits, whatever follows
     them is the variation. Dashes (and their longer cousins a spreadsheet
     program likes to substitute) may have spaces around them. */
  const m = STYLE_NUMBER_HEAD.exec(trimmed);
  if (!m) return { base: trimmed, color: undefined, size: undefined };
  const base = `${m[1]}-${m[2]}-${m[3]}`;
  const tail = m[4] ? m[4].split(/\s*[-\u2013\u2014]\s*/).filter(Boolean) : [];
  if (tail.length === 0) return { base, color: undefined, size: undefined };
  if (tail.length === 1) return { base, color: undefined, size: tail[0] };
  return { base, color: tail.slice(0, -1).join("-"), size: tail[tail.length - 1] };
}

const STYLE_NUMBER_HEAD = /^(\d+)\s*[-\u2013\u2014]\s*(\d+)\s*[-\u2013\u2014]\s*(\d+)(?:\s*[-\u2013\u2014]\s*(.*))?$/;

/* What a style number CELL looks like when nothing names the column: three
   short runs of digits joined by dashes, optionally followed by a variation.
   Short (1-3 digits) on purpose -- a date column ("2026-10-01") is also three
   dash-joined numbers, and must never be mistaken for one. */
const STYLE_NUMBER_CELL = /^\d{1,3}\s*[-\u2013\u2014]\s*\d{1,3}\s*[-\u2013\u2014]\s*\d{1,3}(?:\s*[-\u2013\u2014].*)?$/;

/*
 * Make sure a product sheet's style numbers are found. If any recognised
 * style header carries a value, nothing to do. Otherwise look for the column
 * whose values (at least half of the filled ones) read like style numbers, the
 * leftmost winning, and copy it under the canonical "style id" key so every
 * reader downstream sees it. The original column stays as it was.
 */
function withDetectedStyleColumn(records) {
  if (!records.length) return records;
  if (records.some((r) => pick(r, STYLE_ID_KEYS))) return records;
  for (const header of Object.keys(records[0])) {
    const values = records.map((r) => String(r[header] ?? "").trim()).filter(Boolean);
    if (!values.length) continue;
    const hits = values.filter((v) => STYLE_NUMBER_CELL.test(v)).length;
    if (hits > 0 && hits / values.length >= 0.5) {
      return records.map((r) => ({ ...r, "style id": r[header] }));
    }
  }
  return records;
}

/* Product sheets only (customers have no style numbers). */
function productRecords(text) {
  return withDetectedStyleColumn(csvRecords(parseCsv(text)));
}

/* Enough English to fold a category name onto its own plural, and no more —
   the identical rule catalog-write.js's own suggestCategory() already uses
   for the same reason (kept as its own small copy here rather than an
   export, since matchCategory's own closed-set exact-match semantics are
   deliberately unrelated to that function's fuzzy suggestion scoring).
   "Accessories" -> accessory, "Coats" -> coat, "Dresses" -> dress. */
function singularCategoryWord(t) {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(?:ss|x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 4 && /(?:[^s]s|z)es$/.test(t)) return t.slice(0, -1);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/* Case- and whitespace-insensitive, and plural/singular-insensitive too —
   "when matching categories and subcategories... either plural or singular
   should match" — the owner's own words. The closed set's real names, never
   guessed at beyond that fold. */
function matchCategory(name, categories) {
  const key = singularCategoryWord(name.trim().toLowerCase());
  return categories.find((c) => singularCategoryWord(c.name.trim().toLowerCase()) === key) ?? null;
}

/* "Categories/subcategories should be made if missing. And ids assigned
   auto bumped" — the owner's own words. Every auto-created-from-a-
   spreadsheet category lands at the TOP LEVEL (parent_id null) — a plain
   category cell names no parent to nest it under, and inventing one would
   be a real, consequential guess this file's own "never silently invent"
   rule (matchCategory's own comment) exists to avoid; a manager can
   always re-nest it afterward, the same as any other category. The next
   unused code in that SAME pool every top-level category shares
   (catalog.create_category's own check() enforces the identical two-pool
   split) — `reserved` is whatever this SAME batch has already actually
   claimed for an earlier missing name, so two distinct new categories in
   one upload are never offered the same number before either is
   actually created. */
function nextTopLevelNumericId(categories, reserved) {
  const used = new Set(categories.filter((c) => !c.parent_id && c.numeric_id).map((c) => c.numeric_id));
  for (let n = 0; n <= 99; n++) {
    const code = String(n).padStart(2, "0");
    if (!used.has(code) && !reserved.has(code)) return code;
  }
  return null;
}

/* The SAME idea as nextTopLevelNumericId, immediately above, for the OTHER
   of this shop's own two numeric_id pools: every subcategory anywhere in
   the tree, regardless of depth or parent, shares ONE pool (P0-138's own
   two-pool rule — the identical scope the Admin panel's own
   numericIdPoolFor already uses, and the same partial unique index
   schema.sql enforces). `reserved` is its OWN separate set from the
   top-level one — the two pools never collide with each other, so "01"
   can be freely in use by a top-level category AND, separately, by a
   subcategory at the same time. */
function nextSubcategoryNumericId(categories, reserved) {
  const used = new Set(categories.filter((c) => c.parent_id && c.numeric_id).map((c) => c.numeric_id));
  for (let n = 0; n <= 99; n++) {
    const code = String(n).padStart(2, "0");
    if (!used.has(code) && !reserved.has(code)) return code;
  }
  return null;
}

/*
 * Gives `category` a real number (`numericId`) if it does not already have
 * one — "it should all category have a must have a unique number... that's
 * a hard fail" if it does not, the owner's own words. Shared by
 * `resolveCategoryByCode`'s own name-matched (exact or corrected
 * near-duplicate) category and `resolveOrCreateCategory`'s own
 * near-duplicate match, so an existing-but-unnumbered category (one
 * created by hand through the Admin panel, which still allows leaving
 * numeric_id blank) gets a real number the moment a spreadsheet import
 * references it by name, rather than staying unnumbered forever. Mutates
 * `category` in place on success (the same object every caller's own
 * `categories` array already holds), so the one real number is visible to
 * every row after it in this same batch, not just the one that assigned it.
 */
async function ensureNumbered(env, { actor, role, reserved, rate }, category, numericId) {
  if (category.numeric_id != null && category.numeric_id !== "") return { category };
  if (reserved.has(numericId)) {
    return { error: `numeric_id "${numericId}" was already claimed earlier in this same upload` };
  }
  const gate = await runTool("catalog.set_category_number", { category_id: category.id, numeric_id: numericId }, { actor, role, env, rate });
  if (!gate?.needsApproval) return { error: gate?.error || "could not be numbered" };
  const result = await runTool("catalog.set_category_number", { category_id: category.id, numeric_id: numericId }, {
    actor, role, env, rate, approvalToken: gate.data.approval.token,
  });
  if (result?.error || result?.denied) return { error: result.error || result.denied || "could not be numbered" };
  reserved.add(numericId);
  category.numeric_id = numericId;
  return { category };
}

/* "We can make categories with UI can't we? Why not just pre make them and
   switch to admin tab? If UI works why can't agent?" — the owner's own
   words, correcting an earlier design that parked a SEPARATE approval for
   a missing category and made the uploader come back and re-upload the
   row once someone had clicked it. The Admin panel's own
   /admin/categories/create handler (index.js) already treats "a manager
   filled in the form and hit Create" as the deliberate yes: it calls
   runTool TWICE in the SAME request — once with no token to get the T2
   gate, immediately again with that gate's own approval token — no
   separate approval page in between. Uploading a spreadsheet is just as
   deliberate an action, so a missing category is now created the exact
   same way, right here, inside this SAME draftProductBatch call — the row
   that needed it then creates its own product immediately after (REVISED,
   createRows — no approval link at all any more, product or category
   alike), no re-upload required.
   `cache` is this one batch run's own memory (dedup by lowercased,
   trimmed name), so several rows naming the same missing category only
   create it once; `categories`/`reserved` grow the moment a new one lands
   so nextTopLevelNumericId's own pool-scan and this file's own
   matchCategory both see it as real for every row after it.
   REVISED: `parentId`, when given, makes this create a SUBCATEGORY under
   that specific category instead — picking nextSubcategoryNumericId's
   own tree-wide pool rather than nextTopLevelNumericId's, and keying the
   cache by parent TOO (`"a subcategory name can be used more than once
   [under a different parent]"` — P0-138 — so "Casual" under "Outerwear"
   and "Casual" under "Knitwear" must never share one cache entry).

   REVISED AGAIN — two hard rules, the owner's own words, given directly:
   "if [a category or subcategory] does not match anything we already have,
   provided that they are properly spelled, go ahead and do create them on
   the fly. If they're improperly spelled, do correct the spelling and
   create the properly spelled category" (a misspelling of one that already
   EXISTS conforms to it instead — see the near-duplicate check, below,
   reusing the identical `nearestCategory`/`CATEGORY_DUPLICATE_SIMILARITY`
   scoring `catalog.create_category`'s own check() already uses for this
   exact purpose, so "properly spelled" here means the same thing it
   already means there); and "it should all category have a must have a
   unique number... that's a hard fail" if it does not — a category created
   by THIS function never goes out with no numeric_id, full stop; a pool
   with no free code left (all 100 of 00-99 already in use) is now a real
   error, never a silent unnumbered create. */
async function resolveOrCreateCategory(env, { actor, role, categories, reserved, cache, parentId = null, rate }, name) {
  const key = `${parentId ?? ""}::${name.trim().toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  const siblings = categories.filter((c) => (c.parent_id ?? null) === parentId);
  const near = nearestCategory(name, siblings);
  if (near && near.score >= CAPS.CATEGORY_DUPLICATE_SIMILARITY) {
    if (near.numeric_id != null && near.numeric_id !== "") {
      const outcome = { category: near };
      cache.set(key, outcome);
      return outcome;
    }
    /* A near-duplicate match that itself has no number yet (e.g. created by
       hand through the Admin panel, which still allows leaving numeric_id
       blank) still must not go out unnumbered — "it should all category
       have a must have a unique number... that's a hard fail" otherwise. */
    const assignId = parentId ? nextSubcategoryNumericId(categories, reserved) : nextTopLevelNumericId(categories, reserved);
    if (!assignId) {
      const outcome = { error: `no free ${parentId ? "subcategory" : "top-level category"} number available — all 100 codes (00-99) are already in use` };
      cache.set(key, outcome);
      return outcome;
    }
    const outcome = await ensureNumbered(env, { actor, role, reserved, rate }, near, assignId);
    cache.set(key, outcome);
    return outcome;
  }

  const numericId = parentId ? nextSubcategoryNumericId(categories, reserved) : nextTopLevelNumericId(categories, reserved);
  if (!numericId) {
    const outcome = { error: `no free ${parentId ? "subcategory" : "top-level category"} number available — all 100 codes (00-99) are already in use` };
    cache.set(key, outcome);
    return outcome;
  }
  reserved.add(numericId);
  const args = {
    name: name.trim(),
    reason: "auto-created while importing a spreadsheet",
    ...(parentId ? { parent_id: parentId } : {}),
    numeric_id: numericId,
  };
  const gate = await runTool("catalog.create_category", args, { actor, role, env, rate });
  if (!gate?.needsApproval) {
    const outcome = { error: gate?.error || "could not be validated" };
    cache.set(key, outcome);
    return outcome;
  }
  const result = await runTool("catalog.create_category", args, {
    actor, role, env, rate, approvalToken: gate.data.approval.token,
  });
  if (result?.error || result?.denied) {
    const outcome = { error: result.error || result.denied || "was refused" };
    cache.set(key, outcome);
    return outcome;
  }
  const category = result.data.category;
  categories.push(category);
  const outcome = { category };
  cache.set(key, outcome);
  return outcome;
}

/* Exactly the shape a style number's own base must have to be trusted at
   all — three all-digit, dash-separated segments, whatever their width.
   Anything else (blank, a sentence, a totals row) is not a style number
   and is never fed into resolveCategoryByCode below. */
const STYLE_NUMBER_BASE = /^\d+-\d+-\d+$/;

/*
 * ID-FIRST TOP-LEVEL category resolution — for a sheet whose own style
 * number already encodes everything: "you don't have to think about the
 * names... whatever we have configured, you assign to that category using
 * its ID... if you find that we do not have an ID that matches what we are
 * supplying you, then you will use the columns for the... name and create a
 * new one" — the owner's own words. TOP-LEVEL only — a real sheet's own
 * SUBcategory digit turned out to restart at 1 for every new top-level
 * category ("Blazer" under Jacket and "Dress Pants" under Pants both "001"),
 * incompatible with this shop's own subcategory numeric_id pool being
 * TREE-WIDE unique (a real database constraint, P0-138) — draftGroupedProduct
 * resolves a subcategory by NAME instead, below, exactly as P0-146's own
 * Subcategory column already does. A top-level category's own pool has no
 * such conflict (every top-level code in a real sample sheet was already
 * globally distinct), so ID-first stays exactly what the owner asked for
 * at that one level. `code` is read as a plain INTEGER, never a padded
 * string — "it's just a number... if we use two digits internally and
 * you're providing three-digit padded, it's still the same number" — so
 * "001" and "01" name the exact same category. Three outcomes, tried in
 * order:
 *
 *   1. An EXISTING top-level category whose own numeric_id, read the same
 *      way, equals `code` — used exactly as it is, its own real name kept,
 *      `name` never even consulted. This is the expected, ordinary case
 *      for every row after the first one naming a category the batch
 *      already resolved.
 *   2. No numeric match, but an EXISTING one matches `name` — exactly, or a
 *      corrected near-duplicate spelling of one (`nearestCategory`, the
 *      identical scoring `catalog.create_category`'s own check() already
 *      uses). Never numbered yet: given this exact number NOW
 *      (catalog.set_category_number) rather than creating a confusing
 *      near-duplicate beside it — one existing category already correctly
 *      matches, "Outerwear" style, from before this sheet's own numbering
 *      convention existed at all. Already carrying a DIFFERENT real number
 *      — REVISED, no longer a clash to park: "we already have categories
 *      and subcategories with their corresponding IDs defined in our
 *      database... they do not provide the source of truth. We have the
 *      source of truth, and we must map the incoming spreadsheets to match
 *      ours" — the owner's own words. The existing, real number wins
 *      outright; `draftGroupedProduct` resolves this row's own category_id
 *      from it, never the row's own (wrong) claimed code verbatim --
 *      style_id itself is computed FROM that category, one layer up, in
 *      catalog.create_product.
 *   3. Neither matches anything, not even a near-duplicate spelling — a
 *      brand-new category, named from `name` and given `code`, normalized
 *      to this shop's own two-digit convention, as its numeric_id — "if
 *      [it does] not match anything we already have, provided that they
 *      are properly spelled, go ahead and do create them on the fly," the
 *      owner's own words, and never without a real number: "it should all
 *      category have a must have a unique number... that's a hard fail" if
 *      it does not (see `resolveOrCreateCategory`'s own header comment,
 *      which enforces the identical rule for a subcategory). With no
 *      `name` either, returns `{ category: null }` instead — a SOFT
 *      outcome, not an error (its caller decides whether that is fatal).
 *
 * `reserved` and `cache` are the SAME per-batch-run bookkeeping
 * resolveOrCreateCategory's own already keeps, shared with it (both
 * ultimately claim numeric_id out of the identical top-level pool), so an
 * ID-resolved row and a name-resolved one in the same upload can never pick
 * the same code for two different categories.
 */
async function resolveCategoryByCode(env, { actor, role, categories, reserved, cache, rate }, code, name, { numberFirst = true } = {}) {
  const numeric = Number(code);
  const validCode = Number.isInteger(numeric) && numeric >= 0 && numeric <= 99;
  if (!validCode && numberFirst) {
    return { error: `"${code}" is not a plain 0-99 number this shop's own numbering can use` };
  }
  let padded = validCode ? String(numeric).padStart(2, "0") : null;
  const pool = categories.filter((c) => !c.parent_id);

  /* numberFirst false: the sheet's Category NAME decides (resolveSheetCategory),
     so the number holding that code is never consulted -- only used as the
     number a NEW category asks for, when it is free. */
  const byNumber = numberFirst ? pool.find((c) => c.numeric_id != null && c.numeric_id !== "" && Number(c.numeric_id) === numeric) : null;
  if (byNumber) {
    /* "We have the source of truth, and we must map the incoming
       spreadsheets to match ours" -- the owner's own words, the reason the
       NUMBER wins outright here, never second-guessed against what the
       row's own Category column happens to say. But a genuine real-world
       report proved that silence has a real cost: two DIFFERENT intended
       categories ("Dress", "Pants") that happen to share the same leading
       code by a spreadsheet mistake get silently merged into whichever one
       already holds that number -- invisible at the moment it happens, only
       surfacing later as a confusing "subcategory already exists" clash
       under what looks like the wrong parent. A real name/near-duplicate
       mismatch is now a plain, automatic NOTE (never a clash — the number
       still wins, exactly as asked) naming the real category this row
       landed in, so a genuine mistake is visible immediately instead of
       several steps downstream. */
    const matchesName = !name || nearestCategory(name, [byNumber])?.score >= CAPS.CATEGORY_DUPLICATE_SIMILARITY;
    return {
      category: byNumber,
      note: matchesName
        ? undefined
        : `category code "${padded}" already belongs to "${byNumber.name}", not "${name}" as this row's own Category column says -- filed under the existing "${byNumber.name}" (the number's own source of truth); give this row a different code if "${name}" was meant to be a separate category`,
    };
  }

  /* An exact name match, or a corrected near-duplicate spelling of one --
     "if they're improperly spelled, do correct the spelling and create the
     properly spelled category" -- the owner's own words. Reuses the
     identical `nearestCategory`/`CATEGORY_DUPLICATE_SIMILARITY` scoring
     `catalog.create_category`'s own check() already uses for the same
     purpose, so "properly spelled" here means the same thing it already
     means there. */
  const exact = name ? pool.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()) : null;
  const near = !exact && name ? nearestCategory(name, pool) : null;
  const matched = exact || (near && near.score >= CAPS.CATEGORY_DUPLICATE_SIMILARITY ? near : null);
  if (!numberFirst) {
    /* A number for a category this row creates or numbers: the sheet's own
       code when it is free, else the next free one. */
    const taken = (n) => !n || reserved.has(n) || pool.some((c) => c.numeric_id != null && c.numeric_id !== "" && Number(c.numeric_id) === Number(n));
    if (taken(padded)) padded = nextTopLevelNumericId(categories, reserved);
    if (!padded && !(name && pool.some((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()))) {
      return { error: "no free top-level category number available -- all 100 codes (00-99) are already in use" };
    }
  }
  if (matched) {
    /* REVISED — already numbered, just not the way this row's own style
       number claims: no longer a genuine clash to park. "We already have
       categories and subcategories with their corresponding IDs defined
       in our database... they do not provide the source of truth. We have
       the source of truth, and we must map the incoming spreadsheets to
       match ours" -- the owner's own words. The existing, real number wins
       outright; draftGroupedProduct resolves this row's own category_id
       from it, rather than keeping the row's own (wrong) claimed code
       verbatim -- style_id itself is computed FROM that category, one
       layer up, in catalog.create_product. */
    if (matched.numeric_id != null && matched.numeric_id !== "") {
      return { category: matched };
    }
    const key = `assign::${matched.id}`;
    if (cache.has(key)) return cache.get(key);
    const outcome = await ensureNumbered(env, { actor, role, reserved, rate }, matched, padded);
    cache.set(key, outcome);
    return outcome;
  }

  /* Nothing matched and nothing to name a new one from — a SOFT outcome,
     not an error, per the header comment above. */
  if (!name) {
    return { category: null };
  }
  const key = `create::${name.trim().toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  if (reserved.has(padded)) {
    const outcome = { error: `numeric_id "${padded}" was already claimed earlier in this same upload` };
    cache.set(key, outcome);
    return outcome;
  }
  reserved.add(padded);
  const args = {
    name: name.trim(),
    reason: "auto-created while importing a spreadsheet",
    numeric_id: padded,
  };
  const gate = await runTool("catalog.create_category", args, { actor, role, env, rate });
  if (!gate?.needsApproval) {
    const outcome = { error: gate?.error || "could not be validated" };
    cache.set(key, outcome);
    return outcome;
  }
  const result = await runTool("catalog.create_category", args, { actor, role, env, rate, approvalToken: gate.data.approval.token });
  if (result?.error || result?.denied) {
    const outcome = { error: result.error || result.denied || "was refused" };
    cache.set(key, outcome);
    return outcome;
  }
  const category = result.data.category;
  categories.push(category);
  const outcome = { category };
  cache.set(key, outcome);
  return outcome;
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
 *
 * REVISED: category is now optional here too (below) — a row naming
 * neither a category NOR a style ID that resolves to one stays genuinely
 * unassigned, the same as catalog.create_product already tolerates. `null`
 * gets its own shared counter under the plain word "Item", so a batch of
 * fully-unassigned rows still gets distinct, sequential names rather than
 * colliding on the same one.
 */
function autoTitler(existingCounts) {
  const next = new Map();
  return (category) => {
    const key = category?.id ?? "__unassigned__";
    const label = category?.name ?? "Item";
    const n = next.has(key) ? next.get(key) : (existingCounts.get(key) ?? 0) + 1;
    next.set(key, n + 1);
    return `${label} ${n}`;
  };
}

/*
 * One GROUP (every CSV row sharing one style number base) -> one
 * catalog.create_product call, one variation per row. "It's not one
 * product, one line... I gave you variations" — the owner's own words.
 * The CATEGORY resolves by NUMBER (resolveCategoryByCode, above); the
 * SUBCATEGORY resolves by NAME instead (see this function's own body for
 * why — a real sheet's own subcategory digit turned out to be incompatible
 * with this shop's tree-wide-unique subcategory pool).
 *
 * REVISED, then REVISED AGAIN: "the only hard rule here is that we must
 * have a unique SKU number or ID for each item... if that's true, then add
 * the product," followed by "the only time you want to do an approval link
 * is if there's a clash and it has to be resolved by a person" — the
 * owner's own words, in that order. Together they draw the actual line:
 * something this file can safely default (a missing vendor/unit cost, a
 * malformed commission/vendor-code/quantity, a category code matching
 * NOTHING with no name to create one from) is simply left out of the write
 * and noted — no approval, no clash, nothing to decide. Something this
 * file found a REAL, CONFLICTING answer for and cannot safely pick a side
 * on (a category name already numbered differently than this row's own
 * claim, a category/subcategory Square genuinely refused to create, a
 * price that will not parse, or — surfacing only once catalog.
 * create_product's own check() actually runs — a SKU already used by a
 * different product, or a vendor with no commission on file) is a real
 * CLASH: parked as an ordinary approval link, exactly the same
 * check-then-a-person-decides gate every other T2 write already uses, a
 * person free to edit the prefilled form before saying yes. No title
 * column exists on a sheet like this, so the first row's own Description
 * stands in for it — "Black hand-painted blazer" reads exactly like a
 * product name already.
 *
 * @returns { clash: {row, title, args, reason} } | { row: {rowNumber, title, args} }
 */
/*
 * Split first: every record with a style number whose own first three
 * segments are all-digit joins a GROUP; anything else -- a blank style-id
 * cell, or a non-blank one that does not look like a real style number at
 * all (garbage, a totals row) -- is dropped right here, never reported at
 * all -- it was never a data row to begin with. Shared between
 * draftProductBatch (the real write) and previewBatch (below) so a preview
 * groups a sheet into products EXACTLY the way the real draft will -- the
 * whole point of a preview being able to show "the agent interpreted N rows
 * as this one product," not a second, possibly-drifting guess at the same
 * rule.
 *
 * REVISED — a blank style-id cell used to take a separate STANDALONE path:
 * one row, one product, category/subcategory resolved by NAME (creating
 * either if missing). The owner's own words, having actually seen what that
 * path let through: "Why are you including the totals with a bunch of not
 * found?... if you don't have the qualifying, like the style ID, just don't
 * include that row at all... why would you show that to me?" A real
 * inventory sheet's own totals/notes line has no style number either, and
 * used to preview (and draft) as a near-empty "product." That whole
 * standalone path is gone.
 *
 * REVISED AGAIN — a blank style-id row is not ALWAYS a totals/notes line,
 * though: "we already have categories and subcategories with their
 * corresponding IDs defined in our database... if we were to add a
 * spreadsheet that did not have a style ID, but we did provide matching
 * categories and subcategories, the agent should be able to generate an ID
 * automatically... as long as it finds the matching category and
 * subcategory." A row naming BOTH an existing, already-numbered top-level
 * category AND an existing, already-numbered subcategory under it (by
 * NAME, never a number) is a genuine, identifiable product — it joins
 * `namedRecords` instead of being dropped, and `draftProductBatch`/
 * `previewBatch` resolve those names and let `catalog.create_product`'s own
 * `resolveStyleId` mint the real style_id (category/subcategory's own NN-NN
 * plus the next free index — "the index is just something that it
 * generates on the fly using the next available slot," the owner's own
 * words). Confirmed directly: a name that matches NOTHING (or matches an
 * unnumbered category) is dropped exactly like a totals row always was —
 * this file never creates a category on this path, only looks one up. A
 * category name alone, with no subcategory given or matched, is also
 * dropped — confirmed directly that both are required, matching the "add
 * the product" bar this file already holds real style numbers to.
 */
function splitProductRecords(records) {
  const groups = new Map();
  const groupOrder = [];
  const namedRecords = [];
  for (const [i, record] of records.entries()) {
    const rowNumber = i + 2; /* +1 for the header, +1 for 1-based rows */
    const styleIdRaw = pick(record, STYLE_ID_KEYS);
    const { base, color, size } = parseStyleNumber(styleIdRaw);
    if (STYLE_NUMBER_BASE.test(base)) {
      if (!groups.has(base)) {
        groups.set(base, []);
        groupOrder.push(base);
      }
      groups.get(base).push({ record, rowNumber, color, size, styleIdRaw });
      continue;
    }
    if (pick(record, CATEGORY_KEYS) && pick(record, SUBCATEGORY_KEYS)) {
      namedRecords.push({ record, rowNumber });
    }
  }
  return { groups, groupOrder, namedRecords };
}

/*
 * A row with no style number, but naming BOTH a top-level category AND a
 * subcategory under it -- resolved by NAME, reusing resolveOrCreateCategory
 * (above) for BOTH levels, the same exact-or-corrected-near-duplicate
 * matching, and the same "must have a unique number... hard fail otherwise"
 * guarantee, every other name-driven category resolution in this file
 * already uses. REVISED from this function's own former, more limited
 * self (renamed from matchNamedCategory): a category or subcategory name
 * matching nothing at all is no longer a reason to drop the row -- "if
 * [it does] not match anything we already have, provided that they are
 * properly spelled, go ahead and do create them on the fly," the owner's
 * own words -- it is created instead, top-level first, then the
 * subcategory resolved (or created) under it. A genuine failure (the
 * numeric pool exhausted, a real create refusal) is returned as `{error}`,
 * a clash for a person to review, never a silent drop.
 *
 * Nothing here computes a style_id — `catalog.create_product`'s own
 * `resolveStyleId` (catalog-write.js) already builds one automatically from
 * a given `category_id`'s own NN-NN pair, plus the next free index, the
 * moment that category_id belongs to a real, numbered subcategory. Handing
 * it the resolved subcategory's own id with no `style_id` argument at all
 * is everything this needs.
 */
async function resolveNamedCategory(env, ctx, record) {
  const categoryName = pick(record, CATEGORY_KEYS);
  const subcategoryName = pick(record, SUBCATEGORY_KEYS);
  if (!categoryName || !subcategoryName) return { category: null };
  const { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, rate } = ctx;
  const topOutcome = await resolveOrCreateCategory(
    env,
    { actor, role, categories, reserved: reservedNumericIds, cache: categoryCache, parentId: null, rate },
    categoryName,
  );
  if (topOutcome.error) return topOutcome;
  return resolveOrCreateCategory(
    env,
    { actor, role, categories, reserved: reservedSubcategoryNumericIds, cache: categoryCache, parentId: topOutcome.category.id, rate },
    subcategoryName,
  );
}

/*
 * Builds the one row/variation a name-matched record becomes -- the same
 * field-by-field defaulting the (now-removed) standalone loop always used
 * (a malformed optional value is noted, automatic; only an unparseable
 * price is a genuine clash), minus everything about resolving OR CREATING a
 * category by name, since that already happened above, in
 * resolveNamedCategory. `category` is `null` only when resolution failed
 * entirely or was never attempted (no name given) -- `resolutionError`,
 * when given, is folded into this row's own clashes exactly like a bad
 * price is, so a category creation failure still parks a complete,
 * editable proposal for a person, rather than silently vanishing.
 */
async function draftNamedCategoryProduct(env, category, resolutionError, nextAutoTitle, record, rowNumber, mode, ctx) {
  const rawTitle = pick(record, TITLE_KEYS).slice(0, 200);
  const priceRaw = pick(record, PRICE_KEYS);
  const currency = (pick(record, CURRENCY_KEYS) || "USD").toUpperCase();
  const notes = [];
  const rowClashes = [];
  if (resolutionError) rowClashes.push(resolutionError);

  /* REVISED: "I think if we have the system to do style IDs as our main
     differentiator, it should be like one operation... we're just updating
     information if what we're submitting is different than what we have" --
     the owner's own words, retiring the add/update mode split this file
     used to gate matching behind entirely (Test-PRD-P0-182). A named row (a
     plain Category/Subcategory NAME pair, no style number at all --
     resolveNamedCategory's own header comment) has nothing else to match an
     existing product by, so this always tries the same category+title
     fallback draftGroupedProduct's own style-numbered path uses
     (productsByCategoryAndTitle) -- reused wholesale via draftProductUpdate
     itself, wrapping this one record as a one-row "group" (a named row was
     always exactly one variation, never grouped with siblings the way a
     shared style number groups several rows). Widened the same way
     draftGroupedProduct's own fallback was (the "found no existing
     products" production report): a category-scoped search that comes up
     empty tries once more, catalog-wide by title alone, before this row
     gives up -- a real category move since creation (catalog.update_product,
     a deliberate, separate edit) leaves this row's own still-correct
     category NAME resolving to a real category the product simply is not
     IN any more. No match at all is no longer a clash here either -- it
     simply means this really is a new item, and falls straight through to
     creating one, the one behavior "add" always had; mode no longer changes
     what a miss means, only whether a match was ever looked for at all used
     to. */
  if (!resolutionError && rawTitle) {
    let candidates = category ? await productsByCategoryAndTitle(env.CATALOG_MIRROR, category.id, rawTitle) : [];
    let scoped = candidates.length > 0;
    if (candidates.length === 0) {
      candidates = await productsByTitle(env.CATALOG_MIRROR, rawTitle);
      scoped = false;
    }
    if (candidates.length === 1) {
      return draftProductUpdate(env, candidates[0], rawTitle, [{ record, rowNumber, color: undefined, size: undefined }], { ...ctx, sheetCategory: category });
    }
    if (candidates.length > 1) {
      const scope = scoped ? `in "${category.name}"` : "anywhere in the catalog (no category match narrowed the search)";
      rowClashes.push(
        `"${rawTitle}" ${scope} matches ${candidates.length} existing products ` +
          `(${candidates.map((c) => c.handle).join(", ")}) -- too ambiguous to update automatically; confirm which one, if any, this row means`,
      );
    }
  }

  const title = rawTitle || nextAutoTitle(category);
  const priceMinor = parsePriceToMinor(priceRaw);
  if (priceMinor === null) rowClashes.push(`price "${priceRaw}" is not a plain number like 45.00`);

  const quantityRaw = pick(record, QUANTITY_KEYS);
  let quantity = 1;
  if (quantityRaw) {
    const parsedQuantity = parseQuantity(quantityRaw);
    if (parsedQuantity === null) notes.push(`quantity "${quantityRaw}" is not a plain whole number like 5 -- defaulted to 1`);
    else quantity = parsedQuantity;
  }

  const vendor = pick(record, VENDOR_KEYS);
  const commissionRaw = pick(record, COMMISSION_KEYS);
  let commission;
  if (commissionRaw) {
    commission = parseCommission(commissionRaw);
    if (commission === null) {
      notes.push(`commission "${commissionRaw}" is not a plain whole number like 20 -- left unset`);
      commission = undefined;
    }
  }
  /* REVISED YET AGAIN — a cost value no longer needs a vendor NAMED in this
     row at all: catalog.create_product resolves the built-in "In-house"
     vendor automatically when a row gives none (catalog-writer.js's own
     vendorRefOrInHouse), so cost always lands on the real, vendor-tied
     vendor_information -- never custom_fields, and no longer a separate
     Custom Attribute either. This used to be gated on `vendor &&`
     specifically because vendor_information was the ONLY place cost could
     live at all, and a vendor-less row had no vendor to attach it to. */
  const unitCostRaw = pick(record, LEGACY_COST_FIELD_KEYS);
  let unitCostMinor;
  if (unitCostRaw) {
    unitCostMinor = parsePriceToMinor(unitCostRaw);
    if (unitCostMinor === null) {
      notes.push(`unit cost "${unitCostRaw}" is not a plain number like 45.00 -- left unset`);
      unitCostMinor = undefined;
    }
  }
  const vendorCode = pick(record, VENDOR_CODE_KEYS);
  if (vendorCode && !vendor) notes.push(`vendor code "${vendorCode}" was given without a vendor -- left unset`);

  const description = pick(record, DESCRIPTION_KEYS);
  const knownKeys = unitCostMinor !== undefined ? [...PRODUCT_KNOWN_KEYS, ...LEGACY_COST_FIELD_KEYS, ...LEGACY_MARGIN_FIELD_KEYS] : [...PRODUCT_KNOWN_KEYS, ...LEGACY_MARGIN_FIELD_KEYS];
  const customFields = extraFields(record, knownKeys);
  if (notes.length) customFields["import notes"] = notes.join("; ").slice(0, CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX);

  const optValues = Object.fromEntries(Object.entries(optionValues(record)).filter(([, value]) => value.trim().toUpperCase() !== "TBD"));
  /* "All items... should have... associated sizes... if we don't specify
     a size, it's going to be OS" — the owner's own words; see
     draftGroupedProduct's own identical comment for the full reasoning. */
  if (!optValues.Size) optValues.Size = "OS";

  /* No `style_id` given at all -- catalog.create_product's own
     resolveStyleId mints one from `category_id`'s own NN-NN pair the
     moment it belongs to a real, numbered subcategory, exactly like this. */
  const args = {
    title,
    ...(description ? { description } : {}),
    ...(category ? { category_id: category.id } : {}),
    ...(vendor ? { vendor } : {}),
    ...(vendorCode && vendor ? { vendor_code: vendorCode } : {}),
    ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
    ...(commission !== undefined ? { commission } : {}),
    variations: [
      {
        title,
        ...(priceMinor !== null ? { price_minor: priceMinor } : {}),
        currency,
        quantity,
        ...(Object.keys(optValues).length ? { option_values: optValues } : {}),
      },
    ],
    ...(Object.keys(customFields).length ? { custom_fields: customFields } : {}),
  };

  if (rowClashes.length) return { clash: { row: rowNumber, title, args, reason: rowClashes.join("; "), toolName: "catalog.create_product" } };
  return { row: { rowNumber, title, args, toolName: "catalog.create_product" } };
}

/* Same key set, same values, trimmed and case-folded -- the same leniency
   matchCategory's own comment already gives category NAMES, applied here
   to a variation's own Color/Size instead. Both sides of this comparison
   are only ever populated by THIS SAME importer (OPTION_KEYS' own two
   names), so an exact key-set match reliably picks out the one existing
   variation a row's own Color/Size combination already means. */
function sameOptions(a, b) {
  const norm = (o) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k.trim().toLowerCase(), String(v).trim().toLowerCase()]));
  const na = norm(a);
  const nb = norm(b);
  const keys = Object.keys(na);
  return keys.length === Object.keys(nb).length && keys.every((k) => nb[k] === na[k]);
}

/* "Any time you see TBD, just use like a default or no option" — the
   owner's own words, already applied to a RESUBMIT's own row (the
   rawOptValues filter, draftProductUpdate below) before it is ever compared
   against an existing variant. An EXISTING variant's own stored options
   need the identical treatment before that same comparison, not just a
   freshly-drafted row's — a legacy variant actually synced with a literal
   "TBD" value (predating this filter, or carrying it in from Square some
   other way) would otherwise never match a resubmit of the exact same
   sheet ever again, every single time, since sameOptions' own strict
   key-count check would see one more key on the stored side than the
   filtered row ever has. TBD-stripping only — never the separate "default
   a missing Size to OS" rule draftProductUpdate's own two match attempts
   already apply (or deliberately do not) on the ROW's own side; this stays
   neutral on that question so both the OS-defaulted and the raw/legacy
   fallback attempt keep comparing like with like. */
function stripTbdOptions(options) {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => String(value).trim().toUpperCase() !== "TBD"));
}


/* Plain money text for a change line: 12000 -> "120.00". */
const moneyText = (minor) => (minor === null || minor === undefined ? "none" : (Number(minor) / 100).toFixed(2));

/* "Black / M", or "one size" for a variation with no options at all. */
function variationLabel(options) {
  const values = Object.values(options ?? {}).filter(Boolean);
  return values.length ? values.join(" / ") : "one size";
}

/*
 * Every REAL difference between what a matched row would send to
 * catalog.update_product and what is already on file -- one short line each,
 * "price 100.00 -> 120.00". An empty list is the single definition of "this
 * row is a no-op" (Test-PRD-P0-194-resubmit_no_op_suppression), so the lines
 * a person reads in the checklist are exactly the reasons the row exists at
 * all -- "the only thing I should see are real changes," the owner's own
 * words -- and the same function re-checks a row at the moment it is about
 * to be submitted, so a plan made earlier can never write back values the
 * catalog already holds. title/description only count when the sheet gave a
 * real column for them (titleCol gates both, the same way the args' own
 * construction does); a variation with no variant_id is a brand-new size/
 * color and always a real change.
 */
export function catalogChangesFor({ existing, existingVariants, titleCol, descriptionCol, variations, categoryMove = null }) {
  const changes = [];
  if (categoryMove) changes.push(categoryMove);
  if (titleCol && titleCol.slice(0, 200) !== existing.title) {
    changes.push(`title "${existing.title}" -> "${titleCol.slice(0, 200)}"`);
  }
  if (titleCol && descriptionCol && descriptionCol !== existing.source_description) {
    changes.push("description");
  }
  for (const v of variations ?? []) {
    const current = v.variant_id ? existingVariants.find((ev) => ev.id === v.variant_id) : null;
    if (!current) {
      changes.push(`new variation ${variationLabel(v.option_values)}`);
      continue;
    }
    const label = existingVariants.length > 1 ? `${variationLabel(current.options)}: ` : "";
    if (v.price_minor !== undefined && v.price_minor !== current.price_minor) {
      changes.push(`${label}price ${moneyText(current.price_minor)} -> ${moneyText(v.price_minor)}`);
    }
    if (v.unit_cost_minor !== undefined && v.unit_cost_minor !== current.unit_cost_minor) {
      changes.push(`${label}cost ${moneyText(current.unit_cost_minor)} -> ${moneyText(v.unit_cost_minor)}`);
    }
  }
  return changes;
}

/* The top-level category and (when there is one) subcategory NAMES a
   category id lands in -- "I want to see our result category and
   subcategory that's actually being applied," the owner's own words. */
/* "Jackets › Evening Dresses" for a category id (or just the top level). */
export function categoryPathText(categories, categoryId) {
  const labels = categoryLabels(categories, categoryId);
  return [labels.category, labels.subcategory].filter(Boolean).join(" › ") || "no category";
}

/* The one change line for an item the sheet files somewhere else; null when
   there is no move (no target, or it already sits there). */
export function categoryMoveText(categories, fromId, toId) {
  if (!toId || toId === (fromId ?? null)) return null;
  return `category ${categoryPathText(categories, fromId)} -> ${categoryPathText(categories, toId)}`;
}

export function categoryLabels(categories, categoryId) {
  const leaf = categoryId ? categories.find((c) => c.id === categoryId) : null;
  if (!leaf) return { category: "", subcategory: "" };
  const parent = leaf.parent_id ? categories.find((c) => c.id === leaf.parent_id) : null;
  return parent ? { category: parent.name, subcategory: leaf.name } : { category: leaf.name, subcategory: "" };
}

/*
 * Where a row goes, by the sheet's own words. "Just follow the spreadsheets
 * exactly... the spreadsheets have the right categories and everything" --
 * the owner's own words, reversing the earlier number-first rule, which
 * filed a row under whatever top-level category happened to hold the style
 * number's first digits and silently ignored the Category column (a sheet
 * whose "001" meant Dresses had its dresses filed under Jackets).
 *
 *   - A Category NAME decides the top level: the existing top-level category
 *     of that name (singular or plural), else a corrected near-duplicate of
 *     one, else a new one is created -- never the number's category.
 *   - A Subcategory NAME decides the second level under it, the same way.
 *   - With NO category name at all, the style number's own digits are all
 *     the sheet gives, so they pick the category exactly as before.
 *
 * `nameOnly` (a resubmit of an item already on file) does nothing at all
 * unless the sheet names a category, so an item is only ever moved because
 * the sheet said where it belongs. Returns { category (the leaf, or null),
 * notes, clashes }.
 */
async function resolveSheetCategory(env, ctx, base, record, { nameOnly = false } = {}) {
  const { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, rate } = ctx;
  const [catCode, subCode] = base.split("-");
  const categoryNameCol = pick(record, CATEGORY_KEYS);
  const subcategoryNameCol = pick(record, SUBCATEGORY_KEYS);
  const notes = [];
  const clashes = [];
  if (nameOnly && !categoryNameCol) return { category: null, notes, clashes };

  let topCategory = null;
  if (categoryNameCol) {
    const outcome = await resolveCategoryByCode(
      env,
      { actor, role, categories, reserved: reservedNumericIds, cache: categoryCache, rate },
      catCode,
      categoryNameCol,
      { numberFirst: false },
    );
    if (outcome.error) clashes.push(`category "${categoryNameCol}": ${outcome.error}`);
    else topCategory = outcome.category;
  } else {
    const catOutcome = await resolveCategoryByCode(
      env,
      { actor, role, categories, reserved: reservedNumericIds, cache: categoryCache, rate },
      catCode,
      "",
    );
    if (catOutcome.error) {
      clashes.push(`style number "${base}": category ${catCode}: ${catOutcome.error}`);
    } else if (!catOutcome.category) {
      notes.push(`style number "${base}": category ${catCode} matches no existing category, and no Category name column was given to create one from`);
    } else {
      topCategory = catOutcome.category;
      if (catOutcome.note) notes.push(`style number "${base}": ${catOutcome.note}`);
    }
  }

  let category = topCategory;
  if (topCategory && subcategoryNameCol) {
    let subcategory = matchCategory(subcategoryNameCol, categories.filter((c) => c.parent_id === topCategory.id));
    if (!subcategory) {
      const outcome = await resolveOrCreateCategory(
        env,
        { actor, role, categories, reserved: reservedSubcategoryNumericIds, cache: categoryCache, parentId: topCategory.id, rate },
        subcategoryNameCol,
      );
      if (outcome.error) {
        clashes.push(`subcategory "${subcategoryNameCol}" does not exist yet under "${topCategory.name}" and could not be created: ${outcome.error}`);
      } else {
        subcategory = outcome.category;
      }
    }
    if (subcategory) category = subcategory;
  } else if (topCategory && !categoryNameCol) {
    /* No name column at all: the style number's own middle digits, match
       only, as before. */
    const subNumeric = Number(subCode);
    const match = categories.find((c) => c.parent_id && c.numeric_id != null && c.numeric_id !== "" && Number(c.numeric_id) === subNumeric);
    if (match) category = match;
  } else if (!topCategory && subcategoryNameCol) {
    notes.push(`subcategory "${subcategoryNameCol}" was given without a resolvable category to nest it under`);
  }
  return { category, notes, clashes };
}

/*
 * A resubmit of a group already matched to `existing` (draftGroupedProduct's
 * own import_style_number lookup, just below) -- "all the sizes are the
 * same, all the options are the same, you match them... if that all
 * matches, then you just update," the owner's own words. Builds a
 * catalog.update_product call instead of a fresh catalog.create_product one:
 *
 * - never `category_id` -- a category MOVE is its own separate, deliberate
 *   edit; resending the same one here would only reassign style_id for no
 *   reason (catalog.update_product's own no-op rule already guards this,
 *   but this file never even tries).
 * - never `quantity` -- this codebase's own inventory-ledger guarantee: no
 *   write outside inventory.adjust ever silently changes stock, and a
 *   resubmit is no exception.
 * - `title`/`description` only when the sheet gives a REAL title column of
 *   its own (titleCol) -- a sheet using its Description column as a title
 *   STAND-IN (no title column at all, draftGroupedProduct's own create-path
 *   comment) must not overwrite an already-named product's real title and
 *   description with that guess.
 * - `vendor`/`vendor_code`/`commission` are deliberately NEVER touched here
 *   at all -- catalog.update_product has no home for them (they live on
 *   catalog.set_square_attributes, a separate manager action with its own
 *   business rules about a vendor's centrally-tracked commission rate);
 *   reassigning a product's own vendor relationship mid-resubmit is a
 *   heavier, rarer edit than "update the cost," and stays a deliberate,
 *   separate call a person makes on purpose, never a silent side effect of
 *   ingesting a spreadsheet.
 * - `unit_cost_minor` -- what THIS shop paid -- ships on every matched
 *   variation instead (VARIATION_WITH_ID's own per-variation field), the
 *   sheet's one cost value for the whole group applied to each.
 *
 * Each CSV row is matched to one of `existing`'s OWN CURRENT variations by
 * Color/Size (variantsWithOptionsOf, sameOptions above) -- never by
 * position, never by a stored id the sheet itself could carry. A row whose
 * Color/Size combination matches nothing already on the product is a
 * genuine clash: catalog.update_product's own VARIATION_WITH_ID shape has
 * no `option_values` at all (a materially different, larger edit the owner
 * never asked a resubmit to make), so a truly NEW size/color needs a
 * person, never a silent guess.
 */
async function draftProductUpdate(env, existing, base, groupRows, ctx) {
  const { actor, role, rate } = ctx;
  const first = groupRows[0].record;
  const firstRow = groupRows[0].rowNumber;
  const notes = [];
  const clashes = [];
  const quantityAdjustments = [];
  const explicitQuantities = [];

  const existingVariants = await variantsWithOptionsOf(env.CATALOG_MIRROR, existing.id);

  const titleCol = pick(first, TITLE_KEYS);
  const descriptionCol = pick(first, DESCRIPTION_KEYS);

  const unitCostRaw = pick(first, LEGACY_COST_FIELD_KEYS);
  let unitCostMinor;
  if (unitCostRaw) {
    unitCostMinor = parsePriceToMinor(unitCostRaw);
    if (unitCostMinor === null) {
      notes.push(`unit cost "${unitCostRaw}" is not a plain number like 45.00 -- left unset`);
      unitCostMinor = undefined;
    }
  }

  /* "Make sure that when we're doing an update that you populate the
     in-house because if there is no vendor specified, it's in-house. We
     want to make sure that the cost fields are properly updated" -- the
     owner's own words. catalog.update_product's own check() refuses
     unit_cost_minor on ANY variation when the product has no vendor at
     all -- every product this codebase creates already has one (a real
     name, or the built-in "In-house" default assigned at creation), so
     this only ever bites a LEGACY product that predates that default.
     Fixed inline, the same "check, then immediately re-run with the
     resulting token" pattern resolveOrCreateCategory (above) already uses
     for a missing category -- never a silent skip, and never a clash over
     something this file can safely default on its own. */
  if (unitCostMinor !== undefined && !existing.vendor) {
    const vendorArgs = { handle: existing.handle, clear_vendor: true };
    const gate = await runTool("catalog.set_square_attributes", vendorArgs, { actor, role, env, rate });
    if (!gate?.needsApproval) {
      clashes.push(
        `"${existing.title}" (${existing.handle}) has no vendor yet and could not be defaulted to In-house: ${gate?.error || "could not be validated"} -- cost cannot be updated until it has one`,
      );
    } else {
      const result = await runTool("catalog.set_square_attributes", vendorArgs, {
        actor, role, env, rate, approvalToken: gate.data.approval.token,
      });
      if (result?.error || result?.denied) {
        clashes.push(
          `"${existing.title}" (${existing.handle}) has no vendor yet and could not be defaulted to In-house: ${result.error || result.denied} -- cost cannot be updated until it has one`,
        );
      }
    }
  }

  const variations = [];
  for (const { record, rowNumber, color, size } of groupRows) {
    const rawOptValues = Object.fromEntries(
      Object.entries({ ...(color ? { Color: color } : {}), ...(size ? { Size: size } : {}), ...optionValues(record) }).filter(
        ([, value]) => value.trim().toUpperCase() !== "TBD",
      ),
    );
    /* "All items... should have... associated sizes... if we don't
       specify a size, it's going to be OS" — the owner's own words; see
       draftGroupedProduct's own identical comment for the full reasoning.
       Tried FIRST here, since OS is the standard going forward — but a
       row naming no size at all still falls back to matching the raw,
       undefaulted shape too, so a genuinely legacy variant synced with no
       Size option at all (predating this default) still resubmits
       correctly instead of parking as a false "not an existing variation"
       clash the moment this shipped. */
    const optValues = rawOptValues.Size ? rawOptValues : { ...rawOptValues, Size: "OS" };
    const match =
      existingVariants.find((v) => sameOptions(optValues, stripTbdOptions(v.options))) ??
      (optValues.Size === "OS" && !rawOptValues.Size
        ? existingVariants.find((v) => sameOptions(rawOptValues, stripTbdOptions(v.options)))
        : undefined);
    const priceRaw = pick(record, PRICE_KEYS);
    const priceMinor = parsePriceToMinor(priceRaw);
    const currency = (pick(record, CURRENCY_KEYS) || match?.currency || "USD").toUpperCase();
    if (!match) {
      /* REVISED: "if there is additional options or additional sizes added
         to the same style ID, we're just adding more to the existing
         item... we're not rejecting them, we're adding to them" -- the
         owner's own words, after a real resubmit was refused for naming a
         size the product did not have yet. catalog.update_product's own
         variations schema now accepts option_values on an entry with no
         variant_id (its header comment has the full reasoning) -- the SAME
         shape catalog.create_product's own variations already use, so a
         genuinely new size/color is simply added alongside whatever this
         product already had, never silently dropped or forced into a
         manual, out-of-band step first. A brand-new variation still needs
         a real price, the same way one would at creation -- that is a
         clash, not a default, same as it always was for a MATCHED row's
         own price below. */
      if (priceMinor === null) {
        clashes.push(`row ${rowNumber}: "${Object.values(optValues).join(", ") || "(no size/color)"}" is new on "${existing.title}" (${existing.handle}) and needs a real price to be added -- "${priceRaw}" is not a plain number like 45.00`);
        continue;
      }
      /* "If you're not able to add quantities to a product, it's a fail
         mode and you cannot add that product and have to stop and ask for
         clarification" -- the owner's own words. A brand-new variation
         added here used to have no quantity mechanism at all (VARIATION_
         WITH_ID never had the field) and so always silently started at 0,
         with no tracking and no warning, regardless of what the sheet
         said -- the exact failure mode this whole resubmit system exists
         to prevent. Same tolerance as a fresh create's own quantity column
         (draftGroupedProduct's own identical comment): blank or
         unparseable defaults to 1, noted; only an EXPLICIT 0 is ever a
         clash (catalog.update_product's own matching refusal). */
      const newQuantityRaw = pick(record, QUANTITY_KEYS);
      let newQuantity = 1;
      if (newQuantityRaw) {
        const parsedNewQuantity = parseQuantity(newQuantityRaw);
        if (parsedNewQuantity === null) {
          notes.push(`row ${rowNumber}: quantity "${newQuantityRaw}" is not a plain whole number like 5 -- defaulted to 1`);
        } else {
          newQuantity = parsedNewQuantity;
        }
      }
      variations.push({
        title: [optValues.Color, optValues.Size].filter(Boolean).join(", ") || existing.title,
        price_minor: priceMinor,
        currency,
        option_values: optValues,
        quantity: newQuantity,
        ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
      });
      continue;
    }
    if (priceMinor === null) {
      clashes.push(`row ${rowNumber}: price "${priceRaw}" is not a plain number like 45.00`);
    }
    variations.push({
      variant_id: match.id,
      title: match.title,
      ...(priceMinor !== null ? { price_minor: priceMinor } : {}),
      currency,
      ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
    });

    /* "If there are discrepancies, I should upload the same file again, and
       you should be able to match all of the existing items, and the items
       that do not match with the spreadsheet should be updated... you should
       just be updating the number of units, because that's the only change"
       -- the owner's own words. A resubmit's own quantity cell is compared
       against this variant's CURRENT live stock (never catalog.update_product
       itself, same ledger guarantee this function's own header comment
       already states) -- a mismatch becomes its OWN separate
       inventory.adjust row, gated and approved exactly like any other T2
       stock movement, never folded into the catalog.update_product call
       above. A blank cell still means "no change," same as it always has:
       only a REAL number the sheet actually gives, that disagrees with what
       is on hand right now, is ever a reason to move stock. */
    const quantityRaw = pick(record, QUANTITY_KEYS);
    if (quantityRaw) {
      const parsedQuantity = parseQuantity(quantityRaw);
      if (parsedQuantity === null) {
        notes.push(`row ${rowNumber}: quantity "${quantityRaw}" is not a plain whole number like 5 -- stock left unchanged`);
      } else {
        explicitQuantities.push(parsedQuantity);
        if (env.COMMERCE) {
          try {
            const stockRow = match.sku
              ? await env.COMMERCE.prepare("SELECT on_hand FROM inventory_level WHERE sku = ?").bind(match.sku).first()
              : null;
            const current = Number(stockRow?.on_hand ?? 0);
            if (current !== parsedQuantity) {
              /* "If we have a product and we sold it and the quantity
                 decreased, and then I upload the original CSV file that
                 has the original quantities, we don't necessarily want to
                 update them because they may have been sold already... the
                 only products we want to be updating by default are the
                 ones that are wrong, like zero quantities. All the other
                 ones should show up but unchecked -- I should tell you
                 specifically I want to update these" -- the owner's own
                 words. A real sale between the sheet being made and this
                 resubmit is the ordinary case for ANY non-zero disagreement
                 -- the sheet's own number is no more likely to be right
                 than the live count is, so this is never auto-applied the
                 way a genuine 0 (always wrong, Test-PRD-P0-31's own
                 standing rule) still is. needsConfirmation/confirmReason
                 mirrors flagLikelyDuplicates' own possibleDuplicate/
                 duplicateReason shape exactly -- shown in the SAME
                 checklist, unchecked by default, a person opts in by
                 checking the box; the direct, no-checkbox /products/batch
                 upload (draftProductBatch, below) reclassifies this into a
                 clash instead, since there is no checkbox there to default
                 unchecked in the first place. */
              const needsConfirmation = current !== 0;
              quantityAdjustments.push({
                rowNumber: EXTRA_ROW_ID_OFFSET + rowNumber,
                displayRow: rowNumber,
                title: match.title && match.title !== existing.title ? `${existing.title} — ${match.title}` : existing.title,
                args: { variant_id: match.id, delta: parsedQuantity - current },
                toolName: "inventory.adjust",
                note: `resubmit corrected stock from ${current} to ${parsedQuantity}`,
                changes: `stock ${current} -> ${parsedQuantity}`,
                categoryId: existing.category_id ?? null,
                ...(needsConfirmation
                  ? {
                      needsConfirmation: true,
                      confirmReason: `on hand is already ${current}, not 0 -- this may already reflect real sales since the sheet was made; check the box only if you mean to overwrite it with ${parsedQuantity}`,
                    }
                  : {}),
              });
            }
          } catch (err) {
            console.error(`ERROR batch.js draftProductUpdate: could not read stock for sku ${match.sku} — ${err.message}`);
          }
        }
      }
    }
  }

  /* "If we give you a spreadsheet and it says there's zero units for all
     sizes, then don't add it, because there's something wrong with that...
     why would we even add something that has no units" -- the owner's own
     words, after a resubmit's own checklist reported "updating" while every
     size still read 0 on the sheet itself. Test-PRD-P0-31's own create-time
     guard already refuses this for a BRAND NEW product; a matched resubmit
     had no equivalent at all -- quantity reconciliation only ever ACTS on a
     real disagreement (the user's earlier, still-true words: "if everything
     was matching exactly, then you just skip it"), so a sheet whose every
     size already, consistently reads 0 was silently treated as "nothing to
     reconcile" rather than the data problem it actually is. Scoped to the
     WHOLE group, never a single row: one sold-out size among several in
     stock is ordinary day-to-day inventory, never a reason to block a
     legitimate update to every OTHER size on the same product -- only every
     size on the sheet reading 0 is the red flag. A row giving no quantity
     at all is simply not counted either way, same as it always means "no
     opinion" -- this only fires when the sheet actually commits to "zero,"
     everywhere it says anything. Parked as a clash like any other, not a
     silent drop: the row's own real price/cost/title changes still need a
     person's confirmation, exactly the same "complete, editable proposal"
     every other clash already is -- and no stock move is queued at all,
     never a silent reduction to zero on the strength of a sheet that may
     simply have lost its own quantity column. */
  const allZeroStock = explicitQuantities.length > 0 && explicitQuantities.every((q) => q === 0);
  if (allZeroStock) {
    clashes.push(
      `every size on this sheet reads 0 units for "${existing.title}" (${existing.handle}) -- that's not something we'd ever actually submit; confirm the real counts, then resubmit`,
    );
    quantityAdjustments.length = 0;
  }

  const title = titleCol || existing.title;

  /* "I just want you to resubmit the existing CSV and update the products
     to make them all in-house and update their costs" -- the owner's own
     words, after a whole group got blocked outright because NOT ONE of its
     rows named a size/color this product has on file (a legacy product
     with no real Size/Color structure at all is the common case, not a
     partial mismatch). Vendor and unit_cost_minor do not actually depend
     on any variation matching at all -- catalog.set_square_attributes
     applies both UNIFORMLY across whatever variations the product already
     has, whatever the sheet happens to call them -- so falling all the way
     back to a clash here throws away a real, safe update the owner
     explicitly asked this resubmit to make, over a size/color mismatch
     that update has nothing to do with. Only when EVERY row missed (never
     when SOME matched and some did not -- that stays a genuine clash a
     person should look at, since part of the sheet clearly expected
     variations that are not there) and only when the sheet actually gave a
     cost to apply (nothing to fall back to otherwise, and forcing vendor
     alone was never asked for). The specific new sizes/colors still need a
     person to add them by hand -- unchanged -- but that no longer blocks
     the vendor/cost update the rest of the sheet was clearly also asking
     for. */
  /* Only worth a row when it would actually change something: a cost every
     variation already carries, on a product that already has a vendor, is a
     no-op like any other -- falls through to the ordinary clash below
     instead, which still tells a person about the sizes that were not
     added. */
  const fallbackChanges =
    unitCostMinor === undefined
      ? []
      : [
          ...(!existing.vendor ? ["vendor none -> In-house"] : []),
          ...(existingVariants.some((ev) => ev.unit_cost_minor !== unitCostMinor)
            ? [`cost ${moneyText(existingVariants[0]?.unit_cost_minor)} -> ${moneyText(unitCostMinor)}`]
            : []),
        ];
  if (variations.length === 0 && clashes.length > 0 && unitCostMinor !== undefined && !allZeroStock && fallbackChanges.length > 0) {
    const newOnes = groupRows.map(({ record, color, size }) =>
      Object.values({ ...(color ? { Color: color } : {}), ...(size ? { Size: size } : {}), ...optionValues(record) }).join(", ") || "(no size/color)",
    );
    return {
      row: {
        rowNumber: firstRow,
        title,
        args: { handle: existing.handle, unit_cost_minor: unitCostMinor, ...(existing.vendor ? {} : { clear_vendor: true }) },
        toolName: "catalog.set_square_attributes",
        note: `new sizes/colors on this sheet (${newOnes.join(", ")}) were not added -- add them by hand, then resubmit to price them`,
        changes: fallbackChanges.join("; "),
        categoryId: existing.category_id ?? null,
      },
      extraRows: quantityAdjustments,
    };
  }

  const args = {
    handle: existing.handle,
    ...(titleCol ? { title: titleCol.slice(0, 200) } : {}),
    ...(titleCol && descriptionCol ? { description: descriptionCol } : {}),
    ...(variations.length ? { variations } : {}),
  };

  /* "Follow the spreadsheets exactly... they're assigned to the proper
     things" -- the owner's own words. An item already on file that the sheet
     files somewhere else is MOVED there (catalog.update_product re-numbers
     its style ID for the new category), so re-sending a sheet fixes items an
     earlier run filed under the wrong parent. Only when the sheet names a
     category; a sheet that says nothing about categories never moves one. */
  let sheetLeaf = null;
  if (ctx.sheetCategory !== undefined) {
    /* A sheet with no style number: its category was already resolved by
       name (draftNamedCategoryProduct). */
    sheetLeaf = ctx.sheetCategory;
  } else if (ctx.categories) {
    const sheetCategory = await resolveSheetCategory(env, ctx, base, first, { nameOnly: true });
    clashes.push(...sheetCategory.clashes);
    sheetLeaf = sheetCategory.category;
  }
  const categoryMove = sheetLeaf ? categoryMoveText(ctx.categories ?? (await listCategories(env.CATALOG_MIRROR)), existing.category_id, sheetLeaf.id) : null;
  if (categoryMove) args.category_id = sheetLeaf.id;

  if (clashes.length) {
    return { clash: { row: firstRow, title, args, reason: clashes.join("; "), toolName: "catalog.update_product" }, extraRows: quantityAdjustments };
  }

  /* "If you see nothing to update because all the values match existing,
     don't even show me these as an option... you're giving me all of these
     options that I have to uncheck manually" -- the owner's own words. A
     matched row used to ALWAYS produce its own catalog.update_product
     checklist entry, even one that would write back the exact same price,
     cost and title it already has -- a true no-op, but still one more item
     a person had to notice and either approve (for nothing) or uncheck. A
     brand-new variation (no variant_id at all) is never a no-op by
     definition; an existing one only skips when EVERY field this call
     would actually send (price, unit cost) matches what is already on
     file for it -- title/description are checked the same way, but only
     when the sheet gave a real column for either (titleCol gates both the
     same way args' own construction above already does). The quantity
     reconciliation this same row may have queued (extraRows) is entirely
     independent and still shows up on its own when it represents a real
     change -- this only ever suppresses the CATALOG edit itself. */
  const changes = catalogChangesFor({ existing, existingVariants, titleCol, descriptionCol, variations, categoryMove });

  if (changes.length === 0) {
    return { extraRows: quantityAdjustments };
  }

  return {
    row: {
      rowNumber: firstRow,
      title,
      args,
      toolName: "catalog.update_product",
      changes: changes.join("; "),
      categoryId: args.category_id ?? existing.category_id ?? null,
    },
    extraRows: quantityAdjustments,
  };
}

async function draftGroupedProduct(env, ctx, base, groupRows) {
  const { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, nextAutoTitle, rate, mode } = ctx;
  const first = groupRows[0].record;
  const firstRow = groupRows[0].rowNumber;

  /* REVISED: "I think if we have the system to do style IDs as our main
     differentiator, it should be like one operation... we're just updating
     information if what we're submitting is different than what we have" --
     the owner's own words, retiring the earlier add/update mode split
     (Test-PRD-P0-182-explicit_add_or_update_mode), itself retiring an even
     earlier design (Test-PRD-P0-179/180/181) where every row implicitly
     tried to match before falling back to create -- which is exactly where
     this lands again, deliberately: a style number ALWAYS tries to match an
     existing product first, regardless of which tool or button a caller
     used to get here. "If that all matches, then you just update" / "you
     should be able to determine which item is in there, and just find it
     and update it" -- the owner's own words. import_style_number is `base`
     itself, stamped once at creation (catalog.create_product's own run())
     and never touched again by anything -- a resubmit of the exact same
     sheet finds the SAME product this way even if its category (and so its
     live, fluid style_id) has moved on since. Checked before any category
     resolution at all: an update never resends category_id, so there is
     nothing here to resolve for this path.

     REVISED: "the most important match... our style ID... because that's
     how we want to identify items externally... there may be situations
     where we want to bulk update a bunch of items based on their style
     IDs" -- the owner's own words, once import_style_number turned out to
     be only HALF of what a real resubmit sheet uses: a person bulk-editing
     prices types the item's CURRENT, live style_id, which has already
     moved on from whatever import_style_number still holds if the item's
     own category was corrected since creation. Tried only when
     import_style_number itself finds nothing -- the two can never disagree
     about which product they name (mirror_style_id_ledger reserves a
     style_id forever once assigned, productByStyleId's own comment has the
     full reasoning), so there is nothing to reconcile, only a second door
     to the same room. No match at all is simply a new item now, the same
     "add" has always meant -- see the bottom of this function, past the
     category/title fallback, for the one place that used to turn a miss
     into a clash and no longer does. */
  const existingByStyle = (await productByImportStyleNumber(env.CATALOG_MIRROR, base)) ?? (await productByStyleId(env.CATALOG_MIRROR, base));
  if (existingByStyle) {
    return draftProductUpdate(env, existingByStyle, base, groupRows, ctx);
  }

  /* "Just follow the spreadsheets exactly... the spreadsheets have the right
     categories and everything, and they're assigned to the proper things" --
     the owner's own words. The sheet's Category and Subcategory NAMES decide
     where a row goes (resolveSheetCategory, above); the style number's own
     digits only stand in when the sheet gives no category name at all. */
  const categoryNameCol = pick(first, CATEGORY_KEYS);
  const subcategoryNameCol = pick(first, SUBCATEGORY_KEYS);
  const notes = [];
  const clashes = [];
  const resolved = await resolveSheetCategory(env, ctx, base, first);
  notes.push(...resolved.notes);
  clashes.push(...resolved.clashes);
  const category = resolved.category;

  /* The sheet's own style number is only ever a LOCAL grouping key now
     (splitProductRecords' own `base`, above) — never sent to Square as a
     literal value. style_id is a live reflection of a product's own
     category (Test-PRD-P0-177-fluid_style_id): `category_id` alone,
     already resolved above, is everything catalog.create_product's own
     resolveStyleId needs to mint the real one, sequence number and all —
     the sheet's own trailing index digit (`indexCode`, unused from here
     on) never picks that sequence number itself, "the index is just
     something that it generates on the fly using the next available
     slot" (resolveNamedCategory's own identical comment, above). */

  /* "You are getting the title of the items, the title, right? Not the
     descriptions. The descriptions will generate automatically later" —
     the owner's own words. TITLE_KEYS still wins when a sheet actually
     has one; DESCRIPTION_KEYS stands in for it ONLY when there is no
     title column at all — but a Description column consumed THAT way is
     never also sent as `description`, since it was never really a
     description to begin with, just the title's own stand-in. A sheet
     that gives BOTH a real title AND a separate description keeps
     sending both, unaffected — this only changes the "no title column"
     case. */
  const titleCol = pick(first, TITLE_KEYS);
  const descriptionCol = pick(first, DESCRIPTION_KEYS);
  const rawTitle = (titleCol || descriptionCol).slice(0, 200);
  const title = rawTitle || nextAutoTitle(category);
  const description = titleCol ? descriptionCol : "";

  /* FALLBACK MATCH: neither style-number lookup above (import_style_number,
     then the live style_id) found anything at all, but this row's own
     category and title might still recognize an existing product whose
     style number was deliberately RENUMBERED rather than merely moved --
     "our style ID numbers may be different, we may have changed them, but
     the categories and subcategories and names have not... if you find
     the same item with the same title that we are providing you, then
     that's a match, just update it," the owner's own words. Only even
     attempted with a REAL title (rawTitle, never the auto-generated
     placeholder just above, which could never legitimately match
     anything real) -- productsByCategoryAndTitle's/productsByTitle's own
     comments have the full "zero/one/many" reasoning.

     REVISED, a real production report the day after this shipped: "just
     tried to update products and it found no existing products" -- a
     sheet carrying only a bare numeric style-number code, no Category/
     Subcategory NAME columns, whose categories had since been renumbered
     (this shop's own recurring workflow). With nothing left for
     resolveCategoryByCode to match by number OR by name, `category`
     itself is null here -- exactly the case every earlier tier already
     assumed could not happen (a real category to scope the title search
     to). Scoped to that category when one resolved, same as always;
     catalog-WIDE, by title alone, when nothing resolved at all -- the
     last remaining signal a sheet like that has left.

     REVISED AGAIN, the very next report: "it's the same [expletive]
     spreadsheet I used to upload the items in the first place... you
     should be able to find them just by their category, subcategory, and
     name" -- the owner's own words, and a real, separate gap from the one
     just above: `category` here is NOT null, it resolved to something
     real, just the WRONG something. resolveCategoryByCode resolves a
     style number's own numeric code BY NUMBER FIRST, deliberately, "you
     don't have to think about the names... whatever we have configured,
     you assign to that category using its ID" (Test-PRD-P0-152's own
     category_and_subcategory_resolve_by_number test) -- exactly right for
     CREATING, where a sheet's category text is decoration and the number
     is what this shop actually configured. But a resubmit's own STALE
     number, after this shop's own recurring renumbering, can land on a
     DIFFERENT, unrelated category that happens to hold that number NOW --
     silently misfiling the whole row under the wrong parent, where a
     category-scoped title search can only ever find nothing, even though
     the row's own Category/Subcategory NAME columns never changed at all
     and still correctly name the real product's real home. Not a case
     resolveCategoryByCode itself should second-guess -- ADD mode's own
     test above depends on the number staying authoritative there, and
     changing that would relitigate a deliberate, owner-requested,
     already-shipped design. The fix belongs here instead, one level up:
     an update's own title search never stops at an empty, wrongly-scoped
     result -- it widens to the whole catalog by title alone before giving
     up, the exact same last resort already used when there was no
     category at all to scope by in the first place. Confident only on
     exactly one candidate either way, still an ambiguous, named-candidates
     clash on more than one, never a guess.

     DELIBERATELY STILL GATED, even after the rest of this function's own
     match attempt went unconditional: "make sure you're not just blindly
     matching for naming matches... the style ID is your source of truth"
     -- the owner's own words, the same session this very fallback's risk
     became obvious live. The PRIMARY match above (import_style_number,
     then live style_id) is always safe to run unconditionally -- it is
     never a guess, a style number either names a real product or it does
     not. This one is a genuine judgment call by NAME, built for a real,
     narrower case (a resubmit sheet that regenerates its own style number
     from category+subcategory+index on every export, so a category
     renumbering changes the NUMBER a real, unchanged product carries on
     its next resubmit, even though import_style_number/live style_id both
     correctly still point at nothing new). Running it unconditionally
     would also catch the opposite, genuinely dangerous case this same
     conversation raised: a BRAND NEW style number, never seen before, for
     a product that simply happens to share a title and category with an
     existing one -- two real, intentionally-different items silently
     merged into one by name alone. Left asking for the caller's own
     intent (mode) until there is a safe way to tell those two cases apart
     automatically, rather than guessing which one a oneoff removal of
     this gate would actually be. */
  if (mode === "update" && rawTitle) {
    let candidates = category ? await productsByCategoryAndTitle(env.CATALOG_MIRROR, category.id, rawTitle) : [];
    let scoped = candidates.length > 0;
    if (candidates.length === 0) {
      candidates = await productsByTitle(env.CATALOG_MIRROR, rawTitle);
      scoped = false;
    }
    if (candidates.length === 1) {
      return draftProductUpdate(env, candidates[0], base, groupRows, ctx);
    }
    if (candidates.length > 1) {
      /* "If you have any doubts, pop up a window... are these the correct
         items, should we update them... only if you have a question about
         it though, if you're confident, then just update" -- the owner's
         own words. More than one product shares this exact title (within
         the same category, or across the whole catalog when nothing
         resolved there or the resolved category itself came up empty) -- a
         real ambiguity this file has no safe way to pick between on its
         own, parked for a person the same way any other clash already is,
         naming every candidate so they have enough to decide from. */
      const scope = scoped ? `in "${category.name}"` : "anywhere in the catalog (no category match narrowed the search)";
      clashes.push(
        `style number "${base}": "${rawTitle}" ${scope} matches ${candidates.length} existing products ` +
          `(${candidates.map((c) => c.handle).join(", ")}) -- too ambiguous to update automatically; confirm which one, if any, this row means`,
      );
    }
  }

  /* REVISED: every match attempt above (import_style_number, live
     style_id, category+subcategory+title) has now run and found nothing --
     this used to turn into a forced clash under "update" mode ("expected
     to update an existing product, but nothing matches"), since that mode
     promised never to silently create. That promise no longer applies: a
     genuine miss now simply means this is a new item, the same thing it
     always meant for "add" -- falls straight through below to creating
     one, matching the owner's own words retiring the mode split ("we're
     just updating information if what we're submitting is different than
     what we have" -- implying creating it fresh is exactly right when
     nothing already exists to update). */

  /* Vendor/commission/unit cost/vendor code are PRODUCT-level facts (the
     tool's own schema has no per-variation home for any of them) — read
     once, from the group's own first row. This file's own data keeps them
     identical across every row in a group anyway (only price, quantity,
     SKU and the option values genuinely vary by size/color).
     REVISED: none of these block the row anymore either — a malformed or
     policy-incomplete value is simply left OUT of the write (noted, never
     lost) rather than refusing the whole product over optional business
     data catalog.create_product itself has never actually required
     (confirmed by its own check() — only a vendor genuinely missing a
     commission ON FILE is a real refusal, and that one is still relayed
     verbatim from the tool itself, exactly like any other tool refusal). */
  const vendor = pick(first, VENDOR_KEYS);
  const commissionRaw = pick(first, COMMISSION_KEYS);
  let commission;
  if (commissionRaw) {
    commission = parseCommission(commissionRaw);
    if (commission === null) {
      notes.push(`commission "${commissionRaw}" is not a plain whole number like 20 -- left unset`);
      commission = undefined;
    }
  }
  /* REVISED — see draftNamedCategoryProduct's own identical comment: a cost
     value no longer needs a vendor at all, now that catalog.create_product
     gives it a real, vendor-independent Square Custom Attribute to live in
     when there is none. */
  const unitCostRaw = pick(first, LEGACY_COST_FIELD_KEYS);
  let unitCostMinor;
  if (unitCostRaw) {
    unitCostMinor = parsePriceToMinor(unitCostRaw);
    if (unitCostMinor === null) {
      notes.push(`unit cost "${unitCostRaw}" is not a plain number like 45.00 -- left unset`);
      unitCostMinor = undefined;
    }
  }
  const vendorCode = pick(first, VENDOR_CODE_KEYS);
  if (vendorCode && !vendor) {
    notes.push(`vendor code "${vendorCode}" was given without a vendor -- left unset`);
  }

  /* One variation per row, in the sheet's own order. A bad price on any
     ONE row is a genuine clash -- Square has no way to sell an item for an
     amount nobody gave it, and this file has no safe number to guess, so
     the WHOLE group is parked for a person to fill it in via the same
     editable approval form every other clash uses; it still keeps
     building every other row's own real variation, so that form shows a
     complete, almost-right proposal rather than an empty one. A bad
     quantity, unlike a bad price, is not a clash at all -- it just
     defaults to 1 (noted), the same tolerance a blank quantity cell
     already gets. */
  const variations = [];
  for (const { record, rowNumber, color, size } of groupRows) {
    const priceRaw = pick(record, PRICE_KEYS);
    const priceMinor = parsePriceToMinor(priceRaw);
    if (priceMinor === null) {
      clashes.push(`row ${rowNumber}: price "${priceRaw}" is not a plain number like 45.00`);
    }
    const currency = (pick(record, CURRENCY_KEYS) || "USD").toUpperCase();
    const quantityRaw = pick(record, QUANTITY_KEYS);
    let quantity = 1;
    if (quantityRaw) {
      const parsedQuantity = parseQuantity(quantityRaw);
      if (parsedQuantity === null) {
        notes.push(`row ${rowNumber}: quantity "${quantityRaw}" is not a plain whole number like 5 -- defaulted to 1`);
      } else {
        quantity = parsedQuantity;
      }
    }
    /* "Our customers need to see one size or small, medium, large... they
       want to see black, white, the full names of the options" — the
       owner's own words. An explicit Size/Color column (the full,
       customer-facing name) always wins over the style number's own
       abbreviated trailing segment — the same "explicit wins, derived
       fills the gap" rule this file already follows elsewhere.
       "Any time you see TBD, just use like a default or no option...
       it's just one of a kind, it doesn't need an option" — a value of
       literally "TBD" (case-insensitive) is not a real option value at
       all, so it is dropped from option_values entirely rather than
       becoming a real "TBD" Color/Size in Square. */
    const optValues = Object.fromEntries(
      Object.entries({ ...(color ? { Color: color } : {}), ...(size ? { Size: size } : {}), ...optionValues(record) }).filter(
        ([, value]) => value.trim().toUpperCase() !== "TBD",
      ),
    );
    /* "All items... should have an option and associated sizes... if we
       don't specify a size, it's going to be OS" — the owner's own words,
       a blanket rule applied the same simple way to every row, no
       per-category configuration. "OS" was already a reserved value a
       person could type by hand, meaning "it fits all" (parseStyleNumber's
       own comment, above) — this is the other half, making it the real
       DEFAULT whenever no size was given at all (neither a style-number
       segment nor an explicit Size column), rather than something that
       has to be typed out for every single-size item. Never overrides a
       real size actually given, including a literal "TBD" just filtered
       out above — that is still "no real size," the same as none at all. */
    if (!optValues.Size) optValues.Size = "OS";
    const variationTitle = [optValues.Color, optValues.Size].filter(Boolean).join(", ") || title;
    /* "It should never be looking, expecting an SKU in our spreadsheets,
       because the SKU is something that is generated automatically" — the
       owner's own words, and REVISED FURTHER since (Test-PRD-P0-177-
       fluid_style_id): SKU is now a permanent, opaque, system-generated
       code with NO relationship to the sheet's own style number at all —
       not even the row's own trailing color/size suffix. No `sku` is ever
       sent; catalog.create_product's own generateSku mints one, the same
       as it does for every other product this shop creates. */
    variations.push({
      title: variationTitle,
      ...(priceMinor !== null ? { price_minor: priceMinor } : {}),
      currency,
      quantity,
      ...(Object.keys(optValues).length ? { option_values: optValues } : {}),
    });
  }

  /* REVISED — unit_cost_minor no longer needs a vendor to become a real
     argument (catalog-writer.js's own item-level fallback attribute); it is
     excluded from custom_fields whenever it parsed at all, vendor or not.
     Only a value that would not parse still preserves the raw text
     verbatim via extraFields below, so nothing is silently lost. */
  const knownKeys = unitCostMinor !== undefined ? [...PRODUCT_KNOWN_KEYS, ...LEGACY_COST_FIELD_KEYS, ...LEGACY_MARGIN_FIELD_KEYS] : [...PRODUCT_KNOWN_KEYS, ...LEGACY_MARGIN_FIELD_KEYS];
  const customFields = extraFields(first, knownKeys);
  if (notes.length) customFields["import notes"] = notes.join("; ").slice(0, CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX);

  const args = {
    title,
    ...(description ? { description } : {}),
    ...(category ? { category_id: category.id } : {}),
    ...(vendor ? { vendor } : {}),
    ...(vendorCode && vendor ? { vendor_code: vendorCode } : {}),
    ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
    ...(commission !== undefined ? { commission } : {}),
    variations,
    ...(Object.keys(customFields).length ? { custom_fields: customFields } : {}),
    /* Stamped once, here, at the only moment this product is ever created
       -- so a LATER resubmit of this same row (draftGroupedProduct's own
       productByImportStyleNumber lookup, above) finds it again by this,
       never by the live, fluid style_id (Test-PRD-P0-179-
       import_style_number_matching). */
    import_style_number: base,
  };

  /* A real clash parks the whole group for a person to review and fix,
     exactly the same check-then-a-person-decides gate every other T2
     write already uses -- never silently picked one way, never a bare
     skip either. */
  if (clashes.length) {
    return { clash: { row: firstRow, title, args, reason: clashes.join("; "), toolName: "catalog.create_product" } };
  }

  return { row: { rowNumber: firstRow, title, args, toolName: "catalog.create_product" } };
}

/**
 * Parse a CSV, mint one catalog.create_product approval per PRODUCT that
 * resolves cleanly, and report the rest with a plain reason. "It's not one
 * product, one line... I gave you variations" — the owner's own words.
 * Every row whose style number's own first three segments are all-digit
 * (STYLE_NUMBER_BASE) joins a GROUP keyed by that exact base; several rows
 * sharing one base become ONE catalog.create_product call with several
 * variations, one per row, in the sheet's own order (draftGroupedProducts,
 * below) — category/subcategory resolved by NUMBER (resolveCategoryByCode),
 * never by name. A row whose own style number is blank, or non-blank but
 * does NOT look like one at all (a totals line, a footnote), is dropped
 * outright — "if they don't have that style ID pattern, then just ignore
 * that," and, REVISED, the identical treatment for a blank cell too: "if
 * you don't have the qualifying, like the style ID, just don't include
 * that row at all... why would you show that to me?" — every real product
 * in this shop's own sheets already carries a style number; there is no
 * separate STANDALONE path any more for a row that does not.
 *
 * A row naming a category that does not exist yet gets it created
 * immediately, inline — via the same "check, then immediately re-run with
 * the resulting token" pattern the Admin panel's own
 * /admin/categories/create already uses; the row then proceeds to create its
 * own product in this SAME call (createRows, above) — no approval link, no
 * re-upload ever needed. Several rows naming the same missing category
 * only create it once.
 *
 * @param env   CATALOG_MIRROR, and whatever runTool's own resources need.
 * @param actor, role  the uploader's own verified Access identity.
 * @param onProgress  optional ({done, total, row, title, status}) => void, called
 *   once per row as createRows (below) actually creates it — "I don't like how
 *   the agent goes silent without any progress reports as it creates the new
 *   products," the owner's own words. This one call already runs the whole
 *   batch to completion before returning anything at all; this is the only
 *   hook agent.js has to relay what is happening while that is still in
 *   progress (dispatchBatchDraft's own recordBatchProgress).
 * @returns { created: [{row, title, handle, summary}], ready: [{row, title, url, summary}], skipped: [{row, title, reason}], tooMany?: number }
 */
/*
 * The category/subcategory resolution phase draftProductBatch and
 * planProductBatch (both below) share verbatim — parse into product-shaped
 * rows, creating whichever categories/subcategories the sheet names that do
 * not exist yet, and set aside anything that clashes before it ever reaches
 * catalog.create_product. Everything downstream (create everything in one
 * call, or plan a checklist to submit row by row) differs; this part does
 * not.
 */
async function resolveProductRows(env, { actor, role, mode }, records) {
  const categories = await listCategories(env.CATALOG_MIRROR);
  const nextAutoTitle = autoTitler(await categoryProductCounts(env.CATALOG_MIRROR));

  /* A real 16-row batch reported "some categories and subcategories did get
     created, but only like two items got added" — traced to every runTool
     call this whole function makes (category/subcategory resolution AND
     every row's own catalog.create_product) sharing the SAME per-Access-
     identity budget (rate.js's own default limiter) as that person's
     ordinary chat activity — sized for "an agent in a retry loop," never for
     one bounded, already human-confirmed pass over up to BATCH_MAX_ROWS
     rows. Category/subcategory resolution runs for every row FIRST, then
     every row's own create runs SECOND, so a shared budget merely close to
     exhausted already reliably starves the SECOND phase first — exactly
     "some categories, almost no products." A batch run cannot loop the way
     the shared cap defends against (at most two runTool calls per row,
     once, ever), so it gets its OWN limiter instead, fresh for this one
     call and sized for the real worst case (CAPS.BATCH_CALLS_PER_MINUTE's
     own header comment) rather than anti-abuse. Shared here rather than
     re-created per row: planProductBatch stashes this SAME instance
     alongside its own checklist, so every row's own later, separate submit
     request still spends from the one batch-wide budget, never a fresh one
     each time (see planProductBatch's own header comment for why that
     still matters even once submission itself is chunked). */
  const rate = createRateLimiter({ max: CAPS.BATCH_CALLS_PER_MINUTE });

  const rows = [];
  /* resolveOrCreateCategory's/resolveCategoryByCode's own shared,
     per-batch-run memory (dedup by lowercased, trimmed name — or by id,
     for a number-driven assignment/creation — keyed by parent too) and
     their own record of numeric_ids this SAME batch has already actually
     claimed — shared across every row below, and across BOTH resolution
     paths, so a name-resolved row and a number-resolved row in the same
     upload can never pick the same code for two different categories.
     TWO separate reserved sets, matching this shop's own two separate
     numeric_id pools (P0-138) — a top-level reservation must never block a
     subcategory from claiming the identical code, and vice versa. */
  const categoryCache = new Map();
  const reservedNumericIds = new Set();
  const reservedSubcategoryNumericIds = new Set();

  const { groups, groupOrder, namedRecords } = splitProductRecords(records);

  const clashes = [];

  for (const base of groupOrder) {
    const outcome = await draftGroupedProduct(env, { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, nextAutoTitle, rate, mode }, base, groups.get(base));
    /* The style ID the SHEET itself gave this group, kept on every row it
       produces (the catalog edit and any stock row alongside it) so the
       checklist and results can show it next to where the row lands. */
    for (const r of [outcome.row, ...(outcome.extraRows ?? [])]) if (r) r.sheetStyleId = base;
    if (outcome.clash) clashes.push(outcome.clash);
    else if (outcome.row) rows.push(outcome.row);
    if (outcome.extraRows?.length) rows.push(...outcome.extraRows);
  }

  for (const { record, rowNumber } of namedRecords) {
    const resolved = await resolveNamedCategory(
      env,
      { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, rate },
      record,
    );
    if (!resolved.category && !resolved.error) continue; /* neither name was even given -- nothing to build from */
    const outcome = await draftNamedCategoryProduct(env, resolved.category ?? null, resolved.error, nextAutoTitle, record, rowNumber, mode, { actor, role, rate });
    if (outcome.clash) clashes.push(outcome.clash);
    else if (outcome.row) rows.push(outcome.row);
    if (outcome.extraRows?.length) rows.push(...outcome.extraRows);
  }

  /* "I want to see style IDs that are being provided by the table... and I
     want to see our result category and subcategory that's actually being
     applied to... a way for me to confirm where the things are being
     updated" -- the owner's own words. A create lands in the category its
     args name; a matched update lands in the category the existing product
     already sits in (categoryId, set by draftProductUpdate). */
  for (const row of rows) {
    const labels = categoryLabels(categories, row.categoryId ?? row.args?.category_id);
    row.category = labels.category;
    row.subcategory = labels.subcategory;
    row.sheetStyleId ??= "";
    if (!row.changes) row.changes = row.toolName === "catalog.create_product" ? "new product" : "";
  }

  return { rows, clashes, rate };
}

export async function draftProductBatch(env, { text, actor, role, onProgress, mode }) {
  assertBatchMode(mode);
  const records = productRecords(text);
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { created: [], ready: [], skipped: [], tooMany: records.length };
  }
  const { rows: resolvedRows, clashes, rate } = await resolveProductRows(env, { actor, role, mode }, records);

  /* "They should show up but unchecked -- I should tell you specifically I
     want to update these" -- the owner's own words, about a quantity
     reconciliation row whose CURRENT stock is not a known-wrong 0 (a real
     sale since the sheet was made is the ordinary explanation, never less
     likely to be right than the sheet's own stale number). This direct,
     immediate-apply upload has no checkbox at all to default unchecked in
     the first place -- draftProductUpdate's own needsConfirmation flag is
     reclassified into an ordinary clash here instead, the same "a person
     has to open the link and say yes" gate every other low-confidence row
     already gets, rather than silently auto-applying a stock overwrite
     nothing here can actually confirm is correct. The checklist path
     (planProductBatch, below) needs no equivalent: it already has a real
     checkbox, left unchecked, for exactly this. */
  const rows = [];
  const needsConfirmationClashes = [];
  for (const row of resolvedRows) {
    if (row.needsConfirmation) {
      needsConfirmationClashes.push({ row: row.displayRow ?? row.rowNumber, title: row.title, args: row.args, reason: row.confirmReason, toolName: row.toolName });
    } else {
      rows.push(row);
    }
  }

  const { created: madeRows, parked: parkedFromDenials, skipped: refused } = await createRows(
    env,
    { actor, role, rate, onProgress },
    rows,
  );
  const { parked: parkedFromClashes, skipped: refusedClashes } = await parkClashRows(env, { actor, role }, [...clashes, ...needsConfirmationClashes]);

  return {
    created: madeRows,
    ready: [...parkedFromClashes, ...parkedFromDenials].sort((a, b) => a.row - b.row),
    skipped: [...refused, ...refusedClashes].sort((a, b) => a.row - b.row),
  };
}

/*
 * "Why does this need the 50 [subrequest] limit? Why don't you just make a
 * submission like a page preview and automatically uncheck things that were
 * already detected to skip them... and then have the agent check everything
 * and fill everything out and then just do a straight submit... with the
 * progress bar" — the owner's own words, and the actual fix, not a
 * workaround: draftProductBatch (above) creates every row inside ONE
 * Worker invocation, so its Square subrequest cost is the WHOLE batch's,
 * and Cloudflare's own per-invocation ceiling (50 on the Free plan) is
 * reachable well under BATCH_MAX_ROWS. planProductBatch instead does only
 * the part that has to happen once, together — resolving/creating whatever
 * categories and subcategories the sheet needs, bounded by how many
 * DISTINCT ones it names, never by row count — and stops there: every row
 * that would actually reach catalog.create_product is checked (its own
 * GATE call, which never writes — see catalog-write.js's own check()/run()
 * split) so a row that would just clash again anyway (most often a SKU
 * already used by an earlier, already-completed run of this SAME sheet —
 * "why would you resubmit the same thing twice?") gets its OWN approval
 * link immediately, exactly like a clash batch.js itself already found,
 * rather than sitting in the checklist offered back. What is left —
 * `rows` — is genuinely ready, and agent.js's own dispatchProductBatchPlan
 * stashes it, one row's own args at a time, for submitProductBatchRow
 * (below) to actually create ONE AT A TIME, each its own request, each its
 * own fresh Cloudflare invocation and subrequest budget, with a REAL
 * progress bar the browser can only build from a real response per row —
 * never a polled approximation of one big call still in flight.
 *
 * @returns { rows: [{rowNumber, title, args, summary, possibleDuplicate?, duplicateReason?}], ready: [...], skipped: [...], tooMany?: number }
 */
/* A plain, order-independent signature for one variation's own real shape.
   `includeQty` is false for a comparison against something already in the
   catalog -- an existing product's own on-hand count drifts from the
   moment it was first created (sold, restocked), so comparing it against
   history would either miss a real duplicate the instant one unit sold, or
   flag an unrelated coincidence; options/price do not drift that way and
   are the real signal there. True only for a WITHIN-THIS-SAME-UPLOAD
   comparison, where both rows come from the one fresh sheet and a matching
   quantity is still a meaningful part of "this is the same row twice."
   Never includes sku/title -- a row's own variation TITLE is already built
   FROM its options (variationTitle, draftGroupedProduct's own comment), so
   comparing options already covers "same variant name" too, without being
   thrown off by two different castings of the same title string. */
function variationSignature(v, { includeQty }) {
  const options = Object.entries(v.option_values ?? {})
    .map(([k, val]) => `${k.toLowerCase()}=${String(val).trim().toLowerCase()}`)
    .sort()
    .join("|");
  return includeQty ? `${options}#${v.price_minor ?? ""}#${v.quantity ?? ""}` : `${options}#${v.price_minor ?? ""}`;
}

function productVariationsSignature(variations, { includeQty }) {
  return (variations ?? [])
    .map((v) => variationSignature(v, { includeQty }))
    .sort()
    .join(",");
}

/*
 * "Maybe there are duplicate items... same quantity, same options, same
 * variant names, same cost and price, that's a flag... offer to skip it...
 * sometimes maybe somebody might enter the same value twice or re-upload
 * the same file" — the owner's own words. Two kinds of duplicate, checked
 * separately, scoped to rows that are actually about to CREATE something
 * (never a row already resolved to an update by a real style-ID match —
 * that is a confirmed identity, not a problem to flag):
 *
 * 1. WITHIN THIS SAME UPLOAD — two different rows (different style numbers,
 *    or two different named-category rows) that resolve to the exact same
 *    title, category, vendor, cost, and variation set (options/price/
 *    quantity, all three) are almost certainly a copy-paste mistake or an
 *    accidental re-paste of the same block, never two genuinely different
 *    products that happen to share a style-number convention.
 *
 * 2. AGAINST THE EXISTING CATALOG — the same product already exists (same
 *    title, category, vendor, cost, and variation options/price), most
 *    often from resubmitting a file with a style number that failed to
 *    match (missing, or genuinely never assigned one) when the product it
 *    describes already exists under a different one.
 *
 * REVISED: this used to be gated on the whole BATCH's own "add"/"update"
 * mode — correct back when mode was the only thing that decided whether a
 * row would even attempt to create anything at all, now that style-ID
 * matching always runs regardless of which tool a caller used
 * (Test-PRD-P0-182's own mode split retired). Scoped per ROW instead, by
 * each row's own resolved toolName: a row a real style-ID match already
 * turned into an update is never a candidate here, whatever the batch as a
 * whole was called; a row that is genuinely about to create something
 * always is, whatever it was called too.
 *
 * Never blocks anything on its own: `possibleDuplicate`/`duplicateReason`
 * ride along on the row, read by the checklist (views.js' own
 * checklistCard) to leave that one row UNCHECKED by default — a person
 * still decides, one checkbox at a time, the "offer to skip it" the owner
 * asked for, reusing the checklist's own existing checkbox rather than
 * inventing a second mechanism beside it.
 */
async function flagLikelyDuplicates(env, allRows) {
  const builtRows = allRows.filter((row) => row.toolName === "catalog.create_product");
  if (!builtRows.length) return;

  /* WITHIN-THIS-UPLOAD pass first -- pure in-memory comparison, no store
     access at all, so it costs nothing extra regardless of how many rows a
     sheet has. */
  const seenInBatch = new Map();
  const rowFacts = new Map();
  for (const row of builtRows) {
    const args = row.args;
    const title = (args.title ?? "").trim().toLowerCase();
    const key = `${args.category_id ?? ""}|${title}`;
    /* A blank vendor is never really "no vendor" once a product actually
       exists -- vendorRefOrInHouse (catalog-writer.js) assigns the real
       In-house vendor the moment it is created, so an incoming row with no
       Vendor column at all must compare as THAT, not as blank, or a sheet
       this shop's own plain style (no vendor column) could never match
       anything it already created. */
    const vendor = (args.vendor || INHOUSE_VENDOR_NAME).trim().toLowerCase();
    const unitCost = args.unit_cost_minor ?? null;
    const sigWithQty = productVariationsSignature(args.variations, { includeQty: true });
    const sigNoQty = productVariationsSignature(args.variations, { includeQty: false });
    rowFacts.set(row, { title, vendor, unitCost, sigNoQty });

    const priorInBatch = seenInBatch.get(key) ?? [];
    const batchMatch = priorInBatch.find((p) => p.sig === sigWithQty && p.vendor === vendor && p.unitCost === unitCost);
    if (batchMatch) {
      row.possibleDuplicate = true;
      row.duplicateReason = `same title, category, vendor, cost, options, quantity and price as row ${batchMatch.rowNumber} in this same upload`;
    }
    priorInBatch.push({ rowNumber: row.rowNumber, sig: sigWithQty, vendor, unitCost });
    seenInBatch.set(key, priorInBatch);
  }

  /* AGAINST-THE-EXISTING-CATALOG pass, for whatever rows the first pass
     left unflagged. "Why does this need the 50 subrequest limit?" --
     planProductBatch's own header comment, on the exact same class of
     failure a query PER ROW would reproduce here: a 78-product sheet must
     cost one query per DISTINCT category (or title, for a row with none),
     never one per row -- category resolution just above already follows
     this same bound, and a per-row duplicate check that didn't would undo
     the whole reason that redesign exists. */
  const remaining = builtRows.filter((row) => !row.possibleDuplicate);
  if (!remaining.length) return;

  const byCategory = new Map();
  const byTitleOnly = new Map();
  for (const row of remaining) {
    const args = row.args;
    if (args.category_id) {
      if (!byCategory.has(args.category_id)) byCategory.set(args.category_id, []);
      byCategory.get(args.category_id).push(row);
    } else {
      const title = rowFacts.get(row).title;
      if (!byTitleOnly.has(title)) byTitleOnly.set(title, []);
      byTitleOnly.get(title).push(row);
    }
  }

  const candidatesByCategory = new Map();
  for (const categoryId of byCategory.keys()) {
    candidatesByCategory.set(categoryId, await productsInCategory(env.CATALOG_MIRROR, categoryId));
  }
  const candidatesByTitleOnly = new Map();
  for (const title of byTitleOnly.keys()) {
    candidatesByTitleOnly.set(title, await productsByTitle(env.CATALOG_MIRROR, title));
  }

  const allCandidateIds = [
    ...new Set([
      ...[...candidatesByCategory.values()].flat().map((p) => p.id),
      ...[...candidatesByTitleOnly.values()].flat().map((p) => p.id),
    ]),
  ];
  const variantsByProductId = await variantsWithOptionsOfMany(env.CATALOG_MIRROR, allCandidateIds);

  for (const row of remaining) {
    const { title, vendor, unitCost, sigNoQty } = rowFacts.get(row);
    const candidates = row.args.category_id
      ? (candidatesByCategory.get(row.args.category_id) ?? []).filter((p) => (p.title ?? "").trim().toLowerCase() === title)
      : (candidatesByTitleOnly.get(title) ?? []);
    for (const existing of candidates) {
      if ((existing.vendor ?? "").trim().toLowerCase() !== vendor) continue;
      if ((existing.unit_cost_minor ?? null) !== unitCost) continue;
      const existingSig = productVariationsSignature(
        (variantsByProductId.get(existing.id) ?? []).map((v) => ({ option_values: v.options, price_minor: v.price_minor })),
        { includeQty: false },
      );
      if (existingSig === sigNoQty) {
        row.possibleDuplicate = true;
        row.duplicateReason = `an existing product, "${existing.title}" (${existing.handle}), already has the same title, category, vendor, cost, options and price`;
        break;
      }
    }
  }
}

export async function planProductBatch(env, { text, actor, role, mode }) {
  assertBatchMode(mode);
  const records = productRecords(text);
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { rows: [], ready: [], skipped: [], tooMany: records.length };
  }
  const { rows: built, clashes, rate } = await resolveProductRows(env, { actor, role, mode }, records);
  await flagLikelyDuplicates(env, built);

  const readyRows = [];
  const parkedFromGate = [];
  const skippedFromGate = [];
  for (const row of built) {
    const gate = await runTool(row.toolName, row.args, { actor, role, env, rate });
    if (gate?.needsApproval) {
      readyRows.push({ ...row, summary: row.note ? `${gate.data.would} -- ${row.note}` : gate.data.would });
      continue;
    }
    const reason = gate?.error || "could not be validated";
    const outcome = await parkOrSkip(env, { actor, role }, { row: row.rowNumber, title: row.title, args: row.args, reason, toolName: row.toolName });
    (outcome.bucket === "skipped" ? skippedFromGate : parkedFromGate).push(outcome.entry);
  }

  const { parked: parkedFromClashes, skipped: refusedClashes } = await parkClashRows(env, { actor, role }, clashes);

  return {
    rows: readyRows,
    ready: [...parkedFromClashes, ...parkedFromGate].sort((a, b) => a.row - b.row),
    skipped: [...skippedFromGate, ...refusedClashes].sort((a, b) => a.row - b.row),
    rate,
  };
}

/*
 * ONE row of a stashed planProductBatch plan, actually created — the unit
 * the browser's own submit loop calls once per checked row, sequentially.
 * `rate` is the SAME limiter instance planProductBatch minted for the
 * whole plan (agent.js carries it in the stashed record), not a fresh one
 * per row: a plan spends one batch-wide budget across every one of its own
 * later, separate requests, exactly as it would have inside one call.
 * Reuses createRows (above) wholesale, one-row slice and all, rather than
 * re-implementing the identical gate-then-execute-then-settle dance: a row
 * this late can still turn out to be a clash createRows' own settle()
 * already knows how to park (a SKU collision landed by another actor's
 * submit in the meantime, say) — this is never assumed safe just because
 * planProductBatch's own earlier gate call already liked it once.
 *
 * `editedTitle`, when given, replaces the row's own planned title before it
 * is ever sent — "the only thing the user might want to tweak is the
 * title," the owner's own words, reviewing the checklist this feeds. Both
 * the PRODUCT'S own `args.title` and this row's own bookkeeping `title`
 * (what the result table shows afterward) are replaced together, so the
 * two never disagree; a variation's own title (color/size, or the
 * product's original title as ITS OWN fallback — draftGroupedProduct's own
 * comment) is untouched, since a variation label was never what a person
 * meant by "the title." Whatever a person types still has to clear
 * catalog.create_product's own real checks (CATALOG_TITLE_MAX included) —
 * nothing here validates it twice.
 *
 * REVISED: only for a row whose own tool actually HAS a `title` field —
 * catalog.create_product and catalog.update_product, the only two this
 * whole mechanism was ever built for. The checklist's own title box is
 * always populated and always resent on submit (checklistCard(), views.js),
 * whether or not a person actually touched it, so `editedTitle` is
 * effectively always "present" from here on out: a real production bug this
 * exact gap caused once inventory.adjust (Test-PRD-P0-190-
 * quantity_reconciliation_on_resubmit) became the first OTHER row type a
 * resubmit could ever produce — its own schema is a closed { variant_id,
 * delta }, no `title` at all, so every one of its rows was unconditionally
 * refused ("unknown argument 'title'") and silently parked as "needs a
 * person" instead of actually moving stock, exactly the kind of row a
 * batch's own quantity reconciliation (and catalog.set_square_attributes's
 * own vendor/cost-only fallback, draftProductUpdate above, the SAME latent
 * exposure) was supposed to apply on its own.
 */
const TITLE_EDITABLE_TOOLS = new Set(["catalog.create_product", "catalog.update_product"]);

/* What a result row shows next to its status: the style ID the sheet gave,
   and the category/subcategory the row landed in. The planned values are the
   fallback (a parked or skipped row never landed anywhere, so showing where
   it WOULD have gone is the useful answer); a row that really wrote reads
   the product back, so what is shown is what is now on file, not what was
   hoped for. */
async function appliedPlacement(env, handle, planned) {
  const fallback = { styleId: "", category: planned.category ?? "", subcategory: planned.subcategory ?? "" };
  if (!handle) return fallback;
  try {
    const product = await productByHandle(env.CATALOG_MIRROR, handle);
    if (!product) return fallback;
    const labels = categoryLabels(await listCategories(env.CATALOG_MIRROR), product.category_id);
    return { styleId: product.style_id ?? "", category: labels.category, subcategory: labels.subcategory };
  } catch (err) {
    console.error(`ERROR batch.js: could not read back where "${handle}" landed -- ${err.message}`);
    return fallback;
  }
}

export async function submitProductBatchRow(env, { actor, role, rate }, row, editedTitle) {
  const target =
    editedTitle && TITLE_EDITABLE_TOOLS.has(row.toolName)
      ? { ...row, title: editedTitle, args: { ...row.args, title: editedTitle } }
      : row;
  const planned = { sheetStyleId: target.sheetStyleId ?? "", category: target.category ?? "", subcategory: target.subcategory ?? "" };

  /* "If there's nothing changed, why is this job even triggering?" -- the
     owner's own words. A plan can be older than the catalog it was made
     against (a first run already applied part of it, a person edited the
     item by hand, a sheet was resubmitted), so a catalog edit is compared
     against what is on file RIGHT NOW, with the very same function that
     decided it was worth showing, and skipped without any write when there
     is nothing left to change. */
  if (target.toolName === "catalog.update_product" && target.args?.handle) {
    const current = await productByHandle(env.CATALOG_MIRROR, target.args.handle);
    if (current) {
      const variants = await variantsWithOptionsOf(env.CATALOG_MIRROR, current.id);
      const changes = catalogChangesFor({
        existing: current,
        existingVariants: variants,
        titleCol: target.args.title,
        descriptionCol: target.args.description,
        variations: target.args.variations ?? [],
        categoryMove: target.args.category_id
          ? categoryMoveText(await listCategories(env.CATALOG_MIRROR), current.category_id, target.args.category_id)
          : null,
      });
      if (changes.length === 0) {
        const placement = await appliedPlacement(env, target.args.handle, planned);
        return {
          status: "unchanged",
          row: target.displayRow ?? target.rowNumber,
          title: target.title,
          reason: "already matches what is on file -- nothing to change",
          ...planned,
          ...placement,
        };
      }
    }
  }

  const { created, parked, skipped } = await createRows(env, { actor, role, rate }, [target]);
  if (created.length) {
    const placement = await appliedPlacement(env, created[0].handle, planned);
    return { status: created[0].action, ...created[0], ...planned, ...placement };
  }
  if (parked.length) return { status: "parked", ...parked[0], ...planned, styleId: "" };
  return { status: "skipped", ...skipped[0], ...planned, styleId: "" };
}

/* ── export ───────────────────────────────────────────────────────────── */

/* The exact header row this file's own PRICE_KEYS/QUANTITY_KEYS/etc. synonym
   lists already recognize as their FIRST, canonical entry — a round-trip
   through this export and straight back into /products/batch or either
   batch chat tool needs no column renamed, nothing re-typed by hand. */
const EXPORT_HEADERS = ["title", "category", "subcategory", "style id", "price", "cost", "quantity", "vendor", "vendor code", "commission"];

/*
 * "Any one of our employees that has the rights to add or see the
 * inventory should be able to pull the latest CSV or database into their
 * phone using an endpoint... as long as they're logged in, they have
 * access to it... that way there is never a disconnect. They're never
 * creating a brand new CSV file from scratch. There's always a structure
 * we have that's very specific, maintained through multiple agent
 * sessions" — the owner's own words. No new auth system at all: this is
 * reached through the SAME Cloudflare Access session and `manager`-role
 * gate every other catalog write already requires (index.js's own route),
 * never a separate token — "logged in" already means something real here.
 *
 * One row per VARIATION, not per product — the identical shape a real
 * upload sheet already has, so a person's own agent reading this back can
 * tell "same style, different size" apart without inventing a grouping
 * convention of its own. Three bulk reads, the same bounded, never-one-
 * per-row shape every other aggregate view on this page already uses
 * (listAllProducts itself, index.js's own /items route): products+
 * variants+vendor names, the full category tree (to split a leaf category
 * into its own top-level/subcategory pair), and the whole, small
 * inventory_level view for on-hand counts — never a query per product.
 */
export async function exportProductsCsv(env) {
  const products = await listAllProducts(env.CATALOG_MIRROR, { limit: CAPS.CATALOG_ITEMS_PAGE_MAX_ROWS });
  const categories = await listCategories(env.CATALOG_MIRROR);
  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const vendors = await listMirrorVendors(env.CATALOG_MIRROR);
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));

  /* import_style_number -- the PERMANENT identifier a resubmit matches by
     FIRST (never the live, fluid style_id, which can move with a later
     category change) -- is the one field listAllProducts itself does not
     already carry (it reads the live style_id instead, for the Items tab's
     own display). One extra bulk read, bounded by product count, the same
     as everything else here. */
  const styleNumbers = await env.CATALOG_MIRROR.prepare("SELECT id, import_style_number FROM mirror_product").bind().all();
  const importStyleNumberById = new Map((styleNumbers.results ?? []).map((r) => [r.id, r.import_style_number]));

  let stockBySku = new Map();
  if (env.COMMERCE) {
    try {
      const stock = await env.COMMERCE.prepare("SELECT sku, on_hand FROM inventory_level").bind().all();
      stockBySku = new Map((stock.results ?? []).map((r) => [r.sku, Number(r.on_hand)]));
    } catch (err) {
      /* Same tolerance /items already has for this exact read: a missing
         or failed stock lookup still exports every other column, rather
         than refusing the whole file over quantity alone. */
      console.error(`ERROR ops/products/export: could not read stock levels — ${err.message}`);
    }
  }

  const rows = [EXPORT_HEADERS];
  for (const p of products) {
    const leaf = p.category_id ? categoriesById.get(p.category_id) : null;
    const parent = leaf?.parent_id ? categoriesById.get(leaf.parent_id) : null;
    const category = parent ? parent.name : (leaf?.name ?? "");
    const subcategory = parent ? leaf.name : "";
    const importStyleNumber = importStyleNumberById.get(p.id) || "";

    for (const v of p.variations) {
      /* The exact inverse of parseStyleNumber (above): color before size,
         one dash each, and only when there is actually an import_style_
         number to hang a suffix off of at all -- a legacy or manually
         created product with none still exports every other column fine,
         just with no style number cell a resubmit could key off of
         (title+category+price alone already carries enough for the
         category+title fallback match, update mode's own last resort). */
      const suffix = [v.options?.Color, v.options?.Size].filter(Boolean).join("-");
      const styleId = importStyleNumber ? (suffix ? `${importStyleNumber}-${suffix}` : importStyleNumber) : "";
      const vendorName = v.vendor_id ? (vendorNameById.get(v.vendor_id) ?? "") : "";
      rows.push([
        p.title,
        category,
        subcategory,
        styleId,
        (v.price_minor / 100).toFixed(2),
        v.unit_cost_minor ? (v.unit_cost_minor / 100).toFixed(2) : "",
        String(v.sku ? (stockBySku.get(v.sku) ?? 0) : 0),
        vendorName,
        v.vendor_code || "",
        p.commission_pct != null ? String(p.commission_pct) : "",
      ]);
    }
  }
  return stringifyCsv(rows);
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
 * @param onProgress  optional ({done, total, row, title, status}) => void — see
 *   draftProductBatch's own identical parameter, above.
 * @returns { ready: [{row, title, url, summary}], skipped: [{row, title, reason}], tooMany?: number }
 */
export async function draftCustomerBatch(env, { text, actor, role, onProgress }) {
  const records = csvRecords(parseCsv(text));
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { ready: [], skipped: [], tooMany: records.length };
  }
  /* Same reasoning as draftProductBatch's own identical line — a batch run
     gets its own rate budget, fresh per call, rather than competing with
     this actor's ordinary chat activity for the shared, anti-abuse-sized
     default (CAPS.BATCH_CALLS_PER_MINUTE's own header comment). */
  const rate = createRateLimiter({ max: CAPS.BATCH_CALLS_PER_MINUTE });

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

  const { parked, skipped } = await parkRows(env, { actor, role, toolName: "customer.create", rate, onProgress }, rows);
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
 * data. I don't need to see three of them." Neither draftProductBatch nor
 * draftCustomerBatch is safe to call speculatively. REVISED: draftProductBatch
 * now creates real products the moment a row resolves cleanly (createRows) —
 * no approval link left to even click through or cancel any more, which
 * makes this preview step MORE important than it ever was, not less: a
 * wrong column match now means 400 real, wrong products in Square rather
 * than 400 links sitting unclicked. This reads the same columns the same
 * way (same key lists, same `pick`), on every row, and mints nothing: no
 * listCategories call, no runTool, no parkForApproval, no write of any kind.
 *
 * REVISED AGAIN — "my initial instructions was never followed... I always
 * wanted to be able to click on the chat preview and expand and see the
 * entire column, entire like a table... scroll up and down and just review
 * the entire contents to verify that everything is included." The 1-sample-
 * row cap above was about keeping the CHAT CARD's collapsed default small,
 * never about the DATA this function computes — those were the same number
 * only because nothing yet separated "how much to compute" from "how much
 * to show collapsed." They are separate now: every row is mapped (`sampleRows`
 * carries the WHOLE interpreted sheet), and the client's own "Full screen"
 * toggle (views.js's tableCard(), TABLE_CARD_CSS's own .table-card.full) is
 * what lets a person actually scroll it end to end — the small, collapsed
 * default view (`compact: true`, unchanged) is a CSS presentation choice
 * now, not a smaller dataset. `formatBatchPreview` (agent.js) still narrates
 * only the first one or two as plain text, for the same reason a markdown
 * table restating the same data is banned elsewhere (NO_TEXT_TABLE_NOTE) —
 * the structured table is the one source of truth for "everything," text is
 * only ever a quick orientation.
 *
 * REVISED YET AGAIN — "make sure that my preview table lists actual...
 * compressed style ID for each product, and its sizes listed and its
 * options listed. It should be collapsed. I don't want to see all the
 * variants... just to show that the agent has properly interpreted the
 * product list." One row per CSV line was never the same thing as one row
 * per PRODUCT — a style-numbered sheet's own several size/color rows are
 * one product with several variations (P0-152's own grouping rule), and a
 * preview built one raw CSV row at a time could never show that grouping
 * had actually happened, only repeat the same style_id/title N times in a
 * row. `previewBatch` now runs its product rows through the exact same
 * `splitProductRecords` grouping draftProductBatch itself uses, and
 * `mapProductGroup` (below) collapses each group into ONE row: its shared
 * style_id, title and category, plus every size and color the group's own
 * rows actually carry, aggregated rather than repeated — "how the agent
 * interpreted everything," at a glance, not the raw variant list a person
 * would have to reconstruct the grouping from by hand. A row-group of
 * exactly one variant previews identically to before this change.
 *
 * REVISED ONE MORE TIME — the first version of the collapsing above got two
 * things wrong, both caught by a real person actually reading the result:
 * "How can SKUs be not found? There should be a unique SKU generated for
 * all items... it should never be not found. That's a failure mode," and
 * "for quantities, if I see S/M/L, I should see quantity/quantity/quantity,
 * right?... why do I see one/two and then S/M/L? What does that mean?" Both
 * came from summarizing a group's own price/quantity by DISTINCT VALUE (a
 * `Set`), which silently drops below the variant count the moment two
 * variants agree on a value — the exact mismatch that read as nonsense next
 * to `size`'s own one-entry-per-variant list. And a group's own SKU was
 * treated as unknowable, when in fact every style-numbered row already
 * carries its own real SKU verbatim; collapsing several of them into one
 * preview row never made that information disappear. `size`/`color`/
 * `price`/`quantity`/`sku` are now all POSITIONAL lists (`positionalField`,
 * below) — one entry per row in the group's own order, always exactly
 * `variants` long, so column N of one always names the same variant as
 * column N of any other.
 *
 * REVISED YET ONE MORE TIME — there is no longer a STANDALONE row at all.
 * The owner's own words, having watched a real totals/notes line preview as
 * a near-empty "product": "Why are you including the totals with a bunch of
 * not found?... if you don't have the qualifying, like the style ID, just
 * don't include that row at all... why would you show that to me?" A row
 * with no style number used to preview (and draft) as its own one-variant
 * product, category/subcategory resolved by NAME — that whole path is gone
 * (`splitProductRecords`'s own header comment has the full reasoning);
 * `previewBatch` now only ever calls `mapProductGroup` for a real,
 * style-numbered group, so `sku`/`style_id` are always real values too, not
 * a placeholder for a row this preview could never actually resolve.
 *
 * @returns { headers: string[], rowCount: number, sampleRows: object[] }
 *   `rowCount` is the number of raw CSV data rows read; `sampleRows` has one
 *   entry per PRODUCT (products) or per CUSTOMER (customers) the sheet was
 *   interpreted as — the whole sheet, not a sample of it despite the name,
 *   kept for backward compatibility with every caller already reading it.
 */

/*
 * REVISED — a real user, actually reading this table, immediately flagged
 * two things as broken: "How can SKUs be not found? There should be a
 * unique SKU generated for all items... that's a failure mode." and "for
 * quantities, if I see S/M/L, I should see quantity/quantity/quantity...
 * otherwise, why do I see one/two and then S/M/L? What does that mean?"
 * Both came from the SAME mistake: summarizing a group's own per-variant
 * fields by DISTINCT VALUE (a `Set`) instead of by POSITION. Deduplicating
 * price/quantity broke the one-to-one correspondence with `size`/`color`
 * the moment two variants happened to agree on a value — three sizes but
 * only two distinct quantities reads as a mismatch, not a summary, to
 * anyone trying to line the two lists up by eye. And a lone group's own
 * SKU is not, in fact, unknowable the way a truly standalone row's
 * auto-generated one is — every STYLE-NUMBERED row already carries its own
 * real SKU verbatim (its own full style number cell), known at preview
 * time with no DB round trip needed at all; collapsing several of them
 * into one row never made that information disappear, it just had nowhere
 * to go in a single scalar field.
 *
 * `size`/`color`/`price`/`quantity`/`sku` are now all POSITIONAL lists, one
 * entry per row in `groupRows`' own order, every one of them exactly
 * `variants` long — column position N in one of these fields always
 * describes the SAME variant as column position N in any other. A field
 * with nothing to show for a given variant (no color axis on that specific
 * row, in a group where some other row has one) reads as "—", never a
 * silently shorter list.
 */
function positionalField(values) {
  if (!values.some((v) => v !== null)) return null;
  return values.map((v) => (v === null ? "—" : v)).join(" | ");
}

/* One collapsed row per PRODUCT — a style-numbered group of several
   size/color variations, or a lone name-matched row, previewed the
   identical way (one entry in `groupRows`). Extra columns are spread in
   AFTER the known ones, from the group's own FIRST row only (product-level
   facts, draftGroupedProduct's own comment on vendor/commission/unit cost
   applies here too) — "preserve all fields" means visible before
   confirming, not just kept silently in the background. */
/* `existing`, when given, is the product this group's own style number
   ALREADY matches (import_style_number, Test-PRD-P0-179-
   import_style_number_matching) — "you should be able to determine which
   item is in there, and just find it and update it," the owner's own
   words, shown here BEFORE the real batch runs so a person reviewing the
   preview sees "this will update X" rather than assuming every row mints a
   fresh product. sku/style_id stay "(unchanged)" rather than "(auto-
   generated)" for a match: neither one is touched by catalog.update_product
   at all.

   `showNoMatchNote`, only ever true in UPDATE mode (Test-PRD-P0-182-
   explicit_add_or_update_mode), flags a row `previewBatch` could not
   already confirm a match for from the style number alone -- the real
   draft ALSO tries category+subcategory+title (productsByCategoryAndTitle)
   before giving up, a real, resolving DB read this side-effect-free
   preview does not attempt (it never resolves a category against the real
   list at all, by design -- mapProductGroup's own header history). Never
   shown alongside `will_update`: a style-number match already answers the
   question. */
function mapProductGroup(groupRows, existing = null, showNoMatchNote = false) {
  const first = groupRows[0].record;
  const categoryName = pick(first, CATEGORY_KEYS);
  /* "Any time you see TBD, just use like a default or no option... it
     doesn't need an option" — the owner's own words. Filtered the same way
     draftGroupedProduct's own variation loop filters it, and merged the
     same way too (explicit Color/Size column wins over the style number's
     own trailing segment) — one entry per ROW, not deduplicated (see this
     function's own header comment for why). */
  const perRowOptions = groupRows.map(({ record, color, size }) =>
    Object.fromEntries(
      Object.entries({ ...(color ? { Color: color } : {}), ...(size ? { Size: size } : {}), ...optionValues(record) }).filter(
        ([, value]) => value.trim().toUpperCase() !== "TBD",
      ),
    ),
  );
  /* "It should assume title is description by default and not expect a
     description at all from these ingests" — the owner's own words,
     reported back after the chat agent saw this preview's own title come
     back null (no title column, only Description) and asked a person
     which column was meant to be the title instead of trusting the real
     ingest — draftGroupedProduct already resolves this exact case
     automatically (DESCRIPTION_KEYS stands in for a missing title, and is
     never ALSO sent as a separate description then); this preview just
     never mirrored that same rule, so it showed a
     misleadingly empty title for a row the real draft handles perfectly
     fine. Same fallback, same "never double-counted" rule, here too.
     Neither a title NOR a description column at all is still never a
     real blank title in the actual product either (nextAutoTitle names
     it "<category> N") — a DB round trip this side-effect-free preview
     cannot reproduce exactly, so it says so in words instead of showing a
     misleading blank "—". */
  const titleCol = pick(first, TITLE_KEYS);
  const descriptionCol = pick(first, DESCRIPTION_KEYS);
  const title = titleCol || descriptionCol || "(auto-generated from its category)";
  /* "It's being supplied. It's in the first column. Why is it being
     auto-generated?" -- the owner's own words. A row that carries a style
     number on the sheet must never be previewed as if it had none: the
     sheet's own ID is shown, and the note says what is true -- the shop's
     style_id is built from the category it lands in (the sheet's number is
     kept as the key a resubmit matches by). Only a row with no style number
     at all still reads "(auto-generated)". */
  const sheetStyleId = groupRows[0].styleIdRaw ? parseStyleNumber(groupRows[0].styleIdRaw).base : "";
  /* "It should never be looking, expecting an SKU in our spreadsheets,
     because the SKU is something that is generated automatically" — the
     owner's own words; no column is ever read as an explicit SKU (there is
     no SKU_KEYS), and REVISED FURTHER since (Test-PRD-P0-177-
     fluid_style_id): SKU is now a permanent, opaque, system-generated code
     with NO relationship to the sheet's own style number at all, so it is
     ALWAYS "(auto-generated)" here, whether or not the row carries a style
     number. style_id is the same story, one layer removed: it is a live
     reflection of whatever category the row resolves to, minted by
     catalog.create_product itself, never the sheet's own literal text — so
     it, too, always reads "(auto-generated)". The sheet's own style number
     (`base`) still matters for GROUPING rows into one product and for
     resolving which category/subcategory a row belongs to
     (draftGroupedProduct) — it is simply never shown as if it WERE the
     resulting sku/style_id, since neither one is a promise this preview
     can actually keep. */
  return {
    title,
    ...(existing ? { will_update: `${existing.title} (${existing.handle})` } : {}),
    ...(showNoMatchNote && !existing
      ? {
          /* "What you're showing me is very confusing. You should not do
             that" -- the owner's own words, about this exact note, worded
             the way it used to be: "no existing product found... yet",
             read as a negative result on every single row of a sheet this
             preview simply has not fully checked. Reworded to lead with
             what actually happens next, never with an absence that sounds
             like a verdict -- this preview only ever tried the style
             number; category/subcategory/title (this feature's own strongest
             signal once a style number has drifted) is still to come, for
             real, the moment this gets submitted. */
          update_note: "match check pending -- category/subcategory/title will be checked when this is submitted",
        }
      : {}),
    category: categoryName || null,
    subcategory: pick(first, SUBCATEGORY_KEYS) || null,
    price: positionalField(groupRows.map(({ record }) => pick(record, PRICE_KEYS) || null)),
    currency: (pick(first, CURRENCY_KEYS) || "USD").toUpperCase(),
    description: titleCol ? descriptionCol || null : null,
    sku: existing ? "(unchanged)" : "(auto-generated)",
    style_id: existing ? "(unchanged)" : sheetStyleId ? `${sheetStyleId} (from the sheet; the shop ID follows its category)` : "(auto-generated)",
    variants: groupRows.length,
    /* "Shouldn't you be doing an in-house instead of a dash? Since if a
       vendor is not provided, then it must be in-house" -- the owner's own
       words, and correct: a blank vendor cell is never really blank once
       catalog.create_product actually runs (vendorRefOrInHouse resolves no
       name at all straight to the built-in "In-house" vendor), so a bare
       "—" here understated the real outcome the exact same way a blank SKU
       column once did, before SKU/style_id got their own "(auto-generated)"
       treatment above. But that default is a CREATE-time rule only --
       draftProductUpdate's own header comment is explicit that vendor/
       vendor_code/commission are "deliberately never touched" by an
       update, matched or not (a vendor reassignment is its own separate,
       deliberate action, catalog.set_square_attributes, never a side
       effect of a spreadsheet). So a blank cell means two different real
       things depending on mode, and this preview now says the one that is
       actually true for the row it is showing, instead of the one flat
       dash that used to stand in for both. */
    vendor: showNoMatchNote ? pick(first, VENDOR_KEYS) || "(unchanged)" : pick(first, VENDOR_KEYS) || "In-house",
    vendor_code: showNoMatchNote ? pick(first, VENDOR_CODE_KEYS) || "(unchanged)" : pick(first, VENDOR_CODE_KEYS) || null,
    commission: showNoMatchNote ? pick(first, COMMISSION_KEYS) || "(unchanged)" : pick(first, COMMISSION_KEYS) || null,
    /* Unlike price, a blank quantity cell has a real, known answer already
       ("when quantity not specified use 1") -- never a placeholder. */
    quantity: groupRows.map(({ record }) => pick(record, QUANTITY_KEYS) || "1").join(" | "),
    ...Object.fromEntries(
      Object.keys(OPTION_KEYS).map((name) => [name.toLowerCase(), positionalField(perRowOptions.map((o) => o[name] ?? null))]),
    ),
    ...extraFields(first, PRODUCT_KNOWN_KEYS),
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

export async function previewBatch(env, text, kind, mode) {
  if (kind !== "customers") assertBatchMode(mode);
  const records = kind === "customers" ? csvRecords(parseCsv(text)) : productRecords(text);
  if (!records.length) return { headers: [], rowCount: 0, sampleRows: [] };

  const headers = Object.keys(records[0]);
  let mapped;
  if (kind === "customers") {
    mapped = records.map(mapCustomerRow);
  } else {
    const { groups, groupOrder, namedRecords } = splitProductRecords(records);
    /* REVISED — a named row (no style number, but naming a category and
       subcategory) is never dropped from the preview any more, matched or
       not: the real ingest itself no longer drops one either, it creates
       the missing category/subcategory on the fly (resolveNamedCategory,
       above) — "how the agent interpreted everything" (P0-89's own
       standing goal) would understate what actually happens if this preview
       kept silently omitting the ones with no existing match yet. Category
       resolution/creation itself stays a real DB write, so it is never
       attempted here — previewBatch stays the exact same side-effect-free,
       DB-free function it has always been; it shows the row exactly as
       given (mapProductGroup already reads the category/subcategory names
       straight off the sheet, the same as it always has for a style-numbered
       group), leaving what the real create/conform will resolve to for the
       real draft to actually do.

       REVISED (Test-PRD-P0-182-explicit_add_or_update_mode): match lookups
       (`will_update`/`update_note`) only ever run in UPDATE mode -- "add
       new products will not try to match... it will only identify
       clashes," the owner's own words, so an add-mode preview must never
       suggest a row will update something; it never even queries. Only
       the style-number tiers (import_style_number, live style_id) are
       tried here, both a plain read keyed on `base` alone -- the
       category+subcategory+title fallback needs a REAL category
       resolution against the live list, which stays out of scope for this
       side-effect-free preview (mapProductGroup's own comment); a row
       neither style-number tier confirms gets `update_note` instead of a
       flat "will create", since the real draft still has one more thing
       left to try. */
    const namedRows = namedRecords.map(({ record, rowNumber }) =>
      mapProductGroup([{ record, rowNumber, color: undefined, size: undefined }], null, mode === "update"),
    );
    mapped =
      mode === "update"
        ? [
            ...(await Promise.all(
              groupOrder.map(async (base) => {
                const existing =
                  (await productByImportStyleNumber(env.CATALOG_MIRROR, base)) ?? (await productByStyleId(env.CATALOG_MIRROR, base));
                return mapProductGroup(groups.get(base), existing, true);
              }),
            )),
            ...namedRows,
          ]
        : [...groupOrder.map((base) => mapProductGroup(groups.get(base))), ...namedRows];
  }

  /* mapProductGroup's extra (custom) fields are per-group: a sheet's own
     extra columns are normally consistent, but one group missing a value
     nobody else left blank must not shift what column N means in the
     table. Every mapped row gets the SAME keys, in the SAME order, so
     previewTable()'s columns (this file's own first row's keys) describe
     every row correctly — a key a later row lacks reads as a plain "—",
     the same as a known field that was left blank, not a raw "undefined". */
  const allKeys = [...new Set(mapped.flatMap((row) => Object.keys(row)))];
  const sampleRows = mapped.map((row) => Object.fromEntries(allKeys.map((k) => [k, k in row ? row[k] : null])));

  return { headers, rowCount: records.length, sampleRows };
}
