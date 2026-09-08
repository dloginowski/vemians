# Design direction

Reference: **Mytheresa** — *The finest edit in luxury* (mobile, category listing).

> **Provenance.** The site is blocked by this environment's egress proxy, so values below are
> measured from a **mobile screenshot** supplied on 2026-09-07, at device-pixel accuracy.
>
> The reference is a **fluid, responsive layout**. The capture is therefore *one sample point
> on that curve*, not the specification: 1080dpx at DPR 2, a 540px CSS viewport. Column
> arithmetic checks out at that width (540 − 60 margins − 16 gutter = 2 × 232), which is why
> the measurements are trustworthy — but the absolute margin and column figures are outputs of
> the viewport, not design constants. §3.2 separates what is invariant from what flexes.

Satisfies **G3** and **R2.5** in [`PRD.md`](./PRD.md).

---

## 1. The idiom

Luxury retail design is **subtractive**. Photography carries the emotional load; the
interface earns trust by getting out of the way. Confirmed in the reference:

1. **The image is the hero.** Interface elements are monochrome and quiet.
2. **Colour comes only from the product.** The palette is fully achromatic.
3. **Space, not lines.** No cards, borders, shadows or rounded corners anywhere.
4. **Brand name leads** on the product card, then description, then price.
5. **Editorial framing** — a named, curated "Edit" with a title and standfirst above the grid,
   rather than a bare category listing.

## 2. What the reference actually does — and where I guessed wrong

My first draft assumed the austere Net-a-Porter/SSENSE register. Mytheresa is **warmer and
more legible**. Six corrections, all now reflected below:

| # | I proposed | Reference actually does |
|---|---|---|
| 1 | A five-step type scale down to 13px | **Almost no scale.** Body, nav, brand, product name and price are all ~16px |
| 2 | Uppercase 11px labels at `0.12em` tracking | **Sentence case, normal tracking.** Tracked caps are reserved for the wordmark alone |
| 3 | Modest, restrained headings | Heading is **bold**, 1.9× body, centred |
| 4 | White ground throughout | Product images sit on a **cool pale grey** `#EFF0F4` |
| 5 | 3:4 portrait imagery | **8:9** (1:1.125) — considerably shallower |
| 6 | (omitted) | A lowercase **eyebrow label** and wishlist heart sit *above* each image |

The through-line: it is less austere than I assumed. Larger type, sentence case, bold
headings. Restraint comes from the palette and the whitespace, not from shrinking the text.

## 3. Measured tokens

**Colour**

| Token | Value | Use |
|---|---|---|
| `--ground` | `#FFFFFF` | Page |
| `--image-ground` | `#EFF0F4` | Behind product photography. Cool, not warm |
| `--ink` | `#000000` | Text — effectively pure black |
| `--bar` | `#000000` | Announcement bar, white text, centred |
| `--rule` | `#E5E5E5` | Header underline. Almost the only rule on the page |

No accent colour appears anywhere in the capture.

**Type** — one size does nearly all the work. Values in CSS px at DPR 2.

| Role | Size | Case / weight | Notes |
|---|---|---|---|
| Wordmark | ~32px | Uppercase, tracked, light | The *only* tracked-caps element |
| Editorial heading | ~30px (1.9×) | Sentence case, **bold**, centred | "The finest edit in luxury" |
| Body / standfirst | **16px** / 22px | Regular, **left-aligned** | Left-aligned under a centred heading |
| Category nav | 16px | Sentence case | Pipe-separated, horizontally scrollable |
| Product brand | ~16px | Regular | Line 1 of the card |
| Product name | 16px | Regular | Line 2, truncated to one line with ellipsis |
| Price | ~16px | Regular | Format is `$ 5,600` — **space after the symbol** |
| Eyebrow label | ~14px | **lowercase** | "new season", "new" |

Line-height on body copy is 22/16 = **1.375**.

### 3.1 Invariant — the design DNA

These hold at every viewport and are what actually make it feel like this:

- Achromatic palette; `#EFF0F4` behind all product photography.
- **8:9** image aspect, applied without exception. A consistent crop across the grid is
  most of what makes these pages read as composed.
- The near-flat type scale — one size doing nearly all the work.
- Sentence case; tracked caps reserved for the wordmark.
- Card order: eyebrow + heart → image → brand → name → price.
- No borders, shadows, cards or rounded corners.

### 3.2 Responsive — derived, not declared

The grid has **no breakpoints**. Column count is derived from available width, so the
catalog uses whatever resolution it is given. Measured in headless Chromium against
`shared/design/catalog-grid.css`:

| Viewport | Columns | Card width |
|---|---|---|
| 390px | 2 | 173px |
| 540px *(the reference capture)* | 2 | 242px |
| 768px | 3 | 227px |
| 1024px | 3 | 303px |
| 1440px | 5 | 247px |
| 1920px | 7 | 232px |
| 2560px | 7 | 323px |
| 3840px | 11 | 312px |

Card width stays within 173–323px across a 10× range of viewport widths. Wide displays
gain **both** more columns and slightly larger cards — the card floor is
`clamp(14rem, 11vw, 19rem)` rather than a constant, which stops a 4K display degrading
into a contact sheet of thumbnails.

Two columns on the narrowest phones, never one, enforced by the `min(…, 46%)` floor.

**`auto-fill`, not `auto-fit`** — despite the names reading backwards. On a full grid the
two are identical. They diverge on filtered results, where `auto-fit` collapses the empty
tracks and lets the survivors absorb the space:

| 2 results at 3840px | `auto-fill` | `auto-fit` |
|---|---|---|
| Card width | 312px | **1842px** |

A 1842px-wide product image is not a design. `auto-fill` is what actually keeps the layout
filling the viewport sensibly at *every* result count.

Media queries are then reserved for genuine art-direction changes — the header collapsing,
type stepping up — rather than re-declaring the grid.

## 4. Product card anatomy

```
  new season                    ♡     ← eyebrow ~14px lowercase; heart outline, right
┌────────────────────────────────┐
│                                │
│        8:9, ground #EFF0F4     │    ← product floats on grey, never white
│                                │
└────────────────────────────────┘
  Valentino                           ← brand, 16px regular
  Shearling-trimmed wool-bl…          ← name, 16px regular, ONE line, ellipsis
  $ 5,600                             ← price, 16px, space after symbol
```

The eyebrow and heart sit **above** the image, on the page ground — not overlaid on the
photograph. No border, no shadow, no rounded corners: the image edge is the card.

## 5. Still unobserved

Desktop column count, gutters and whether there is a max-width cap; the product detail page;
whether type steps up at wider viewports; hover behaviour (the alternate-image
swap is a genre convention but unverified here); sale/markdown treatment; footer; the filter and
sort panels. Screenshots of a desktop grid and a product page would close most of this.

**Typeface.** A humanist sans with fairly geometric round forms, set light in the wordmark and
bold in the heading. I am not going to guess the exact face from one screenshot — and it is a
brand decision regardless, and the single largest lever on how this feels.

**Light only.** I would not build dark mode. The genre is committed to a white ground.

## 6. The tension with N1

**PRD N1 sets p75 LCP < 2.0s, and this design is image-led.** Image strategy, not framework
choice, decides whether we hit it. Required, not optional:

- AVIF with WebP fallback, via Cloudflare Images off R2 originals (**R2.2**).
- `srcset` cut to the real rendered column width at each breakpoint, with a `sizes` attribute
  that mirrors the `clamp()` above — the browser cannot infer it from a fluid grid. At the one
  measured layout that slot is 232px, so never ship a 2000px file into it.
- `fetchpriority="high"` on the first-row images; lazy-load below the fold.
- Explicit dimensions on every image. With a fixed 8:9 slot there is no excuse for layout shift.
- A page-weight budget enforced in CI, alongside the Exit Test (**R2.6**).

The grey image ground helps here: a flat `#EFF0F4` placeholder at the right aspect ratio is
indistinguishable from an unloaded image, so the grid holds its shape while photography streams in.

## 7. Learning from it versus copying it

Build **in this idiom** — these conventions are shared genre vocabulary. Do not reproduce
Mytheresa's specific expression: their wordmark, typeface, photography or yellow-box identity.

Partly legal, mostly strategic. For a luxury brand distinctiveness *is* the product, and a
clone reads as reseller rather than house.
