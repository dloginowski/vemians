# ADR-012 — Ops is a delegate, not a principal

**Status:** Proposed · **Date:** 2026-09-08 · **Amends:** ADR-011 · **Extends:** ADR-009

## Decision

**Ops grants nothing.** It accelerates work a person could already do in Square by hand, with their
own hands, today. Its ceiling is their Square ceiling. It is a delegate acting for a principal, and
the principal is Square.

Concretely, three rules:

1. **Square's staff list is the roster.** `status: INACTIVE` in Square revokes ops. Nobody is
   added to ops who is not employed in Square.
2. **Ops never offers a capability the person's Square job could not already perform.** Not gated
   behind an approval — *absent from the tool list they are handed*, which is how P0-25 already
   treats refunds, payroll and deletion.
3. **The admin panel maps job titles to roles. It does not enrol people.** A handful of rows, not
   one per employee. Adding staff is a Square task; it always was.

## The finding that shapes this

**Square's public API exposes no permission data.** Verified against Square's own OpenAPI
specification (`square/connect-api-specification`, `api.json`), not from memory:

| Schema | Fields |
|---|---|
| `TeamMember` | `id`, `reference_id`, `is_owner`, `status`, `given_name`, `family_name`, `email_address`, `phone_number`, `created_at`, `updated_at`, `assigned_locations`, `wage_setting` |
| `Job` | `id`, `title`, `is_tip_eligible`, `created_at`, `updated_at`, `version` |
| `JobAssignment` | `job_title`, `job_id`, `pay_type`, `hourly_rate`, `annual_rate`, `weekly_hours` |
| `TeamMemberStatus` | `ACTIVE` \| `INACTIVE` |

No permission set on a team member. None on a job. **No schema anywhere in the specification whose
name contains "permission", and no permissions endpoint.** The checkboxes a Square administrator
ticks for "can manage inventory" are dashboard state that the API does not return.

## What follows, stated plainly

**We honour the boundary. We cannot enforce it, because Square will not tell us where it is.**

That distinction is the whole risk and it is not papered over. What we can key on is what the API
actually returns:

| Signal | Used for |
|---|---|
| `status` | Revocation. The safety-critical direction, and it is automatic |
| `job_assignments[].job_title` | The role, via a map the admin panel owns |
| `is_owner` | The one permission Square *does* expose |
| `assigned_locations` | Scope, once there is more than one location |

The residual risk, named so it is not discovered later: **a job title is not a permission set.**
Someone titled "Manager" whose inventory rights were revoked in the Square dashboard still looks
like a manager to us. Two mitigations, both structural rather than hopeful:

- **Our ceiling is set deliberately below the plausible floor of each title.** A role's tool list is
  chosen so that anyone holding that title could already do all of it in Square. Where a title's
  rights are uncertain, the tool is absent, not gated.
- **Every ops action is a Square action, attributed.** Ops writes through Square's API rather than
  to a private store, so the change appears in Square's own history where a manager already looks.
  A delegate that leaves no trace in the principal's records is not a delegate.

## What this changes in ADR-011

ADR-011 had the admin panel owning a per-person ops allow-list. That is now **wrong in the same way
group membership was wrong**: it makes ops a second place where employment is recorded, and two
rosters disagree the first week someone leaves.

| | ADR-011 said | ADR-012 says |
|---|---|---|
| Ops roster | Rows in an access store, one per person | **Square's team list** |
| Adding someone | A manager, in the admin panel | **In Square** — where they are hired anyway |
| Removing someone | A manager, in the admin panel | **In Square** — `INACTIVE`, automatic |
| Admin panel owns | Every entry | **The job-title → role map**, and nothing per-person |

**What survives ADR-011 unchanged, and matters most:** no Worker holds a Cloudflare API token, so
the admin panel still cannot grant admin. Admin remains a Cloudflare Access policy edited in the
dashboard. The root of trust does not move.

## Open

1. **The identity gap.** Square's `email_address` is whatever was typed at hire — often personal —
   while Access admits `email_domain: vemians.com`. A staff member on a personal address is on the
   roster and cannot reach the perimeter. Unresolved, and it blocks staff login, not the design.
2. **Does the token even carry team scope?** Unknown: Square is answering `401` to
   `SQUARE_ACCESS_TOKEN` at present, so nothing has been read from the live account.
3. **Per-user OAuth** would make the ceiling enforced rather than honoured — if Square scopes a
   token to the authorising team member's rights. **Not verified**, and Square's OAuth appears to
   authorise at merchant level. Worth answering before assuming it is an escape from rule 2 above.
