# Design direction

Reference supplied: **Mytheresa** — *New Season: The Finest Edit in Luxury*.

> **Provenance.** This environment's network policy blocks `mytheresa.com`, so I could not
> load or screenshot the page. What follows is the **luxury multi-brand retail idiom** as
> practised by Mytheresa, Net-a-Porter, MatchesFashion and SSENSE — a stable and well
> documented convention — not an observation of that specific page. Treat every concrete
> value below as a proposal to correct, not a measurement. Screenshots would let me tighten
> this considerably.

Satisfies **G3** and **R2.5** in [`PRD.md`](./PRD.md): the design system is ours, with no
vendor theming layer.

---

## 1. The idiom, and why it works

Luxury retail design is **subtractive**. The interface earns trust by getting out of the
way; the product photography carries the entire emotional load. Every rule below follows
from that one idea.

1. **The image is the hero. Chrome recedes.** Interface elements are small, quiet and
   monochrome. Nothing competes with the product.
2. **Colour comes only from the product.** The palette is achromatic — white ground, black
   text, one grey. Saturated UI colour reads as discount retail.
3. **Space, not lines.** Separation is achieved with whitespace. Borders, shadows, cards
   and rounded corners are largely absent.
4. **Small type, wide tracking.** Restraint signals confidence. Labels are 11–12px,
   uppercase, generously letter-spaced. Headings stay modest — no 72px hero type.
5. **Brand name first.** On a multi-brand product card the designer's name leads, then the
   product description, then price. This ordering is a genre convention because the brand
   is the primary purchase signal. Getting it backwards immediately reads as mass-market.
6. **Editorial framing.** "Edits" — curated, named, seasonally themed collections with
   editorial imagery and copy — are the organising unit, not raw category listings. The
   linked page is exactly this.

## 2. Proposed tokens

Starting values. The typeface is a brand decision and is deliberately left open (§4).

**Colour** — achromatic; all pairings meet WCAG AA.

| Token | Value | Use |
|---|---|---|
| `--ground` | `#FFFFFF` | Page |
| `--ground-alt` | `#FAFAF8` | Editorial bands, quiet sections |
| `--ink` | `#111111` | Primary text |
| `--ink-muted` | `#6E6E6E` | Product name, metadata (4.9:1 on white) |
| `--rule` | `#E5E5E5` | The rare divider |
| `--sale` | `#8A2119` | Markdown price only. Nowhere else |

**Type scale** — small and tight.

| Token | Size / tracking | Use |
|---|---|---|
| `--t-nav` | 11px, uppercase, `0.12em` | Navigation, labels |
| `--t-meta` | 12px, `0.04em` | Price, size, metadata |
| `--t-brand` | 13px, medium, `0.06em` | Product card — brand name |
| `--t-name` | 13px, regular, muted | Product card — description |
| `--t-body` | 15px / 1.6 | Editorial copy |
| `--t-h2` | 22px, `0.06em` | Section headings |
| `--t-h1` | 34px | Editorial hero. Ceiling, not a target |

**Space** — 4px base; the large end gets used far more than in typical UI.
`4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128`

**Grid**

| Breakpoint | Columns | Gutter | Page margin |
|---|---|---|---|
| ≥1440px | 4 | 24px | 48px |
| 1024–1439 | 3 | 20px | 32px |
| 768–1023 | 2 | 16px | 24px |
| <768 | 2 | 12px | 16px |

Two columns on mobile, not one — the genre standard, and it keeps browsing dense enough
to scan.

**Imagery.** Portrait **3:4**, applied without exception. A consistent crop across the grid
is most of what makes these pages feel composed. Neutral or on-model, consistent lighting.
Hover swaps to an alternate shot.

## 3. Product card anatomy

```
┌────────────────┐
│                │
│   3:4 image    │   ← hover swaps to alternate
│                │
└────────────────┘
  THE ROW              ← brand, --t-brand, uppercase
  Leather tote bag     ← name, --t-name, muted
  $1,890               ← price, --t-meta
```

No border, no card background, no shadow, no rounded corners. The image edge *is* the card.

## 4. Decisions still open

- **Typeface.** The single largest lever on how this feels, and a brand decision rather
  than a technical one. The structure above works with a refined grotesque (Söhne, Neue
  Haas), a modern serif for the wordmark, or a well-set system stack for v1. Licensing
  cost varies enormously — worth deciding early since it affects §2 sizing.
- **Light only.** I would not build dark mode. The genre is committed to a white ground and
  a dark variant would weaken it. This is a deliberate single-look commitment.

## 5. The tension with N1

**PRD N1 sets p75 LCP < 2.0s. This design is image-led. Those pull against each other**,
and image strategy — not framework choice — decides whether we hit it.

Mitigations, all required rather than optional:

- AVIF with WebP fallback, via Cloudflare Images off R2 originals (**R2.2**).
- Responsive `srcset` cut to the actual grid widths; never ship a 2000px file into a 340px slot.
- `fetchpriority="high"` on the hero or first-row image; lazy-load everything below the fold.
- Explicit `width`/`height` on every image — with a 3:4 grid there is no excuse for layout shift.
- A page-weight budget enforced in CI, alongside the Exit Test.

Set the image budget before building, not after the first Lighthouse run.

## 6. Learning from it versus copying it

We should build **in this idiom** — the conventions above are shared genre vocabulary and
using them is ordinary practice. We should not reproduce Mytheresa's specific expression:
their wordmark, their typeface pairing, their photography, their exact layout.

That is partly a legal point and mostly a strategic one. For a luxury brand, distinctiveness
*is* the product. A site that reads as a Mytheresa clone signals reseller, not house.

## 7. What would sharpen this

Since I could not load the reference, the most useful thing you can send is screenshots —
ideally the landing hero, a product grid, and a product page, desktop and mobile. With those
I can replace the proposed values above with observed ones, and put a visual mockup in front
of you to react to.

Worth naming now: which parts of the reference do you actually like — the restraint and
whitespace, the editorial "Edit" framing, the photography treatment, or the typography?
They are separable, and knowing which one is the draw changes what we build first.
