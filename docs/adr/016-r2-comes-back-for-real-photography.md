# ADR-016 — R2 comes back, for real photography on the storefront

**Status:** Accepted · **Date:** 2026-09-13 · **Amends:** ADR-013 · **Narrows:** P0-29

## Decision

**Bind `MEDIA` again.** A Cloudflare R2 bucket, `vemians-media`, with a public custom domain
(`media.vemians.com`), and a scheduled job (`ops/src/media-backfill.js`) that copies every
photograph Square already has into it.

The owner's call, in as many words: asked directly to build real photography on the storefront
and real product pages, after finding out the shop had shipped with every product photo a
generated placeholder rectangle.

## Why this does not contradict ADR-013

ADR-013 traded photograph *longevity* for one fewer piece of infrastructure — "if we leave
Square, we will just download them when we're leaving." That trade was never about whether the
**storefront** could show a real photograph at all; it was silent on that, because nothing on the
storefront rendered a real photograph either way at the time. What actually blocks a real photo
on the public site is a different, structural rule that ADR-013 did not touch and this ADR does
not touch either: `store/src/index.js` makes zero outbound requests
(Test-PRD-P0-37-mirror_is_ours), so the storefront cannot fetch Square's CDN itself, ever — an
outage at Square must not be able to take the shop down. A real photograph on vemians.com
therefore requires **our own copy, at our own domain**, no matter what ADR-013 decided about
longevity.

ADR-013's own text already named the way out: *"Binding a bucket later restores the original
behaviour with no code change."* `mediaStoreFor(env)` (`ops/src/tools/index.js`) has picked R2
over Square the instant `MEDIA` is bound since before ADR-013 was even written — that fallback
logic was never removed, only left unused. This ADR is that prediction coming true, not a
reversal fought against.

## What changed, concretely

1. **The bucket exists again**, created by `.github/workflows/bootstrap-media.yml` — a workflow
   kept deliberately separate from `bootstrap-resources.yml`, because an R2 step failing on a
   missing token permission is the exact failure ADR-013 records happening twice, and it must not
   take the KV namespaces that Worker actually needs down with it a third time.
2. **A backfill job that did not exist before.** ADR-013 predicted the binding coming back; it
   said nothing about the photographs Square already held by then. `mirror_image.media_key` — "our
   R2 key, once mirrored" — was a column with a comment and no writer. `media-backfill.js` is that
   writer: for every synced image with a `source_url` and no `media_key`, fetch it off Square's
   CDN once, store our own copy, record the key. Runs once per scheduled sync, capped per run so a
   first backfill of an existing catalog spreads across several runs rather than one.
3. **The storefront renders it.** `store/src/catalog.js` builds an `<img src>` straight from
   `media_key` at the bucket's public domain — string concatenation over a mirror fact, not a
   fetch, so the storefront's zero-outbound-request property (P0-37) and its one-D1-binding
   allow-list (P0-24) are both exactly as narrow as before this ADR.

## What this does NOT undo

- **The upload path's choice of store is unchanged in spirit.** `catalog.upload_image` already
  went to R2 when a bucket was bound and to Square when it was not; nothing in that logic moved.
  What changed is which state this deployment is in.
- **`Test-PRD-P0-29-exit_test`'s scope, as ADR-013 narrowed it, is unaffected by this ADR.** A
  photograph uploaded *before* the bucket existed, and never backfilled, still lives only in
  Square until this job (or a future one) reaches it. This ADR widens what the exit test can true-
  fully claim going forward; it does not retroactively rewrite what already happened.
- **The photographs kept in R2 are still never sent back to Square as a bulk export.** Leaving
  Square remains a plan to write when it is needed, not a mechanism built speculatively now.

## What it costs, so nobody is surprised later

The same two things ADR-013 spent avoiding, paid now instead: one more piece of infrastructure to
configure and pay for, and the token-permission step that failed bootstrap-resources.yml twice —
kept isolated to its own workflow this time specifically so a repeat of that failure costs one
bucket, not the KV namespaces the ops Worker depends on for everything else.
