# ADR-014 — Square Appointments' own widget is the one third party this page loads

**Status:** Accepted, feature shelved · **Date:** 2026-09-10 · **Amends:** ADR-009 · **Narrows:** P0-56

> **Shelved 2026-09-10.** The owner's call to stop featuring appointments on the site for now —
> `SITE.appointments.shelved = true` — separate from "not configured yet." The whole
> `#appointments` section is absent from `/visit` while this holds, not present with the
> phone-number fallback below. Nothing in this decision changed: the widget-vs-custom-build
> reasoning, the P0-56 carve-out and its scoping all stand exactly as written, waiting for the
> flag to flip back.

## Decision

The interactive "book an appointment" interface on the visit page is **Square's own
Appointments booking widget**, embedded verbatim from the snippet Square's dashboard gives you.
Not a custom scheduler built against Square's Bookings API.

The owner's call: use Square's hosted widget rather than build a bespoke one, and Square
Appointments is not yet configured on their account, so today this ships as a third placeholder
alongside the address and the socials — real the day someone turns it on, not before.

## Why the widget, not a custom build

Same shape of trade ADR-009 already made for checkout, and the same answer:

- **Availability, services, staff and hours all live in Square's dashboard already** — that is
  where the owner will actually manage them, on the counter iPad, the same reason ADR-009 made
  Square authoritative for stock. A custom scheduler still needs all of that data, live, which
  means calling Square per request either way.
- **A custom build needs a new API scope, new endpoints, and a new outbound path.** Square's
  Bookings API (`SearchAvailability`, `CreateBooking`) would be a second live, per-request call to
  the provider from the public storefront — today there is exactly one (Payment Links, ADR-009),
  and that one is deliberate and small. Availability cannot be mirrored the way the catalog is
  (P0-37): it changes by the minute, so there is no nightly-sync version of this that stays
  correct. A live call is what a custom build actually requires, not an implementation detail to
  defer.
- **The widget is Square's to keep current.** Its markup, its script, its own handling of
  double-booking (P0-18 is about staff shifts in ops, not customer bookings, and stays
  unaffected) — all Square's problem, the same reason Payment Links stayed a redirect instead of
  embedded card fields.

Building our own would buy a scheduler that looks like the rest of this site, at the cost of a
new credential, a new live provider dependency on the public path, and a service we would then
own keeping correct against whatever Square changes next. Not at this stage — revisit if the
widget's look is ever the thing actually costing bookings, not before, mirroring exactly the
call ADR-009 already made about the Web Payments SDK.

## What this costs P0-56

Test-PRD-P0-56 asserted **no third party loads onto any page** — no `<iframe>`, no external
`<script src>`, no external stylesheet, anywhere. That guarantee now has exactly one carve-out:

- **Scoped to one page.** Only `/visit` may ever carry it — no other route renders
  `SITE.appointments.widgetEmbed`.
- **Scoped to one field.** The permitted script is whatever `SITE.appointments.widgetEmbed`
  itself names — not "anything Square-shaped," and not a rule the test can satisfy by pattern-
  matching a domain. The test reads the same config the page renders from, so the exception can
  never drift wider than what a person actually pasted in.
- **Absent by default.** Unconfigured, `widgetEmbed` is `""` and the guarantee holds exactly as
  written — the amendment costs nothing until the day it is actually turned on.

## Why the snippet is pasted verbatim, unescaped, rather than reconstructed

`shared/commerce/square/client.js` already established the standard this follows: pin evidence,
never guess. Square's widget markup is not documented anywhere this environment's egress can
reach right now, and it is Square's to change without notice — encoding an assumed shape into
this codebase would mean silently breaking the day Square updates it, in exactly the way
`SQUARE_VERSION`'s comment exists to prevent for the REST API.

So `widgetEmbed` holds the **whole snippet**, copied from Square's dashboard (Appointments →
Online Booking → Share → Add to your website) into one field, and the page inserts it verbatim.
Trusted operator config, the same trust level `SITE.social[].href` or `SITE.phone` already carry
— never visitor input, and nothing here parses or validates its shape.

## What this does NOT concede

- **Checkout's boundary is unchanged.** Square is still called live for exactly one thing on the
  commerce path — minting a Payment Link. The widget is a second, independent exception, not a
  widening of that one.
- **The mirror is unchanged.** Catalog and stock still read from our own D1 mirror, never
  Square per request (P0-37 stands for everything except this one widget and Payment Links).
- **Portable if Square Appointments is ever dropped.** Clearing `widgetEmbed` is a one-line
  config change, same as `bookingUrl` — the page falls back to a link, then to a phone number,
  never to a broken control.

## Anti-patterns

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| A custom scheduler calling Square's Bookings API per request | A second live provider dependency on the public path, for data Square already exposes as a widget | Embed Square's own widget |
| Reconstructing Square's widget markup from memory instead of the operator's own snippet | Silently stale the day Square changes it, with no evidence this environment could have checked | Store and render the exact snippet verbatim |
| Loosening P0-56 to "third-party scripts are fine now" | Reopens the door to anything, not the one thing an owner deliberately pasted in | Scope the exception to `SITE.appointments.widgetEmbed` specifically, on `/visit` only |
| Shipping a widget snippet that does not exist yet | A control that does nothing is worse than a phone number that works | Keep it `""` — PLACEHOLDER — until Square Appointments is actually configured |

## Open questions

1. **Deposits or no-show fees.** If Square Appointments is configured to take a card on file,
   that is Square's widget handling PCI scope, same as Payment Links today — worth a one-line
   confirmation when appointments actually goes live, not a blocker now.
2. **Ops visibility.** Whether staff need appointment bookings visible inside `ops` (alongside
   orders) is unopened here — this ADR covers only the public storefront's booking interface.
