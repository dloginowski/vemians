/*
 * budget.* / expense.* — inherits agent-tool-contract, then finance-skills.
 *
 * No `people` binding: an expense carries `employee_id` plus a name snapshot,
 * so an expense leak does not expose staff records
 * (Test-PRD-P0-20-cross_store_snapshot). Which means this file cannot resolve
 * an Access email to an employee row, and does not try: the submitter IS the
 * Access identity, written to `employee_id`, and the approver is compared
 * against it. One identity, both ends, no lookup across a boundary.
 *
 * Budget figures are DERIVED on every read. A stored balance drifts from the
 * rows that produced it and nobody notices until quarter end
 * (finance-skills rule 4).
 *
 * `expense.approve` is the only tool in this directory that mutates a store,
 * and approval is a one-way door: the trigger in finance.sql refuses an
 * in-place edit afterwards (Test-PRD-P0-19-approved_expense_immutable). There
 * is no reversal tool yet — that is the correction path and it is a T1 the next
 * change should add.
 */
import { CAPS, rowLimit } from "./caps.js";
import { roleAtLeast } from "./roles.js";
import { createKvByteStore } from "./kv-store.js";

/* The receipt photo's bytes, in its OWN KV namespace (RECEIPT_FILES) — never
   ASSET_FILES, never a binding any tool holds. src/index.js's /expenses/new
   and /expenses/<id> routes only. */
export function createReceiptFileStore(kv) {
  return createKvByteStore(kv, { bindingName: "RECEIPT_FILES", maxBytes: CAPS.RECEIPT_MAX_BYTES });
}

const EXPENSE_COLUMNS =
  "id, budget_id, vendor_id, employee_id, employee_name, description, amount_minor," +
  " currency, incurred_on, status, approved_by, approved_at, receipt_key, created_at";

export const financeTools = {
  "budget.status": {
    tier: "T0",
    domain: "finance",
    stores: ["finance"],
    minRole: "manager",
    describe:
      "Spend against budget for a period, derived from expense rows on every read. " +
      "Never a stored balance.",
    undo: null,
    schema: {
      period: { type: "string", maxLength: 20 },
      budget_id: { type: "string", format: "id" },
    },
    async run(args, t) {
      const where = [];
      const binds = [];
      if (args.period) {
        where.push("b.period = ?");
        binds.push(args.period);
      }
      if (args.budget_id) {
        where.push("b.id = ?");
        binds.push(args.budget_id);
      }
      binds.push(CAPS.MAX_ROWS);

      const rows = await t.db.finance
        .prepare(
          "SELECT b.id, b.name, b.period, b.limit_minor, b.currency," +
            " COALESCE(SUM(CASE WHEN e.status IN ('approved','reimbursed')" +
            "   THEN e.amount_minor END), 0) AS committed_minor," +
            " COALESCE(SUM(CASE WHEN e.status IN ('draft','submitted')" +
            "   THEN e.amount_minor END), 0) AS pending_minor" +
            " FROM budget b LEFT JOIN expense e ON e.budget_id = b.id" +
            (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
            " GROUP BY b.id, b.name, b.period, b.limit_minor, b.currency" +
            " ORDER BY b.period DESC, b.name LIMIT ?",
        )
        .bind(...binds)
        .all();

      return {
        budgets: (rows.results ?? []).map((b) => ({
          budget_id: b.id,
          name: b.name,
          period: b.period,
          currency: b.currency,
          limit_minor: b.limit_minor,
          committed_minor: b.committed_minor,
          pending_minor: b.pending_minor,
          remaining_minor: b.limit_minor - b.committed_minor,
          derived: true,
        })),
      };
    },
  },

  "expense.list": {
    tier: "T0",
    domain: "finance",
    stores: ["finance"],
    minRole: "staff",
    describe:
      "Expenses. Staff see their own submissions; managers and owners see all. " +
      "Scoped by the Access identity, in code.",
    undo: null,
    schema: {
      status: {
        type: "string",
        enum: ["draft", "submitted", "approved", "rejected", "reimbursed"],
      },
      budget_id: { type: "string", format: "id" },
      limit: { type: "integer", min: 1, max: CAPS.MAX_ROWS },
    },
    async run(args, t) {
      const wide = roleAtLeast(t.role, "manager");
      const where = [];
      const binds = [];
      if (!wide) {
        where.push("employee_id = ?");
        binds.push(t.actor);
      }
      if (args.status) {
        where.push("status = ?");
        binds.push(args.status);
      }
      if (args.budget_id) {
        where.push("budget_id = ?");
        binds.push(args.budget_id);
      }
      const limit = rowLimit(args.limit);
      binds.push(limit);

      const rows = await t.db.finance
        .prepare(
          `SELECT ${EXPENSE_COLUMNS} FROM expense` +
            (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
            " ORDER BY incurred_on DESC LIMIT ?",
        )
        .bind(...binds)
        .all();

      return { scope: wide ? "all" : "own", expenses: rows.results ?? [], limit };
    },
  },

  /*
   * T1: the submission is a proposal, not a row. The receipt must already be
   * stored — finance-skills rule "the receipt lands in its own store before
   * the row is written", so the key is required here and an approval later
   * cannot invent one. Committing the proposal into a real 'submitted' row is
   * NOT this tool's job (this file's header: only expense.approve mutates a
   * store) — it happens in src/index.js's /expenses/new -> /expenses/confirm
   * flow, the human action that turns a validated proposal into a filed
   * expense, the same way a merged PR is what commits a catalog.draft_edit.
   */
  "expense.submit": {
    tier: "T1",
    domain: "finance",
    stores: ["finance"],
    minRole: "staff",
    describe:
      "Propose an expense. Returns the row to insert, with the submitter taken from " +
      "the Access identity and the receipt key required. Writes nothing.",
    undo: "withdraw before approval; after approval, a reversing entry only",
    schema: {
      description: { type: "string", required: true, maxLength: CAPS.MAX_TEXT },
      amount_minor: { type: "integer", required: true, min: 1 },
      currency: { type: "string", required: true, format: "currency" },
      incurred_on: { type: "string", required: true, format: "date" },
      budget_id: { type: "string", format: "id" },
      vendor_id: { type: "string", format: "id" },
      receipt_key: { type: "string", required: true, maxLength: 200 },
    },
    async check(args, t) {
      if (args.amount_minor > CAPS.EXPENSE_SUBMIT_MAX_MINOR) {
        return {
          denied:
            `amount ${args.amount_minor} ${args.currency} exceeds the submission cap of ` +
            `${CAPS.EXPENSE_SUBMIT_MAX_MINOR}. Refused.`,
        };
      }
      if (args.budget_id) {
        const budget = await t.db.finance
          .prepare("SELECT id, currency FROM budget WHERE id = ?")
          .bind(args.budget_id)
          .first();
        if (!budget) return { denied: `no budget '${args.budget_id}'` };
        if (budget.currency !== args.currency) {
          return { denied: `budget ${budget.id} is in ${budget.currency}, the expense is in ${args.currency}` };
        }
      }
      return { ok: true, summary: `${args.amount_minor} ${args.currency} — ${args.description}` };
    },
    async run(args, t) {
      return {
        applied: false,
        proposal: {
          table: "expense",
          op: "insert",
          values: {
            budget_id: args.budget_id ?? null,
            vendor_id: args.vendor_id ?? null,
            /* The submitter is the verified Access identity, in both fields:
             * finance holds no `people` binding, so there is no name to snapshot
             * that this store could have looked up. */
            employee_id: t.actor,
            employee_name: t.actor,
            description: args.description,
            amount_minor: args.amount_minor,
            currency: args.currency,
            incurred_on: args.incurred_on,
            status: "submitted",
            receipt_key: args.receipt_key,
          },
        },
      };
    },
  },

  /*
   * T2. Executes only with an in-session approval token issued by a prior call.
   * Three refusals live in the preflight, all in code:
   *   - the approver may not be the submitter (finance-skills rule 3),
   *   - an amount over the ceiling is refused outright, not escalated,
   *   - an already-approved expense is not re-approvable; correct by reversal.
   */
  "expense.approve": {
    tier: "T2",
    domain: "finance",
    stores: ["finance"],
    minRole: "manager",
    describe:
      `Approve one submitted expense, up to ${CAPS.EXPENSE_APPROVE_MAX_MINOR} minor units. ` +
      "Requires an in-session approval token. Approval is a one-way door.",
    undo: "none in place — correct with a reversing entry",
    schema: {
      expense_id: { type: "string", required: true, format: "id" },
      note: { type: "string", maxLength: CAPS.MAX_TEXT },
    },
    async check(args, t) {
      const row = await t.db.finance
        .prepare(
          "SELECT id, employee_id, amount_minor, currency, status, receipt_key, description" +
            " FROM expense WHERE id = ?",
        )
        .bind(args.expense_id)
        .first();
      if (!row) return { denied: `no expense '${args.expense_id}'` };

      if (!["draft", "submitted"].includes(row.status)) {
        return { denied: `expense ${row.id} is '${row.status}': correct it with a reversing entry, not another approval` };
      }
      if (row.employee_id === t.actor) {
        return { denied: "the submitter cannot approve their own expense" };
      }
      if (!row.receipt_key) {
        return { denied: "no receipt key on this expense: an approved expense with no receipt is an unauditable payment" };
      }
      if (row.amount_minor > CAPS.EXPENSE_APPROVE_MAX_MINOR) {
        return {
          denied:
            `amount ${row.amount_minor} ${row.currency} exceeds the approval cap of ` +
            `${CAPS.EXPENSE_APPROVE_MAX_MINOR}. Refused in code, not escalated.`,
          detail: { cap_minor: CAPS.EXPENSE_APPROVE_MAX_MINOR, amount_minor: row.amount_minor },
        };
      }
      return {
        ok: true,
        summary: `approve ${row.amount_minor} ${row.currency} — ${row.description} (${row.id})`,
        preflight: { expense: row },
      };
    },
    async run(args, t) {
      const at = new Date().toISOString();
      const res = await t.db.finance
        .prepare(
          "UPDATE expense SET status = 'approved', approved_by = ?, approved_at = ?" +
            " WHERE id = ? AND status IN ('draft','submitted')",
        )
        .bind(t.actor, at, args.expense_id)
        .run();

      /* The status guard in the WHERE is the race-free half of the check above. */
      if (!res?.meta?.changes) {
        return { error: `expense ${args.expense_id} was not in an approvable state` };
      }
      return {
        applied: true,
        expense_id: args.expense_id,
        status: "approved",
        approved_by: t.actor,
        approved_at: at,
        immutable_from_now: true,
      };
    },
  },
};
