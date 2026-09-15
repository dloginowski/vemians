/*
 * catalog.* authoring — a staff member describes a garment to their own AI
 * client, and it lands in Square, priced and categorised.
 *
 * Inherits agent-tool-contract, then catalog-skills. Ten tools:
 *
 *   catalog.categories       T0  the closed set of categories that EXIST
 *   catalog.product          T0  read one mirrored product, variants and all
 *   catalog.upload_image     T1  an original into OUR bucket; returns our key
 *   catalog.draft_product    T1  a complete proposal and a diff; writes nothing
 *   catalog.create_product   T2  ITEM + ITEM_VARIATIONs in Square, then sync
 *   catalog.update_product   T2  the same path for an edit
 *   catalog.create_category  T2  separate, deliberate, and rarely right
 *   catalog.set_channel      T2  which audience sees a product — OURS, not Square's
 *   catalog.set_custom_fields T2 whatever else we track that Square doesn't — OURS too
 *   catalog.set_style_and_vendor T2 style_id + vendor — Square's OWN Custom Attributes
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
 *    `catalog.set_style_and_vendor` is the OPPOSITE case, on purpose: style_id
 *    and vendor used to be `custom_fields` examples, and moved OUT once Square
 *    turned out to already have a supported mechanism for exactly this — its
 *    own Custom Attributes (Test-PRD-P0-136-square_custom_attributes). The
 *    owner's own words, having weighed "ours, not Square's" against not
 *    reinventing something Square already offers: "why do we need to have our
 *    own custom fields then? It doesn't make sense... we don't mind having our
 *    stuff being stored completely in Square." So this tool DOES declare
 *    `square` and DOES call it — Square is authoritative for these two now,
 *    the same as title or price, and the mirror sync overwrites them on every
 *    re-sync rather than preserving them untouched the way `channel` is.
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
import { listCategories, mergeVariations, priceBand, productByHandle, variantsOf } from "./catalog-writer.js";
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
  schema: { ...VARIATION.schema, variant_id: { type: "string", format: "id" } },
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
      "List the product categories that ALREADY EXIST. This is a closed set: catalog.create_product " +
      "accepts a category_id from this list and refuses anything else. Call this before drafting a " +
      "product, and choose the closest existing category rather than reaching for a new one.",
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
      "never writes a product row directly. `category_id` MUST come from catalog.categories; anything " +
      "else is refused. Prices are integer MINOR units, currency \"USD\" — this shop trades in nothing " +
      "else, so pass it without asking. A product with no real size/color options still needs one " +
      "variation, conventionally titled \"One size\". This is a T2 write: it executes only after a " +
      "human approves it. `custom_fields` is OURS, not Square's: any field name -> string value we " +
      "track that Square has no concept of at all (unit cost, a vendor name, a spreadsheet column " +
      "with no home elsewhere). It never reaches Square — it is written to our own mirror right after " +
      "the item is created — and survives every future sync untouched. Edit it later with " +
      "catalog.set_custom_fields.",
    undo: "withdraw the item in Square; nothing is deleted, and the originals in R2 are untouched",
    schema: {
      title: { type: "string", required: true, maxLength: CAPS.CATALOG_TITLE_MAX },
      description: { type: "string", maxLength: CAPS.CATALOG_DESCRIPTION_MAX },
      category_id: { type: "string", required: true, format: "id" },
      variations: { type: "array", required: true, maxItems: CAPS.CATALOG_MAX_VARIATIONS, of: VARIATION },
      images: IMAGES,
      custom_fields: {
        type: "record",
        maxKeys: CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS,
        keyMaxLength: CAPS.CATALOG_CUSTOM_FIELD_KEY_MAX,
        valueMaxLength: CAPS.CATALOG_CUSTOM_FIELD_VALUE_MAX,
      },
    },
    async check(args, t) {
      const problems = validateProposal(args);
      if (problems.length) {
        return {
          denied: `refused before Square saw it: ${problems.join(" | ")}`,
          detail: { reason: "invalid_product", problems },
        };
      }

      /* The closed set, read from the mirror. Not a prompt instruction. */
      const categories = await listCategories(t.db.catalog_mirror);
      const chosen = categories.find((c) => c.id === args.category_id);
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

      const media = await checkImages(args.images, t.media);
      if (media.denied) return { denied: media.denied, detail: { reason: "unknown_media_key" } };

      const total = args.variations.map((v) => `${v.title} ${v.price_minor} ${v.currency}`).join(", ");
      return {
        ok: true,
        summary: `create "${args.title}" in ${chosen.name} — ${args.variations.length} variation(s): ${total}`,
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

      const out = await t.square.createProduct({
        title: args.title,
        description: args.description ?? "",
        categoryId: args.category_id,
        variations: args.variations,
        images,
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
      "RARELY THE RIGHT TOOL. Create a new product category in Square. Almost every product belongs in " +
      "a category that already exists — call catalog.categories and choose from it. Categories are the " +
      "storefront's navigation, and an agent that mints one whenever the existing name is not quite the " +
      "phrase it had in mind produces 'Coats', 'Outerwear', 'Jackets' and 'Coats & Jackets' inside a " +
      "month, at which point browsing the shop tells a customer nothing. This tool refuses a lexical " +
      "near-duplicate outright, and everything it does not refuse still needs a manager to approve it. " +
      "Use it when the shop genuinely starts selling something it has never sold before.",
    undo: "withdraw the category in Square; the mirror archives it and keeps the row",
    schema: {
      name: { type: "string", required: true, maxLength: 60 },
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
      const exact = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (exact) return { denied: `"${exact.name}" already exists. Use it.` };

      const near = nearestCategory(name, categories);
      if (near && near.score >= CAPS.CATEGORY_DUPLICATE_SIMILARITY) {
        return {
          denied:
            `"${name}" overlaps the existing category "${near.name}" (${near.score}). ` +
            "Two near-identical categories make the storefront navigation meaningless, which is exactly " +
            "what this refusal exists to prevent. Put the product in the existing category, or rename " +
            "that category deliberately — do not add a second one beside it.",
          detail: { reason: "near_duplicate_category", nearest: near.name, score: near.score },
        };
      }

      return {
        ok: true,
        summary: `create the category "${name}" beside the ${categories.length} that exist — ${args.reason}`,
        preflight: { name, existing: categories.length, nearest: near },
      };
    },
    async run(args, t) {
      const out = await t.square.createCategory({ name: t.preflight.name });
      return {
        created: true,
        category: out.category,
        existing_before: t.preflight.existing,
        mirror_sync: out.sync,
        authority: "square",
      };
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
      "field for at all. (style_id and vendor are NOT set here any more — catalog.set_style_and_vendor " +
      "does those, as Square's own Custom Attributes.) `fields` is a PATCH merged into what is already there: a key with a real " +
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

  "catalog.set_style_and_vendor": {
    tier: "T2",
    domain: "catalog",
    stores: ["catalog_mirror"],
    resources: ["square"],
    minRole: "manager",
    describe:
      "Set a product's own Style ID and/or vendor, by handle. Both are stored as SQUARE'S OWN " +
      "Custom Attributes, not a fact this codebase invents — this DOES call Square, then syncs the " +
      "mirror back, unlike catalog.set_channel or catalog.set_custom_fields. style_id follows this " +
      "shop's own nomenclature — NN-NN-NNN: a 2-digit category, a 2-digit subcategory, a 3-digit " +
      "item number, e.g. \"01-04-001\" — and is NEVER generated here: give one, or leave it as it " +
      "is. Refused if another product already has the same style_id — style IDs are unique, one per " +
      "product. vendor is a plain name. Give either alone to leave the other untouched. NEITHER of " +
      "these is the SKU on a variation: Square assigns that automatically and nothing in this " +
      "codebase ever sets it, reads it for anything but display, or treats it as this shop's own " +
      "nomenclature.",
    undo: "another catalog.set_style_and_vendor call, back to the previous value(s)",
    schema: {
      handle: { type: "string", required: true, format: "handle" },
      style_id: { type: "string", maxLength: 20 },
      vendor: { type: "string", maxLength: 120 },
    },
    async check(args, t) {
      if (args.style_id === undefined && args.vendor === undefined) {
        return { denied: "give a style_id, a vendor, or both — this call would change nothing" };
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
        const conflict = await t.db.catalog_mirror
          .prepare("SELECT handle FROM mirror_product WHERE style_id = ? AND handle != ?")
          .bind(args.style_id, args.handle)
          .first();
        if (conflict) {
          return {
            denied: `style_id '${args.style_id}' is already assigned to '${conflict.handle}' — style IDs are unique, one per product`,
          };
        }
      }

      const resultingStyleId = args.style_id !== undefined ? args.style_id : existing.style_id;
      const resultingVendor = args.vendor !== undefined ? args.vendor : existing.vendor;
      if (resultingStyleId === existing.style_id && resultingVendor === existing.vendor) {
        return { denied: `'${args.handle}' already has that style_id and vendor — nothing would change` };
      }

      const changes = [
        args.style_id !== undefined ? `style_id -> ${args.style_id}` : null,
        args.vendor !== undefined ? `vendor -> ${args.vendor}` : null,
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
      const out = await t.square.updateProduct({
        handle: args.handle,
        styleId: args.style_id,
        vendor: args.vendor,
      });
      return {
        updated: true,
        handle: args.handle,
        style_id: out.product?.style_id ?? null,
        vendor: out.product?.vendor ?? null,
        previous_style_id: t.preflight.existing.style_id,
        previous_vendor: t.preflight.existing.vendor,
        mirror_sync: out.sync,
        authority: "square",
      };
    },
  },
};
