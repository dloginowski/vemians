/*
 * Customers — one endpoint, CreateCustomer, and one caller: the storefront's
 * public contact form (ADR-015).
 *
 * A message typed into vemians.com/visit becomes a Square customer record, in
 * the SAME Customer Directory the counter iPad already writes to, rather than
 * an inbox or a database of ours. Same reasoning family as ADR-013 (photos)
 * and ADR-014 (appointments): if the owner already looks in Square for this
 * kind of thing, do not build a second place for them to check — and this
 * repository goes out of its way to keep unnecessary personal data OUT of our
 * own stores (the `identity` vault exists because that data is hard to hold
 * safely), so leaning on Square here is not a shortcut, it is the same
 * data-minimisation instinct pointed at a form instead of a table.
 *
 * NOT deduplicated against a prior submission by the same email — every
 * submission is a NEW customer record. Square's own dashboard has a manual
 * merge tool for duplicates; searching first would be a second live call on
 * the public path for a case (a repeat visitor writing in twice) this shop's
 * current scale does not need optimised away.
 *
 * Test-PRD-P0-16-commerce_port: everything here is adapter-internal. A Square
 * identifier must not appear outside shared/commerce/square/.
 */
import { idempotencyKey } from "./ids.js";

const CUSTOMERS = "/v2/customers";

/*
 * Square's note field length limit is UNVERIFIED here — developer.squareup.com
 * and connect.squareup.com are both blocked by this environment's egress proxy,
 * the same wall client.js hit pinning SQUARE_VERSION. 500 is a conservative cut
 * chosen without evidence of the real ceiling, not a documented one; loosen it
 * the moment anyone can actually load the docs and check.
 */
const NOTE_MAX = 500;

/*
 * A full name splits on the FIRST space: everything before it is
 * `given_name`, everything after is `family_name`. Wrong for a name with more
 * than two parts, and Square's own fallback for a name with none. A name typed
 * into one box on a contact form is not this codebase's to parse correctly —
 * only well enough that the record is findable and fixable by hand in Square's
 * dashboard, the same trust level ADR-014 already gave the appointments
 * widget's own markup: good enough for an owner to clean up, not a promise of
 * accuracy.
 */
export function splitName(full) {
  const trimmed = String(full ?? "").trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) return { given_name: trimmed };
  return { given_name: trimmed.slice(0, space), family_name: trimmed.slice(space + 1).trim() };
}

/*
 * `client` is a createSquareClient() — the same convention checkout.js's
 * createPaymentLink uses, so this file never reads env or SQUARE_ACCESS_TOKEN
 * itself and cannot get the wrong one by accident.
 *
 * ONE CALLER OF CreateCustomer, TWO SHAPES OF INPUT. The contact form has a
 * single "name" box and a message to fold into a note (below); ops's batch
 * customer intake already has Square's own field names apart, because that is
 * the structure a spreadsheet or a staff member typing at the till uses. Both
 * end at this function so there is one place that builds the request body,
 * one idempotency convention, one note-length cap — not two that could drift.
 *
 * Square's own rule: at least one of given_name, family_name, company_name,
 * email_address or phone_number. Enforced by the CALLER (ops's customer.create
 * checks it before this ever runs; the contact form's required name+email
 * fields already satisfy it) — this function does not repeat that check, the
 * same way createProduct does not re-validate a category id its caller already
 * resolved.
 */
export async function createCustomer(client, { given_name, family_name, email_address, phone_number, note, reference_id } = {}) {
  const body = { idempotency_key: idempotencyKey() };
  if (given_name) body.given_name = given_name;
  if (family_name) body.family_name = family_name;
  if (email_address) body.email_address = email_address;
  if (phone_number) body.phone_number = phone_number;
  if (note) body.note = String(note).slice(0, NOTE_MAX);
  if (reference_id) body.reference_id = reference_id;
  return client.post(CUSTOMERS, body);
}

/*
 * The idempotency key is fresh per call (no seed): a retry of the SAME HTTP
 * request reuses it because the caller generates one key and passes it once,
 * so the client's own retry loop (client.js, 429/5xx) cannot double-create a
 * customer — but two genuinely separate form submissions, even identical ones,
 * are two separate people's worth of contact and get two separate records.
 */
export async function createContactCustomer(client, { name, email, phone, message, source = "vemians.com/visit" }) {
  const stamp = new Date().toISOString();
  const note = `${source} · ${stamp}\n${String(message ?? "").slice(0, NOTE_MAX)}`;
  return createCustomer(client, { ...splitName(name), email_address: email, phone_number: phone, note });
}
