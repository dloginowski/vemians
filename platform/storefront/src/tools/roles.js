/*
 * Roles — read, never assigned.
 *
 * Test-PRD-P0-23-group_derived_roles: authorisation derives from Cloudflare
 * Access Group membership. Nothing here assigns a role, stores a role, or lets
 * a tool grant itself one; this module only ORDERS the three roles the Access
 * policies hand us so a tool can state its minimum.
 *
 * The role arrives on `ctx.role`, put there by the request handler from the
 * Access assertion's group claims (src/access.js). Like `actor`, it is never a
 * tool argument — src/tools/index.js refuses a call whose arguments mention it.
 */

/* Order matters: the index is the comparison. */
export const ROLES = Object.freeze(["staff", "manager", "owner"]);

export function isRole(role) {
  return ROLES.includes(role);
}

/*
 * Does `role` meet `minimum`? An unknown or absent role meets nothing — fail
 * closed, the same way access.js does with a missing assertion.
 */
export function roleAtLeast(role, minimum) {
  const have = ROLES.indexOf(role);
  const need = ROLES.indexOf(minimum);
  if (have < 0 || need < 0) return false;
  return have >= need;
}
