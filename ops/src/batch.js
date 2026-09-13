/*
 * "Add products from a spreadsheet" — one CSV row in, one T2 approval out.
 *
 * DELIBERATELY NOT A NEW WRITE PATH. Every product this mints an approval for
 * goes through the exact same gate catalog.create_product already enforces —
 * this module resolves a category NAME to the id that tool requires and turns
 * a dollar amount into minor units, then calls runTool the same way a chat
 * agent's draft would. The closed category set, the price caps, the title
 * length limit: none of that is re-checked here, because re-checking it here
 * is how the two checks eventually disagree. A row this cannot even attempt —
 * an unparsable price, a category that matches nothing — is reported before
 * runTool ever sees it, because runTool has no way to say "not a number".
 *
 * ONE PRODUCT, ONE VARIATION, PER ROW. A spreadsheet cell cannot describe a
 * garment with three sizes at three prices without a schema of its own, and
 * building one is exactly the scope creep P0-40's closed set exists to avoid
 * elsewhere. A product that needs more than one variation is drafted through
 * the chat tools, same as always; this is the fast path for the common case,
 * not a replacement for the general one.
 *
 * PHOTOS ARE NOT IN SCOPE. A spreadsheet cell cannot hold image bytes, and a
 * filename or URL column would be a second, unverified image pipeline next to
 * the signed-ticket one media.js already is. A photo is added afterward,
 * per product, through the same "Add a photo" link a one-off product uses —
 * see /media/new.
 */
import { runTool } from "./tools/index.js";
import { listCategories } from "./tools/catalog-writer.js";
import { parkForApproval } from "./mcp.js";
import { csvRecords, parseCsv } from "./tools/csv.js";
import { CAPS } from "./tools/caps.js";

const TITLE_KEYS = ["title", "name", "product", "product title", "product name"];
const DESCRIPTION_KEYS = ["description", "desc", "details"];
const CATEGORY_KEYS = ["category", "category name"];
const PRICE_KEYS = ["price", "cost", "price (usd)"];
const CURRENCY_KEYS = ["currency"];
const SKU_KEYS = ["sku"];

function pick(record, keys) {
  for (const k of keys) {
    if (record[k]) return record[k];
  }
  return "";
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

/** Case- and whitespace-insensitive; the closed set's real names, never guessed. */
function matchCategory(name, categories) {
  const key = name.trim().toLowerCase();
  return categories.find((c) => c.name.trim().toLowerCase() === key) ?? null;
}

/**
 * Parse a CSV, mint one T2 approval per row that resolves cleanly, and report
 * the rest with a plain reason. Nothing is written: parkForApproval only ever
 * records an intent, same as every other T2 path in this codebase.
 *
 * @param env   CATALOG_MIRROR, and whatever runTool's own resources need
 *              (SQUARE_ACCESS_TOKEN etc — the same env a chat call runs under).
 * @param actor, role  the uploader's own verified Access identity. The
 *              spreadsheet is theirs; each row is parked as if they had typed
 *              it, and each one is still approved individually afterward —
 *              uploading is not approving.
 * @returns { ready: [{row, title, url, summary}], skipped: [{row, title, reason}], tooMany?: number }
 *          `tooMany` means nothing in the file was even attempted — it names
 *          the row count so the refusal page can say what to do about it.
 */
export async function draftBatch(env, { text, actor, role }) {
  const records = csvRecords(parseCsv(text));
  if (records.length > CAPS.BATCH_MAX_ROWS) {
    return { ready: [], skipped: [], tooMany: records.length };
  }
  const categories = await listCategories(env.CATALOG_MIRROR);

  const ready = [];
  const skipped = [];

  records.forEach((record, i) => {
    const rowNumber = i + 2; /* +1 for the header, +1 for 1-based rows */
    const title = pick(record, TITLE_KEYS).slice(0, 200);
    const categoryName = pick(record, CATEGORY_KEYS);
    const priceRaw = pick(record, PRICE_KEYS);
    const currency = (pick(record, CURRENCY_KEYS) || "USD").toUpperCase();

    if (!title) {
      skipped.push({ row: rowNumber, title: "(no title)", reason: "no title column, or it was empty" });
      return;
    }
    const category = categoryName ? matchCategory(categoryName, categories) : null;
    if (!category) {
      const known = categories.map((c) => c.name).join(", ") || "none yet";
      skipped.push({
        row: rowNumber,
        title,
        reason: categoryName
          ? `category "${categoryName}" does not exist — it must be exactly one of: ${known}`
          : `no category column, or it was empty — it must be exactly one of: ${known}`,
      });
      return;
    }
    const priceMinor = parsePriceToMinor(priceRaw);
    if (priceMinor === null) {
      skipped.push({ row: rowNumber, title, reason: `price "${priceRaw}" is not a plain number like 45.00` });
      return;
    }

    const description = pick(record, DESCRIPTION_KEYS);
    ready.push({ rowNumber, args: {
      title,
      ...(description ? { description } : {}),
      category_id: category.id,
      variations: [
        {
          title,
          price_minor: priceMinor,
          currency,
          ...(pick(record, SKU_KEYS) ? { sku: pick(record, SKU_KEYS) } : {}),
        },
      ],
    } });
  });

  const parked = [];
  for (const { rowNumber, args } of ready) {
    const gate = await runTool("catalog.create_product", args, { actor, role, env });
    if (!gate?.needsApproval) {
      skipped.push({ row: rowNumber, title: args.title, reason: gate?.error || "could not be validated" });
      continue;
    }
    const { url } = await parkForApproval(env, {
      name: "catalog.create_product",
      args,
      actor,
      role,
      tier: "T2",
      summary: gate.data.would,
    });
    parked.push({ row: rowNumber, title: args.title, url, summary: gate.data.would });
  }

  skipped.sort((a, b) => a.row - b.row);
  return { ready: parked, skipped };
}
