/*
 * The seed catalog. Hardcoded, because the versioned catalog store (PRD §3.1,
 * Test-PRD-P0-02-catalog_git_shards) is not built yet.
 *
 * Shared, because BOTH surfaces read the catalog and neither owns it: the
 * storefront renders these products, and the ops tools search them and stage
 * price changes against them through ops/src/tools/catalog-source.js. One copy
 * here, so a price on the shop and a price an agent quotes cannot disagree. The
 * real source replaces this file behind the same shape; nothing else moves.
 *
 * Money is an integer minor amount plus an explicit currency, everywhere
 * (PRD N4 / Test-PRD-P0-15-money_minor_units). No floats, no implied currency.
 */

/*
 * catalog — Git store. One object here per catalog/products/<handle>.json.
 *
 * `sub` is the second level of the navigation: clothing splits into dresses,
 * knitwear, outerwear and the rest, the way a shop's rail does. It is EDITORIAL
 * — Square's item carries a category and no sub-category, so this is Git's half
 * of the ADR-009 split, exactly like `brand` and `eyebrow`. store/src/query.js
 * derives the drawer's second level from whatever `sub` values are present, so
 * a product with none simply does not appear under a sub-heading and the
 * category still lists it under "View all".
 */
export const products = [
  { handle: "shearling-trimmed-wool-coat", brand: "Aurelien",  name: "Shearling-trimmed wool-blend coat",   minor: 560000, currency: "USD", category: "clothing",    sub: "outerwear", eyebrow: "new season", tone: 0.06 },
  { handle: "cashmere-crewneck",           brand: "Vestra",    name: "Cashmere crewneck sweater",           minor:  98000, currency: "USD", category: "clothing",    sub: "knitwear",  eyebrow: "new",        tone: 0.14 },
  { handle: "silk-crepe-midi-dress",       brand: "Marchetti", name: "Silk crepe de chine midi dress",      minor: 234000, currency: "USD", category: "clothing",    sub: "dresses",   eyebrow: "new season", tone: 0.10 },
  { handle: "leather-ankle-boot",          brand: "Corvino",   name: "Polished-leather ankle boots",        minor: 129500, currency: "USD", category: "shoes",       sub: "boots",     eyebrow: "new",        tone: 0.20 },
  { handle: "wide-leg-wool-trouser",       brand: "Aurelien",  name: "Wide-leg pressed wool trousers",      minor:  87000, currency: "USD", category: "clothing",    sub: "trousers",  eyebrow: "new season", tone: 0.08 },
  { handle: "quilted-shoulder-bag",        brand: "Solene",    name: "Quilted leather shoulder bag",        minor: 312000, currency: "USD", category: "bags",        sub: "shoulder",  eyebrow: "new",        tone: 0.17 },
  { handle: "double-face-scarf",           brand: "Vestra",    name: "Double-face cashmere scarf",          minor:  52000, currency: "USD", category: "accessories", sub: "scarves",   eyebrow: "new",        tone: 0.05 },
  { handle: "cotton-poplin-shirt",         brand: "Marchetti", name: "Cotton-poplin oversized shirt",       minor:  61000, currency: "USD", category: "clothing",    sub: "shirts",    eyebrow: "new season", tone: 0.03 },
  { handle: "suede-loafer",                brand: "Corvino",   name: "Suede penny loafers",                 minor:  94500, currency: "USD", category: "shoes",       sub: "flats",     eyebrow: "new",        tone: 0.22 },
  { handle: "wool-blend-tailored-jacket",  brand: "Aurelien",  name: "Wool-blend single-breasted jacket",   minor: 198000, currency: "USD", category: "clothing",    sub: "outerwear", eyebrow: "new season", tone: 0.11 },
  { handle: "pleated-satin-skirt",         brand: "Solene",    name: "Pleated satin midi skirt",            minor: 145000, currency: "USD", category: "clothing",    sub: "skirts",    eyebrow: "new",        tone: 0.09 },
  { handle: "ribbed-merino-polo",          brand: "Vestra",    name: "Ribbed merino-wool polo shirt",       minor:  72000, currency: "USD", category: "clothing",    sub: "knitwear",  eyebrow: "new season", tone: 0.15 },
  { handle: "gold-vermeil-hoop",           brand: "Solene",    name: "Gold-vermeil hoop earrings",          minor:  38000, currency: "USD", category: "jewellery",   sub: "earrings",  eyebrow: "new",        tone: 0.24 },
  { handle: "signet-ring",                 brand: "Solene",    name: "Brushed gold signet ring",            minor:  46000, currency: "USD", category: "jewellery",   sub: "rings",     eyebrow: "new season", tone: 0.19 },
  { handle: "felted-wool-fedora",          brand: "Marchetti", name: "Felted wool wide-brim fedora",        minor:  44000, currency: "USD", category: "hats",        sub: "brimmed",   eyebrow: "new",        tone: 0.12 },
  { handle: "cashmere-beanie",             brand: "Vestra",    name: "Ribbed cashmere beanie",              minor:  29000, currency: "USD", category: "hats",        sub: "knitted",   eyebrow: "new",        tone: 0.16 },
];
