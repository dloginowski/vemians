/*
 * Seed data for the employee area, and for it only.
 *
 * The prototype runs with no D1 binding attached — see the `[[env.ops...]]`
 * blocks in wrangler.toml for where each of these shapes lands once the stores
 * are real. Nothing here is imported by the storefront: `store/` has no reason
 * to hold a customer record or a staff rota, and the way to guarantee that is
 * for the data not to be in its package (Test-PRD-P0-24-binding_scoped_tools,
 * applied to the source tree as well as to the bindings).
 *
 * The catalog is NOT here — it is shared/seed/catalog.js, because both surfaces
 * read it.
 *
 * Money is an integer minor amount plus an explicit currency, everywhere
 * (PRD N4 / Test-PRD-P0-15-money_minor_units). No floats, no implied currency.
 */

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
