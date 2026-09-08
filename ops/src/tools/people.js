/*
 * schedule.* — inherits agent-tool-contract, then people-skills.
 *
 * The `people` store sits behind the tightest Access policy of the six, and
 * nothing outside this file may declare it (asserted in the registry test).
 * Finance holds `employee_id` plus a name snapshot precisely so an expense leak
 * does not reach staff records.
 *
 * SCOPING IS IN CODE, NOT IN THE PROMPT
 *   `schedule.view` resolves the ACTOR to an employee by email — people.sql
 *   states that column matches the Access identity — and staff see their own
 *   week only. The manager widening is the `roleAtLeast` call below, which is
 *   the whole of it: there is no argument a staff caller can pass to widen.
 *
 * OVERLAP IS THE DATABASE'S JOB
 *   `schedule.draft` is T1 and writes nothing, so it cannot rely on the
 *   `shift_no_overlap_*` triggers to refuse it — it READS the week and flags
 *   conflicts advisorily. The authority stays where people-skills puts it: the
 *   trigger fires when a manager publishes (T2, not built yet — the contract
 *   says build the gated writes after the approval path is exercised). A draft
 *   that flags a conflict is a draft nobody should publish; a draft that
 *   silently proposed one would be a double booking waiting for a retry.
 *   Test-PRD-P0-18-no_double_booking.
 */
import { CAPS } from "./caps.js";
import { roleAtLeast } from "./roles.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const peopleTools = {
  "schedule.view": {
    tier: "T0",
    domain: "people",
    stores: ["people"],
    minRole: "staff",
    describe:
      "Shifts in a date range. Staff see their own; managers and owners see everyone. " +
      "The widening is the role check, not an argument.",
    undo: null,
    schema: {
      from: { type: "string", required: true, format: "date" },
      to: { type: "string", required: true, format: "date" },
      employee_id: { type: "string", format: "id" },
      status: { type: "string", enum: ["scheduled", "confirmed", "cancelled", "completed"] },
    },
    async check(args) {
      const span = (Date.parse(`${args.to}T00:00:00Z`) - Date.parse(`${args.from}T00:00:00Z`)) / DAY_MS;
      if (!Number.isFinite(span) || span < 0) return { denied: "'to' is before 'from'" };
      if (span > CAPS.SCHEDULE_VIEW_MAX_DAYS) {
        return { denied: `range of ${span} days exceeds the ${CAPS.SCHEDULE_VIEW_MAX_DAYS}-day cap` };
      }
      return { ok: true };
    },
    async run(args, t) {
      const wide = roleAtLeast(t.role, "manager");

      /* Who is calling, in this store's terms. Never taken from an argument. */
      const me = await t.db.people
        .prepare("SELECT id, role FROM employee WHERE email = ? AND is_active = 1")
        .bind(t.actor)
        .first();

      if (!wide && !me) {
        return { error: "no active employee record for the calling Access identity" };
      }

      const where = ['starts_at >= ?', 'starts_at < ?'];
      const binds = [`${args.from}T00:00:00Z`, `${args.to}T23:59:59Z`];
      if (!wide) {
        /* Staff: own shifts, full stop. */
        where.push("employee_id = ?");
        binds.push(me.id);
      } else if (args.employee_id) {
        where.push("employee_id = ?");
        binds.push(args.employee_id);
      }
      if (args.status) {
        where.push("status = ?");
        binds.push(args.status);
      }
      binds.push(CAPS.MAX_ROWS);

      const rows = await t.db.people
        .prepare(
          "SELECT id, employee_id, location_id, starts_at, ends_at, status, notes FROM shift" +
            ` WHERE ${where.join(" AND ")} ORDER BY starts_at LIMIT ?`,
        )
        .bind(...binds)
        .all();

      return {
        scope: wide ? "all" : "own",
        employee_id: wide ? (args.employee_id ?? null) : me.id,
        shifts: rows.results ?? [],
      };
    },
  },

  "schedule.draft": {
    tier: "T1",
    domain: "people",
    stores: ["people"],
    minRole: "staff",
    describe:
      "Propose shifts for a week. Writes nothing: returns the rows a manager would " +
      "publish, with any overlap against the existing schedule flagged.",
    undo: "discard the draft; a published shift is cancelled, never deleted",
    schema: {
      location_id: { type: "string", format: "id" },
      shifts: {
        type: "array",
        required: true,
        maxItems: CAPS.SCHEDULE_DRAFT_MAX_SHIFTS,
        of: {
          type: "object",
          schema: {
            employee_id: { type: "string", required: true, format: "id" },
            starts_at: { type: "string", required: true, format: "datetime" },
            ends_at: { type: "string", required: true, format: "datetime" },
            notes: { type: "string", maxLength: CAPS.MAX_TEXT },
          },
        },
      },
    },
    async check(args) {
      if (args.shifts.length === 0) return { denied: "a draft with no shifts is not a draft" };
      for (const s of args.shifts) {
        if (Date.parse(s.ends_at) <= Date.parse(s.starts_at)) {
          return { denied: `inverted or empty interval for ${s.employee_id}: ${s.starts_at} -> ${s.ends_at}` };
        }
      }
      return { ok: true, summary: `${args.shifts.length} shifts` };
    },
    async run(args, t) {
      const ids = [...new Set(args.shifts.map((s) => s.employee_id))];
      const known = await t.db.people
        .prepare(
          `SELECT id FROM employee WHERE is_active = 1 AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .bind(...ids)
        .all();
      const active = new Set((known.results ?? []).map((r) => r.id));

      const from = args.shifts.reduce((a, s) => (s.starts_at < a ? s.starts_at : a), args.shifts[0].starts_at);
      const to = args.shifts.reduce((a, s) => (s.ends_at > a ? s.ends_at : a), args.shifts[0].ends_at);
      const existing = await t.db.people
        .prepare(
          "SELECT id, employee_id, starts_at, ends_at FROM shift" +
            " WHERE status IN ('scheduled','confirmed') AND starts_at < ? AND ends_at > ? LIMIT ?",
        )
        .bind(to, from, CAPS.MAX_ROWS)
        .all();

      const overlaps = (a, b) => a.starts_at < b.ends_at && a.ends_at > b.starts_at;
      const proposed = args.shifts.map((s, i) => {
        const conflicts = [
          ...(existing.results ?? [])
            .filter((e) => e.employee_id === s.employee_id && overlaps(s, e))
            .map((e) => ({ with: "published", shift_id: e.id, starts_at: e.starts_at, ends_at: e.ends_at })),
          ...args.shifts
            .filter((o, j) => j !== i && o.employee_id === s.employee_id && overlaps(s, o))
            .map((o) => ({ with: "draft", starts_at: o.starts_at, ends_at: o.ends_at })),
        ];
        return {
          employee_id: s.employee_id,
          location_id: args.location_id ?? null,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          status: "scheduled",
          notes: s.notes ?? "",
          employee_active: active.has(s.employee_id),
          conflicts,
        };
      });

      const conflicted = proposed.filter((p) => p.conflicts.length > 0);
      return {
        applied: false,
        proposal: {
          rows: proposed,
          conflicts: conflicted.length,
          unknown_employees: proposed.filter((p) => !p.employee_active).map((p) => p.employee_id),
          publishable: conflicted.length === 0 && proposed.every((p) => p.employee_active),
          /* The advisory read above is not the guarantee; this is. */
          enforced_by:
            "shift_no_overlap_insert / shift_no_overlap_update in shared/db/people.sql," +
            " which refuse an overlapping row at publish time",
        },
      };
    },
  },
};
