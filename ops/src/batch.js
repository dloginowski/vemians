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
import { listCategories } from "./tools/catalog-writer.js";
import { parkForApproval } from "./mcp.js";
import { csvRecords, parseCsv } from "./tools/csv.js";
import { CAPS } from "./tools/caps.js";

function pick(record, keys) {
  for (const k of keys) {
    if (record[k]) return record[k];
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

const TITLE_KEYS = ["title", "name", "product", "product title", "product name"];
const DESCRIPTION_KEYS = ["description", "desc", "details"];
const CATEGORY_KEYS = ["category", "category name"];
const PRICE_KEYS = ["price", "cost", "price (usd)"];
const CURRENCY_KEYS = ["currency"];
const SKU_KEYS = ["sku"];

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

  const rows = [];
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
    rows.push({
      rowNumber,
      title,
      args: {
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
