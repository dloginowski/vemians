/*
 * The one Square call this Worker is allowed to make outside minting a
 * checkout URL (ADR-015), and the one file that is allowed to make it.
 *
 * store/src/catalog.js and store/src/views.js stay exactly as pure as before —
 * neither imports this file or shared/commerce/square, and
 * store/test/storefront.test.mjs still asserts zero calls out of them. This
 * file is the SCOPED EXCEPTION, the same shape ADR-014 gave the appointments
 * widget: one file, one credential name (`SQUARE_ACCESS_TOKEN_CONTACT`,
 * deliberately not the name ops/sync uses), one endpoint.
 *
 * THE CREDENTIAL. This is the first secret the public storefront Worker has
 * ever held. A leak of it hands whoever finds it write access to Square's
 * Customer Directory for whatever that token's permissions cover — so it MUST
 * be its own token, scoped to the narrowest permission Square's dashboard
 * allows for creating a customer, never the same token catalog sync or any
 * other ops process uses. That is a decision made in Square's dashboard, not
 * in this file; see ADR-015 for the checklist.
 *
 * A form that posts into nothing is worse than no form (P0-56), and the
 * inverse holds too: a form that silently drops a submission on a Square
 * failure is worse than a phone number that works. Every failure here is
 * logged and answered honestly — never a quiet 200 over a message that did
 * not arrive.
 */
import { SITE } from "../../shared/site.js";
import { createSquareClient, SquareError } from "../../shared/commerce/square/client.js";
import { createContactCustomer } from "../../shared/commerce/square/customers.js";
import { contactResultPage } from "./pages.js";

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/* Plain text, not a link: contactResultPage escapes `detail` on purpose (it is
   built from an error path, not from markup this file controls at that call
   site), so a fallback mentions the phone number and email as text a person
   can read and dial or type themselves. */
const fallback = () => `Please call ${SITE.phone} or email ${SITE.email} instead.`;

const NAME_MAX = 120;
const EMAIL_MAX = 200;
const PHONE_MAX = 40;
const MESSAGE_MAX = 4000;

/* Loose on purpose: this gates a friendly error message, not Square's own
   validation, which runs on whatever survives this and is authoritative. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const field = (form, key, max) => String(form.get(key) ?? "").trim().slice(0, max);

/* index.js already refuses anything but POST here — with a 404, not a 405,
   so a GET on this path reads exactly like any other route that does not
   exist, rather than confirming a form lives at this address. */
export async function handleContact(request, env, { categories, subs }) {
  const fail = (reason, status = 400) =>
    html(contactResultPage(categories, subs, false, reason), status);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    console.error(`ERROR store/contact: unreadable form — ${err.message}`);
    return fail("That form could not be read. Please try again.");
  }

  /* The honeypot. An empty field a person never sees and a robot fills in.
     Answered with the SAME success page a real sender gets — telling a robot
     it was caught is telling whoever wrote it what to change — but nothing is
     sent to Square: a caught submission is not a customer. */
  if (field(form, "company", 100)) {
    console.info("INFO store/contact: honeypot filled — discarded, nothing sent to Square");
    return html(contactResultPage(categories, subs, true, "Thank you. We will be in touch."));
  }

  const name = field(form, "name", NAME_MAX);
  const email = field(form, "email", EMAIL_MAX);
  const phone = field(form, "phone", PHONE_MAX); // the one optional field
  const message = field(form, "message", MESSAGE_MAX);

  if (!name || !email || !message) {
    return fail("Please fill in your name, your email and a message.");
  }
  if (!EMAIL_SHAPE.test(email)) {
    return fail("That email address does not look complete.");
  }

  let client;
  try {
    /* Reshaped, not env itself: createSquareClient reads env.SQUARE_ACCESS_TOKEN
       by name, and the storefront's token lives under a DIFFERENT name so it
       can never be confused with, or accidentally widened to, whatever ops
       uses for catalog sync. */
    client = createSquareClient({
      SQUARE_ACCESS_TOKEN: env.SQUARE_ACCESS_TOKEN_CONTACT,
      SQUARE_ENV: env.SQUARE_ENV,
    });
  } catch (err) {
    console.error(`ERROR store/contact: ${err.message}`);
    return fail(`Messages are not connected yet. ${fallback()}`, 503);
  }

  try {
    await createContactCustomer(client, { name, email, phone, message });
  } catch (err) {
    const detail = err instanceof SquareError ? `${err.status} — ${err.message}` : err.message;
    console.error(`ERROR store/contact: Square refused the submission — ${detail}`);
    return fail(`That did not send. ${fallback()}`, 502);
  }

  return html(contactResultPage(categories, subs, true, "Thank you. We will be in touch."));
}
