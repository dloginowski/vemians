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
import { listCategories, categoryProductCounts } from "./tools/catalog-writer.js";
import { nearestCategory } from "./tools/catalog-write.js";
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

async function createRows(env, { actor, role, toolName }, rows) {
  const created = [];
  const parked = [];
  const skipped = [];
  const settle = async (rowNumber, title, args, reason) => {
    if (NOT_ROW_FIXABLE.test(reason)) {
      skipped.push({ row: rowNumber, title, reason });
      return;
    }
    const { url } = await parkForApproval(env, { name: toolName, args, actor, role, tier: "T2", summary: reason });
    parked.push({ row: rowNumber, title, url, summary: reason });
  };
  for (const { rowNumber, title, args } of rows) {
    const gate = await runTool(toolName, args, { actor, role, env });
    if (!gate?.needsApproval) {
      await settle(rowNumber, title, args, gate?.error || "could not be validated");
      continue;
    }
    const result = await runTool(toolName, args, { actor, role, env, approvalToken: gate.data.approval.token });
    if (result?.error || result?.denied) {
      await settle(rowNumber, title, args, result.error || result.denied || "was refused");
      continue;
    }
    created.push({ row: rowNumber, title, handle: result.data?.product?.handle, summary: gate.data.would });
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
async function parkClashRows(env, { actor, role, toolName }, rows) {
  const parked = [];
  const skipped = [];
  for (const { row, title, args, reason } of rows) {
    if (NOT_ROW_FIXABLE.test(reason)) {
      skipped.push({ row, title, reason });
      continue;
    }
    const { url } = await parkForApproval(env, { name: toolName, args, actor, role, tier: "T2", summary: reason });
    parked.push({ row, title, url, summary: reason });
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
/* REVISED: "it should never be looking, expecting an SKU in our
   spreadsheets, because the SKU is something that is generated
   automatically" — the owner's own words, confirmed against the owner's
   own real sample sheet (Style #/Category/Subcategory/Description/Color/
   Size/Qty/Cost/Retail Price — no SKU column of any kind) taken as the
   benchmark for what an upload actually looks like going forward. There is
   no SKU_KEYS any more, and no column is ever read as one: a style-numbered
   row's own full style number (styleIdRaw) becomes its real SKU verbatim,
   the same as it already did when no explicit column existed; a row with
   no style number at all sends no `sku` argument, and catalog-writer.js's
   own generateSku() mints one — "SKU should be auto generated when adding
   variants or options — Square does that," the owner's own words, on
   discovering Square only does this for a Dashboard/POS-created item,
   never one this codebase creates through the Catalog API. A column
   literally named "SKU" (or "item number", "product code") is no longer
   claimed at all — it falls through to custom_fields like any other
   unrecognized column, "preserve all fields" applying here too. */
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
   copies that rate onto the row's own product automatically. */
/* Bare "style"/"style #" claimed here. "style #", "style#" and "style"
   itself all normalize to the same "style" key.
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
  ...STYLE_ID_KEYS, ...VENDOR_KEYS, ...VENDOR_CODE_KEYS, ...COMMISSION_KEYS, ...QUANTITY_KEYS,
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

/* Enough English to fold a category name onto its own plural, and no more —
   the identical rule catalog-write.js's own suggestCategory() already uses
   for the same reason (kept as its own small copy here rather than an
   export, since matchCategory's own closed-set exact-match semantics are
   deliberately unrelated to that function's fuzzy suggestion scoring).
   "Accessories" -> accessory, "Coats" -> coat, "Dresses" -> dress. */
function singularCategoryWord(t) {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
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
async function ensureNumbered(env, { actor, role, reserved }, category, numericId) {
  if (category.numeric_id != null && category.numeric_id !== "") return { category };
  if (reserved.has(numericId)) {
    return { error: `numeric_id "${numericId}" was already claimed earlier in this same upload` };
  }
  const gate = await runTool("catalog.set_category_number", { category_id: category.id, numeric_id: numericId }, { actor, role, env });
  if (!gate?.needsApproval) return { error: gate?.error || "could not be numbered" };
  const result = await runTool("catalog.set_category_number", { category_id: category.id, numeric_id: numericId }, {
    actor, role, env, approvalToken: gate.data.approval.token,
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
async function resolveOrCreateCategory(env, { actor, role, categories, reserved, cache, parentId = null }, name) {
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
    const outcome = await ensureNumbered(env, { actor, role, reserved }, near, assignId);
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
 *      outright; `draftGroupedProduct`'s own variation loop rebuilds this
 *      row's own style_id/sku from it, never keeping the row's own (wrong)
 *      claimed code verbatim.
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
async function resolveCategoryByCode(env, { actor, role, categories, reserved, cache }, code, name) {
  const numeric = Number(code);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 99) {
    return { error: `"${code}" is not a plain 0-99 number this shop's own numbering can use` };
  }
  const padded = String(numeric).padStart(2, "0");
  const pool = categories.filter((c) => !c.parent_id);

  const byNumber = pool.find((c) => c.numeric_id != null && c.numeric_id !== "" && Number(c.numeric_id) === numeric);
  if (byNumber) return { category: byNumber };

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
  if (matched) {
    /* REVISED — already numbered, just not the way this row's own style
       number claims: no longer a genuine clash to park. "We already have
       categories and subcategories with their corresponding IDs defined
       in our database... they do not provide the source of truth. We have
       the source of truth, and we must map the incoming spreadsheets to
       match ours" -- the owner's own words. The existing, real number wins
       outright; draftGroupedProduct's own variation loop rebuilds this
       row's own style_id/sku from it, rather than keeping the row's own
       (wrong) claimed code verbatim. */
    if (matched.numeric_id != null && matched.numeric_id !== "") {
      return { category: matched };
    }
    const key = `assign::${matched.id}`;
    if (cache.has(key)) return cache.get(key);
    const outcome = await ensureNumbered(env, { actor, role, reserved }, matched, padded);
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
  const { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache } = ctx;
  const topOutcome = await resolveOrCreateCategory(
    env,
    { actor, role, categories, reserved: reservedNumericIds, cache: categoryCache, parentId: null },
    categoryName,
  );
  if (topOutcome.error) return topOutcome;
  return resolveOrCreateCategory(
    env,
    { actor, role, categories, reserved: reservedSubcategoryNumericIds, cache: categoryCache, parentId: topOutcome.category.id },
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
function draftNamedCategoryProduct(category, resolutionError, nextAutoTitle, record, rowNumber) {
  const rawTitle = pick(record, TITLE_KEYS).slice(0, 200);
  const priceRaw = pick(record, PRICE_KEYS);
  const currency = (pick(record, CURRENCY_KEYS) || "USD").toUpperCase();
  const notes = [];
  const rowClashes = [];
  if (resolutionError) rowClashes.push(resolutionError);

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
  const unitCostRaw = pick(record, UNIT_COST_KEYS);
  let unitCostMinor;
  if (vendor && unitCostRaw) {
    unitCostMinor = parsePriceToMinor(unitCostRaw);
    if (unitCostMinor === null) {
      notes.push(`unit cost "${unitCostRaw}" is not a plain number like 45.00 -- left unset`);
      unitCostMinor = undefined;
    }
  }
  const vendorCode = pick(record, VENDOR_CODE_KEYS);
  if (vendorCode && !vendor) notes.push(`vendor code "${vendorCode}" was given without a vendor -- left unset`);

  const description = pick(record, DESCRIPTION_KEYS);
  const knownKeys = unitCostMinor !== undefined ? [...PRODUCT_KNOWN_KEYS, ...UNIT_COST_KEYS] : PRODUCT_KNOWN_KEYS;
  const customFields = extraFields(record, knownKeys);
  if (notes.length) customFields["import notes"] = notes.join("; ").slice(0, CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX);

  const optValues = Object.fromEntries(Object.entries(optionValues(record)).filter(([, value]) => value.trim().toUpperCase() !== "TBD"));

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

  if (rowClashes.length) return { clash: { row: rowNumber, title, args, reason: rowClashes.join("; ") } };
  return { row: { rowNumber, title, args } };
}

async function draftGroupedProduct(env, ctx, base, groupRows) {
  const { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, nextAutoTitle } = ctx;
  const first = groupRows[0].record;
  const firstRow = groupRows[0].rowNumber;
  const [catCode, subCode, indexCode] = base.split("-");
  const categoryNameCol = pick(first, CATEGORY_KEYS);
  const subcategoryNameCol = pick(first, SUBCATEGORY_KEYS);
  /* Something this file could safely default is noted here, in plain
     text, on the product itself. Something it could NOT safely decide for
     itself goes in `clashes` instead -- the whole row still gets built (so
     a person reviewing the parked approval sees a complete, editable
     proposal), but it is parked rather than created outright. */
  const notes = [];
  const clashes = [];

  const catOutcome = await resolveCategoryByCode(
    env,
    { actor, role, categories, reserved: reservedNumericIds, cache: categoryCache },
    catCode,
    categoryNameCol,
  );
  let topCategory = null;
  if (catOutcome.error) {
    clashes.push(`style number "${base}": category ${catCode}: ${catOutcome.error}`);
  } else if (!catOutcome.category) {
    /* Nothing to decide -- just plain absence, not a clash: no code
       matched anything, and no name was even given to try creating one
       from. Automatic, unassigned, noted. */
    notes.push(`style number "${base}": category ${catCode} matches no existing category, and no Category name column was given to create one from`);
  } else {
    topCategory = catOutcome.category;
  }

  /* SUBCATEGORY: two different rules, picked by whether a Subcategory
     NAME column exists at all -- only even attempted once a real
     top-level category exists to nest under; a subcategory named beside
     an unresolved top-level category has nowhere to go, and rides along
     with whatever `clashes`/`notes` the category resolution above already
     recorded, rather than reporting its own second, redundant problem.
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
     than the sheet's own locally-scoped one. A CREATE failure (a real
     Square refusal, a rate cap) IS a clash -- parked, same as the
     top-level category's own.
     WITH NO name column (a bare style_id, from before that column
     existed) — resolves by NUMBER instead, tree-wide, MATCH ONLY, never
     creating: the exact deriveCategoryIdForStyleId lookup this shop's
     style_id nomenclature has always used for a style_id with nothing
     else to go on. This never risks the same cross-category collision a
     name-less CREATE would, since nothing here ever assigns a new
     number from a per-parent-scoped digit; a number that matches nothing
     yet simply leaves this row at the top-level category, its own raw
     digit still riding into the constructed style_id verbatim (padded)
     — not a clash either, nothing here disagreed with anything. */
  let category = topCategory;
  let subCodeNormalized = topCategory ? String(Number(subCode)).padStart(2, "0") : null;
  if (topCategory && subcategoryNameCol) {
    let subcategory = matchCategory(subcategoryNameCol, categories.filter((c) => c.parent_id === topCategory.id));
    if (!subcategory) {
      const outcome = await resolveOrCreateCategory(
        env,
        { actor, role, categories, reserved: reservedSubcategoryNumericIds, cache: categoryCache, parentId: topCategory.id },
        subcategoryNameCol,
      );
      if (outcome.error) {
        clashes.push(`subcategory "${subcategoryNameCol}" does not exist yet under "${topCategory.name}" and could not be created: ${outcome.error}`);
      } else {
        subcategory = outcome.category;
      }
    }
    if (subcategory) {
      category = subcategory;
      subCodeNormalized = subcategory.numeric_id;
    }
  } else if (topCategory) {
    const subNumeric = Number(subCode);
    const match = categories.find(
      (c) => c.parent_id && c.numeric_id != null && c.numeric_id !== "" && Number(c.numeric_id) === subNumeric,
    );
    if (match) {
      category = match;
      subCodeNormalized = match.numeric_id;
    }
  } else if (subcategoryNameCol) {
    /* Nowhere to nest -- but nothing DISAGREES either, there is simply no
       category to check the subcategory against. Automatic, noted. */
    notes.push(`subcategory "${subcategoryNameCol}" was given without a resolvable category to nest it under`);
  }

  /* This shop's own style_id, built from the category/subcategory actually
     resolved above (always real, always two digits by now — never the
     sheet's own wider padding) plus the group's own item index, padded to
     this shop's own three digits the same way. Computed here, BEFORE the
     variations loop below, because each row's own SKU must be rebuilt from
     this SAME corrected value, not the sheet's own possibly-stale one --
     "we have the source of truth, and we must map the incoming spreadsheets
     to match ours," the owner's own words, apply just as much to a row's
     SKU as to its style_id: a category/subcategory that got silently
     conformed to an existing, differently-numbered match above must not
     leave its old, wrong numbers riding into the SKU verbatim. A conflict
     with an already-used style_id is still resolveStyleId's own job
     (catalog.create_product) — bumped to the next free index, never
     refused, exactly as it already works everywhere else. With no real
     category at all to build it from, style_id is left out entirely — the
     product lands unassigned, its own intended style number preserved
     verbatim above in `notes` instead. */
  const styleId = topCategory ? `${topCategory.numeric_id}-${subCodeNormalized}-${String(Number(indexCode)).padStart(3, "0")}` : undefined;

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
  const unitCostRaw = pick(first, UNIT_COST_KEYS);
  let unitCostMinor;
  if (vendor && unitCostRaw) {
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
  for (const { record, rowNumber, color, size, styleIdRaw } of groupRows) {
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
    const variationTitle = [optValues.Color, optValues.Size].filter(Boolean).join(", ") || title;
    /* "For our full SKU number, we can go with the shorter names... the
       SKU is basically what we gave you in the first column. That's the
       SKU" — the owner's own words. "It should never be looking, expecting
       an SKU in our spreadsheets, because the SKU is something that is
       generated automatically" — REVISED: no column is ever read as an
       explicit SKU any more (there is no SKU_KEYS); the row's own full
       style number — abbreviations and all, verbatim — always becomes
       this variation's own real, already-unique SKU. REVISED AGAIN: only
       the row's own trailing color/size suffix rides in verbatim now --
       the LEADING base (category-subcategory-index) is always rebuilt from
       `styleId`, the same corrected value the product's own style_id above
       was built from, so a row whose category/subcategory got silently
       conformed to an existing, differently-numbered match does not leave
       its SKU quietly disagreeing with its own style_id. With no real
       category resolved at all, `styleId` is undefined and the row's own
       raw text rides in completely unchanged, exactly as before. "The only
       hard rule here is that we must have a unique SKU number or ID for
       each item... if that's true, then add the product" — catalog.
       create_product's own check() still refuses a SKU it finds already
       in use by any OTHER product in the shop; that refusal is a clash
       only the tool itself can discover, so it is caught and parked one
       level up, in createRows, once it actually tries the write. */
    const sku = styleId ? `${styleId}${styleIdRaw.slice(base.length)}` : styleIdRaw;
    variations.push({
      title: variationTitle,
      ...(priceMinor !== null ? { price_minor: priceMinor } : {}),
      currency,
      quantity,
      ...(sku ? { sku } : {}),
      ...(Object.keys(optValues).length ? { option_values: optValues } : {}),
    });
  }

  /* unit_cost_minor is excluded from custom_fields ONLY once it actually
     became a real argument above -- a vendor-less row, or one whose own
     value would not parse, still preserves the raw text verbatim via
     extraFields below, same as it always has. */
  const knownKeys = unitCostMinor !== undefined ? [...PRODUCT_KNOWN_KEYS, ...UNIT_COST_KEYS] : PRODUCT_KNOWN_KEYS;
  const customFields = extraFields(first, knownKeys);
  if (notes.length) customFields["import notes"] = notes.join("; ").slice(0, CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX);

  const args = {
    title,
    ...(description ? { description } : {}),
    ...(category ? { category_id: category.id } : {}),
    ...(styleId ? { style_id: styleId } : {}),
    ...(vendor ? { vendor } : {}),
    ...(vendorCode && vendor ? { vendor_code: vendorCode } : {}),
    ...(unitCostMinor !== undefined ? { unit_cost_minor: unitCostMinor } : {}),
    ...(commission !== undefined ? { commission } : {}),
    variations,
    ...(Object.keys(customFields).length ? { custom_fields: customFields } : {}),
  };

  /* A real clash parks the whole group for a person to review and fix,
     exactly the same check-then-a-person-decides gate every other T2
     write already uses -- never silently picked one way, never a bare
     skip either. */
  if (clashes.length) {
    return { clash: { row: firstRow, title, args, reason: clashes.join("; ") } };
  }

  return { row: { rowNumber: firstRow, title, args } };
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
 * @returns { created: [{row, title, handle, summary}], ready: [{row, title, url, summary}], skipped: [{row, title, reason}], tooMany?: number }
 */
export async function draftProductBatch(env, { text, actor, role }) {
  const records = csvRecords(parseCsv(text));
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { created: [], ready: [], skipped: [], tooMany: records.length };
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

  const { groups, groupOrder, namedRecords } = splitProductRecords(records);

  const clashes = [];

  for (const base of groupOrder) {
    const outcome = await draftGroupedProduct(env, { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache, nextAutoTitle }, base, groups.get(base));
    if (outcome.clash) clashes.push(outcome.clash);
    else rows.push(outcome.row);
  }

  for (const { record, rowNumber } of namedRecords) {
    const resolved = await resolveNamedCategory(
      env,
      { actor, role, categories, reservedNumericIds, reservedSubcategoryNumericIds, categoryCache },
      record,
    );
    if (!resolved.category && !resolved.error) continue; /* neither name was even given -- nothing to build from */
    const outcome = draftNamedCategoryProduct(resolved.category ?? null, resolved.error, nextAutoTitle, record, rowNumber);
    if (outcome.clash) clashes.push(outcome.clash);
    else rows.push(outcome.row);
  }

  const { created: madeRows, parked: parkedFromDenials, skipped: refused } = await createRows(
    env,
    { actor, role, toolName: "catalog.create_product" },
    rows,
  );
  const { parked: parkedFromClashes, skipped: refusedClashes } = await parkClashRows(
    env,
    { actor, role, toolName: "catalog.create_product" },
    clashes,
  );

  return {
    created: madeRows,
    ready: [...parkedFromClashes, ...parkedFromDenials].sort((a, b) => a.row - b.row),
    skipped: [...skipped, ...refused, ...refusedClashes].sort((a, b) => a.row - b.row),
  };
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
   size/color variations, or a lone standalone row, previewed the identical
   way (`base` empty, one entry in `groupRows`). Extra columns are spread in
   AFTER the known ones, from the group's own FIRST row only (product-level
   facts, draftGroupedProduct's own comment on vendor/commission/unit cost
   applies here too) — "preserve all fields" means visible before
   confirming, not just kept silently in the background. */
function mapProductGroup(base, groupRows) {
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
  /* "It should never be looking, expecting an SKU in our spreadsheets,
     because the SKU is something that is generated automatically" — the
     owner's own words; no column is ever read as an explicit SKU (there is
     no SKU_KEYS). EVERY style-numbered row's own full style number is
     already its real SKU verbatim (draftGroupedProduct's own variation
     loop) — known at preview time, one per variant, whether the group has
     one row or several. `mapProductGroup` is reached by a real
     style-numbered group (`base` a real "NN-NN-NNN") OR by a single
     name-matched row with no style number at all (`base === ""`,
     `previewBatch`'s own call for a `namedRecords` match) — that second
     case has no real style_id yet at preview time either (the same reason
     a truly standalone row once needed this, before this shop's own
     matching category/subcategory made it a real, identifiable product
     instead of a dropped one) — an EXPECTED, named outcome, not a missing
     value, so it reads "(auto-generated)" rather than the generic,
     alarming "(not found)" a value nobody supplied would read as. */
  const sku = base ? groupRows.map(({ styleIdRaw }) => styleIdRaw).join(" | ") : "(auto-generated)";
  return {
    title,
    category: categoryName || null,
    subcategory: pick(first, SUBCATEGORY_KEYS) || null,
    price: positionalField(groupRows.map(({ record }) => pick(record, PRICE_KEYS) || null)),
    currency: (pick(first, CURRENCY_KEYS) || "USD").toUpperCase(),
    description: titleCol ? descriptionCol || null : null,
    sku,
    style_id: base || "(auto-generated)",
    variants: groupRows.length,
    vendor: pick(first, VENDOR_KEYS) || null,
    vendor_code: pick(first, VENDOR_CODE_KEYS) || null,
    commission: pick(first, COMMISSION_KEYS) || null,
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

export function previewBatch(text, kind) {
  const records = csvRecords(parseCsv(text));
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
       real draft to actually do. */
    const namedRows = namedRecords.map(({ record, rowNumber }) =>
      mapProductGroup("", [{ record, rowNumber, color: undefined, size: undefined, styleIdRaw: undefined }]),
    );
    mapped = [...groupOrder.map((base) => mapProductGroup(base, groups.get(base))), ...namedRows];
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
