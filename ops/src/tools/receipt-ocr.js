/*
 * Receipt OCR — a best-effort PREFILL, never a filed value.
 *
 * finance-skills rule 4: a vision model's read of a receipt is a guess at
 * four fields, never trusted straight into the expense row — the same reason
 * this codebase never lets a model write a price straight into Square. This
 * module's job ends at handing back a guess; src/index.js's confirm form is
 * where a person accepts or corrects it, and nothing here ever calls
 * expense.submit or touches the `finance` store.
 *
 * MODEL CHOICE, STATED HONESTLY. `@cf/llava-hf/llava-1.5-7b-hf` is used
 * below. Cloudflare's Workers AI catalog and its exact request/response
 * shape could not be confirmed against live documentation from this
 * environment — the same `developers.cloudflare.com` wall ADR-007 already
 * hit — so this is UNVERIFIED against a real account, same as ADR-007's own
 * unresolved claims were. Confirm the model id and the `{ image, prompt }`
 * input shape with one real `wrangler dev` call before relying on this in
 * production; a wrong model id fails the AI call, which this module treats
 * as "OCR unavailable" and falls back to the blank confirm form, not a crash
 * (see `scanReceipt`'s catch).
 */
const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

const PROMPT =
  "You are reading a photograph of a purchase receipt. Reply with EXACTLY these four lines " +
  "and nothing else. Use UNKNOWN for anything you cannot read.\n" +
  "VENDOR: <the store or business name>\n" +
  "DATE: <the purchase date as YYYY-MM-DD>\n" +
  "TOTAL: <the final total amount as a plain number, no currency symbol, no thousands separator>\n" +
  "CURRENCY: <the three-letter currency code, your best guess if unclear>";

const LINE = /^(VENDOR|DATE|TOTAL|CURRENCY):\s*(.*)$/i;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_SHAPE = /^[A-Za-z]{3}$/;

/*
 * Pure and directly testable: given whatever text a vision model (or a test)
 * produced, extract what can be trusted and leave the rest for a human.
 * Never throws — a field that will not parse is simply absent from the
 * result, exactly like a field the model never mentioned.
 */
export function parseReceiptText(text) {
  const fields = {};
  for (const raw of String(text ?? "").split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const value = m[2].trim();
    if (!value || /^unknown$/i.test(value)) continue;
    fields[m[1].toUpperCase()] = value;
  }

  const vendor = fields.VENDOR || null;
  const incurred_on = fields.DATE && DATE_SHAPE.test(fields.DATE) ? fields.DATE : null;
  const currency = fields.CURRENCY && CURRENCY_SHAPE.test(fields.CURRENCY) ? fields.CURRENCY.toUpperCase() : null;

  let amount_minor = null;
  if (fields.TOTAL) {
    const n = Number(fields.TOTAL.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) amount_minor = Math.round(n * 100);
  }

  return {
    vendor,
    incurred_on,
    currency,
    amount_minor,
    description: vendor ? `Receipt from ${vendor}` : null,
  };
}

/*
 * The IO half. Any failure — no AI binding, a model error, a timeout — is
 * "OCR did not work this time", never an exception the upload route has to
 * handle specially: the confirm form just comes back blank for whatever this
 * could not read, same as it would for a PDF receipt no vision call ever ran
 * on.
 */
export async function scanReceipt(env, bytes) {
  if (!env?.AI || typeof env.AI.run !== "function") {
    console.info("INFO receipt-ocr: no AI binding — the confirm form will be blank, not prefilled");
    return { vendor: null, incurred_on: null, currency: null, amount_minor: null, description: null };
  }
  try {
    const result = await env.AI.run(MODEL, { image: [...bytes], prompt: PROMPT });
    return parseReceiptText(result?.description ?? result?.response ?? "");
  } catch (err) {
    console.error(`ERROR receipt-ocr: ${err.message} — the confirm form will be blank, not prefilled`);
    return { vendor: null, incurred_on: null, currency: null, amount_minor: null, description: null };
  }
}
