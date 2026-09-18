/*
 * catalog.* authoring — a staff member describes a garment to their own AI
 * client, and it lands in Square, priced and categorised.
 *
 * Inherits agent-tool-contract, then catalog-skills. Fifteen tools:
 *
 *   catalog.categories       T0  the closed set of categories that EXIST
 *   catalog.product          T0  read one mirrored product, variants and all
 *   catalog.upload_image     T1  an original into OUR bucket; returns our key
 *   catalog.draft_product    T1  a complete proposal and a diff; writes nothing
 *   catalog.create_product   T2  ITEM + ITEM_VARIATIONs in Square, then sync
 *   catalog.update_product   T2  the same path for an edit
 *   catalog.create_category  T2  separate, deliberate, and rarely right — now nestable
 *   catalog.rename_category  T2  the deliberate rename create_category's own describe text points at
 *   catalog.remove_category  T2  archives it in Square, never a real delete — refused while it has children
 *   catalog.set_category_number T2 a category/subcategory's own 2-digit style_id code — OURS, not Square's
 *   catalog.set_channel      T2  which audience sees a product — OURS, not Square's
 *   catalog.set_active       T2  archive or restore a product — Square's own presence, not ours
 *   catalog.set_custom_fields T2 whatever else we track that Square doesn't — OURS too
 *   catalog.set_square_attributes T2 style_id + vendor + commission — Square's OWN Custom Attributes
 *   catalog.resync_from_square T2 force a full sweep now, instead of waiting on the cron's own cursor
 *
 * ─── THREE DECISIONS, AND WHY EACH IS THE WAY IT IS ────────────────────────
 *
 * 1. THE AGENT WRITES TO SQUARE, NEVER TO OUR MIRROR — FOR A FACT SQUARE HAS.
 *    ADR-009 makes Square authoritative for the commercial facts of the
 *    catalog because the till changes them without asking us. The till and the
 *    agent therefore share ONE write target, and the mirror follows by sync and
 *    webhook. Two writers into the mirror would diverge from Square silently.
 *    Enforcement is in catalog-writer.js — every write ends at Square and the
 *    mirror is only ever read back — and structurally here: a tool that must
 *    not write declares no `square` resource, so it holds nothing that could.
 *
 *    `catalog.set_channel` and `catalog.set_custom_fields` are the deliberate
 *    exceptions, and each is one for the same reason: `channel` (website /
 *    direct_link — Test-PRD-P0-71-product_channel) and
 *    `custom_fields` (a fabric note, a reorder date, anything else ad hoc "our
 *    workers need more data tracking than square offers" — the owner's own
 *    words) are not facts Square has any notion of at all. Square does not
 *    know our storefront exists, and it has no field for a fact we invented,
 *    so neither has a second writer to diverge from. Both write
 *    `mirror_product` directly and declare no `square` resource at all — the
 *    tool that must not call Square holds nothing that could, the same
 *    structural argument as above, pointed the other way. `catalog.
 *    create_product` is allowed to ALSO set `custom_fields` at creation time
 *    (it already holds `square`, for the item itself) — the fields still
 *    never reach Square, only a second `UPDATE mirror_product` right after
 *    the sync that follows.
 *
 *    `catalog.set_square_attributes` is the OPPOSITE case, on purpose: style_id
 *    and vendor used to be `custom_fields` examples, and moved OUT once Square
 *    turned out to already have a supported mechanism for exactly this — its
 *    own Custom Attributes (Test-PRD-P0-136-square_custom_attributes). The
 *    owner's own words, having weighed "ours, not Square's" against not
 *    reinventing something Square already offers: "why do we need to have our
 *    own custom fields then? It doesn't make sense... we don't mind having our
 *    stuff being stored completely in Square." So this tool DOES declare
 *    `square` and DOES call it — Square is authoritative for these three now,
 *    the same as title or price, and the mirror sync overwrites them on every
 *    re-sync rather than preserving them untouched the way `channel` is.
 *    `commission` (0-100, an integer percentage) joined the other two once the
 *    owner walked the full set of custom attributes a second time: "that's
 *    only for vendors — anything that has a vendor, it has a commission."
 *    Cost-of-goods was considered too and dropped on the same pass: "we don't
 *    need to do cogs, there is a unit cost, we just use the unit cost" — the
 *    existing `custom_fields` entry already covers that, so there is no
 *    fourth attribute here.
 *
 * 2. EVERY CATALOG WRITE IS T2.
 *    A price, a SKU and whether a thing is for sale are commercial facts.
 *    Proposal, then human approval, then execution, with the approval token
 *    minted server-side (Test-PRD-P0-25-write_approval_gate,
 *    Test-PRD-P0-35-approval_never_in_band). Over MCP the T2 call does not
 *    execute at all: it returns a link a human opens on ops.vemians.com.
 *
 * 3. THE CATEGORY COMES FROM A CLOSED SET (Test-PRD-P0-40-closed_category_set).
 *    This is the trap in agentic authoring and it is not hypothetical. A model
 *    that can create a category will create one whenever the existing name is
 *    not the phrase it had in mind, and a month of that produces "Coats",
 *    "Outerwear", "Jackets" and "Coats & Jackets" — at which point the
 *    storefront navigation means nothing and no human decision was ever taken
 *    to make it so. So:
 *      * `catalog.categories` hands the model the set it must choose from;
 *      * `catalog.draft_product` returns a SUGGESTION with its reasoning and
 *        never assigns one silently;
 *      * `catalog.create_product` refuses a category id outside the set —
 *        in code, reading the mirror, not by asking the prompt nicely;
 *      * `catalog.create_category` exists, is T2, is manager+, refuses a
 *        lexical near-duplicate, and says in its own description that it is
 *        rarely the right tool.
 *
 * ─── UNDO ─────────────────────────────────────────────────────────────────
 * Nothing here deletes. A product created in error is withdrawn in Square
 * (`retractProduct`, which sets `present_at_all_locations: false` rather than
 * calling DeleteCatalogObject) and archived in the mirror. An edit is another
 * edit. The originals in R2 are never removed by any code path in this repo.
 */
import { CAPS } from "./caps.js";
import {
  deriveCategoryIdForStyleId,
  listCategories,
  listCustomFieldNames,
  listMirrorVendors,
  mergeVariations,
  priceBand,
  productByHandle,
  variantsOf,
  vendorCommission,
} from "./catalog-writer.js";
import { contentTypeFor, isOurMediaKey, mediaKey, squareAcceptsType, STORABLE_IMAGE_TYPES } from "./media.js";

/* The shop's own nomenclature for style_id (Test-PRD-P0-136-square_custom_
   attributes): 2-digit category, 2-digit subcategory, 3-digit item number,
   dash-separated — e.g. "01-04-001". Never generated here — the category/
   subcategory table this would need to auto-increment from does not exist
   yet — only validated and checked for conflicts. */
const STYLE_ID_FORMAT = /^\d{2}-\d{2}-\d{3}$/;

/* ── category matching: a suggestion, with its reasoning ────────────────── */

const STOP = new Set(["and", "the", "of", "for", "a", "an", "with", "in", "s"]);

/* Crude, deliberate, and explainable: lowercase, strip punctuation, drop stop
   words, fold a trailing plural. "Coats & Jackets" -> {coat, jacket}. A real
   stemmer would be better at English and worse at being auditable by the person
   reading the reasoning string. */
function tokens(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
      .map(singular),
  );
}

/* Enough English to fold a category name onto its own plural, and no more.
   "Accessories" -> accessory, "Coats" -> coat, "Dresses" -> dress. */
function singular(t) {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/* How much of the CATEGORY's vocabulary appears in the text at all. A one-word
   category matched inside a long description scores 1 here and near 0 on
   Jaccard, and both readings are useful, so both are reported. */
function coverage(catTokens, textTokens) {
  if (catTokens.size === 0) return 0;
  let hit = 0;
  for (const t of catTokens) if (textTokens.has(t)) hit += 1;
  return hit / catTokens.size;
}

/**
 * Score every EXISTING category against the hint and the copy, and — when the
 * model has already picked one — check that pick against the closed set and
 * against the lexical reading.
 *
 * WHO DOES WHAT, AND WHY IT IS SPLIT THIS WAY
 *
 * The semantics belong to the MODEL: it is the thing that knows a gabardine
 * trench coat is outerwear, and no lexicon in this file will ever know that
 * without becoming a lexicon that rots. What belongs to the TOOL is the part a
 * prompt cannot be trusted with — that the chosen id is one that exists, and
 * that the choice arrives with an argument attached rather than as a bare
 * assignment. So `category_id` is the model's pick, checked here against the
 * set; the lexical score is a CROSS-CHECK reported beside it, loud when the two
 * disagree, and the fallback when the model offers no pick at all.
 */
/* A-B-C-D-E instead of prose. `alternatives` already carries everything a
   caller needs; `choices` is the same top five, shaped so an agent can put
   the question to a human as a multiple-choice list rather than composing
   one out of a sentence. */
const lettered = (ranked) =>
  ranked.slice(0, 5).map((c, i) => ({ letter: String.fromCharCode(65 + i), id: c.id, name: c.name }));

export function suggestCategory({ hint, title, description, categories, chosenId = null }) {
  const hintT = tokens(hint);
  const textT = tokens(`${title ?? ""} ${description ?? ""}`);
  const ranked = (categories ?? [])
    .map((c) => {
      const catT = tokens(c.name);
      const byHint = jaccard(hintT, catT);
      const byText = coverage(catT, textT);
      const matched = [...catT].filter((t) => hintT.has(t) || textT.has(t));
      return {
        id: c.id,
        name: c.name,
        score: Number(Math.max(byHint, byText * 0.9).toFixed(3)),
        matched_words: matched,
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  const chosen = chosenId ? ranked.find((c) => c.id === chosenId) ?? null : null;

  const note =
    "A suggestion, not an assignment. Pass the category_id you want to catalog.create_product; " +
    "it must be one of the categories that already exist. If none fits, that is a conversation with " +
    "a manager, not a new category.";

  /* The model named a category that is not in the set. Nothing is written by a
     draft, so this is reported rather than refused — but it is reported as the
     blocking problem it will be at the write. */
  if (chosenId && !chosen) {
    return {
      suggestion: null,
      chosen_id_exists: false,
      confidence: "none",
      reasoning:
        `category_id '${chosenId}' is not one of the ${ranked.length} categories that exist ` +
        `(${ranked.map((c) => c.name).join(", ") || "none yet"}). catalog.create_product will refuse it. ` +
        "Call catalog.categories and choose from that list.",
      alternatives: ranked.slice(0, 5),
      choices: lettered(ranked),
      closed_set_size: ranked.length,
      note,
    };
  }

  if (chosen) {
    const disagrees = best && best.score > 0 && best.id !== chosen.id;
    return {
      suggestion: { id: chosen.id, name: chosen.name },
      chosen_id_exists: true,
      chosen_by: "the model, from the existing set",
      confidence: chosen.score > 0 ? "high" : "asserted",
      reasoning:
        `"${chosen.name}" was chosen from the ${ranked.length} categories that already exist, so it is a ` +
        "category the shop has, not one invented to fit this product. " +
        (chosen.score > 0
          ? `The wording backs it up: ${JSON.stringify(chosen.matched_words)} appear in the copy.`
          : "Nothing in the copy lexically matches the category name, which is ordinary — " +
            "a gabardine trench coat is outerwear without saying so.") +
        (disagrees
          ? ` NOTE: on wording alone "${best.name}" scored higher (${best.score}); if that reads better to the human, say so.`
          : ""),
      alternatives: ranked.slice(0, 5),
      choices: lettered(ranked),
      closed_set_size: ranked.length,
      note,
    };
  }

  let confidence = "none";
  if (best && best.score >= 0.6) confidence = "high";
  else if (best && best.score >= 0.3) confidence = "medium";
  else if (best && best.score > 0) confidence = "low";

  const reasoning = !best
    ? "There are no categories in Square yet, so there is nothing to choose from."
    : best.score === 0
      ? `No category_id was given, and nothing in the wording overlaps any of the ${ranked.length} existing ` +
        `categories (${ranked.map((c) => c.name).join(", ")}). Pick the one that fits and pass its ` +
        "category_id, or ask the human which one this belongs in — do not create a category to fit it."
      : `No category_id was given, so this is a reading of the wording alone: "${best.name}" scores ` +
        `${best.score} on ${JSON.stringify(best.matched_words)}` +
        (runnerUp && runnerUp.score > 0
          ? `; next closest is "${runnerUp.name}" at ${runnerUp.score}.`
          : "; no other existing category overlaps at all.") +
        ` Drawn from the ${ranked.length} categories that already exist — this tool cannot invent one.`;

  return {
    suggestion: best && best.score > 0 ? { id: best.id, name: best.name } : null,
    chosen_id_exists: null,
    confidence,
    reasoning,
    alternatives: ranked.slice(0, 5),
    choices: lettered(ranked),
    closed_set_size: ranked.length,
    note,
  };
}

/** The near-duplicate refusal behind catalog.create_category. */
export function nearestCategory(name, categories) {
  const t = tokens(name);
  let worst = null;
  for (const c of categories ?? []) {
    const ct = tokens(c.name);
    const subset = ct.size > 0 && t.size > 0 && ([...ct].every((x) => t.has(x)) || [...t].every((x) => ct.has(x)));
    const score = subset ? 1 : jaccard(t, ct);
    if (!worst || score > worst.score) worst = { ...c, score: Number(score.toFixed(3)) };
  }
  return worst;
}

/* ── validation, before Square sees any of it ───────────────────────────── */

/*
 * One validator, three callers: the draft REPORTS these as `blocking`, and both
 * writes REFUSE on them in their read-only preflight — so a proposal that would
 * be refused never gets an approval token issued for it. Approving something
 * the tool would then refuse is how a gate becomes theatre (catalog.set_price
 * makes the same argument).
 */
export function validateProposal({ title, description, variations }) {
  const problems = [];

  const t = String(title ?? "").trim();
  if (t.length === 0) problems.push("title is empty — a product with no name cannot be sold or found");
  if (t.length > CAPS.CATALOG_TITLE_MAX) {
    problems.push(
      `title is ${t.length} characters; the cap is ${CAPS.CATALOG_TITLE_MAX}. That is a description, not a title — ` +
        "put the long version in the description field.",
    );
  }
  if (String(description ?? "").length > CAPS.CATALOG_DESCRIPTION_MAX) {
    problems.push(`description is longer than ${CAPS.CATALOG_DESCRIPTION_MAX} characters`);
  }

  const vs = Array.isArray(variations) ? variations : [];
  if (vs.length < CAPS.CATALOG_MIN_VARIATIONS) {
    problems.push(
      "no variations — a Square ITEM is not sellable without at least one ITEM_VARIATION. " +
        'A single-size garment still needs one, conventionally titled "One size".',
    );
  }
  if (vs.length > CAPS.CATALOG_MAX_VARIATIONS) {
    problems.push(`${vs.length} variations exceeds the cap of ${CAPS.CATALOG_MAX_VARIATIONS}`);
  }

  const seenSku = new Set();
  for (const [i, v] of vs.entries()) {
    const where = `variation ${i + 1} (${v?.title ?? "untitled"})`;
    if (!String(v?.title ?? "").trim()) problems.push(`${where}: title is empty`);

    const price = v?.price_minor;
    if (!Number.isInteger(price)) {
      problems.push(
        `${where}: price_minor must be an integer number of MINOR units — 4999 for £49.99, never 49.99`,
      );
    } else if (price < CAPS.PRICE_MIN_MINOR) {
      problems.push(
        `${where}: price ${price} is below the floor of ${CAPS.PRICE_MIN_MINOR} minor unit. ` +
          "Zero is not a discount, it is a broken write — refused here rather than sold for nothing.",
      );
    } else if (price > CAPS.PRICE_MAX_MINOR) {
      problems.push(
        `${where}: price ${price} exceeds the ceiling of ${CAPS.PRICE_MAX_MINOR} minor units. ` +
          "That is usually a major/minor unit confusion or a decimal-point slip; it is refused, not warned about.",
      );
    }

    if (!/^[A-Z]{3}$/.test(String(v?.currency ?? ""))) {
      problems.push(`${where}: currency must be an ISO-4217 code, so the amount means something`);
    }
    const sku = String(v?.sku ?? "").trim();
    if (sku) {
      if (seenSku.has(sku)) problems.push(`${where}: SKU '${sku}' is used twice in this product`);
      seenSku.add(sku);
    }
  }

  return problems;
}

/* The proposal, as a reviewable diff rather than a paragraph. */
function diffFor({ title, description, categoryName, variations, images, existing }) {
  const rows = [];
  const add = (op, field, from, to) => rows.push({ op, field, from, to });
  add(existing ? "replace" : "add", "title", existing?.title ?? null, title);
  if (description !== undefined) {
    add(existing ? "replace" : "add", "description", existing?.source_description ?? null, description ?? "");
  }
  add(existing ? "replace" : "add", "category", existing?.category_name ?? null, categoryName ?? null);
  for (const [i, v] of (variations ?? []).entries()) {
    add("add", `variations[${i}]`, null, {
      title: v.title,
      sku: v.sku ?? null,
      price_minor: v.price_minor,
      currency: v.currency,
    });
  }
  for (const [i, key] of (images ?? []).entries()) add("add", `images[${i}]`, null, key);
  return rows;
}

const VARIATION = {
  type: "object",
  schema: {
    title: { type: "string", required: true, maxLength: 80 },
    sku: { type: "string", maxLength: 40 },
    /* No `min`/`max` here on purpose: the BUSINESS cap is enforced in the
       preflight so the refusal can say why, in money, rather than "must be at
       least 1". The schema still refuses a non-integer. */
    price_minor: { type: "integer", required: true },
    currency: { type: "string", required: true, format: "currency" },
  },
};

const VARIATION_WITH_ID = {
  type: "object",
  schema: {
    ...VARIATION.schema,
    variant_id: { type: "string", format: "id" },
    /* Per-variation cost, once the owner revised the earlier "one vendor,
       one unit cost, applied uniformly" simplification: "all the variants
       can have a different unit cost too." undefined means "leave this
       one's own cost as it is" — the same "resend the whole thing, only
       what is actually being changed carries a value" convention every
       other optional field on this shape already uses. Only meaningful
       for a product that already has a vendor — see check() below. */
    unit_cost_minor: { type: "integer" },
  },
};

const IMAGES = {
  type: "array",
  maxItems: CAPS.CATALOG_MAX_IMAGES,
  of: { type: "string", maxLength: 200 },
};

/* Our R2 keys, checked before a write, so a typo is not discovered halfway
   through an upload to Square. */
async function checkImages(keys, media) {
  const found = [];
  for (const key of keys ?? []) {
    if (!isOurMediaKey(key)) {
      return { denied: `'${key}' is not a media key this application minted. Use catalog.upload_image to get one.` };
    }
    const head = await media.head(key);
    if (!head) {
      return {
        denied:
          `no bytes at '${key}'. If catalog.upload_image gave you an upload_url, the human has not ` +
          "finished uploading yet — wait for them, do not invent a key.",
      };
    }
    found.push(head);
  }
  return { found };
}

export const catalogWriteTools = {
  /* ── T0 ───────────────────────────────────────────────────────────────── */

  "catalog.categories": {
    tier: "T0",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "staff",
    describe:
      "List the product categories that ALREADY EXIST, INCLUDING SUBCATEGORIES at any nesting depth — " +
      "a row's own parent_id (null for a top-level category) is how the tree hangs together, and " +
      "numeric_id (null until assigned) is its own 2-digit style_id code, if it has one yet. This is a " +
      "closed set: catalog.create_product accepts a category_id from this list and refuses anything " +
      "else. Call this before drafting a product, and choose the most specific existing node rather " +
      "than reaching for a new one.",
    undo: null,
    schema: {},
    async run(_args, t) {
      const categories = await listCategories(t.db.catalog_mirror);
      return {
        categories,
        count: categories.length,
        closed_set: true,
        note:
          "Choose one of these. Creating a new category is catalog.create_category — a separate, " +
          "manager-gated action that is rarely the right answer.",
      };
    },
  },

  /*
   * The read path for a real, mirrored product — nothing else in this file
   * exposes one to the model as a callable result (catalog.draft_product
   * reasons about a NEW product; catalog.update_product's own preflight read
   * is internal bookkeeping, not a tool result). Without this, "these
   * fields should be visible... to agents" would be true only at the
   * instant of creation and never again. custom_fields comes back parsed,
   * not as a JSON string a model would have to re-parse itself.
   */
  "catalog.product": {
    tier: "T0",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "staff",
    describe:
      "Read one product from OUR mirror by handle: title, description, category, channel, every " +
      "variation, and custom_fields — whatever a spreadsheet import or catalog.set_custom_fields put " +
      "there that Square has no field for at all (unit cost, a vendor name, anything else we track " +
      "that Square doesn't). This is the read path for catalog.set_custom_fields and " +
      "catalog.update_product alike; it never calls Square.",
    undo: null,
    schema: {
      handle: { type: "string", required: true, format: "handle" },
    },
    async run(args, t) {
      const product = await productByHandle(t.db.catalog_mirror, args.handle);
      if (!product) return { error: `no product with handle '${args.handle}'` };
      const variations = await variantsOf(t.db.catalog_mirror, product.id);
      let custom_fields = {};
      try {
        custom_fields = JSON.parse(product.custom_fields || "{}");
      } catch {
        custom_fields = {};
      }
      return {
        product: { ...product, custom_fields },
        variations,
      };
    },
  },

  /* ── T1: propose, and store our own originals ─────────────────────────── */

  "catalog.upload_image": {
    tier: "T1",
    domain: "catalog",
    stores: [],
    resources: ["media"],
    minRole: "staff",
    describe:
      "Put one product photograph into OUR media bucket and return our key. Two modes. " +
      "With `bytes_base64` the bytes are stored immediately — but that path is capped at " +
      `${Math.round(CAPS.INLINE_IMAGE_MAX_BYTES / 1024)} KiB because the base64 has to be emitted by ` +
      "the model making this call, and a phone photograph is one to two million output tokens of it. " +
      "Without `bytes_base64` you get a short-lived upload link for the human to open in their browser; " +
      "the key is minted now, so you can carry on composing the product while they upload. " +
      "The original stays ours whatever happens to Square.",
    undo: "the key is never referenced until a T2 write attaches it; originals are never deleted",
    schema: {
      filename: { type: "string", required: true, maxLength: 120 },
      content_type: { type: "string", maxLength: 60 },
      caption: { type: "string", maxLength: 255 },
      /* The schema ceiling is the outer belt — it stops a megabyte of base64
         being parsed at all. The MEANINGFUL cap is CAPS.INLINE_IMAGE_MAX_BYTES,
         checked in the preflight so the refusal can say what to do instead. */
      bytes_base64: { type: "string", maxLength: 400_000 },
    },
    async check(args, t) {
      const contentType = contentTypeFor(args.filename, args.content_type);
      if (!contentType) {
        return {
          denied:
            `cannot tell what kind of image '${args.filename}' is. Give a content_type, or a filename ` +
            `with an extension. Stored types: ${STORABLE_IMAGE_TYPES.join(", ")}.`,
        };
      }
      if (args.bytes_base64) {
        const bytes = Math.floor((args.bytes_base64.length * 3) / 4);
        if (bytes > CAPS.INLINE_IMAGE_MAX_BYTES) {
          return {
            denied:
              `${bytes} bytes inline exceeds the ${CAPS.INLINE_IMAGE_MAX_BYTES}-byte cap for base64 in a tool ` +
              "argument. Call this tool again without bytes_base64 and give the human the upload link.",
          };
        }
      }
      return { ok: true, preflight: { contentType }, summary: `store ${args.filename} as an original` };
    },
    async run(args, t) {
      const { contentType } = t.preflight;
      const key = mediaKey(contentType);

      if (!args.bytes_base64) {
        const link = await t.media.uploadUrl({ key, actor: t.actor });
        return {
          key,
          stored: false,
          content_type: contentType,
          upload_url: link.url,
          expires_at: link.expires_at,
          square_will_accept: squareAcceptsType(contentType),
          /* A markdown link the human can click straight from chat, not a
             paragraph explaining what a link is. */
          how: `[Upload the photo](${link.url}) — opens already signed into ops.vemians.com.`,
        };
      }

      let bytes;
      try {
        const binary = atob(args.bytes_base64);
        bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      } catch (err) {
        return { error: `bytes_base64 is not valid base64 (${err.message})` };
      }
      const stored = await t.media.put(key, bytes, {
        contentType,
        actor: t.actor,
        caption: args.caption ?? "",
      });
      return {
        ...stored,
        stored: true,
        square_will_accept: squareAcceptsType(contentType),
        note: "The original is ours. Square gets a copy when a T2 write attaches this key to a product.",
      };
    },
  },

  "catalog.draft_product": {
    tier: "T1",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "staff",
    describe:
      "Turn a description and some uploaded photographs into a complete product proposal: title, " +
      "description, variations, a price read against comparable stock, and a CATEGORY SUGGESTION with " +
      "the reasoning behind it. Returns a diff for a human to review. THIS WRITES NOTHING — not to " +
      "Square, not to our stores. Feed the result to catalog.create_product when the human agrees. " +
      "EFFICIENT DRAFTING: this shop trades in USD only — pass \"USD\" without asking. Write the " +
      "description yourself from the title/category/photo rather than asking the person to dictate " +
      "one. A product with no real size/color options still needs one variation — title it " +
      "\"One size\" rather than asking whether it has variations. Only ask the person about a " +
      "genuine choice: what it is, the price, and (if it truly has them) the sizes or colors.",
    undo: "nothing to undo — this tool produces a proposal and changes no store, here or at Square",
    schema: {
      title: { type: "string", required: true, maxLength: CAPS.CATALOG_TITLE_MAX },
      description: { type: "string", required: true, maxLength: CAPS.CATALOG_DESCRIPTION_MAX },
      /* The model's own pick, from catalog.categories. Optional, and checked
         against the set rather than trusted. */
      category_id: { type: "string", format: "id" },
      category_hint: { type: "string", maxLength: 80 },
      variations: { type: "array", required: true, maxItems: CAPS.CATALOG_MAX_VARIATIONS, of: VARIATION },
      images: IMAGES,
    },
    async run(args, t) {
      const categories = await listCategories(t.db.catalog_mirror);
      const category = suggestCategory({
        hint: args.category_hint,
        title: args.title,
        description: args.description,
        categories,
        chosenId: args.category_id ?? null,
      });

      const band = category.suggestion ? await priceBand(t.db.catalog_mirror, category.suggestion.id) : null;
      const blocking = validateProposal(args);
      if (category.chosen_id_exists === false) {
        blocking.push(
          `category_id '${args.category_id}' is not one of the ${category.closed_set_size} categories that exist`,
        );
      }

      const pricing = (args.variations ?? []).map((v) => {
        let verdict = "within the caps";
        if (!Number.isInteger(v.price_minor)) verdict = "not an integer minor amount";
        else if (v.price_minor < CAPS.PRICE_MIN_MINOR || v.price_minor > CAPS.PRICE_MAX_MINOR) {
          verdict = "outside the caps — catalog.create_product will refuse this";
        } else if (band && v.price_minor < band.min_minor / 4) {
          verdict = `far below the ${band.currency} ${band.min_minor}-${band.max_minor} range of comparable stock — check it`;
        } else if (band && v.price_minor > band.max_minor * 4) {
          verdict = `far above the ${band.currency} ${band.min_minor}-${band.max_minor} range of comparable stock — check it`;
        }
        return { title: v.title, price_minor: v.price_minor, currency: v.currency, verdict };
      });

      return {
        writes_nothing: true,
        proposal: {
          title: args.title,
          description: args.description,
          variations: args.variations,
          images: args.images ?? [],
        },
        category,
        price: {
          comparable_stock: band,
          per_variation: pricing,
          basis: band
            ? `${band.sample} variation(s) already in "${category.suggestion.name}"`
            : "no comparable stock in the suggested category — the price is the human's call",
        },
        diff: diffFor({
          title: args.title,
          description: args.description,
          categoryName: category.suggestion?.name ?? null,
          variations: args.variations,
          images: args.images,
          existing: null,
        }),
        ready: blocking.length === 0,
        blocking,
        next:
          blocking.length === 0
            ? "catalog.create_product with this proposal and a category_id from catalog.categories. " +
              "That is a T2 write: a human approves it in a browser before anything reaches Square."
            : "Fix the blocking problems above and draft again. catalog.create_product would refuse this as it stands.",
      };
    },
  },

  /* ── T2: the writes ───────────────────────────────────────────────────── */

  "catalog.create_product": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square", "media"],
    minRole: "manager",
    describe:
      "Create a product in SQUARE — the ITEM and its ITEM_VARIATIONs — attach the uploaded originals " +
      "as images, and then sync our mirror from Square. Square is authoritative (ADR-009); this tool " +
      "never writes a product row directly. `category_id`, when given, MUST come from " +
      "catalog.categories; anything else is refused. It is OPTIONAL, though: give a `style_id` instead " +
      "(or as well) and its own digits are looked up against every category/subcategory's own " +
      "numeric_id — the deepest, most specific match wins — to derive the category automatically, the " +
      "same lookup catalog.set_square_attributes already uses for an edit. No match yet (the category " +
      "or subcategory this style_id names has not been created, or numbered, yet) is not a refusal — " +
      "the product is created UNASSIGNED, and picked up automatically the moment a matching " +
      "category/subcategory is created or numbered (catalog.create_category, " +
      "catalog.set_category_number). Prices are integer MINOR units, currency \"USD\" — this shop " +
      "trades in nothing else, so pass it without asking. A product with no real size/color options " +
      "still needs one variation, conventionally titled \"One size\"; VARIATION carries no quantity of " +
      "its own — set initial stock with inventory.adjust, by variant_id, once this call returns one. " +
      "This is a T2 write: it executes only after a human approves it. `custom_fields` is OURS, not " +
      "Square's: any field name -> string value we track that Square has no concept of at all (unit " +
      "cost, a spreadsheet column with no home elsewhere). It never reaches Square — it is written to " +
      "our own mirror right after the item is created — and survives every future sync untouched. Edit " +
      "it later with catalog.set_custom_fields. `style_id`, `vendor`, `vendor_code`, `unit_cost_minor` " +
      "and `commission` MAY be set here at creation time, since this call already reaches Square for " +
      "the item itself — style_id/commission ARE Square's own Custom Attributes; vendor is a real " +
      "Square Vendor entity (Retail Plus/Premium), reused by name or created; vendor_code/" +
      "unit_cost_minor live on that same vendor association (see catalog.set_square_attributes for the " +
      "full description of each). vendor_code/unit_cost_minor/commission all only make sense alongside " +
      "a vendor and are refused without one. `commission` is NOT re-stated for every item from a " +
      "vendor already known: a vendor's own rate is centralized (mirror_vendor.commission_pct, OURS, " +
      "not Square's — Square has no concept of a resale commission at all) and copied onto a new " +
      "product automatically whenever `vendor` is given with no `commission` of its own — refused only " +
      "when that vendor genuinely has nothing on file yet (brand new, or one Square already knew about " +
      "that this shop never gave a rate). An EXPLICIT `commission` given alongside a vendor becomes " +
      "that vendor's own new central rate, applied to every future item from it the same way. " +
      "style_id follows this shop's own NN-NN-NNN nomenclature and is refused if another product " +
      "already has it. INGESTING A BATCH (e.g. from a spreadsheet): every row needs style_id, title, " +
      "quantity (set afterward via inventory.adjust) and MSRP (variations[].price_minor); WITHOUT a " +
      "vendor, unit_cost_minor is also required (this shop's own cost of goods); WITH a vendor, give " +
      "commission only for that vendor's OWN FIRST row (or omit it entirely and let this tool refuse, " +
      "naming exactly which vendor still needs one) — do not ask a person to repeat a vendor's own " +
      "commission on every row, it is privileged information and this tool already carries it forward " +
      "once given.",
    undo: "withdraw the item in Square; nothing is deleted, and the originals in R2 are untouched",
    schema: {
      title: { type: "string", required: true, maxLength: CAPS.CATALOG_TITLE_MAX },
      description: { type: "string", maxLength: CAPS.CATALOG_DESCRIPTION_MAX },
      category_id: { type: "string", format: "id" },
      variations: { type: "array", required: true, maxItems: CAPS.CATALOG_MAX_VARIATIONS, of: VARIATION },
      images: IMAGES,
      style_id: { type: "string", maxLength: 20 },
      vendor: { type: "string", maxLength: 120 },
      vendor_code: { type: "string", maxLength: 80 },
      unit_cost_minor: { type: "integer" },
      commission: { type: "integer" },
      custom_fields: {
        type: "record",
        maxKeys: CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS,
        keyMaxLength: CAPS.CATALOG_CUSTOM_FIELD_KEY_MAX,
        valueMaxLength: CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX,
      },
    },
    async check(args, t) {
      const problems = validateProposal(args);
      const needsVendor = ["commission", "vendor_code", "unit_cost_minor"].filter((k) => args[k] !== undefined);
      if (needsVendor.length && !args.vendor) {
        problems.push(
          `${needsVendor.join("/")} ${needsVendor.length > 1 ? "were" : "was"} given without a vendor — these are ` +
            "facts about a VENDOR's product, so they do not apply without one",
        );
      }
      if (args.commission !== undefined && (!Number.isInteger(args.commission) || args.commission < 0 || args.commission > 100)) {
        problems.push(`commission '${args.commission}' must be a whole number 0-100`);
      }
      if (args.unit_cost_minor !== undefined && (!Number.isInteger(args.unit_cost_minor) || args.unit_cost_minor < 0)) {
        problems.push(`unit_cost_minor '${args.unit_cost_minor}' must be a non-negative integer minor amount`);
      }
      if (args.style_id !== undefined && !STYLE_ID_FORMAT.test(args.style_id)) {
        problems.push(
          `style_id '${args.style_id}' does not match this shop's own nomenclature — ` +
            "NN-NN-NNN (2-digit category, 2-digit subcategory, 3-digit item number), e.g. \"01-04-001\".",
        );
      }
      if (problems.length) {
        return {
          denied: `refused before Square saw it: ${problems.join(" | ")}`,
          detail: { reason: "invalid_product", problems },
        };
      }

      if (args.style_id !== undefined) {
        /* mirror_style_id_ledger, not just mirror_product's own current
           column — the owner's own words: "we want that style number to be
           held, so that you don't overwrite that style number and reuse it
           for something else." A style_id a DIFFERENT product moved away
           from is still reserved forever (schema.sql's own comment on the
           ledger table). */
        const conflict = await t.db.catalog_mirror
          .prepare(
            "SELECT mp.handle FROM mirror_style_id_ledger l JOIN mirror_product mp ON mp.id = l.product_id" +
              " WHERE l.style_id = ?",
          )
          .bind(args.style_id)
          .first();
        if (conflict) {
          return {
            denied: `style_id '${args.style_id}' is already assigned to '${conflict.handle}' — style IDs are unique, one per product, and never reused once given out`,
            detail: { reason: "style_id_conflict" },
          };
        }
      }

      /* REVISED: "let's not force vendor's commission to be stated out
         loud [on every item]... we store it in essential locations per
         vendor so that their commission is recorded in a central
         location and automatically applied" — the owner's own words.
         A vendor with a rate already on file (mirror_vendor.
         commission_pct, set by an earlier call that DID give one) needs
         nothing here at all — run() below copies that rate onto this
         product automatically. Only a vendor with NOTHING on file yet —
         brand new, or one Square already knew about (created directly in
         Square's own dashboard, say) that this shop has never given a
         rate — actually needs one stated now. */
      if (args.vendor !== undefined && args.commission === undefined) {
        const onFile = await vendorCommission(t.db.catalog_mirror, args.vendor);
        if (onFile === null) {
          return {
            denied: `vendor '${args.vendor}' has no commission on file yet — give one now (0-100); it is stored centrally against this vendor and applied automatically to every item from it after this`,
            detail: { reason: "vendor_needs_commission_on_file" },
          };
        }
      }

      /* REVISED: category_id is now optional — "if categories do not exist,
         then they will not get assigned to a category, they'll stay
         unassigned" — the owner's own words. The closed-set check only
         applies when a caller actually names one; leaving it out entirely
         is not an error, it defers to style_id's own derivation in run()
         (or leaves the product unassigned, if that matches nothing yet
         either). Read from the mirror, not a prompt instruction. */
      let chosen = null;
      if (args.category_id !== undefined) {
        const categories = await listCategories(t.db.catalog_mirror);
        chosen = categories.find((c) => c.id === args.category_id);
        if (!chosen) {
          return {
            denied:
              `category '${args.category_id}' is not one of the ${categories.length} categories that exist ` +
              `(${categories.map((c) => c.name).join(", ") || "none yet"}). ` +
              "Choose one from catalog.categories. Creating a category is catalog.create_category, a separate " +
              "manager decision — it is not something this tool does on the way past.",
            detail: { reason: "category_outside_closed_set", closed_set_size: categories.length },
          };
        }
      }

      const media = await checkImages(args.images, t.media);
      if (media.denied) return { denied: media.denied, detail: { reason: "unknown_media_key" } };

      const total = args.variations.map((v) => `${v.title} ${v.price_minor} ${v.currency}`).join(", ");
      const categoryNote = chosen
        ? `in ${chosen.name}`
        : args.style_id !== undefined
          ? "in whichever category/subcategory's own numeric_id matches its style_id, or unassigned if none does yet"
          : "with no category";
      return {
        ok: true,
        summary: `create "${args.title}" ${categoryNote} — ${args.variations.length} variation(s): ${total}`,
        preflight: { category: chosen, images: media.found },
      };
    },
    async run(args, t) {
      const images = [];
      for (const key of args.images ?? []) {
        /* attachable(), not bytes(): with no bucket the photograph is already
           in Square and comes back as an image ref, and re-sending the pixels
           would make a second CatalogImage for one photograph. */
        const original = await t.media.attachable(key);
        if (!original) return { error: `the original at '${key}' disappeared between the check and the write` };
        images.push({ ...original, caption: args.title });
      }

      /* "If categories do not exist, then they will not get assigned to a
         category, they'll stay unassigned. However, if that category is
         then later created with the matching ID... these assets should
         be auto assigned to that category" — the owner's own words. A
         category_id actually given always wins outright; otherwise a
         style_id is looked up the exact same way catalog.
         set_square_attributes already does for an edit, landing on the
         deepest matching subcategory/category or null (unassigned) if
         neither exists yet — never a refusal either way. */
      const categoryId =
        args.category_id !== undefined
          ? args.category_id
          : args.style_id !== undefined
            ? await deriveCategoryIdForStyleId(t.db.catalog_mirror, args.style_id)
            : null;
      /* "We store it in essential locations per vendor so that their
         commission is recorded in a central location and automatically
         applied" — the owner's own words. An explicit commission always
         wins outright; otherwise, a named vendor's own on-file rate
         (mirror_vendor.commission_pct) is copied onto this product —
         check() above already refused this call if neither exists. */
      const commissionPct =
        args.commission !== undefined
          ? args.commission
          : args.vendor !== undefined
            ? await vendorCommission(t.db.catalog_mirror, args.vendor)
            : undefined;
      const out = await t.square.createProduct({
        title: args.title,
        description: args.description ?? "",
        categoryId,
        variations: args.variations,
        images,
        styleId: args.style_id,
        vendor: args.vendor,
        vendorCode: args.vendor_code,
        unitCostMinor: args.unit_cost_minor,
        commissionPct,
      });

      /* custom_fields never reaches Square — see the note on the schema
         above and on catalog.set_channel below. A fresh product has none
         yet, so this is a plain SET rather than the read-merge-write
         catalog.set_custom_fields needs for an EXISTING one. */
      if (args.custom_fields && Object.keys(args.custom_fields).length) {
        await t.db.catalog_mirror
          .prepare("UPDATE mirror_product SET custom_fields = ? WHERE handle = ?")
          .bind(JSON.stringify(args.custom_fields), out.product.handle)
          .run();
      }

      /* An EXPLICITLY given commission becomes this vendor's own new
         central rate — the moment this write ran is the moment this
         became the vendor's own most-current known arrangement. Only
         after t.square.createProduct() returns: that call's own
         syncAfterWrite is what gives a BRAND NEW vendor its first
         mirror_vendor row at all (vendorRef() itself only ever calls
         Square, never the mirror directly — this file's own header,
         "the agent writes to Square, never to the mirror" — so there is
         nothing to UPDATE here before that sync has actually run). */
      if (args.vendor !== undefined && args.commission !== undefined) {
        await t.db.catalog_mirror
          .prepare("UPDATE mirror_vendor SET commission_pct = ? WHERE name = ? COLLATE NOCASE")
          .bind(args.commission, args.vendor)
          .run();
      }

      return {
        created: true,
        product: { ...out.product, custom_fields: args.custom_fields ?? {} },
        category: out.category,
        images: { ...out.images, originals_kept_in_r2: (args.images ?? []).length },
        mirror_sync: out.sync,
        authority: "square",
      };
    },
  },

  "catalog.update_product": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square", "media"],
    minRole: "manager",
    describe:
      "Edit an existing product in SQUARE by handle — title, description, category, variations, extra " +
      "images — then sync our mirror. A variation carrying `variant_id` is edited; one without is added. " +
      "Nothing is removed: withdrawing a product or a variation is a separate path, because deleting a " +
      "commercial record destroys its history. Same T2 gate as creation.",
    undo: "another edit; Square keeps the version history and the mirror archives rather than deletes",
    schema: {
      handle: { type: "string", required: true, format: "handle" },
      title: { type: "string", maxLength: CAPS.CATALOG_TITLE_MAX },
      description: { type: "string", maxLength: CAPS.CATALOG_DESCRIPTION_MAX },
      category_id: { type: "string", format: "id" },
      variations: { type: "array", maxItems: CAPS.CATALOG_MAX_VARIATIONS, of: VARIATION_WITH_ID },
      images: IMAGES,
    },
    async check(args, t) {
      const existing = await productByHandle(t.db.catalog_mirror, args.handle);
      if (!existing) return { denied: `no product with handle '${args.handle}' in the mirror` };

      /* Validate the RESULTING product, not the patch: an edit that leaves a
         product with no sellable variation, or reprices one to zero, is the
         same broken product as a creation that never worked. The merge is the
         same function the write uses, so the two cannot disagree. */
      const current = await variantsOf(t.db.catalog_mirror, existing.id);
      const merged = mergeVariations(current, args.variations);
      if (merged.error) return { denied: `${merged.error} ('${args.handle}')` };
      const resulting = {
        title: args.title ?? existing.title,
        description: args.description ?? existing.source_description,
        variations: merged.variations,
      };
      const problems = validateProposal(resulting);
      if (problems.length) {
        return {
          denied: `refused before Square saw it: ${problems.join(" | ")}`,
          detail: { reason: "invalid_product", problems },
        };
      }

      /* A per-variation unit_cost_minor is a fact about a VENDOR's product
         (the same reasoning catalog.set_square_attributes' own needsVendor
         check already applies at the product level) — refused here the
         same way, before Square ever sees it. */
      if ((args.variations ?? []).some((v) => v.unit_cost_minor !== undefined) && !existing.vendor) {
        return {
          denied: `'${args.handle}' has no vendor, so unit_cost_minor does not apply — these are facts about a VENDOR's product. Set a vendor at the same time, or first.`,
          detail: { reason: "unit_cost_without_vendor" },
        };
      }

      let chosen = null;
      if (args.category_id) {
        const categories = await listCategories(t.db.catalog_mirror);
        chosen = categories.find((c) => c.id === args.category_id);
        if (!chosen) {
          return {
            denied:
              `category '${args.category_id}' is not one of the ${categories.length} categories that exist. ` +
              "Choose one from catalog.categories; catalog.create_category is a separate manager decision.",
            detail: { reason: "category_outside_closed_set" },
          };
        }
      }

      const media = await checkImages(args.images, t.media);
      if (media.denied) return { denied: media.denied, detail: { reason: "unknown_media_key" } };

      return {
        ok: true,
        summary:
          `edit "${existing.title}" (${args.handle})` +
          (args.title && args.title !== existing.title ? ` -> "${args.title}"` : "") +
          (chosen ? `, category -> ${chosen.name}` : "") +
          (args.variations?.length ? `, ${args.variations.length} variation(s)` : "") +
          (args.images?.length ? `, +${args.images.length} image(s)` : ""),
        preflight: { existing, category: chosen },
      };
    },
    async run(args, t) {
      const images = [];
      for (const key of args.images ?? []) {
        /* attachable(), for the same reason as create_product above. */
        const original = await t.media.attachable(key);
        if (!original) return { error: `the original at '${key}' disappeared between the check and the write` };
        images.push({ ...original, caption: args.title ?? t.preflight.existing.title });
      }

      const out = await t.square.updateProduct({
        handle: args.handle,
        title: args.title,
        description: args.description,
        categoryId: args.category_id,
        variations: args.variations,
        images,
      });

      return {
        updated: true,
        product: out.product,
        category: out.category,
        images: { ...out.images, originals_kept_in_r2: (args.images ?? []).length },
        mirror_sync: out.sync,
        authority: "square",
      };
    },
  },

  "catalog.create_category": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "RARELY THE RIGHT TOOL. Create a new product category — or, with parent_id, a SUBCATEGORY nested " +
      "under an existing one, any number of levels deep — in Square. Almost every product belongs in a " +
      "category that already exists — call catalog.categories and choose from it. Categories are the " +
      "storefront's navigation, and an agent that mints one whenever the existing name is not quite the " +
      "phrase it had in mind produces 'Coats', 'Outerwear', 'Jackets' and 'Coats & Jackets' inside a " +
      "month, at which point browsing the shop tells a customer nothing. This tool refuses a lexical " +
      "near-duplicate among SIBLINGS (same parent) outright — a name may repeat under a DIFFERENT " +
      "parent, since what's unique is the numeric_id, not the name — and everything it does not refuse " +
      "still needs a manager to approve it. numeric_id is optional here (catalog.set_category_number " +
      "can still assign or change it later) but, when given, is validated against the same two pools " +
      "that tool enforces — and, exactly like catalog.set_category_number, RETROACTIVELY re-assigns " +
      "any product already sitting unassigned (or under a looser fallback match) whose own style_id " +
      "digits match this brand-new numeric_id: an item ingested before its category existed yet is not " +
      "stuck unassigned forever, it is picked up the moment a matching category or subcategory finally " +
      "is created. Use it when the shop genuinely starts selling something it has never sold before, " +
      "or is organizing its own tree further.",
    undo: "withdraw the category in Square; the mirror archives it and keeps the row",
    schema: {
      name: { type: "string", required: true, maxLength: 60 },
      parent_id: { type: "string", format: "id" },
      /* "The add row is supposed to have ID as well" — set it at creation
         time instead of needing a separate catalog.set_category_number
         follow-up call right after. Optional: a manager can still leave it
         blank and assign one later, exactly as before this. */
      numeric_id: { type: "string", maxLength: 2 },
      reason: {
        type: "string",
        required: true,
        maxLength: CAPS.MAX_TEXT,
      },
    },
    async check(args, t) {
      const name = args.name.trim();
      if (!name) return { denied: "a category needs a name" };

      const categories = await listCategories(t.db.catalog_mirror);
      let parent = null;
      if (args.parent_id) {
        parent = categories.find((c) => c.id === args.parent_id);
        if (!parent) return { denied: `no category '${args.parent_id}' to nest this under` };
      }

      /* Siblings only — same parent (both top-level, or both nested under
         the SAME node) — never the whole tree. The owner's own words: "a
         subcategory name can be used more than once [under a different
         parent]. The ID cannot." A flat, tree-wide check would refuse a
         perfectly fine "Casual" under both "Pants" and "Shirts". */
      const siblings = categories.filter((c) => (c.parent_id ?? null) === (args.parent_id ?? null));
      const exact = siblings.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (exact) return { denied: `"${exact.name}" already exists${parent ? ` under "${parent.name}"` : ""}. Use it.` };

      const near = nearestCategory(name, siblings);
      if (near && near.score >= CAPS.CATEGORY_DUPLICATE_SIMILARITY) {
        return {
          denied:
            `"${name}" overlaps the existing${parent ? ` "${parent.name}"` : ""} category "${near.name}" (${near.score}). ` +
            "Two near-identical categories make the storefront navigation meaningless, which is exactly " +
            "what this refusal exists to prevent. Put the product in the existing category, or rename " +
            "that category deliberately — do not add a second one beside it.",
          detail: { reason: "near_duplicate_category", nearest: near.name, score: near.score },
        };
      }

      /* Same validation catalog.set_category_number's own check() applies,
         inlined rather than shared: two SEPARATE '00'-'99' pools (every
         top-level category shares one, every subcategory regardless of
         depth or parent shares the other), the same partial unique indexes
         in schema.sql enforce at the database level either way. */
      let numericId = null;
      if (args.numeric_id !== undefined && args.numeric_id.trim() !== "") {
        numericId = args.numeric_id.trim();
        if (!/^\d{2}$/.test(numericId)) {
          return { denied: `numeric_id '${args.numeric_id}' must be exactly two digits, "00" through "99"` };
        }
        const isSubcategory = Boolean(parent);
        const conflict = categories.find((c) => c.numeric_id === numericId && (c.parent_id !== null) === isSubcategory);
        if (conflict) {
          return {
            denied:
              `numeric_id '${numericId}' is already assigned to "${conflict.name}" — ${
                isSubcategory ? "every subcategory in the whole tree" : "every top-level category"
              } shares one pool, so this number is not available until that one is freed.`,
          };
        }
      }

      return {
        ok: true,
        summary:
          `create the ${parent ? "subcategory" : "category"} "${name}"` +
          `${parent ? ` under "${parent.name}"` : ""} beside the ${siblings.length} that exist there — ${args.reason}`,
        preflight: { name, parentId: args.parent_id ?? null, numericId, existing: siblings.length, nearest: near },
      };
    },
    async run(args, t) {
      const out = await t.square.createCategory({ name: t.preflight.name, parentId: t.preflight.parentId });
      /* numeric_id is OURS, not Square's — the same direct mirror write
         catalog.set_category_number's own run() makes, applied here to the
         row this call itself just created.
         REVISED: "if that category is then later created with the
         matching ID, then... these assets should be auto assigned to
         that category" — the owner's own words. A brand-new numeric_id
         cannot already match any existing product's own CURRENT category
         (nothing could have pointed AT this category before it existed),
         but a product ingested earlier with a style_id whose digits
         happen to match this exact numeric_id may already be sitting
         unassigned (or filed under a looser fallback match) — exactly
         the case resortProductsByStyleId exists to fix. Skipping it here
         was the actual bug: this call is the FIRST moment such a product
         could ever become assignable, so it is also the first moment
         this resort needs to run. */
      let resorted = 0;
      let resortErrors = [];
      if (t.preflight.numericId && out.category) {
        await t.db.catalog_mirror
          .prepare("UPDATE mirror_category SET numeric_id = ? WHERE id = ?")
          .bind(t.preflight.numericId, out.category.id)
          .run();
        out.category.numeric_id = t.preflight.numericId;
        ({ resorted, errors: resortErrors } = await t.square.resortProductsByStyleId());
      }
      return {
        created: true,
        category: out.category,
        existing_before: t.preflight.existing,
        mirror_sync: out.sync,
        products_resorted: resorted,
        resort_errors: resortErrors,
        authority: "square",
      };
    },
  },

  /*
   * The deliberate rename catalog.create_category's own describe text
   * points at ("rename that category deliberately — do not add a second
   * one beside it"). A real Square write (category_data.name), not a
   * mirror-only field like numeric_id, since the category's name is
   * Square's own storefront navigation label (ADR-009).
   */
  "catalog.rename_category": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Rename an EXISTING category or subcategory in Square. Refuses a lexical exact-duplicate among " +
      "SIBLINGS (same parent) — the same rule catalog.create_category enforces on creation, so a rename " +
      "can never produce the 'Coats'/'Outerwear' duplication that tool already refuses to create. Does " +
      "not touch numeric_id, parent, or any product's own category assignment — only the name.",
    undo: "another catalog.rename_category call, back to the previous name",
    schema: {
      category_id: { type: "string", required: true, format: "id" },
      name: { type: "string", required: true, maxLength: 60 },
    },
    async check(args, t) {
      const categories = await listCategories(t.db.catalog_mirror);
      const category = categories.find((c) => c.id === args.category_id);
      if (!category) return { denied: `no category '${args.category_id}'` };

      const name = args.name.trim();
      if (!name) return { denied: "a category needs a name" };
      if (name === category.name) return { denied: `"${category.name}" is already named that` };

      const siblings = categories.filter(
        (c) => c.id !== category.id && (c.parent_id ?? null) === (category.parent_id ?? null),
      );
      const exact = siblings.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (exact) return { denied: `"${exact.name}" already exists at that level. Use it instead of renaming into a duplicate.` };

      return {
        ok: true,
        summary: `rename "${category.name}" to "${name}"`,
        preflight: { categoryId: category.id, name },
      };
    },
    async run(args, t) {
      const out = await t.square.renameCategory({ categoryId: t.preflight.categoryId, name: t.preflight.name });
      return {
        renamed: true,
        category: out.category,
        mirror_sync: out.sync,
        authority: "square",
      };
    },
  },

  /*
   * "Delete" a category/subcategory — never a real DELETE (ADR-008: every
   * mirror_* table archives, never deletes). Refuses outright while the
   * category still has subcategories of its own — the owner's own words:
   * "I should not be able to delete a category until it has no more
   * subcategories" — so the UI disables the button instead of ever
   * reaching this refusal in normal use, the same disabled-not-hidden
   * treatment a control gets when its own precondition is not yet met.
   */
  "catalog.remove_category": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Remove a category or subcategory from the working set — deletes the object in Square " +
      "(DeleteCatalogObject; unlike an ITEM, a CATEGORY has no presence lifecycle to archive it through " +
      "instead — Square itself refuses to disable one). The mirror row is only ever archived, never " +
      "deleted, the same as every mirror_* table (ADR-008) — it picks up archived_at on the next sync " +
      "once Square reports the object is_deleted. Refuses outright while the category still has any " +
      "subcategory of its own — remove those first, or this would silently strand them with a parent no " +
      "longer in the working set — and refuses outright while any product is still assigned to it, " +
      "since removing it out from under them would leave those products uncategorized with no warning.",
    undo: "recreate it in Square directly — there is no restore tool here yet",
    schema: {
      category_id: { type: "string", required: true, format: "id" },
    },
    async check(args, t) {
      const categories = await listCategories(t.db.catalog_mirror);
      const category = categories.find((c) => c.id === args.category_id);
      if (!category) return { denied: `no category '${args.category_id}'` };

      const children = categories.filter((c) => c.parent_id === category.id);
      if (children.length > 0) {
        return {
          denied:
            `"${category.name}" still has ${children.length} subcategor${children.length === 1 ? "y" : "ies"} ` +
            `of its own (${children.map((c) => c.name).join(", ")}) — remove those first.`,
        };
      }

      /* "We probably should not enable the deletion of subcategories if
         they have items assigned to them" — the owner's own words,
         applied to any category (top-level or subcategory alike) with a
         product still sitting in it, the same reasoning the subcategory
         check just above already follows: removing the category out from
         under a product would leave it silently uncategorized. */
      const assigned = await t.db.catalog_mirror
        .prepare("SELECT COUNT(*) AS n FROM mirror_product_index WHERE category_id = ?")
        .bind(category.id)
        .first("n");
      if (assigned > 0) {
        return {
          denied:
            `"${category.name}" still has ${assigned} product${assigned === 1 ? "" : "s"} assigned to it — ` +
            "move them to a different category first.",
        };
      }

      return {
        ok: true,
        summary: `remove "${category.name}" from the working set`,
        preflight: { categoryId: category.id },
      };
    },
    async run(args, t) {
      const out = await t.square.removeCategory({ categoryId: t.preflight.categoryId });
      return {
        removed: true,
        mirror_sync: out.sync,
        authority: "square",
      };
    },
  },

  /*
   * OURS only, never Square's — a 2-digit code this shop assigns to a
   * category/subcategory, later embedded in a product's own style_id
   * (NN-NN-NNN). Deliberately its own tool, not folded into
   * catalog.create_category: it needs no Square call at all (catalog.
   * set_channel's own shape), and can re-assign/correct an already-created
   * category's number without recreating it.
   */
  "catalog.set_category_number": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Assign or change a category or subcategory's own 2-digit numeric_id ('00'-'99'), the code that " +
      "later becomes a product's own style_id segment (NN-NN-NNN: the first NN is a TOP-LEVEL " +
      "category's own numeric_id, the second is a SUBCATEGORY's, at whatever nesting depth). Top-level " +
      "categories share ONE '00'-'99' pool; ALL subcategories, regardless of depth or parent, share a " +
      "SEPARATE '00'-'99' pool of their own — once a number is given to any subcategory anywhere in the " +
      "tree, it stops being available to any other, even one nested under a different category " +
      "entirely. Assigning or changing this RETROACTIVELY re-sorts every existing product whose own " +
      "style_id segment now matches it — a real Square write (reporting_category) for each one, not " +
      "just a mirror update, since Square is authoritative for a product's own category (ADR-009). " +
      "Give numeric_id to set it, or clear: true (not both) to remove it.",
    undo: "another catalog.set_category_number call, back to the previous value (or clear: true)",
    schema: {
      category_id: { type: "string", required: true, format: "id" },
      /* Not required: the generic schema validator refuses an empty STRING
         outright ("must not be empty"), so clearing an existing numeric_id
         needs its own explicit flag rather than numeric_id: "". */
      numeric_id: { type: "string", maxLength: 2 },
      clear: { type: "boolean" },
    },
    async check(args, t) {
      const categories = await listCategories(t.db.catalog_mirror);
      const category = categories.find((c) => c.id === args.category_id);
      if (!category) return { denied: `no category '${args.category_id}'` };

      if (args.clear && args.numeric_id !== undefined) {
        return { denied: "give either numeric_id or clear: true, not both" };
      }
      if (!args.clear && args.numeric_id === undefined) {
        return { denied: "give a numeric_id ('00' through '99'), or clear: true to remove the existing one" };
      }
      const numericId = args.clear ? null : args.numeric_id;
      if (numericId !== null && !/^\d{2}$/.test(numericId)) {
        return { denied: `numeric_id '${args.numeric_id}' must be exactly two digits, "00" through "99"` };
      }
      if (numericId === category.numeric_id) {
        return { denied: `"${category.name}" already has numeric_id '${numericId ?? "(none)"}'` };
      }

      if (numericId !== null) {
        const isSubcategory = category.parent_id !== null;
        const conflict = categories.find(
          (c) => c.id !== category.id && c.numeric_id === numericId && (c.parent_id !== null) === isSubcategory,
        );
        if (conflict) {
          return {
            denied:
              `numeric_id '${numericId}' is already assigned to "${conflict.name}" — ${
                isSubcategory ? "every subcategory in the whole tree" : "every top-level category"
              } shares one pool, so this number is not available until that one is freed.`,
          };
        }
      }

      return {
        ok: true,
        summary: `set "${category.name}"'s own numeric_id to '${numericId ?? "(none)"}' — resorts every matching product`,
        preflight: { category, numericId },
      };
    },
    async run(args, t) {
      /* numeric_id is OURS, not Square's — a direct mirror write, the same
         "no second writer to diverge from" shape catalog.set_channel's own
         channel column already establishes, extended here to
         mirror_category. The RETROACTIVE re-sort that follows is a real
         Square write per affected product (reporting_category IS a
         Square fact), so it goes through t.square, never a direct write
         of its own. */
      await t.db.catalog_mirror
        .prepare("UPDATE mirror_category SET numeric_id = ? WHERE id = ?")
        .bind(t.preflight.numericId, t.preflight.category.id)
        .run();
      const { resorted, errors } = await t.square.resortProductsByStyleId();
      return {
        updated: true,
        category_id: t.preflight.category.id,
        numeric_id: t.preflight.numericId,
        previous_numeric_id: t.preflight.category.numeric_id,
        products_resorted: resorted,
        resort_errors: errors,
        authority: "ours",
      };
    },
  },

  "catalog.resync_from_square": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Force an immediate FULL resync from Square, bypassing the scheduled sync's own incremental cursor " +
      "(Test-PRD-P0-48-scheduled_mirror_sync, every 15 minutes). The owner's own question, after adding " +
      "categories directly in Square's own dashboard: 'why aren't you synchronizing them?' — the scheduled " +
      "sync only does a full sweep on its very first-ever run; every run after that asks Square for objects " +
      "updated SINCE its last cursor, so a category that already existed in Square and has not been TOUCHED " +
      "since (in particular its own parent_category link, a field this mirror only started reading once " +
      "nested categories shipped) never surfaces on its own — only a real full sweep re-reads it. Safe to " +
      "run any time: every upsert underneath is idempotent (external_ref UNIQUE), the same property that " +
      "already makes the cron's own full-sweep path a no-op on an unchanged catalog.",
    undo:
      "Not applicable — this only re-reads Square's own current state into the mirror (ADR-009); nothing " +
      "it touches is ours to revert, and running it again changes nothing beyond what Square itself says.",
    schema: {},
    async run(_args, t) {
      const counts = await t.square.adapter.pullCatalog({ full: true });
      return { resynced: true, full: true, ...counts };
    },
  },

  "catalog.set_channel": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "manager",
    describe:
      "Set whether a product is ALSO browsable in the storefront grid, by handle: `website` (shown in the " +
      "grid and has its own page) or `direct_link` (has its own page, but left out of the grid — for " +
      "someone with the link, not for browsing). Every product already has a working page; this only " +
      "decides whether it is ALSO listed for browsing. This is OURS, not Square's — Square has no idea " +
      "our storefront exists, so this never calls Square and never triggers a mirror sync; it writes the " +
      "mirror directly and the value survives every future sync untouched. Every product starts " +
      "`direct_link` until a person opts it into the grid.",
    undo: "another catalog.set_channel call, back to the previous value",
    schema: {
      handle: { type: "string", required: true, format: "handle" },
      channel: { type: "string", required: true, enum: ["website", "direct_link"] },
    },
    async check(args, t) {
      const existing = await productByHandle(t.db.catalog_mirror, args.handle);
      if (!existing) return { denied: `no product with handle '${args.handle}' in the mirror` };
      if (existing.channel === args.channel) {
        return { denied: `'${args.handle}' is already ${args.channel}` };
      }
      return {
        ok: true,
        summary: `set "${existing.title}" (${args.handle}) from ${existing.channel} to ${args.channel}`,
        preflight: { existing },
      };
    },
    async run(args, t) {
      await t.db.catalog_mirror
        .prepare("UPDATE mirror_product SET channel = ? WHERE handle = ?")
        .bind(args.channel, args.handle)
        .run();
      return {
        updated: true,
        handle: args.handle,
        channel: args.channel,
        previous_channel: t.preflight.existing.channel,
        authority: "ours",
      };
    },
  },

  /*
   * WHETHER SQUARE SELLS IT AT ALL — not `channel` (OURS: whether it is also
   * browsable here), and not deleting anything (ADR-008: archive, never
   * delete). The Items tab's own "Active" checkbox, beside "Web".
   */
  "catalog.set_active": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Archive or restore a product in Square, by handle. Archiving withdraws it from sale at " +
      "this shop's one location without deleting the authoritative record (ADR-008) — the mirror " +
      "row is archived, not removed, and the product's own page keeps working for anyone with a " +
      "direct link either way; this only affects whether it shows up as sellable stock. Restoring " +
      "undoes exactly that. This is Square's own lifecycle, not catalog.set_channel's OURS-only " +
      "website/direct_link choice — the two are independent.",
    undo: "another catalog.set_active call with the opposite value",
    schema: {
      handle: { type: "string", required: true, format: "handle" },
      active: { type: "boolean", required: true },
    },
    async check(args, t) {
      /* productByHandleAny, not productByHandle: a product this call would
         RESTORE is archived, and mirror_product_index — everything
         productByHandle reads — excludes archived rows by definition. */
      const existing = await t.square.productByHandleAny(args.handle);
      if (!existing) return { denied: `no product with handle '${args.handle}' in the mirror` };
      /* "active", not "!= archived": the same two-state reading the tile's
         own isActive already uses (P0-131's own "draft and archived both
         collapse into the same inactive bucket") — draft is unreachable in
         practice (Square itself has no draft/active/archived, see catalog.js's
         own comment), but this keeps the checkbox and this refusal agreeing
         about what "already active" means either way. */
      const currentlyActive = existing.status === "active";
      if (currentlyActive === args.active) {
        return { denied: `'${args.handle}' is already ${args.active ? "active" : "archived"}` };
      }
      return {
        ok: true,
        summary: `${args.active ? "restore" : "archive"} "${existing.title}" (${args.handle})`,
        preflight: { existing },
      };
    },
    async run(args, t) {
      if (args.active) {
        await t.square.adapter.restoreProduct(args.handle);
      } else {
        await t.square.adapter.retractProduct(args.handle);
      }
      /* The write to Square (the authority, ADR-009) already happened by
         this point. A failed resync must not make the whole call look
         refused — the same reasoning inventory.adjust's own run() applies
         after its pushInventory, hardened after the production incident
         where a flaky post-write pullInventory did exactly that. The
         nightly reconcile catches up regardless. */
      try {
        await t.square.syncAfterWrite();
      } catch (err) {
        console.error(`ERROR catalog.set_active: immediate resync failed, cron will reconcile — ${err.message}`);
        return { active: args.active, handle: args.handle, synced: false };
      }
      return { active: args.active, handle: args.handle, synced: true };
    },
  },

  /*
   * A patch, not a replacement — the same shape a person edits one field of
   * a form with, without having to restate every other field back. Setting
   * a key to the empty string REMOVES it, so one tool both adds/updates and
   * deletes rather than needing a second one for the opposite direction.
   */
  "catalog.set_custom_fields": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "manager",
    describe:
      "Add, change or remove OUR OWN extra fields on a product, by handle — whatever a spreadsheet " +
      "import carried, or anything else \"our workers need more data tracking than square offers\" " +
      "(the owner's own words): unit cost, a reorder note, a fabric detail, anything Square has no " +
      "field for at all. (style_id, vendor and commission are NOT set here any more — " +
      "catalog.set_square_attributes does those, as Square's own Custom Attributes.) `fields` is a PATCH merged into what is already there: a key with a real " +
      "value is set or updated, a key set to the empty string \"\" is removed, and every key not " +
      "mentioned is left untouched. This is OURS, not Square's — it never calls Square and never " +
      "triggers a mirror sync; it writes the mirror directly and the value survives every future " +
      "sync untouched, the same way catalog.set_channel's own value does. Read the current fields " +
      "first with catalog.product.",
    undo: "another catalog.set_custom_fields call, patching the previous values back",
    schema: {
      handle: { type: "string", required: true, format: "handle" },
      fields: {
        type: "record",
        required: true,
        maxKeys: CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS,
        keyMaxLength: CAPS.CATALOG_CUSTOM_FIELD_KEY_MAX,
        valueMaxLength: CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX,
      },
    },
    async check(args, t) {
      const existing = await productByHandle(t.db.catalog_mirror, args.handle);
      if (!existing) return { denied: `no product with handle '${args.handle}' in the mirror` };

      let current = {};
      try {
        current = JSON.parse(existing.custom_fields || "{}");
      } catch {
        current = {};
      }

      const merged = { ...current };
      const added = [];
      const updated = [];
      const removed = [];
      for (const [key, value] of Object.entries(args.fields)) {
        const had = Object.prototype.hasOwnProperty.call(current, key);
        if (value === "") {
          if (had) {
            delete merged[key];
            removed.push(key);
          }
          continue;
        }
        if (!had) added.push(key);
        else if (current[key] !== value) updated.push(key);
        merged[key] = value;
      }

      if (!added.length && !updated.length && !removed.length) {
        return { denied: `'${args.handle}' already has exactly these fields — nothing would change` };
      }
      if (Object.keys(merged).length > CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS) {
        return {
          denied:
            `this would leave '${args.handle}' with more than ${CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS} ` +
            "custom fields — remove one first",
        };
      }

      const changes = [
        ...added.map((k) => `+${k}`),
        ...updated.map((k) => `~${k}`),
        ...removed.map((k) => `-${k}`),
      ].join(", ");
      return {
        ok: true,
        summary: `set custom fields on "${existing.title}" (${args.handle}): ${changes}`,
        preflight: { existing, current, merged },
      };
    },
    async run(args, t) {
      const { merged, current } = t.preflight;
      await t.db.catalog_mirror
        .prepare("UPDATE mirror_product SET custom_fields = ? WHERE handle = ?")
        .bind(JSON.stringify(merged), args.handle)
        .run();
      return {
        updated: true,
        handle: args.handle,
        custom_fields: merged,
        previous_custom_fields: current,
        authority: "ours",
      };
    },
  },

  "catalog.set_square_attributes": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Set a product's own Style ID, vendor, vendor code, unit cost and/or commission, by handle. " +
      "style_id and commission are OUR OWN Square Custom Attributes; vendor is a real Square Vendor " +
      "entity (Retail Plus/Premium), and vendor_code/unit_cost_minor live on that same vendor " +
      "association — all five call Square, then sync the mirror back, unlike catalog.set_channel or " +
      "catalog.set_custom_fields. style_id follows this shop's own nomenclature — NN-NN-NNN: a " +
      "2-digit category, a 2-digit subcategory, a 3-digit item number, e.g. \"01-04-001\" — and is " +
      "NEVER generated here: give one, or leave it as it is. Refused if another product already has " +
      "the same style_id — style IDs are unique, one per product. vendor is a plain name: an " +
      "existing Square Vendor with that name is reused, or a new one is created. vendor_code is the " +
      "VENDOR's own SKU/product code for this item (their invoice/catalog identifier — never Square's " +
      "own `sku`, never this shop's `style_id`). unit_cost_minor is what this shop PAID the vendor, " +
      "integer minor units like every other price in this codebase. commission is an integer 0-100 " +
      "(a percentage) — the owner's own words: \"that's only for vendors — anything that has a vendor, " +
      "it has a commission\" — so vendor_code/unit_cost_minor/commission all only make sense for a " +
      "product that HAS a vendor, resolved from whatever this same call also sets, and are refused " +
      "for one with none. `commission` is NOT re-stated for every item, though: a vendor's own rate " +
      "is centralized (mirror_vendor.commission_pct, OURS, not Square's) and copied onto THIS product " +
      "automatically whenever `vendor` is being (re)assigned here with no `commission` of its own — " +
      "refused only when that vendor genuinely has nothing on file yet. An EXPLICIT `commission` given " +
      "alongside a vendor becomes that vendor's own new central rate, applied the same way to every " +
      "future item from it — reassigning a product to a DIFFERENT vendor with no fresh commission " +
      "adopts THAT vendor's own on-file rate, never the product's previous vendor's own leftover value. " +
      "Give any subset to leave the rest untouched. Give vendor to set it, or clear_vendor: true " +
      "(not both) to remove the existing vendor association entirely — clearing it also clears " +
      "vendor_code/unit_cost_minor/commission for this product, since none of those apply without one. " +
      "NONE of these is the SKU on a variation: Square assigns that automatically and nothing in " +
      "this codebase ever sets it, reads it for anything but display, or treats it as this shop's " +
      "own nomenclature.",
    undo: "another catalog.set_square_attributes call, back to the previous value(s) (or clear_vendor: true)",
    schema: {
      handle: { type: "string", required: true, format: "handle" },
      style_id: { type: "string", maxLength: 20 },
      vendor: { type: "string", maxLength: 120 },
      /* Not required: the generic schema validator refuses an empty STRING
         outright ("must not be empty"), so clearing an existing vendor
         needs its own explicit flag rather than vendor: "" — the same
         "clear needs its own boolean" precedent catalog.set_category_number
         already establishes for numeric_id. */
      clear_vendor: { type: "boolean" },
      vendor_code: { type: "string", maxLength: 80 },
      unit_cost_minor: { type: "integer" },
      commission: { type: "integer" },
    },
    async check(args, t) {
      if (
        args.style_id === undefined &&
        args.vendor === undefined &&
        args.clear_vendor === undefined &&
        args.vendor_code === undefined &&
        args.unit_cost_minor === undefined &&
        args.commission === undefined
      ) {
        return {
          denied: "give a style_id, a vendor (or clear_vendor: true), a vendor code, a unit cost, a commission, or any combination — this call would change nothing",
        };
      }
      if (args.vendor !== undefined && args.clear_vendor) {
        return { denied: "give either vendor or clear_vendor: true, not both" };
      }
      const existing = await productByHandle(t.db.catalog_mirror, args.handle);
      if (!existing) return { denied: `no product with handle '${args.handle}' in the mirror` };

      if (args.style_id !== undefined) {
        if (!STYLE_ID_FORMAT.test(args.style_id)) {
          return {
            denied:
              `style_id '${args.style_id}' does not match this shop's own nomenclature — ` +
              "NN-NN-NNN (2-digit category, 2-digit subcategory, 3-digit item number), e.g. \"01-04-001\".",
          };
        }
        /* mirror_style_id_ledger, not just mirror_product's own current
           column — the owner's own words: "we want that style number to be
           held, so that you don't overwrite that style number and reuse it
           for something else." Excludes THIS product's own id, not its
           handle: re-affirming the style_id it already holds (the ledger
           row it wrote the first time it got one) is not a conflict with
           itself. */
        const conflict = await t.db.catalog_mirror
          .prepare(
            "SELECT mp.handle FROM mirror_style_id_ledger l JOIN mirror_product mp ON mp.id = l.product_id" +
              " WHERE l.style_id = ? AND l.product_id != ?",
          )
          .bind(args.style_id, existing.id)
          .first();
        if (conflict) {
          return {
            denied: `style_id '${args.style_id}' is already assigned to '${conflict.handle}' — style IDs are unique, one per product, and never reused once given out`,
          };
        }
      }

      const resultingVendor = args.clear_vendor ? null : args.vendor !== undefined ? args.vendor : existing.vendor;
      const needsVendor = ["commission", "vendor_code", "unit_cost_minor"].filter((k) => args[k] !== undefined);
      if (needsVendor.length && !resultingVendor) {
        return {
          denied:
            `'${args.handle}' has no vendor, so ${needsVendor.join("/")} do${needsVendor.length > 1 ? "" : "es"} not apply — ` +
            "these are facts about a VENDOR's product. Set a vendor at the same time, or first.",
        };
      }
      if (args.commission !== undefined && (!Number.isInteger(args.commission) || args.commission < 0 || args.commission > 100)) {
        return { denied: `commission '${args.commission}' must be a whole number 0-100` };
      }
      if (args.unit_cost_minor !== undefined && (!Number.isInteger(args.unit_cost_minor) || args.unit_cost_minor < 0)) {
        return { denied: `unit_cost_minor '${args.unit_cost_minor}' must be a non-negative integer minor amount` };
      }

      /* REVISED: the exact same central-commission rule as
         catalog.create_product — the owner's own words apply just as well
         to an edit that (re)assigns this product's own vendor. A vendor
         with a rate already on file needs nothing stated here at all;
         only one with nothing on file yet does. */
      if (args.vendor !== undefined && args.commission === undefined) {
        const onFile = await vendorCommission(t.db.catalog_mirror, args.vendor);
        if (onFile === null) {
          return {
            denied: `vendor '${args.vendor}' has no commission on file yet — give one now (0-100); it is stored centrally against this vendor and applied automatically to every item from it after this`,
          };
        }
      }

      const resultingStyleId = args.style_id !== undefined ? args.style_id : existing.style_id;
      /* A vendor actually CHANGING here (even to a different name) adopts
         THAT vendor's own on-file rate when no fresh commission comes
         along with it — check() above already refused this call if
         neither exists — rather than blindly carrying over whatever this
         product's own PREVIOUS vendor happened to leave behind. */
      const resultingCommission =
        args.commission !== undefined
          ? args.commission
          : args.vendor !== undefined
            ? await vendorCommission(t.db.catalog_mirror, args.vendor)
            : args.clear_vendor
              ? null
              : existing.commission_pct;
      const resultingVendorCode = args.vendor_code !== undefined ? args.vendor_code : args.clear_vendor ? null : existing.vendor_code;
      /* 0, not null: mirror_variant.unit_cost_minor is NOT NULL DEFAULT 0 —
         a variation with no vendor_information at all (mirror.js's own
         sync, `toStorableMinor(v.unitCost?.amountMinor ?? 0n, ...)`) reads
         back as 0, never null, so a genuinely vendor-less product's
         existing.unit_cost_minor is already 0 too; clearing must resolve
         to that same value or this no-op check below would never match. */
      const resultingUnitCostMinor = args.unit_cost_minor !== undefined ? args.unit_cost_minor : args.clear_vendor ? 0 : existing.unit_cost_minor;
      if (
        resultingStyleId === existing.style_id &&
        resultingVendor === existing.vendor &&
        resultingVendorCode === existing.vendor_code &&
        resultingUnitCostMinor === existing.unit_cost_minor &&
        resultingCommission === existing.commission_pct
      ) {
        return { denied: `'${args.handle}' already has those values — nothing would change` };
      }

      const changes = [
        args.style_id !== undefined ? `style_id -> ${args.style_id}` : null,
        args.vendor !== undefined ? `vendor -> ${args.vendor}` : null,
        args.clear_vendor ? "vendor -> (none)" : null,
        args.vendor_code !== undefined ? `vendor_code -> ${args.vendor_code}` : null,
        args.unit_cost_minor !== undefined ? `unit_cost_minor -> ${args.unit_cost_minor}` : null,
        args.commission !== undefined ? `commission -> ${args.commission}%` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        ok: true,
        summary: `set "${existing.title}" (${args.handle}): ${changes}`,
        preflight: { existing },
      };
    },
    async run(args, t) {
      /* "Anytime we submit items with a style ID, those style IDs will
         actually be driving which categories and subcategories these
         items automatically get sorted to" — the owner's own words. Only
         when style_id is ACTUALLY changing here (undefined otherwise), and
         only when it resolves to a real category/subcategory numeric_id;
         no match leaves categoryId undefined, which updateProduct's own
         "resend the whole thing" fallback reads as "keep this product's
         current category," never as "clear it" (P0-138's own bug fix). */
      const derivedCategoryId =
        args.style_id !== undefined ? await deriveCategoryIdForStyleId(t.db.catalog_mirror, args.style_id) : undefined;
      /* "We store it in essential locations per vendor so that their
         commission is recorded in a central location and automatically
         applied" — the owner's own words. An explicit commission always
         wins outright; a vendor actually changing here with none given
         adopts that vendor's own on-file rate instead (check() above
         already refused this call if neither exists); leaving BOTH
         undefined, unchanged, reaches updateProduct's own "resend the
         whole thing" fallback, which reads undefined as "keep this
         product's current commission," never as "clear it." */
      const commissionPct =
        args.commission !== undefined
          ? args.commission
          : args.vendor !== undefined
            ? await vendorCommission(t.db.catalog_mirror, args.vendor)
            : args.clear_vendor
              ? null
              : undefined;
      /* vendor: "" is updateProduct's own "clear it" signal (catalog-writer.js:
         `vendor ? await vendorRef(vendor) : null`, reached only when vendor
         !== undefined) — clear_vendor: true translates to exactly that,
         never a real vendorRef lookup/create against Square for an empty
         name. */
      const out = await t.square.updateProduct({
        handle: args.handle,
        styleId: args.style_id,
        vendor: args.clear_vendor ? "" : args.vendor,
        vendorCode: args.vendor_code,
        unitCostMinor: args.unit_cost_minor,
        commissionPct,
        ...(derivedCategoryId ? { categoryId: derivedCategoryId } : {}),
      });
      /* An EXPLICITLY given commission becomes this vendor's own new
         central rate — see catalog.create_product's own identical
         comment. Safe to run after updateProduct: the vendor named here
         either already had a mirror row (reused) or this same call's own
         resolve-or-create path just gave it one, through Square, before
         updateProduct's own syncAfterWrite ran. */
      if (args.vendor !== undefined && args.commission !== undefined) {
        await t.db.catalog_mirror
          .prepare("UPDATE mirror_vendor SET commission_pct = ? WHERE name = ? COLLATE NOCASE")
          .bind(args.commission, args.vendor)
          .run();
      }
      return {
        updated: true,
        handle: args.handle,
        style_id: out.product?.style_id ?? null,
        vendor: out.product?.vendor ?? null,
        vendor_code: out.product?.vendor_code ?? null,
        unit_cost_minor: out.product?.unit_cost_minor ?? null,
        commission: out.product?.commission_pct ?? null,
        previous_style_id: t.preflight.existing.style_id,
        previous_vendor: t.preflight.existing.vendor,
        previous_vendor_code: t.preflight.existing.vendor_code,
        previous_unit_cost_minor: t.preflight.existing.unit_cost_minor,
        previous_commission: t.preflight.existing.commission_pct,
        mirror_sync: out.sync,
        authority: "square",
      };
    },
  },

  /*
   * "The same kind of drop down schema that we have for categories" — the
   * owner's own words. The closed set catalog.create_vendor/catalog.
   * set_vendor_commission and the ops UI's own vendor picker all read from,
   * the exact mirror of catalog.categories above for vendors instead.
   */
  "catalog.vendors": {
    tier: "T0",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "staff",
    describe:
      "List every vendor that already exists, with its own central commission rate (null if none is " +
      "on file yet). catalog.create_product/catalog.set_square_attributes both read from this same " +
      "central rate automatically — call this before naming a vendor to see whether one already exists " +
      "under a slightly different spelling, and what it already charges.",
    undo: null,
    schema: {},
    async run(_args, t) {
      const vendors = await listMirrorVendors(t.db.catalog_mirror);
      return {
        vendors,
        count: vendors.length,
        note: "A vendor with commission_pct: null has nothing on file yet — catalog.create_product/catalog.set_square_attributes will refuse naming it until catalog.set_vendor_commission (or a fresh catalog.create_vendor) gives it one.",
      };
    },
  },

  /*
   * REVISED: "let's not force vendor's commission to be stated out loud [on
   * every item]... we store it in essential locations per vendor so that
   * their commission is recorded in a central location and automatically
   * applied" — the owner's own words. Standalone, no product needs to
   * exist or be touched at all — the picker/admin panel's own "add a
   * vendor" flow, distinct from vendorRef's own resolve-or-create that
   * only ever runs as a side effect of a product write.
   */
  "catalog.create_vendor": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Create a new Vendor in Square, standalone — no product needs to reference it yet. commission " +
      "is REQUIRED here (0-100), unlike a vendor resolved as a side effect of catalog.create_product/ " +
      "catalog.set_square_attributes reusing one that already has a rate: this IS the moment a brand-" +
      "new vendor's own central rate (mirror_vendor.commission_pct, OURS, not Square's — Square has no " +
      "concept of a resale commission at all) gets set, and every future item naming this vendor picks " +
      "it up automatically, nothing restated. Refused if a vendor with this name already exists " +
      "(case-insensitive, whether or not it has a commission on file) — catalog.set_vendor_commission " +
      "changes an existing one's own rate; this never makes a second vendor beside it.",
    undo:
      "no undo: a Vendor cannot be withdrawn or deleted through Square's own API once created — " +
      "correcting a mistaken rate is catalog.set_vendor_commission; there is currently no rename",
    schema: {
      name: { type: "string", required: true, maxLength: 120 },
      commission: { type: "integer", required: true },
      reason: { type: "string", required: true, maxLength: CAPS.MAX_TEXT },
    },
    async check(args, t) {
      const name = args.name.trim();
      if (!name) return { denied: "a vendor needs a name" };
      if (!Number.isInteger(args.commission) || args.commission < 0 || args.commission > 100) {
        return { denied: `commission '${args.commission}' must be a whole number 0-100` };
      }
      const vendors = await listMirrorVendors(t.db.catalog_mirror);
      const exact = vendors.find((v) => v.name.toLowerCase() === name.toLowerCase());
      if (exact) {
        return {
          denied:
            `"${exact.name}" already exists` +
            (exact.commission_pct !== null ? `, with a commission of ${exact.commission_pct}% already on file` : ", with nothing on file yet") +
            " — use catalog.set_vendor_commission to change its own rate, not a second vendor beside it",
          detail: { reason: "vendor_already_exists" },
        };
      }
      return {
        ok: true,
        summary: `create the vendor "${name}" with a ${args.commission}% commission — ${args.reason}`,
        preflight: { name },
      };
    },
    async run(args, t) {
      const out = await t.square.createVendorEntity(t.preflight.name);
      await t.db.catalog_mirror
        .prepare("UPDATE mirror_vendor SET commission_pct = ? WHERE name = ? COLLATE NOCASE")
        .bind(args.commission, t.preflight.name)
        .run();
      return {
        created: true,
        name: t.preflight.name,
        commission: args.commission,
        mirror_sync: out.sync,
        authority: "square",
      };
    },
  },

  /*
   * The reverse direction of the same rule: an EXPLICIT commission given
   * alongside a vendor in catalog.create_product/catalog.
   * set_square_attributes already becomes that vendor's own new central
   * rate automatically (both tools' own run()); this is for correcting one
   * directly, with no product in the same call at all — the vendor picker's
   * own admin panel. OURS, not Square's: a direct mirror write, the same
   * shape catalog.set_category_number's own numeric_id write already is,
   * minus the retroactive resort (a vendor's own rate change is forward-
   * only, deliberately — see this tool's own describe text).
   */
  "catalog.set_vendor_commission": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "manager",
    describe:
      "Change an EXISTING vendor's own central commission rate (0-100). OURS, not Square's — Square " +
      "has no concept of a resale commission at all, so this never calls Square and never triggers a " +
      "mirror sync. Forward-only, deliberately: every product naming this vendor from now on, with no " +
      "commission of its own given, picks up this new rate automatically, but an existing product's " +
      "own already-set commission_pct is left exactly as it is — this is not a retroactive rewrite of " +
      "every product this vendor has ever supplied, the same way changing a real commission agreement " +
      "does not reach back and re-bill past sales. vendor_id comes from catalog.vendors.",
    undo: "another catalog.set_vendor_commission call, back to the previous rate",
    schema: {
      vendor_id: { type: "string", required: true, format: "id" },
      commission: { type: "integer", required: true },
    },
    async check(args, t) {
      if (!Number.isInteger(args.commission) || args.commission < 0 || args.commission > 100) {
        return { denied: `commission '${args.commission}' must be a whole number 0-100` };
      }
      const vendors = await listMirrorVendors(t.db.catalog_mirror);
      const vendor = vendors.find((v) => v.id === args.vendor_id);
      if (!vendor) return { denied: `no vendor '${args.vendor_id}' in the mirror` };
      if (vendor.commission_pct === args.commission) {
        return { denied: `"${vendor.name}" already has a commission of ${args.commission}% — nothing would change` };
      }
      return {
        ok: true,
        summary: `set "${vendor.name}"'s own commission to ${args.commission}%`,
        preflight: { vendor },
      };
    },
    async run(args, t) {
      await t.db.catalog_mirror
        .prepare("UPDATE mirror_vendor SET commission_pct = ? WHERE id = ?")
        .bind(args.commission, args.vendor_id)
        .run();
      return {
        updated: true,
        vendor_id: args.vendor_id,
        name: t.preflight.vendor.name,
        commission: args.commission,
        previous_commission: t.preflight.vendor.commission_pct,
        authority: "ours",
      };
    },
  },

  "catalog.custom_field_names": {
    tier: "T0",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "staff",
    describe:
      "List every globally-known custom field name (mirror_custom_field_name) — the closed set the " +
      "Items tab offers a value row for on every product, whether or not that particular product has " +
      "a value for it yet. Call this before naming a new one, to see whether one already exists under " +
      "a slightly different spelling.",
    undo: null,
    schema: {},
    async run(_args, t) {
      const names = await listCustomFieldNames(t.db.catalog_mirror);
      return { names, count: names.length };
    },
  },

  /*
   * REVISED: "remove add fields from items. I don't want to be adding
   * fields per item. If I'm adding custom fields, I'm adding them to all
   * items. And this is done inside of the admin panel, not inside of the
   * item panel" — the owner's own words. A field's NAME is registered
   * here, once, globally; catalog.set_custom_fields (unchanged) is still
   * what actually gives ONE product a VALUE for it. Never touches Square
   * at all — mirror_custom_field_name is purely OURS, with no Square
   * correlate whatsoever, unlike every other table this tool layer writes.
   */
  "catalog.create_custom_field_name": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    minRole: "manager",
    describe:
      "Register a new custom field NAME, globally — it then gets its own value row on every product in " +
      "the Items tab (blank until a value is actually set there with catalog.set_custom_fields). Refused " +
      "if this exact name is already registered (case-insensitive) — nothing to do twice.",
    undo: "no undo yet: a registered field name cannot currently be removed",
    schema: {
      name: { type: "string", required: true, maxLength: CAPS.CATALOG_CUSTOM_FIELD_KEY_MAX },
      reason: { type: "string", required: true, maxLength: CAPS.MAX_TEXT },
    },
    async check(args, t) {
      const name = args.name.trim();
      if (!name) return { denied: "a custom field needs a name" };
      const names = await listCustomFieldNames(t.db.catalog_mirror);
      if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
        return { denied: `"${name}" is already a registered custom field — nothing to add` };
      }
      return { ok: true, summary: `register the custom field "${name}" — ${args.reason}`, preflight: { name } };
    },
    async run(_args, t) {
      await t.db.catalog_mirror.prepare("INSERT INTO mirror_custom_field_name (name) VALUES (?)").bind(t.preflight.name).run();
      return { created: true, name: t.preflight.name, authority: "ours" };
    },
  },
};
