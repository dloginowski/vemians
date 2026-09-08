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

/* catalog — Git store. One object here per catalog/products/<handle>.json. */
export const products = [
  { handle: "shearling-trimmed-wool-coat", brand: "Aurelien",  name: "Shearling-trimmed wool-blend coat",   minor: 560000, currency: "USD", eyebrow: "new season", tone: 0.06 },
  { handle: "cashmere-crewneck",           brand: "Vestra",    name: "Cashmere crewneck sweater",           minor:  98000, currency: "USD", eyebrow: "new",        tone: 0.14 },
  { handle: "silk-crepe-midi-dress",       brand: "Marchetti", name: "Silk crepe de chine midi dress",      minor: 234000, currency: "USD", eyebrow: "new season", tone: 0.10 },
  { handle: "leather-ankle-boot",          brand: "Corvino",   name: "Polished-leather ankle boots",        minor: 129500, currency: "USD", eyebrow: "new",        tone: 0.20 },
  { handle: "wide-leg-wool-trouser",       brand: "Aurelien",  name: "Wide-leg pressed wool trousers",      minor:  87000, currency: "USD", eyebrow: "new season", tone: 0.08 },
  { handle: "quilted-shoulder-bag",        brand: "Solene",    name: "Quilted leather shoulder bag",        minor: 312000, currency: "USD", eyebrow: "new",        tone: 0.17 },
  { handle: "double-face-scarf",           brand: "Vestra",    name: "Double-face cashmere scarf",          minor:  52000, currency: "USD", eyebrow: "new",        tone: 0.05 },
  { handle: "cotton-poplin-shirt",         brand: "Marchetti", name: "Cotton-poplin oversized shirt",       minor:  61000, currency: "USD", eyebrow: "new season", tone: 0.03 },
  { handle: "suede-loafer",                brand: "Corvino",   name: "Suede penny loafers",                 minor:  94500, currency: "USD", eyebrow: "new",        tone: 0.22 },
  { handle: "wool-blend-tailored-jacket",  brand: "Aurelien",  name: "Wool-blend single-breasted jacket",   minor: 198000, currency: "USD", eyebrow: "new season", tone: 0.11 },
  { handle: "pleated-satin-skirt",         brand: "Solene",    name: "Pleated satin midi skirt",            minor: 145000, currency: "USD", eyebrow: "new",        tone: 0.09 },
  { handle: "ribbed-merino-polo",          brand: "Vestra",    name: "Ribbed merino-wool polo shirt",       minor:  72000, currency: "USD", eyebrow: "new season", tone: 0.15 },
];
