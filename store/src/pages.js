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
import { SITE, addressLine, hoursRows, mapsDirectionsUrl, mapsSearchUrl } from "../../shared/site.js";
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
    `<div class="bar">Open Monday to Saturday &middot; <a href="${esc(mapsSearchUrl())}" rel="noopener" target="_blank">${esc(addressLine())}</a></div>
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
    <p>Prefer to be looked after? <a href="/visit#appointments">Book an appointment</a> and
       we will have your size ready.</p>
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
 * Contact, and why there is no form yet.
 *
 * A form that posts into nothing is worse than a phone number: the person
 * believes they have been in touch and they have not. Delivering a message
 * needs one outbound request from this Worker, and this Worker deliberately
 * makes none — see the header of src/index.js — so where that request should go
 * is a decision to take rather than a default to pick.
 *
 * Until it is taken, this block is the phone number, the address and the email,
 * all of which work today.
 */
function contactBlock() {
  return `    <p>Call <a href="tel:${esc(SITE.phone.replace(/[^+\d]/g, ""))}">${esc(SITE.phone)}</a>
       or write to <a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>. We answer both.</p>
    <p>Or come in and ask &mdash; <a href="#directions">we are here</a>, six days a week.</p>`;
}

export function visitPage(categories, subsByCategory) {
  const booking = SITE.appointments.bookingUrl
    ? `    <p><a class="btn" href="${esc(SITE.appointments.bookingUrl)}" rel="noopener" target="_blank">Book an appointment</a></p>`
    : `    <p>Appointments are booked by phone for now: <a href="tel:${esc(SITE.phone.replace(/[^+\d]/g, ""))}">${esc(SITE.phone)}</a>.</p>`;

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

  <section class="block" id="appointments"${reveal}>
    <h2>Appointments</h2>
    <p>${esc(SITE.appointments.lead)} Tell us what you are looking for and it will be
       waiting, in your size, in a room with a door.</p>
${booking}
  </section>

  <section class="block" id="directions"${reveal}>
    <h2>Directions</h2>
    <p class="address"><a href="${esc(mapsSearchUrl())}" rel="noopener" target="_blank">${esc(addressLine())}</a></p>
    <p class="links">
      <a href="${esc(mapsDirectionsUrl())}" rel="noopener" target="_blank">Directions on Google Maps</a>
      <a href="${esc(mapsSearchUrl())}" rel="noopener" target="_blank">Open the map</a>
    </p>
  </section>

  <section class="block" id="contact"${reveal}>
    <h2>Contact</h2>
${contactBlock()}
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
