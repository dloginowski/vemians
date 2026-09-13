/*
 * Friendly, EDITABLE fields for the /approvals/ page — the difference between
 * a screen that only says yes/no to whatever was proposed and one where a
 * coworker can fix a typo'd title or a wrong price before saying yes.
 *
 * DELIBERATELY NOT GENERIC. Only the two tools the spreadsheet and narrated-
 * list flows actually produce — catalog.create_product, customer.create —
 * get a friendly form. Every other T2 tool (catalog.update_product,
 * catalog.create_category, expense.approve, ...) keeps the plain read-only
 * details view views.js already had: building a correct generic form for an
 * arbitrary tool schema is a different, much larger project, and a wrong
 * guess at one is worse than the honest raw view.
 *
 * EDITS STILL GO THROUGH THE TOOL'S OWN check(). This file only reshapes
 * values between a form and an args object; it does not decide whether an
 * edited price or category is acceptable. A bad edit is refused by
 * runTool() exactly the way a bad CSV row already is (batch.js), not by
 * anything here.
 */
import { parsePriceToMinor } from "./batch.js";

const CATALOG_CREATE_PRODUCT = "catalog.create_product";
const CUSTOMER_CREATE = "customer.create";

/**
 * @returns null for a tool with no friendly form (render the plain details
 *          view instead), or an array of {name, label, kind, value, options?}
 *          for the fields to render as real inputs.
 */
export function editableFieldsFor(tool, args, categories = []) {
  const a = args ?? {};
  if (tool === CATALOG_CREATE_PRODUCT) {
    const variation = a.variations?.[0] ?? {};
    return [
      { name: "title", label: "Title", kind: "text", value: a.title ?? "" },
      { name: "description", label: "Description", kind: "textarea", value: a.description ?? "" },
      {
        name: "category_id",
        label: "Category",
        kind: "select",
        value: a.category_id ?? "",
        options: categories.map((c) => ({ value: c.id, label: c.name })),
      },
      {
        name: "price",
        label: "Price (USD)",
        kind: "text",
        value: typeof variation.price_minor === "number" ? (variation.price_minor / 100).toFixed(2) : "",
      },
      { name: "sku", label: "SKU", kind: "text", value: variation.sku ?? "" },
    ];
  }
  if (tool === CUSTOMER_CREATE) {
    return [
      { name: "given_name", label: "First name", kind: "text", value: a.given_name ?? "" },
      { name: "family_name", label: "Last name", kind: "text", value: a.family_name ?? "" },
      { name: "email_address", label: "Email", kind: "text", value: a.email_address ?? "" },
      { name: "phone_number", label: "Phone", kind: "text", value: a.phone_number ?? "" },
      { name: "note", label: "Note", kind: "textarea", value: a.note ?? "" },
      { name: "reference_id", label: "Reference ID", kind: "text", value: a.reference_id ?? "" },
    ];
  }
  return null;
}

const trim = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Merge a submitted form's edits over the originally parked args.
 *
 * @param form  anything with a `.get(name)` method — a real FormData, or a
 *              plain Map in a test.
 * @returns { ok: true, args } or { ok: false, error } — the same shape a
 *          tool's own check() answers with, so the caller can show one kind
 *          of refusal page regardless of whether Square or a field parser
 *          objected.
 */
export function applyFormEdits(tool, args, form) {
  const a = args ?? {};
  if (tool === CATALOG_CREATE_PRODUCT) {
    const title = trim(form.get("title")) || a.title;
    const description = trim(form.get("description"));
    const categoryId = trim(form.get("category_id")) || a.category_id;
    const sku = trim(form.get("sku"));
    const priceRaw = form.get("price");
    const existingVariation = a.variations?.[0] ?? {};

    let priceMinor = existingVariation.price_minor;
    if (priceRaw !== null && trim(priceRaw) !== "") {
      const parsed = parsePriceToMinor(priceRaw);
      if (parsed === null) {
        return { ok: false, error: `price "${priceRaw}" is not a plain number like 45.00` };
      }
      priceMinor = parsed;
    }

    return {
      ok: true,
      args: {
        ...a,
        title,
        ...(description ? { description } : {}),
        category_id: categoryId,
        variations: [{ ...existingVariation, title, price_minor: priceMinor, ...(sku ? { sku } : {}) }],
      },
    };
  }
  if (tool === CUSTOMER_CREATE) {
    const given_name = trim(form.get("given_name"));
    const family_name = trim(form.get("family_name"));
    const email_address = trim(form.get("email_address"));
    const phone_number = trim(form.get("phone_number"));
    const note = trim(form.get("note"));
    const reference_id = trim(form.get("reference_id"));
    return {
      ok: true,
      args: {
        ...(given_name ? { given_name } : {}),
        ...(family_name ? { family_name } : {}),
        ...(email_address ? { email_address } : {}),
        ...(phone_number ? { phone_number } : {}),
        ...(note ? { note } : {}),
        ...(reference_id ? { reference_id } : {}),
      },
    };
  }
  /* No known form for this tool: nothing to edit, run the parked args as-is. */
  return { ok: true, args: a };
}
