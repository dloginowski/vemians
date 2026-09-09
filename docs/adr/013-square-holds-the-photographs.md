# ADR-013 — Square holds the photographs

**Status:** Accepted · **Date:** 2026-09-09 · **Amends:** ADR-009 · **Narrows:** P0-29

## Decision

**No R2 bucket. Photographs go to Square, and Square holds the only copy.**

The owner's call, in their words: *"I don't care about longevity. If we leave Square, then we will
just download them when we're leaving."*

## Why this is a reasonable trade, stated properly

Square hosts catalog images — `POST /v2/catalog/images`, multipart, and Square returns a URL. The
adapter already implemented it. **The bucket was never about capability.** It existed so that
leaving Square would not also mean leaving the photography behind, because a Square image URL dies
with the Square account.

Against that: a bulk export before departure is a real exit, the photographs are also on whatever
device shot them, and one fewer piece of infrastructure is one fewer thing to configure, pay for
and get the permissions right on. Setting up R2 had already cost two failed workflow runs and a
token permission that still is not granted.

## What it costs, so nobody is surprised later

1. **The export must happen while the account is live.** A closed, suspended or lapsed Square
   account is not a slow exit, it is no exit — there is nothing to download from. This is the whole
   of the risk and it is a calendar problem, not an engineering one.
2. **P0-29's exit test can no longer claim media survives** provider deletion. Amended rather than
   quietly left true-looking.
3. **`bytes(key)` does not exist on this path.** R2 could return the original; Square returns a
   URL. The Square store refuses the call by name rather than returning empty, so a caller cannot
   mistake "we do not hold pixels" for "there is no image".

## The mapping problem, and why there is no table

An upload key is minted BEFORE the bytes arrive, so that an agent can carry on composing a product
while a human uploads from their phone. With a bucket, the key is the R2 key. Without one,
something must remember which Square image a key became.

**Square's `CatalogImage` carries a searchable `name`.** So the upload sets `name` to our key, and
`findByName()` asks Square for it back. Square is the store and the index. A local table mapping
our keys to Square ids would be a second thing to keep correct, in a system where the bytes only
ever live in one place anyway.

## Both stores, one contract

`createMediaStore` (R2) and `createSquareMediaStore` (Square) present the same surface, and
`mediaStoreFor(env)` picks by whether `MEDIA` is bound. The signed upload link is minted by ONE
shared function used by both — a path or date format that differed between them would send the
browser and the agent to different places, and this repository has produced that exact class of bug
three times in a day.

Binding a bucket later restores the original behaviour with no code change. The decision is
reversible; the photographs uploaded in the meantime are not.
