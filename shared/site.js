/*
 * The facts about the shop that are not the catalog.
 *
 * Opening hours, the address, the phone number, where the social accounts are,
 * and the two link columns in the footer. One file, because these appear on
 * every page and in more than one surface, and a phone number that is right in
 * the footer and wrong on the visit page is worse than one that is missing.
 *
 * NOT provider data and not editorial copy about a product — this is the shop
 * itself, so it lives in Git next to the code that renders it (ADR-009's split:
 * Square owns commerce, Git owns everything Square has no field for).
 *
 * PLACEHOLDERS ARE MARKED. Anything below that is not yet the real value says
 * so in a comment, so nobody ships a map link to a street we are not on. Change
 * them here and every page follows.
 */

export const SITE = {
  name: "Vemians",

  /* The real one. Supplied by the owner, and the only address in the codebase —
     the footer, the visit page and both map links all read it from here. */
  address: {
    line1: "719 S San Fernando Blvd",
    line2: "",
    city: "Burbank",
    region: "CA",
    postal: "91502",
    country: "USA",
  },

  /* PLACEHOLDER — real contact details pending. */
  phone: "+1 (555) 010-0000",
  email: "hello@vemians.com",

  /*
   * Hours as data, not as a paragraph, so "are you open now" is answerable by
   * code rather than by reading. `day` is the JS weekday index (0 = Sunday).
   * `null` is closed. Times are 24h local strings.
   */
  hours: [
    { day: 1, from: "11:00", to: "18:00" },
    { day: 2, from: "11:00", to: "18:00" },
    { day: 3, from: "11:00", to: "18:00" },
    { day: 4, from: "11:00", to: "19:00" },
    { day: 5, from: "11:00", to: "19:00" },
    { day: 6, from: "11:00", to: "18:00" },
    { day: 0, from: null, to: null },
  ],

  /*
   * Appointments. A private hour with a stylist, which for a shop this size is
   * the thing worth booking rather than a slot machine of fifteen-minute
   * windows. Until a booking provider is chosen, the page asks people to
   * call, which is true, rather than showing a control that goes nowhere.
   *
   * Two ways a provider can be wired in, in order of preference:
   *
   *   `widgetEmbed` — the exact snippet Square's dashboard gives you at
   *   Appointments → Online Booking → Share → Add to your website (a
   *   <script> tag, sometimes with a companion <div>). Pasted in VERBATIM,
   *   unescaped, by design: this is trusted operator config, never visitor
   *   input, and Square's own markup is not this codebase's to guess at or
   *   reconstruct — see ADR-014. It renders inline in the #appointments
   *   section, which is what makes it "interactive" rather than a link out.
   *
   *   `bookingUrl` — a plain link to Square's hosted booking page, opened in
   *   a new tab. Lighter than the widget, no script loaded, and works as a
   *   fallback if the widget snippet is ever pulled without a replacement.
   *
   * `widgetEmbed` wins when both are set. Neither is real until the owner has
   * actually turned on Square Appointments (ADR-014) — until then both stay
   * PLACEHOLDER, and the page keeps telling people to call, which is true.
   *
   * `shelved` is a separate, deliberate decision from "not configured yet":
   * the owner's call to stop featuring appointments on the site for now,
   * regardless of whether a widget or link is ever set. `true` here means the
   * whole section is absent from the visit page, the footer and the drawer —
   * not shown with a phone-number fallback, not shown at all — because a
   * section for a thing we are actively not offering is worse than no
   * section. The wiring underneath (this comment, ADR-014, the widget/link
   * fallback chain) stays exactly as built: flipping this back to `false` is
   * the whole of picking the feature back up.
   */
  appointments: {
    shelved: true,             // the owner's call — see the paragraph above
    widgetEmbed: "",          // PLACEHOLDER — Square Appointments not yet configured
    bookingUrl: "",           // PLACEHOLDER — no booking provider connected yet
    lead: "Private appointments run an hour and are complimentary.",
  },

  /*
   * Join the list — a hosted Square page (Customer Directory → Customer
   * programs), not a form this codebase renders or a mailing address this
   * codebase collects. Same call ADR-009 made for checkout and ADR-014 for
   * booking: enrolment fields, consent language and where the data actually
   * lands are Square's to keep current, so this is a plain link out, exactly
   * like `appointments.bookingUrl`, opened in a new tab, nothing embedded.
   *
   * Real from the day it was handed over — no PLACEHOLDER marker, unlike the
   * fields above it, because this URL is not a guess.
   */
  signup: {
    url: "https://squareup.com/customer-programs/enroll/nEi7fZrMYRDM?utm_medium=copied-link&utm_source=online",
    lead: "First word on new arrivals, restocks and private sales.",
  },

  /* Social. `handle` is what a person reads; `href` is where it goes. An
     account we do not have is simply not in this list — an icon linking to a
     404 is worse than one fewer icon. PLACEHOLDER handles. */
  social: [
    { name: "Instagram", handle: "@vemians", href: "https://instagram.com/vemians" },
    { name: "Pinterest", handle: "vemians", href: "https://pinterest.com/vemians" },
    { name: "TikTok", handle: "@vemians", href: "https://tiktok.com/@vemians" },
  ],
};

/* One string, built from the parts above, for a map link and for the page. */
export const addressLine = (a = SITE.address) =>
  `${a.line1}, ${a.line2 ? `${a.line2}, ` : ""}${a.city}, ${a.region} ${a.postal}`;

/*
 * Google Maps, two ways, because they are different questions:
 *   mapsSearchUrl  "where is this" — opens the place.
 *   mapsDirectionsUrl  "take me there" — opens directions from wherever the
 *   person is, which is what someone standing outside on a phone actually taps.
 *
 * Built with the documented `google.com/maps` query parameters and the address
 * encoded, so there is no embedded API key and nothing to leak, and no iframe
 * loading a third party's script on our page.
 */
export const mapsSearchUrl = (a = SITE.address) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLine(a))}`;

export const mapsDirectionsUrl = (a = SITE.address) =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressLine(a))}`;

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* Monday first, the way a shop's door sign reads, with consecutive identical
   days collapsed into one row — "Mon – Wed 11:00–18:00" rather than three
   lines saying the same thing. */
export function hoursRows(hours = SITE.hours) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const byDay = new Map(hours.map((h) => [h.day, h]));
  const rows = [];
  for (const day of order) {
    const h = byDay.get(day) || { day, from: null, to: null };
    const text = h.from && h.to ? `${h.from}–${h.to}` : "Closed";
    const last = rows[rows.length - 1];
    if (last && last.text === text) last.days.push(day);
    else rows.push({ days: [day], text });
  }
  return rows.map((r) => ({
    label: r.days.length === 1 ? DAY[r.days[0]] : `${DAY[r.days[0]]} – ${DAY[r.days[r.days.length - 1]]}`,
    text: r.text,
  }));
}

/*
 * The footer's link columns. Two lists, named, so the footer renders from data
 * and a new page is one line here rather than markup pasted into a template.
 * Every href points at a route this Worker actually serves — a footer full of
 * dead links is the fastest way to make a small shop look abandoned.
 */
/*
 * A FUNCTION, not a static list, because "Book an appointment" has to come
 * and go with `SITE.appointments.shelved` — a footer link straight into a
 * section the visit page no longer renders is a dead link, and P0-56 already
 * has a labeled check that every footer link goes somewhere
 * (`no_footer_link_goes_nowhere`).
 */
export function footerColumns() {
  return [
    {
      heading: "Visit",
      links: [
        { text: "Store hours", href: "/visit" },
        ...(SITE.appointments.shelved ? [] : [{ text: "Book an appointment", href: "/visit#appointments" }]),
        { text: "Directions", href: "/visit#directions" },
        { text: "Contact us", href: "/visit#contact" },
      ],
    },
    {
      heading: "The shop",
      links: [
        { text: "New in", href: "/" },
        { text: "Collaborations", href: "/collaborations" },
        { text: "Your bag", href: "/bag" },
        { text: "Join our list", href: "/visit#join" },
      ],
    },
  ];
}
