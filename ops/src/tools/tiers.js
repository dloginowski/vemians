/*
 * The four tiers, and the absences.
 *
 * T3 is a DESIGN OUTPUT, not an omission: "an absent tool that is not written
 * down gets built by the next person" (agent-tool-contract). The list below is
 * assembled from each domain skill's own T3 table so the absences are visible
 * in the code that would otherwise be the place to add them. Nothing here is
 * callable — `runTool` refuses any name not in TOOLS, and buildRegistry refuses
 * a tool declaring tier T3.
 */

export const TIERS = Object.freeze({
  T0: "read — runs immediately, audited",
  T1: "propose — returns a diff or a pull request; a human applies it",
  T2: "approve — executes only after an in-session approval by someone holding the role",
  T3: "absent — not built, and named so nobody builds it by accident",
});

export const T3_ABSENT = Object.freeze([
  { name: "catalog.delete", why: "no undo path; discontinue by status and Git keeps the history" },
  { name: "catalog.bulk_price", why: "one approval covering unbounded money" },
  { name: "catalog.commit_to_main", why: "removes the review that is the entire safety model" },
  { name: "catalog.write_index", why: "the index is derived; rebuild it, do not write it" },
  {
    name: "catalog.write_mirror",
    why: "our copy of Square's catalog has one writer, the sync; a second one diverges silently",
  },
  {
    name: "catalog.bulk_create",
    why: "one approval covering an unbounded number of new commercial facts",
  },
  {
    name: "catalog.delete_category",
    why: "a category with products in it cannot be removed without moving them; withdraw it at Square",
  },
  {
    name: "catalog.delete_image",
    why: "an original is evidence of what was sold; nothing in this repository deletes from R2",
  },
  { name: "customer.delete", why: "erasure is identity.erase — owner-gated and cascade-driven" },
  { name: "customer.bulk_export", why: "an unbounded read of pseudonymous personal data" },
  { name: "customer.search_by_name", why: "encrypted fields cannot be searched; exact HMAC only" },
  { name: "order.refund", why: "money movement belongs to the provider that holds the payment" },
  { name: "order.cancel", why: "the channel owns fulfilment state" },
  { name: "order.delete", why: "tax retention; the record survives even a customer erasure" },
  { name: "inventory.bulk_set", why: "one approval covering the entire stock position" },
  { name: "payroll.*", why: "money owed to people, with no reverse entry available" },
  { name: "shift.delete", why: "cancellation has the same effect and keeps the history" },
  { name: "expense.delete", why: "reversal keeps both rows and the reason" },
  { name: "expense.bulk_approve", why: "one approval covering unbounded money" },
  { name: "ledger.post", why: "the accounting provider holds the books of record; we export" },
  { name: "identity.reveal", why: "built last, after the audit and approval paths are exercised" },
  { name: "identity.erase", why: "the one tool that legitimately destroys; owner-only, and not yet built" },
  { name: "db.query", why: "raw SQL: the tool surface IS the constraint" },
  { name: "audit.disable", why: "an audit log an application can switch off is not an audit log" },
]);
