# ADR-015 — The contact form writes a Square customer record, and holds the first secret the storefront has ever carried

**Status:** Accepted · **Date:** 2026-09-10 · **Amends:** ADR-009 · **Narrows:** P0-26, P0-37, P0-56

## Decision

The visit page's contact form — full name, email, an optional phone number, a message, all
required except the phone — does not post into our own database and does not send an email. It
calls Square's `CreateCustomer` endpoint and lands the submission as a **customer record in the
merchant's own Square Customer Directory**, the same one the counter iPad already writes to, with
the message stored in that record's `note` field.

This is the owner's call, made in as many words: get rid of the plain "write to
hello@vemians.com" text and replace it with a real form that goes somewhere.

## Why Square, not our own store and not an email service

Same reasoning family as ADR-013 (photographs) and ADR-014 (appointments): **if the owner already
looks in Square for this, do not build a second place for them to check.** A contact-form
submission from a stranger who might become a customer belongs next to every other customer
record the owner already manages from the same dashboard.

It is also the same instinct RULES.md and this repository's own `identity` vault already apply to
customer data generally, pointed at a different surface. This platform goes out of its way to keep
direct identifiers **out** of its own stores — envelope encryption, crypto-shredding, an opaque id
everywhere else — precisely because holding name-plus-contact-details safely is real, ongoing work.
A contact form is a second door into exactly that category of data (an unauthenticated stranger's
name, email, sometimes a phone number, plus free text), and the honest options were: build a second
vault-shaped thing for it, or hand it to the vendor who already has to solve that problem for their
own Customers product. The second one is not a shortcut; it is the same minimisation principle
applied consistently.

## What this costs — spelled out plainly, because it is real

**This is the first secret the public, unauthenticated storefront Worker has ever held.** Every
other credential in this codebase lives behind Cloudflare Access (`ops`) or in a scheduled job with
no public entry point. `SQUARE_ACCESS_TOKEN_CONTACT` is different: it ships in a Worker anyone on
the internet can send a request to. A leak — a logged error that somehow included it, a dependency
compromise, a misconfigured var dumped in a response — hands whoever finds it write access to
Square's Customer Directory for whatever that token's permissions cover.

Three mitigations, in order of how much they actually matter:

1. **A dedicated token, under a name that cannot be confused with any other.** `env.SQUARE_ACCESS_TOKEN_CONTACT`
   is read in exactly one file, `store/src/contact.js`, and nowhere does this codebase read
   `SQUARE_ACCESS_TOKEN` (the name `ops`'s catalog sync uses) inside the `store/` package. A
   labeled test asserts both halves of that: the name is distinct, and only `contact.js` reads it.
   This is not encryption or a permission boundary — it is the cheapest possible guarantee that
   compromising one path cannot silently widen into the other, and it costs nothing to keep.

2. **Scope the token at the source, in Square's own dashboard — a step this code cannot enforce.**
   If the Square account this token comes from supports issuing a credential restricted to
   `CUSTOMERS_WRITE` alone (no Payments, Orders, Inventory or Catalog), that is the token that goes
   here, never the one already used for catalog sync or anything broader. This is a checklist for
   whoever holds the Square dashboard, not something a Worker can verify about its own token at
   runtime — Square's token-introspection surface was not something this environment's egress
   could reach to confirm one way or the other. **Until that scoping is done, treat this exactly
   like every other credential in this repository that "works" before it is actually safe: real,
   but not yet correctly bounded.**

3. **Nothing is ever logged.** `client.js`'s existing rule — the token never appears in a log line,
   an error message, or a thrown object — already covers this call for free, because it is the
   same client every other Square call in this codebase goes through.

**What is explicitly NOT built here:** rate limiting, a CAPTCHA, or any other anti-abuse
infrastructure beyond a honeypot field. A flood of junk submissions creates junk Square customer
records — an annoyance the owner can bulk-delete from Square's own dashboard — not a security
incident and not a cost this shop's current scale needs engineered away pre-emptively. Revisit if
it ever actually happens (see Open questions).

## What this costs the three PRD guarantees it narrows

- **P0-26 / P0-37 ("the storefront makes zero calls to a commerce provider except to mint a
  checkout URL")** widens by exactly one case: submitting the contact form. Everything else —
  every GET route, the whole catalog and browsing path — is exactly as pure as before.
  `store/src/catalog.js` and `store/src/views.js` import nothing from `shared/commerce/square` and
  never will for this feature; the exception lives entirely in `store/src/contact.js`, one file,
  one route (`POST /contact`), one credential. A test scans catalog.js and views.js exactly as it
  did before this ADR, plus a new, separate test that pins the exception to contact.js by name.

- **P0-56 ("a contact form ships only when it has somewhere to go")** is satisfied rather than
  narrowed: this is that form, finally built, now that a destination was chosen.

## Anti-patterns

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Reusing `SQUARE_ACCESS_TOKEN` (ops's catalog-sync token) for the contact form | One compromised, public-facing surface would carry the same credential as every private, Access-gated one | A separate name, `SQUARE_ACCESS_TOKEN_CONTACT`, read in exactly one file |
| Storing the submission in a D1 table of our own "just in case" | Reinstates the exact identifier-handling burden the `identity` vault exists to contain, for data that does not need to live here at all | Square holds it; this Worker keeps zero rows |
| Searching Square for an existing customer by email before creating one, to avoid duplicates | A second live call on the public path, to solve a cosmetic problem (duplicate directory entries) Square's own dashboard already has a merge tool for | Always create; let the owner merge duplicates in Square if it ever matters |
| Letting the P0-37 "no provider call" test loosen everywhere once one exception exists | The exact drift that turns a scoped exception into "third-party calls are fine now" (ADR-014 names the same failure mode for scripts) | Scope the test to the one file, the one credential name, exactly like every other exception in this codebase |
| Logging the raw Square error object on failure | `client.js` already keeps the token out of it, but a raw payload can still carry other operator-configured detail nobody meant to put in a log | Log status and message only, exactly as `client.js`'s own `SquareError` already shapes it |

## Open questions

1. **Token scoping is a manual step, not yet confirmed.** Whoever holds the Square dashboard needs
   to generate (or restrict) a token to the narrowest permission that can create a customer, before
   this goes live with a real credential. Sandbox testing does not need this; production does.
2. **Anti-abuse beyond a honeypot** — worth adding if junk submissions actually become a problem,
   not before. Cloudflare's own bot-management or rate-limiting at the zone level is the more
   likely first move, since it needs no code change here at all.
3. **Note field length.** 500 characters, in `shared/commerce/square/customers.js`, is a guess —
   Square's own docs on the real ceiling were unreachable from this environment, the same wall
   `client.js` hit pinning `SQUARE_VERSION`.
4. **Ops visibility.** Whether staff should see contact submissions inside `ops` (rather than only
   in Square's own dashboard) is unopened here, the same way ADR-014 left appointment-booking
   visibility in `ops` unopened.
