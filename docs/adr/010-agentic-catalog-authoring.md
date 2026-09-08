# ADR-010 — Catalog is authored agentically, into Square

**Status:** Proposed · **Date:** 2026-09-08 · **Extends:** ADR-009

## Decision

Products are created and edited by staff talking to their own AI client — describe the item,
upload photos, set a price — and the result lands in Square, categorised.

This resolves the question ADR-009 left open. The answer was neither of the options offered:
the catalog is curated externally **and** created at the till **and** entered while buying
stock. All three are real, so the design cannot assume a single origin.

## The agent writes to Square, not to our mirror

One write target, whoever is writing. A member of staff at the counter and a member of staff
talking to Claude both end up in the same place, and the mirror follows by sync and webhook.

The alternative — the agent writing our mirror directly, since it is ours and closer — is the
mistake. Two writers into a mirror of a third system diverge from it silently, and the
divergence surfaces as an oversell rather than an error.

So the write path is: **agent → Square → mirror.** Never agent → mirror.

## Media: R2 authoritative, Square gets a copy

Photography is the most expensive thing on the page and the least replaceable. Originals go to
R2 under our own key; Square receives a copy so the item looks right on the POS.

Losing Square must not lose the photographs. This is the one place we deliberately keep two
copies rather than mirroring in one direction.

## Auto-categorisation, and the trap in it

The agent suggests a category. It chooses from **categories that already exist**, and creating
a new one is a separate, explicitly gated action.

This constraint is the whole feature. An agent free to invent categories produces, within a
month, *Coats*, *Outerwear*, *Jackets* and *Coats & Jackets* — each holding a few items, none
holding what a customer expects, and the storefront navigation quietly stops meaning anything.
Nobody notices on any single write; everybody notices at fifty.

So: a closed set to choose from, a suggestion with its reasoning rather than a silent
assignment, and a deliberate act to widen the taxonomy.

## Every catalog write is T2

Price, title and category are commercial facts. Proposal → human approval → execution, with
the approval token minted server-side and never taken from model output (P0-25).

Drafting is T1 and free: describe an item, get a complete proposal back, iterate on it. Only
the commit is gated. The cost lands where the risk is rather than on every keystroke.

## Validation is ours, not Square's

A zero price, a 300-character title, a product with no variation — refused by us with a clear
message. Forwarding invalid input to Square and relaying the bounce is worse on every axis:
slower, a worse message, and an audit row saying we tried.

## Anti-patterns

| Anti-pattern | Why wrong | Correct |
|---|---|---|
| Agent writes the mirror directly | Diverges from Square silently; surfaces as an oversell | Agent → Square → mirror |
| Agent invents categories freely | Forty near-duplicates in a month; navigation stops meaning anything | Choose from a closed set; widening it is gated |
| Silent category assignment | Nobody reviews what nobody is shown | Suggest with reasoning |
| Photos only in Square | Loses the most expensive asset with the vendor | R2 authoritative, Square gets a copy |
| Ungated create because "drafting is safe" | Drafting is safe; committing a price is not | T1 to draft, T2 to commit |
| Letting Square do the validating | Slow, worse messages, an audit row for every typo | Validate before the call |

## Consequences

- The MCP surface gains write tools, so a staff member's own Claude or ChatGPT becomes a
  full authoring tool. The approval step still happens in a browser (P0-35), so the model
  never holds the ability to commit.
- Image upload over MCP has a practical size ceiling. A phone photo is larger than a
  comfortable tool argument, so the transport needs deciding rather than assuming.
- Category taxonomy becomes a thing someone owns. It was implicitly owned by whoever typed
  into Square; now it is a closed set with a gate on it, which is better but not free.
