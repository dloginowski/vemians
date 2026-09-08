# ADR-011 — Two surfaces, two authorities

**Status:** Proposed · **Date:** 2026-09-08 · **Amends:** ADR-002 · **Reverses part of** P0-23

## Decision

There are two employee-facing surfaces, and they do not merely differ in permissions. **They take
their allow-lists from different authorities, on purpose.**

| | `ops.vemians.com` | `admin.vemians.com` |
|---|---|---|
| What it does | Catalog, scheduling, customers, tickets — the day's work | Defines who may use ops, and configures the site |
| Who may enter | An allow-list **the admin panel owns** | A Cloudflare Access policy, **edited only in the Cloudflare dashboard** |
| Changed by | A manager, in a web page, in seconds | An owner, in Cloudflare, deliberately |
| Expected churn | Every hire and every leaver | Almost never |
| Blast radius of a mistake | One employee sees the wrong screen | The gate itself |

Cloudflare Access still terminates identity for **both**. The difference is what happens after
identity is proven: for admin, being in the policy *is* the authorisation; for ops, the verified
email is then looked up in a table that admin owns.

## Why ops stops deriving roles from Workspace groups

P0-23 said authorisation derives from Google Workspace group membership. That is being narrowed to
admin only, for the same reason ADR-009 moved catalog authorship to the till:

> *"A design that requires a pull request before an item can be sold will be worked around by
> lunchtime."*

Adding a new hire to a Google Workspace group requires a Workspace administrator in the Google
admin console. Retail staffing does not move at that speed, and the workaround for a gate that is
too slow is always the same — someone shares a login. A manager must be able to add a new hire to
ops from a page, in the shop, on the day they start.

Admin is the opposite case. It changes almost never, its mistakes are unrecoverable from inside the
system, and there is no cost to it being slow and deliberate. So it keeps the heavyweight gate.

## The property this buys: the admin panel cannot grant admin

**No Worker holds a Cloudflare API token.** Nothing we deploy can edit an Access policy.

So the only way to become an admin is the Cloudflare dashboard — a different credential, a
different console, and not reachable from any code in this repository. An attacker who fully owns
the ops Worker gets ops. An attacker who fully owns the admin Worker gets the ops allow-list, which
is bad, and still **cannot make themselves an admin or add one**.

This is the whole reason the two authorities are kept apart rather than unified behind one
convenient API. A single admin panel that edited its own gate would be a shorter design and would
convert any admin-surface bug into a permanent, self-granted foothold.

## How ops asks

**The ops Worker has no binding to the access store.** It cannot read it and it cannot write it.
It asks the admin Worker over a **service binding** — Worker to Worker, inside Cloudflare, never
over the internet and never through Access.

The alternative considered was binding the store to both Workers, read-only on ops by convention.
Rejected: D1 bindings have no read-only mode, so "ops only reads it" would be a comment rather than
a constraint, and this is the one table where the difference matters most.

Two rules on the admin Worker follow from this:

1. The internal authorisation endpoint is **strictly read-only**. It answers "may this email use
   ops, and as what role", and nothing else.
2. Every **mutation** requires a verified Access identity. A service binding proves the caller is
   our own Worker; it proves nothing about a person, and no one is on the other end of a cron.

## Failure is closed

If the admin Worker is unreachable, ops **denies**. An authorisation service that fails open is
worse than no authorisation service, because it is trusted.

The cost is real and stated: admin becomes a hard dependency of ops, and a subrequest joins the
critical path of every ops request. Decisions are cached in the isolate for a short TTL, which
bounds the cost without letting a revocation linger.

## What this does not change

- **The storefront.** It has neither surface's gate, holds no employee data, and binds only the
  catalog mirror (P0-24). Unaffected.
- **Customers.** They never touch either surface. Customer identity remains ADR-004's problem.
- **Access terminating identity.** Both surfaces still have no login form, no password, no session
  cookie of their own and no reset path (P0-22). Only the *authorisation* step moved.
- **Audit.** The verified Access email is still the `actor` on every row, on both surfaces.

## Open

1. Does an ops allow-list entry carry a role (`staff` / `manager` / `owner`), or a set of
   capabilities? Roles to start, because three names are checkable at a glance and a capability
   matrix is not.
2. Where does the store live — a ninth D1 (`vemians-access`), or a table in `identity`? A ninth,
   per ADR-002: this is the highest-blast-radius, lowest-volume data in the system, and its
   retention rules are its own.
3. May a manager grant `owner`? Assumed **no** — you cannot grant above yourself — but that is a
   policy decision, not a technical one.
