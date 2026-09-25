/*
 * "Add products/customers from a spreadsheet" — one CSV row in, one real
 * write out.
 *
 * DELIBERATELY NOT A NEW WRITE PATH, for either kind. Every row this writes
 * goes through the exact same tool a chat agent's own draft would —
 * catalog.create_product for merchandise, customer.create for customers —
 * so the closed category set, the price caps, "Square needs at least one of
 * these fields": none of that is re-checked here, because re-checking it
 * here is how the two checks eventually disagree. A row this cannot even
 * attempt (an unparsable price, a category that matches nothing) is
 * reported before runTool ever sees it, because runTool has no way to say
 * "not a number" — everything else is left to the tool's own check(), and its
 * refusal text becomes the row's skip reason verbatim.
 *
 * A PRODUCT row is created IMMEDIATELY (createRows) rather than parked as a
 * separate T2 approval for someone to click later — "you have all the
 * information to create all of them, so just make them. I don't want to sit
 * here and approve them" — the owner's own words. Uploading the spreadsheet
 * already IS the deliberate action; createRows' own header comment has the
 * full reasoning. A CUSTOMER row still parks the ordinary way (parkRows) —
 * this was only ever asked for merchandise, and a customer record has no
 * "major clash" of the kind this file already resolves inline (no category,
 * no numbering, nothing to recommend a fix for).
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
 * A row that fails EITHER call (a genuine business-rule refusal — a bad
 * category, a price outside the caps, whatever check()/run() itself
 * refuses) is reported as a skip with that real reason, precisely how a
 * refused row already was under parkRows — "if there is a major clash
 * that prevents [a row] from being ingested, it should stop and explain
 * what needs to be fixed" is exactly this skip reason, not a blocked
 * upload: every OTHER row still goes through.
 */
async function createRows(env, { actor, role, toolName }, rows) {
  const created = [];
  const skipped = [];
  for (const { rowNumber, title, args } of rows) {
    const gate = await runTool(toolName, args, { actor, role, env });
    if (!gate?.needsApproval) {
      skipped.push({ row: rowNumber, title, reason: gate?.error || "could not be validated" });
      continue;
    }
    const result = await runTool(toolName, args, { actor, role, env, approvalToken: gate.data.approval.token });
    if (result?.error || result?.denied) {
      skipped.push({ row: rowNumber, title, reason: result.error || result.denied || "was refused" });
      continue;
    }
    created.push({ row: rowNumber, title, handle: result.data?.product?.handle, summary: gate.data.would });
  }
  return { created, skipped };
}

/* ── merchandise ──────────────────────────────────────────────────────── */

/* Bare "style" USED to be a title synonym too, on the theory that some shops
   call a garment's own descriptive name its "style" ("style name" still is,
   below). REVISED, hitting a real sheet: "Style #" and "Style" alike
   normalize (normalizeKey, above) to the same bare "style" this list used to
   claim for title — so a column of style NUMBERS ("001-001") was landing as
   the product's own TITLE, and a real style_id column right next to it went
   unrecognized. "You are mistaking style id with title" — the owner's own
   words. Removed here; STYLE_ID_KEYS (below) claims "style" instead, the same
   division SKU_KEYS' own comment already draws for "style number". */
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
const SKU_KEYS = ["sku", "style number", "item number", "product code"];
/* style_id, vendor and commission are Square's own Custom Attributes now
   (Test-PRD-P0-136-square_custom_attributes), not a custom_fields example —
   recognized here so a sheet carrying them reaches catalog.create_product as
   real arguments rather than inert text. style_id itself is no longer
   required at all, REVISED: "category and subcategory is style id and vice
   versa" — the owner's own words. A row giving one keeps it verbatim,
   subject to catalog.create_product's own format/conflict checks (a
   conflict auto-bumps now, never a refusal); a row giving NONE at all
   still resolves a category from it when it CAN (a style ID whose digits
   match a real category/subcategory, the same lookup an edit already
   uses), and either way create_product's own resolveStyleId builds a
   style_id automatically from whatever category the row lands on, when
   that category has a numeric_id of its own — see this file's own
   draftProductBatch for the actual resolution order. Separately, a vendor
   NAME with no commission on file yet (mirror_vendor.commission_pct —
   brand new to this shop, or a vendor Square already knew about that was
   never given a rate) needs one given in the same row. REVISED: "let's not
   force vendor's commission to be
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
/* Bare "style"/"style #" claimed here, not by SKU_KEYS' own "style number" —
   see TITLE_KEYS' own comment above for the real sheet that hit this
   collision. "style #", "style#" and "style" itself all normalize to the
   same "style" key.
   REVISED: this same cell may now carry the FULL style number — style_id
   plus a color and/or a size riding along after it, one dash each
   (parseStyleNumber, above) — not just the bare NN-NN-NNN this shop's own
   style_id nomenclature is on its own. */
const STYLE_ID_KEYS = ["style id", "style_id", "style #", "style"];
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
const UNIT_COST_KEYS = ["unit cost", "cost", "cost (usd)", "cost usd", "cogs", "cost of goods", "wholesale cost"];
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
  ...SKU_KEYS, ...STYLE_ID_KEYS, ...VENDOR_KEYS, ...VENDOR_CODE_KEYS, ...COMMISSION_KEYS, ...QUANTITY_KEYS,
  ...Object.values(OPTION_KEYS).flat(),
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
  const segments = trimmed.split("-");
  if (segments.length === 4) return { base: segments.slice(0, 3).join("-"), color: undefined, size: segments[3] };
  if (segments.length === 5) return { base: segments.slice(0, 3).join("-"), color: segments[3], size: segments[4] };
  return { base: trimmed, color: undefined, size: undefined };
}

/** Case- and whitespace-insensitive; the closed set's real names, never guessed. */
function matchCategory(name, categories) {
  const key = name.trim().toLowerCase();
  return categories.find((c) => c.name.trim().toLowerCase() === key) ?? null;
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
   and "Casual" under "Knitwear" must never share one cache entry). */
async function resolveOrCreateCategory(env, { actor, role, categories, reserved, cache, parentId = null }, name) {
  const key = `${parentId ?? ""}::${name.trim().toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  const numericId = parentId ? nextSubcategoryNumericId(categories, reserved) : nextTopLevelNumericId(categories, reserved);
  if (numericId) reserved.add(numericId);
  const args = {
    name: name.trim(),
    reason: "auto-created while importing a spreadsheet",
    ...(parentId ? { parent_id: parentId } : {}),
    ...(numericId ? { numeric_id: numericId } : {}),
  };
  const gate = await runTool("catalog.create_category", args, { actor, role, env });
  if (!gate?.needsApproval) {
    const outcome = { error: gate?.error || "could not be validated" };
    cache.set(key, outcome);
    return outcome;
  }
  const result = await runTool("catalog.create_category", args, {
    actor, role, env, approvalToken: gate.data.approval.token,
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
 *   2. No numeric match, but an EXISTING one already carries `name`
 *      VERBATIM — the same real category, simply never numbered yet.
 *      Given this exact number NOW (catalog.set_category_number) rather
 *      than creating a confusing near-duplicate beside it — one existing
 *      category already correctly matches, "Outerwear" style, from before
 *      this sheet's own numbering convention existed at all. Already
 *      carrying a DIFFERENT real number is a genuine mismatch, reported
 *      rather than silently reassigned.
 *   3. Neither matches anything — a brand-new category, named from `name`
 *      and given `code`, normalized to this shop's own two-digit
 *      convention, as its numeric_id. With no `name` either, returns
 *      `{ category: null }` instead — a SOFT outcome, not an error (its
 *      caller decides whether that is fatal).
 *
 * `reserved` and `cache` are the SAME per-batch-run bookkeeping
 * resolveOrCreateCategory's own already keeps, shared with it (both
 * ultimately claim numeric_id out of the identical top-level pool), so an
 * ID-resolved row and a name-resolved one in the same upload can never pick
 * the same code for two different categories.
 */
async function resolveCategoryByCode(env, { actor, role, categories, reserved, cache }, code, name) {
  const numeric = Number(code);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 99) {
    return { error: `"${code}" is not a plain 0-99 number this shop's own numbering can use` };
  }
  const padded = String(numeric).padStart(2, "0");
  const pool = categories.filter((c) => !c.parent_id);

  const byNumber = pool.find((c) => c.numeric_id != null && c.numeric_id !== "" && Number(c.numeric_id) === numeric);
  if (byNumber) return { category: byNumber };

  const byName = name ? pool.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()) : null;
  if (byName) {
    if (byName.numeric_id != null && byName.numeric_id !== "") {
      return {
        error: `"${name}" already exists numbered "${byName.numeric_id}", not "${code}" as this row's own style number says — check for a mismatch`,
      };
    }
    const key = `assign::${byName.id}`;
    if (cache.has(key)) return cache.get(key);
    if (reserved.has(padded)) {
      const outcome = { error: `numeric_id "${padded}" was already claimed earlier in this same upload` };
      cache.set(key, outcome);
      return outcome;
    }
    const gate = await runTool("catalog.set_category_number", { category_id: byName.id, numeric_id: padded }, { actor, role, env });
    if (!gate?.needsApproval) {
      const outcome = { error: gate?.error || "could not be numbered" };
      cache.set(key, outcome);
      return outcome;
    }
    const result = await runTool("catalog.set_category_number", { category_id: byName.id, numeric_id: padded }, {
      actor, role, env, approvalToken: gate.data.approval.token,
    });
    if (result?.error || result?.denied) {
      const outcome = { error: result.error || result.denied || "could not be numbered" };
      cache.set(key, outcome);
      return outcome;
    }
    reserved.add(padded);
    byName.numeric_id = padded;
    const outcome = { category: byName };
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
  const gate = await runTool("catalog.create_category", args, { actor, role, env });
  if (!gate?.needsApproval) {
    const outcome = { error: gate?.error || "could not be validated" };
    cache.set(key, outcome);
    return outcome;
  }
  const result = await runTool("catalog.create_category", args, { actor, role, env, approvalToken: gate.data.approval.token });
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
 * with this shop's tree-wide-unique subcategory pool). A failure at ANY
 * step — category, subcategory, or any ONE row's own price/quantity —
 * skips the WHOLE group with that one clear reason, rather than creating a
 * product missing a size. No title column exists on a sheet like this, so
 * the first row's own Description stands in for it — "Black hand-painted
 * blazer" reads exactly like a product name already.
 *
 * @returns { skip: {row, title, reason} } | { row: {rowNumber, title, args} }
 */
async function draftGroupedProduct(env, ctx, base, groupRows) {
  const { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, nextAutoTitle } = ctx;
  const first = groupRows[0].record;
  const firstRow = groupRows[0].rowNumber;
  const [catCode, subCode, indexCode] = base.split("-");
  const categoryNameCol = pick(first, CATEGORY_KEYS);
  const subcategoryNameCol = pick(first, SUBCATEGORY_KEYS);
  const fallbackTitle = pick(first, TITLE_KEYS) || pick(first, DESCRIPTION_KEYS) || "(no title)";

  const catOutcome = await resolveCategoryByCode(
    env,
    { actor, role, categories, reserved: reservedNumericIds, cache: categoryCache },
    catCode,
    categoryNameCol,
  );
  if (catOutcome.error) {
    return { skip: { row: firstRow, title: fallbackTitle, reason: `category ${catCode}: ${catOutcome.error}` } };
  }
  /* The category itself has nothing left to fall back to (there is no
     "parent" above it) -- a SOFT null here (resolveCategoryByCode's own
     "nothing matched, no name to create from" case) is fatal at this
     level, unlike at the subcategory level just below. */
  if (!catOutcome.category) {
    return { skip: { row: firstRow, title: fallbackTitle, reason: `category ${catCode}: no existing category has this number, and no Category name column was given to create one from` } };
  }
  const topCategory = catOutcome.category;

  /* SUBCATEGORY: two different rules, picked by whether a Subcategory
     NAME column exists at all.
     WITH a name column (the owner's own actual sample sheet) — resolves
     by NAME, NOT by number, REVISED against that real file: this shop's
     own subcategory numeric_id pool is TREE-WIDE unique (P0-138's own
     two-pool rule, a real database constraint), but a real sheet's own
     middle segment restarts at 1 for every new top-level category
     ("Blazer" under Jacket and "Dress Pants" under Pants both landed on
     "001") — the two conventions are genuinely incompatible, not a
     matter of preference. Matched (or created) by name under the
     category actually resolved above, the same mechanism P0-146's own
     Subcategory column already uses, auto-assigning THIS shop's own
     real, tree-wide-unique numeric_id (nextSubcategoryNumericId) rather
     than the sheet's own locally-scoped one.
     WITH NO name column (a bare style_id, from before that column
     existed) — resolves by NUMBER instead, tree-wide, MATCH ONLY, never
     creating: the exact deriveCategoryIdForStyleId lookup this shop's
     style_id nomenclature has always used for a style_id with nothing
     else to go on. This never risks the same cross-category collision a
     name-less CREATE would, since nothing here ever assigns a new
     number from a per-parent-scoped digit; a number that matches nothing
     yet simply leaves this row at the top-level category, its own raw
     digit still riding into the constructed style_id verbatim (padded)
     — the same "no automatic skip either way" tolerance a bare style_id
     has always gotten. */
  let category = topCategory;
  let subCodeNormalized = String(Number(subCode)).padStart(2, "0");
  if (subcategoryNameCol) {
    let subcategory = matchCategory(subcategoryNameCol, categories.filter((c) => c.parent_id === topCategory.id));
    if (!subcategory) {
      const outcome = await resolveOrCreateCategory(
        env,
        { actor, role, categories, reserved: reservedSubcategoryNumericIds, cache: categoryCache, parentId: topCategory.id },
        subcategoryNameCol,
      );
      if (outcome.error) {
        return {
          skip: {
            row: firstRow,
            title: fallbackTitle,
            reason: `subcategory "${subcategoryNameCol}" does not exist yet under "${topCategory.name}" and could not be created: ${outcome.error}`,
          },
        };
      }
      subcategory = outcome.category;
    }
    category = subcategory;
    subCodeNormalized = subcategory.numeric_id;
  } else {
    const subNumeric = Number(subCode);
    const match = categories.find(
      (c) => c.parent_id && c.numeric_id != null && c.numeric_id !== "" && Number(c.numeric_id) === subNumeric,
    );
    if (match) {
      category = match;
      subCodeNormalized = match.numeric_id;
    }
  }

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

  /* Vendor/commission/unit cost/vendor code are PRODUCT-level facts (the
     tool's own schema has no per-variation home for any of them) — read
     once, from the group's own first row. This file's own data keeps them
     identical across every row in a group anyway (only price, quantity,
     SKU and the option values genuinely vary by size/color). */
  const vendor = pick(first, VENDOR_KEYS);
  const commissionRaw = pick(first, COMMISSION_KEYS);
  let commission;
  if (commissionRaw) {
    commission = parseCommission(commissionRaw);
    if (commission === null) {
      return { skip: { row: firstRow, title, reason: `commission "${commissionRaw}" is not a plain whole number like 20` } };
    }
  }
  const unitCostRaw = pick(first, UNIT_COST_KEYS);
  const hasUnitCost = Boolean(unitCostRaw);
  if (!vendor && !hasUnitCost) {
    return { skip: { row: firstRow, title, reason: "no vendor and no unit cost — a product needs a vendor or a unit cost" } };
  }
  let unitCostMinor;
  if (vendor && hasUnitCost) {
    unitCostMinor = parsePriceToMinor(unitCostRaw);
    if (unitCostMinor === null) {
      return { skip: { row: firstRow, title, reason: `unit cost "${unitCostRaw}" is not a plain number like 45.00` } };
    }
  }
  const vendorCode = pick(first, VENDOR_CODE_KEYS);
  if (vendorCode && !vendor) {
    return {
      skip: { row: firstRow, title, reason: `vendor code "${vendorCode}" was given without a vendor — it is the VENDOR's own SKU for this product` },
    };
  }

  /* One variation per row, in the sheet's own order. A bad price or
     quantity on any ONE row skips the whole group -- a product silently
     missing one of its own sizes is worse than not creating it yet. */
  const variations = [];
  for (const { record, rowNumber, color, size, styleIdRaw } of groupRows) {
    const priceRaw = pick(record, PRICE_KEYS);
    const priceMinor = parsePriceToMinor(priceRaw);
    if (priceMinor === null) {
      return { skip: { row: rowNumber, title, reason: `price "${priceRaw}" is not a plain number like 45.00` } };
    }
    const currency = (pick(record, CURRENCY_KEYS) || "USD").toUpperCase();
    const quantityRaw = pick(record, QUANTITY_KEYS);
    let quantity = 1;
    if (quantityRaw) {
      quantity = parseQuantity(quantityRaw);
      if (quantity === null) {
        return { skip: { row: rowNumber, title, reason: `quantity "${quantityRaw}" is not a plain whole number like 5` } };
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
    const variationTitle = [optValues.Color, optValues.Size].filter(Boolean).join(", ") || title;
    /* "For our full SKU number, we can go with the shorter names... the
       SKU is basically what we gave you in the first column. That's the
       SKU" — the owner's own words. An explicit SKU column, when a sheet
       has one, still wins (the same "explicit wins" rule as above); with
       none, the row's own full style number — abbreviations and all,
       verbatim — becomes this variation's own real, already-unique SKU. */
    const sku = pick(record, SKU_KEYS) || styleIdRaw;
    variations.push({
      title: variationTitle,
      price_minor: priceMinor,
      currency,
      quantity,
      ...(sku ? { sku } : {}),
      ...(Object.keys(optValues).length ? { option_values: optValues } : {}),
    });
  }

  const knownKeys = vendor ? [...PRODUCT_KNOWN_KEYS, ...UNIT_COST_KEYS] : PRODUCT_KNOWN_KEYS;
  const customFields = extraFields(first, knownKeys);
  /* This shop's own style_id, built from the category/subcategory actually
     resolved above (always real, always two digits by now — never the
     sheet's own wider padding) plus the group's own item index, padded to
     this shop's own three digits the same way. A conflict with an
     already-used style_id is still resolveStyleId's own job
     (catalog.create_product) — bumped to the next free index, never
     refused, exactly as it already works everywhere else. */
  const styleId = `${topCategory.numeric_id}-${subCodeNormalized}-${String(Number(indexCode)).padStart(3, "0")}`;

  return {
    row: {
      rowNumber: firstRow,
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
        variations,
        ...(Object.keys(customFields).length ? { custom_fields: customFields } : {}),
      },
    },
  };
}

/**
 * Parse a CSV, mint one catalog.create_product approval per PRODUCT that
 * resolves cleanly, and report the rest with a plain reason. Two distinct
 * paths, decided per row by whether it gives a style number at all:
 *
 *   GROUPED — "it's not one product, one line... I gave you variations" —
 *   the owner's own words. Every row whose style number's own first three
 *   segments are all-digit (STYLE_NUMBER_BASE) joins a GROUP keyed by that
 *   exact base; several rows sharing one base become ONE catalog.
 *   create_product call with several variations, one per row, in the
 *   sheet's own order (draftGroupedProducts, below) — category/subcategory
 *   resolved by NUMBER (resolveCategoryByCode), never by name. A row whose
 *   own style number is non-blank but does NOT look like one at all (a
 *   totals line, a footnote) is dropped outright — "if they don't have
 *   that style ID pattern, then just ignore that."
 *
 *   STANDALONE — a row with NO style number cell at all keeps this
 *   importer's original shape: one row, one product, one variation,
 *   category/subcategory resolved by NAME (matchCategory/
 *   resolveOrCreateCategory) — for a sheet that does not encode a style
 *   number into every cell at all.
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
 * @returns { created: [{row, title, handle, summary}], skipped: [{row, title, reason}], tooMany?: number }
 */
export async function draftProductBatch(env, { text, actor, role }) {
  const records = csvRecords(parseCsv(text));
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { created: [], skipped: [], tooMany: records.length };
  }
  const categories = await listCategories(env.CATALOG_MIRROR);
  const nextAutoTitle = autoTitler(await categoryProductCounts(env.CATALOG_MIRROR));

  const rows = [];
  const skipped = [];
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

  /* Split first: every record with a style number whose own first three
     segments are all-digit joins a GROUP; a blank cell goes to the
     standalone path unchanged; anything else non-blank (garbage, a
     totals row) is dropped right here, never reported at all -- it was
     never a data row to begin with. */
  const groups = new Map();
  const groupOrder = [];
  const standaloneRecords = [];
  for (const [i, record] of records.entries()) {
    const rowNumber = i + 2; /* +1 for the header, +1 for 1-based rows */
    const styleIdRaw = pick(record, STYLE_ID_KEYS);
    if (!styleIdRaw) {
      standaloneRecords.push({ record, rowNumber });
      continue;
    }
    const { base, color, size } = parseStyleNumber(styleIdRaw);
    if (!STYLE_NUMBER_BASE.test(base)) continue;
    if (!groups.has(base)) {
      groups.set(base, []);
      groupOrder.push(base);
    }
    groups.get(base).push({ record, rowNumber, color, size, styleIdRaw });
  }

  for (const base of groupOrder) {
    const outcome = await draftGroupedProduct(env, { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, nextAutoTitle }, base, groups.get(base));
    if (outcome.skip) skipped.push(outcome.skip);
    else rows.push(outcome.row);
  }

  for (const { record, rowNumber } of standaloneRecords) {
    const rawTitle = pick(record, TITLE_KEYS).slice(0, 200);
    const categoryName = pick(record, CATEGORY_KEYS);
    const subcategoryName = pick(record, SUBCATEGORY_KEYS);
    const priceRaw = pick(record, PRICE_KEYS);
    const currency = (pick(record, CURRENCY_KEYS) || "USD").toUpperCase();

    /* This loop is reached ONLY by a row with a genuinely BLANK style-id
       cell (draftProductBatch's own split, above) — a sheet that does not
       encode everything into one cell, resolving purely by NAME.
       "Categories/subcategories should be made if missing. And ids
       assigned auto bumped" — the owner's own words. REVISED: "we can
       make categories with UI can't we? ... if UI works why can't
       agent?" — created immediately, right here (resolveOrCreateCategory,
       above), the same "check, then re-run with the token" pattern the
       Admin panel's own category form already uses, rather than parking a
       separate approval and making the uploader come back. A real
       creation failure (a near-duplicate name, say) is relayed as this
       row's own skip reason directly. A row naming NO category at all is
       a genuinely different case, unaffected: no automatic skip either
       way — it stays genuinely UNASSIGNED, exactly as catalog.
       create_product already tolerates on its own. */
    let category = categoryName ? matchCategory(categoryName, categories) : null;
    if (categoryName && !category) {
      const outcome = await resolveOrCreateCategory(
        env,
        { actor, role, categories, reserved: reservedNumericIds, cache: categoryCache },
        categoryName,
      );
      if (outcome.error) {
        skipped.push({
          row: rowNumber,
          title: rawTitle || "(no title)",
          reason: `category "${categoryName}" does not exist yet and could not be created: ${outcome.error}`,
        });
        continue;
      }
      category = outcome.category;
    }
    /* A SEPARATE Subcategory column (SUBCATEGORY_KEYS, above) — "Jacket"/
       "Blazer" as two distinct cells. Matched (or created) as a child of
       whichever category this row just landed on, then REPLACES it as
       this row's own category — the same "the subcategory is the
       authoritative, more specific level" rule this file already applies
       when a style ID's own digits resolve to one instead. Given with no
       category at all to nest under, this is refused up front, the same
       treatment a vendor code given with no vendor already gets below. */
    if (subcategoryName) {
      if (!category) {
        skipped.push({
          row: rowNumber,
          title: rawTitle || "(no title)",
          reason: `subcategory "${subcategoryName}" was given without a category to nest it under`,
        });
        continue;
      }
      let subcategory = matchCategory(subcategoryName, categories.filter((c) => c.parent_id === category.id));
      if (!subcategory) {
        const outcome = await resolveOrCreateCategory(
          env,
          { actor, role, categories, reserved: reservedSubcategoryNumericIds, cache: categoryCache, parentId: category.id },
          subcategoryName,
        );
        if (outcome.error) {
          skipped.push({
            row: rowNumber,
            title: rawTitle || "(no title)",
            reason: `subcategory "${subcategoryName}" does not exist yet under "${category.name}" and could not be created: ${outcome.error}`,
          });
          continue;
        }
        subcategory = outcome.category;
      }
      category = subcategory;
    }
    /* Title is spelled from whichever category this row actually landed on
       (its own subcategory name, when that is what matched) — autoTitler's
       own "Item" fallback only fires for a row that is genuinely
       unassigned either way. */
    const title = rawTitle || nextAutoTitle(category);
    const priceMinor = parsePriceToMinor(priceRaw);
    if (priceMinor === null) {
      skipped.push({ row: rowNumber, title, reason: `price "${priceRaw}" is not a plain number like 45.00` });
      continue;
    }

    /* Never given here at all: this loop is ONLY reached by a row with a
       genuinely BLANK style-id cell (draftProductBatch's own split, above
       — anything non-blank either joins a GROUP or is dropped outright).
       create_product's own resolveStyleId (catalog-write.js) still builds
       one automatically from `category`'s own NN-NN pair, the moment this
       row lands on a real subcategory that has one. */
    const styleId = undefined;

    /* "When quantity not specified use 1" — the owner's own words. Blank
       defaults rather than blocks; a value that IS given but does not
       parse is a real typo, reported the same way a bad price is. */
    const quantityRaw = pick(record, QUANTITY_KEYS);
    let quantity = 1;
    if (quantityRaw) {
      quantity = parseQuantity(quantityRaw);
      if (quantity === null) {
        skipped.push({ row: rowNumber, title, reason: `quantity "${quantityRaw}" is not a plain whole number like 5` });
        continue;
      }
    }

    const vendor = pick(record, VENDOR_KEYS);
    const commissionRaw = pick(record, COMMISSION_KEYS);
    let commission;
    if (commissionRaw) {
      commission = parseCommission(commissionRaw);
      if (commission === null) {
        skipped.push({ row: rowNumber, title, reason: `commission "${commissionRaw}" is not a plain whole number like 20` });
        continue;
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
      continue;
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
        continue;
      }
    }
    const vendorCode = pick(record, VENDOR_CODE_KEYS);
    if (vendorCode && !vendor) {
      skipped.push({
        row: rowNumber,
        title,
        reason: `vendor code "${vendorCode}" was given without a vendor — it is the VENDOR's own SKU for this product`,
      });
      continue;
    }

    const description = pick(record, DESCRIPTION_KEYS);
    /* vendor's own UNIT_COST_KEYS column is excluded from custom_fields
       ONLY when it just became a real argument above — a vendor-less row
       still preserves it verbatim, unchanged from before this feature. */
    const knownKeys = vendor ? [...PRODUCT_KNOWN_KEYS, ...UNIT_COST_KEYS] : PRODUCT_KNOWN_KEYS;
    const customFields = extraFields(record, knownKeys);
    /* No style number here to derive a color/size from at all (this loop
       is blank-style-id rows only) -- an explicit Size/Color column
       (OPTION_KEYS) is the only source. */
    const optValues = optionValues(record);
    rows.push({
      rowNumber,
      title,
      args: {
        title,
        ...(description ? { description } : {}),
        ...(category ? { category_id: category.id } : {}),
        ...(styleId ? { style_id: styleId } : {}),
        ...(vendor ? { vendor } : {}),
        ...(vendorCode ? { vendor_code: vendorCode } : {}),
        ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
        ...(commission !== undefined ? { commission } : {}),
        variations: [
          {
            title,
            price_minor: priceMinor,
            currency,
            quantity,
            ...(pick(record, SKU_KEYS) ? { sku: pick(record, SKU_KEYS) } : {}),
            ...(Object.keys(optValues).length ? { option_values: optValues } : {}),
          },
        ],
        ...(Object.keys(customFields).length ? { custom_fields: customFields } : {}),
      },
    });
  }

  const { created: madeRows, skipped: refused } = await createRows(env, { actor, role, toolName: "catalog.create_product" }, rows);

  return { created: madeRows, skipped: [...skipped, ...refused].sort((a, b) => a.row - b.row) };
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
 * speculatively. REVISED: draftProductBatch now creates real products the
 * moment a row resolves cleanly (createRows) — no approval link left to
 * even click through or cancel any more, which makes this preview step
 * MORE important than it ever was, not less: a wrong column match now
 * means 400 real, wrong products in Square rather than 400 links sitting
 * unclicked. This reads the same columns the same way (same key lists,
 * same `pick`), on the first row only, and mints nothing: no listCategories
 * call, no runTool, no parkForApproval, no write of any kind.
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
  const categoryName = pick(record, CATEGORY_KEYS);
  const styleIdRaw = pick(record, STYLE_ID_KEYS);
  /* Same parse (parseStyleNumber, above) — the preview must show exactly
     the style_id base/color/size a real upload would actually read, not
     the raw, unsplit cell. It shows the parsed BASE as given, never this
     shop's own normalized two-digit form -- draftProductBatch's own
     grouping/resolveCategoryByCode is a real DB round trip this
     side-effect-free, single-sample preview deliberately never makes. */
  const { base: styleBase, color: styleColor, size: styleSize } = styleIdRaw
    ? parseStyleNumber(styleIdRaw)
    : { base: "", color: undefined, size: undefined };
  const optValues = { ...(styleColor ? { Color: styleColor } : {}), ...(styleSize ? { Size: styleSize } : {}), ...optionValues(record) };
  return {
    title: pick(record, TITLE_KEYS) || null,
    category: categoryName || null,
    subcategory: pick(record, SUBCATEGORY_KEYS) || null,
    price: pick(record, PRICE_KEYS) || null,
    currency: (pick(record, CURRENCY_KEYS) || "USD").toUpperCase(),
    description: pick(record, DESCRIPTION_KEYS) || null,
    sku: pick(record, SKU_KEYS) || null,
    style_id: styleBase || null,
    vendor: pick(record, VENDOR_KEYS) || null,
    vendor_code: pick(record, VENDOR_CODE_KEYS) || null,
    commission: pick(record, COMMISSION_KEYS) || null,
    quantity: pick(record, QUANTITY_KEYS) || "1 (default)",
    ...Object.fromEntries(Object.keys(OPTION_KEYS).map((name) => [name.toLowerCase(), optValues[name] ?? null])),
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
