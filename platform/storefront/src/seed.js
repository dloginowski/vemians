/*
 * Hardcoded seed data. The prototype runs with no D1 bindings attached — see
 * the commented blocks in wrangler.toml for where each of these six shapes
 * lands once the stores are real.
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

/*
 * customers — D1 store. Opaque id, profile, fit, consent. NO direct identifier
 * (Test-PRD-P0-08-customers_no_identifiers): name, email and phone live only in
 * `identity`, as ciphertext, and this surface never binds to it. Birth year, not
 * date of birth (Test-PRD-P0-09-data_minimisation).
 */
export const customers = [
  { id: "cus_01J8QF4M2K", birthYear: 1985, fit: "IT 42",  segment: "clienteling", consent: ["marketing_email", "profiling"], orders: 7, lifetimeMinor: 2140000, currency: "USD" },
  { id: "cus_01J8QF7T9A", birthYear: 1991, fit: "IT 38",  segment: "returning",   consent: ["marketing_email"],              orders: 3, lifetimeMinor:  486000, currency: "USD" },
  { id: "cus_01J8QFB1XC", birthYear: 1978, fit: "UK 10",  segment: "clienteling", consent: ["marketing_email", "sms"],       orders: 12, lifetimeMinor: 5930000, currency: "USD" },
  { id: "cus_01J8QFD6PE", birthYear: 1996, fit: "IT 44",  segment: "new",         consent: [],                               orders: 1, lifetimeMinor:   98000, currency: "USD" },
  { id: "cus_01J8QFG0RH", birthYear: 1969, fit: "UK 12",  segment: "returning",   consent: ["marketing_email"],              orders: 5, lifetimeMinor: 1275000, currency: "USD" },
];

/*
 * people — D1 store. Half-open intervals, so back-to-back shifts are legal
 * (Test-PRD-P0-18-no_double_booking). The overlap check is a database trigger,
 * not application code; this view only reads.
 */
export const week = {
  starting: "2026-09-07",
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  shifts: [
    { day: 0, from: "10:00", to: "16:00", who: "Alina R.",  role: "Floor" },
    { day: 0, from: "16:00", to: "20:00", who: "Tomas K.",  role: "Floor" },
    { day: 1, from: "10:00", to: "18:00", who: "Alina R.",  role: "Floor" },
    { day: 2, from: "10:00", to: "16:00", who: "Priya N.",  role: "Clienteling" },
    { day: 2, from: "16:00", to: "20:00", who: "Tomas K.",  role: "Floor" },
    { day: 3, from: "10:00", to: "18:00", who: "Priya N.",  role: "Clienteling" },
    { day: 4, from: "10:00", to: "15:00", who: "Alina R.",  role: "Floor" },
    { day: 4, from: "15:00", to: "20:00", who: "Marcus D.", role: "Stock" },
    { day: 5, from: "11:00", to: "19:00", who: "Tomas K.",  role: "Floor" },
    { day: 6, from: "12:00", to: "18:00", who: "Marcus D.", role: "Stock" },
  ],
};
