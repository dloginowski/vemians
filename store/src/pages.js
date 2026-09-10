/*
 * The pages that are not the catalog: the bag, the visit page and
 * collaborations.
 *
 * We are a shop with a door before we are a shop with a checkout, so the visit
 * page is not a footer link — it is where hours, appointments, directions and
 * the way to reach a person live, and it is the page the footer points at from
 * every other one.
 */

import { esc, money, page } from "../../shared/view/html.js";
import { SITE, addressLine, hoursRows, mapsDirectionsUrl, mapsSearchUrl, openDaysCount, openDaysLabel } from "../../shared/site.js";
import { CSS, footer, header, drawer, label } from "./shell.js";

/*
 * `reveal` marks a block for the scroll-in. It is an ATTRIBUTE, not a class
 * that hides anything: the CSS only acts on it under `.js`, and the script
 * clears it as each block arrives. With JavaScript off, or if the observer
 * never runs, every one of these is a plain visible section — nothing on this
 * site is parked at opacity 0 waiting for a scroll event that may not come.
 */
const reveal = ' data-reveal';

function shell(title, body, { categories = [], subsByCategory = {}, q = null, note = "" }) {
  return page(
    title,
    `<div class="bar">${esc(openDaysLabel())} &middot; <a href="${esc(mapsSearchUrl())}" rel="noopener" target="_blank">${esc(addressLine())}</a></div>
${header()}
${drawer(categories, subsByCategory, q)}
${body}
${footer(note)}`,
    CSS,
    "/s.js",
  );
}

/* ─────────────────────────────────────────────────────────── the bag ───── */

/*
 * The bag holds nothing on the server. This Worker has no cart, no cookie and
 * no session — it never had, and adding one to show a count would have been the
 * first write on a surface whose whole design is that it does not write.
 *
 * So the bag is the viewer's own device, read by the script from localStorage,
 * exactly like the wishlist (Test-PRD-P0-46-viewer_local_wishlist). The server
 * renders the empty state; the script replaces it if that device has anything
 * in it. Which means the page below is what a first-time visitor sees, and it
 * is written to be useful to them rather than to apologise.
 */
export function bagPage(categories, subsByCategory) {
  const tiles = categories
    .slice(0, 4)
    .map(
      (c) => `    <a class="tile" href="/?category=${encodeURIComponent(c)}">
      <span class="tile-media"></span>
      <span class="tile-name">${esc(label(c))}</span>
    </a>`,
    )
    .join("\n");

  return shell(
    "Your bag",
    `<main class="page bag" id="bag">
  <section class="edit"${reveal}>
    <h1>Your bag is empty</h1>
    <p>Nothing here yet. Everything below is in the shop now, and everything in the shop
       is also on the rail &mdash; come and try it on.</p>
  </section>
  <div class="tiles"${reveal}>
${tiles}
  </div>
  <section class="edit"${reveal}>
    <p>Want first look at what comes in next? <a href="/visit#join">Join our list</a>.</p>
  </section>
</main>`,
    { categories, subsByCategory },
  );
}

/* ───────────────────────────────────────────────────────── the visit ───── */

const hoursTable = () =>
  hoursRows()
    .map((r) => `      <tr><th scope="row">${esc(r.label)}</th><td>${esc(r.text)}</td></tr>`)
    .join("\n");

/*
 * The contact form (ADR-015).
 *
 * A form that posts into nothing is worse than no form (P0-56) — this one has
 * somewhere real to go: store/src/contact.js turns a submission into a Square
 * customer record, in the same directory the counter iPad already writes to.
 *
 * Every field but phone is required, matched by both the browser (`required`)
 * and the handler, because a person with JavaScript off, or a client that
 * skips HTML validation, must be refused the same way a person typing too
 * fast is. Phone is the one optional field — plenty of people write in who
 * would rather not be called.
 *
 * The honeypot (`company`) is a field a person never sees and a robot fills
 * in; hidden with `.trap` off-canvas rather than `display:none`, because a
 * screen reader and most bots both skip a field that is actually hidden from
 * assistive tech, which would defeat the point.
 */
function contactForm() {
  return `    <form class="contact" method="post" action="/contact">
      <label for="c-name">Full name</label>
      <input id="c-name" name="name" autocomplete="name" required>

      <label for="c-phone">Phone <span class="optional">(optional)</span></label>
      <input id="c-phone" name="phone" type="tel" autocomplete="tel">

      <label for="c-email">Email</label>
      <input id="c-email" name="email" type="email" autocomplete="email" required>

      <label for="c-message">Message</label>
      <textarea id="c-message" name="message" rows="5" required></textarea>

      <p class="trap" aria-hidden="true"><label>Leave this empty<input name="company" tabindex="-1" autocomplete="off"></label></p>

      <button class="btn" type="submit">Send</button>
    </form>`;
}

export function visitPage(categories, subsByCategory) {
  /*
   * Three tiers, most-real first. `widgetEmbed` is Square's own snippet,
   * inserted VERBATIM (unescaped) — see the comment on SITE.appointments and
   * ADR-014: it is trusted operator config, not visitor input, and it is the
   * one deliberate exception to "no third party loads onto this page"
   * (Test-PRD-P0-56), scoped to exactly this section on this page. Falling
   * back to a link, and then to a phone number, keeps the page honest about
   * what is actually wired up rather than showing a control that does nothing.
   *
   * Rendered only when the owner is featuring it at all — see the comment on
   * `SITE.appointments.shelved`. Shelved means the SECTION IS ABSENT, not
   * present with a phone-number fallback: a section for a thing we are
   * actively not offering right now is worse than no section.
   */
  const booking = SITE.appointments.widgetEmbed
    ? SITE.appointments.widgetEmbed
    : SITE.appointments.bookingUrl
    ? `    <p><a class="btn" href="${esc(SITE.appointments.bookingUrl)}" rel="noopener" target="_blank">Book an appointment</a></p>`
    : `    <p>Appointments are booked by phone for now: <a href="tel:${esc(SITE.phone.replace(/[^+\d]/g, ""))}">${esc(SITE.phone)}</a>.</p>`;

  const appointments = SITE.appointments.shelved
    ? ""
    : `  <section class="block" id="appointments"${reveal}>
    <h2>Appointments</h2>
    <p>${esc(SITE.appointments.lead)} Tell us what you are looking for and it will be
       waiting, in your size, in a room with a door.</p>
${booking}
  </section>

`;

  return shell(
    "Visit the store",
    `<main class="page visit">
  <section class="edit"${reveal}>
    <h1>Come and see it</h1>
    <p>We are a shop before we are a website. Everything photographed here is on the rail,
       in one room, and someone who knows it is standing next to it.</p>
  </section>

  <section class="block" id="hours"${reveal}>
    <h2>Hours</h2>
    <table class="hours">
      <tbody>
${hoursTable()}
      </tbody>
    </table>
  </section>

${appointments}  <section class="block" id="directions"${reveal}>
    <h2>Directions</h2>
    <p class="address"><a href="${esc(mapsSearchUrl())}" rel="noopener" target="_blank">${esc(addressLine())}</a></p>
    <p class="links">
      <a href="${esc(mapsDirectionsUrl())}" rel="noopener" target="_blank">Directions on Google Maps</a>
      <a href="${esc(mapsSearchUrl())}" rel="noopener" target="_blank">Open the map</a>
    </p>
    <p>We are here ${openDaysCount()} day${openDaysCount() === 1 ? "" : "s"} a week — see <a href="#hours">hours</a> above.</p>
  </section>

  <section class="block" id="contact"${reveal}>
    <h2>Contact</h2>
    <p>Tell us what's on your mind and we will get back to you.</p>
${contactForm()}
  </section>

  <section class="block" id="join"${reveal}>
    <h2>Join our list</h2>
    <p>${esc(SITE.signup.lead)}</p>
    <p><a class="btn" href="${esc(SITE.signup.url)}" rel="noopener" target="_blank">Sign up</a></p>
  </section>
</main>`,
    { categories, subsByCategory },
  );
}

/*
 * The page after a submission — success or failure, same shell, same shape as
 * every other page on this Worker, because a bare "thank you" with no header
 * or footer reads as a different, broken site the moment something goes
 * wrong. `detail` is written by store/src/contact.js and is always a plain,
 * pre-decided sentence — never a raw error, which would either leak nothing
 * useful to the visitor or, worse, leak something that was.
 */
export function contactResultPage(categories, subsByCategory, ok, detail) {
  return shell(
    ok ? "Message sent" : "Not sent",
    `<main class="page">
  <section class="edit"${reveal}>
    <h1>${ok ? "Thank you" : "That did not send"}</h1>
    <p>${esc(detail)}</p>
    <p><a href="/visit#contact">Back to contact</a></p>
  </section>
</main>`,
    { categories, subsByCategory },
  );
}

/* ──────────────────────────────────────────────── collaborations ───────── */

/*
 * Collaborations. Editorial, and empty until there are real ones — a page of
 * invented capsule collections on a real shop's site is a lie with a photograph
 * attached. The shape is here so the first real one is a data entry rather than
 * a build.
 */
export const COLLABORATIONS = [];

export function collaborationsPage(categories, subsByCategory) {
  const items = COLLABORATIONS.map(
    (c) => `  <article class="collab"${reveal}>
    <p class="eyebrow">${esc(c.eyebrow || "")}</p>
    <h2>${esc(c.title)}</h2>
    <p>${esc(c.text)}</p>
    ${c.href ? `<p><a href="${esc(c.href)}">See the pieces</a></p>` : ""}
  </article>`,
  ).join("\n");

  return shell(
    "Collaborations",
    `<main class="page collabs">
  <section class="edit"${reveal}>
    <h1>Collaborations</h1>
    <p>Short runs made with people we know, cut in quantities small enough that we can
       tell you who made each one.</p>
  </section>
${
  COLLABORATIONS.length
    ? items
    : `  <section class="block"${reveal}>
    <p>The first one is being cut now. If you would like to hear when it lands,
       <a href="/visit#contact">tell us</a> or come in and ask.</p>
  </section>`
}
</main>`,
    { categories, subsByCategory },
  );
}
