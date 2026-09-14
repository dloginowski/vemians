/*
 * ticket.* — company-wide issues and internal messages. Inherits
 * agent-tool-contract.
 *
 * WHY TICKETS ARE THE MESSAGING SURFACE, NOT A SEPARATE TABLE
 *   shared/db/tickets.sql already exists for P0-32 (closed, never deleted,
 *   append-only comments) but had no tool or ops UI reaching it — schema
 *   without a surface. The owner's own words, once "everyone has their own
 *   emails" retired email as the way staff (and eventually customers) reach
 *   each other: "we will handle communication entirely through our website
 *   internal messages." A ticket IS a message thread — title plus an
 *   append-only comment log — with the category/priority/status machinery
 *   already built and tested, so this is that surface, not a second,
 *   parallel one built to look simpler.
 *
 * WHAT THIS FILE DOES NOT YET COVER
 *   Everyone in this file is a signed-in ops identity (staff+): this is the
 *   staff-to-staff half. A customer has no account or login on the
 *   storefront at all today, so staff-to-customer messaging needs its own
 *   identity decision (a magic link? an order-lookup code?) before it can
 *   reuse this same thread shape — deliberately left open rather than
 *   guessed at here. `ticket_link` (shared/db/tickets.sql) already has an
 *   `entity_type='customer'` shape ready for that day.
 *
 * WRITES ARE PROPOSALS, LIKE EVERY OTHER T1 IN THIS DIRECTORY
 *   ticket.create and ticket.comment validate and return the row to insert;
 *   they write nothing themselves (finance.js's expense.submit is the same
 *   shape). The actual INSERT happens in src/index.js's /tickets routes —
 *   a human's browser submission — the same "propose, then a human action
 *   commits it" split every other T1 tool in this codebase uses.
 *
 * NO minRole ABOVE staff
 *   Unlike finance or people, a ticket carries no money and no employee
 *   record — the PRD's own line: "tickets are read and written by everyone."
 *   Assigning one to a specific person, and resolving it, both stay staff+
 *   for the same reason: this is coordination, not authorisation.
 */
import { CAPS } from "./caps.js";

const TICKET_CATEGORIES = ["stock", "fulfilment", "customer", "site", "supplier", "facilities", "other"];
const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"];
const TICKET_STATUSES = ["open", "in_progress", "blocked", "resolved", "closed"];

const TICKET_COLUMNS =
  "id, number, title, body, category, priority, status, created_by, assigned_to," +
  " created_at, updated_at, resolved_at";

export const ticketTools = {
  "ticket.list": {
    tier: "T0",
    domain: "tickets",
    stores: ["tickets"],
    minRole: "staff",
    describe:
      "Tickets in the working set (not archived), newest first. Filter by status, category " +
      "or assignee; everyone sees every ticket — there is no per-person scoping here.",
    undo: null,
    schema: {
      status: { type: "string", enum: TICKET_STATUSES },
      category: { type: "string", enum: TICKET_CATEGORIES },
      assigned_to: { type: "string", maxLength: 200 },
      limit: { type: "integer", min: 1, max: CAPS.MAX_ROWS },
    },
    async run(args, t) {
      const where = ["archived_at IS NULL"];
      const binds = [];
      if (args.status) {
        where.push("status = ?");
        binds.push(args.status);
      }
      if (args.category) {
        where.push("category = ?");
        binds.push(args.category);
      }
      if (args.assigned_to) {
        where.push("assigned_to = ?");
        binds.push(args.assigned_to);
      }
      const limit = Number.isInteger(args.limit) ? Math.min(args.limit, CAPS.MAX_ROWS) : CAPS.DEFAULT_ROWS;
      binds.push(limit);

      const rows = await t.db.tickets
        .prepare(
          `SELECT ${TICKET_COLUMNS} FROM ticket WHERE ${where.join(" AND ")}` +
            " ORDER BY priority = 'urgent' DESC, priority = 'high' DESC, created_at DESC LIMIT ?",
        )
        .bind(...binds)
        .all();

      return { tickets: rows.results ?? [], limit };
    },
  },

  "ticket.get": {
    tier: "T0",
    domain: "tickets",
    stores: ["tickets"],
    minRole: "staff",
    describe: "One ticket with its full, append-only comment thread, oldest first.",
    undo: null,
    schema: { ticket_id: { type: "string", required: true, format: "id" } },
    async run(args, t) {
      const ticket = await t.db.tickets
        .prepare(`SELECT ${TICKET_COLUMNS} FROM ticket WHERE id = ?`)
        .bind(args.ticket_id)
        .first();
      if (!ticket) return { error: `no ticket '${args.ticket_id}'` };

      const comments = await t.db.tickets
        .prepare(
          "SELECT id, author, body, created_at FROM ticket_comment" +
            " WHERE ticket_id = ? ORDER BY created_at LIMIT ?",
        )
        .bind(args.ticket_id, CAPS.MAX_ROWS)
        .all();

      return { ticket, comments: comments.results ?? [] };
    },
  },

  /*
   * T1: a proposal, not a row (see the file header). The human-facing
   * /tickets/new route in src/index.js turns this into the real INSERT,
   * minting `id` and the human-readable `number` there — the same split
   * expense.submit -> /expenses/confirm already uses.
   */
  "ticket.create": {
    tier: "T1",
    domain: "tickets",
    stores: [],
    minRole: "staff",
    describe:
      "Propose a new ticket: a title, an optional longer body, a category and a priority. " +
      "The reporter is taken from the Access identity. Writes nothing.",
    undo: "close it — nothing here is ever deleted",
    schema: {
      title: { type: "string", required: true, maxLength: 200 },
      body: { type: "string", maxLength: CAPS.MAX_TEXT },
      category: { type: "string", enum: TICKET_CATEGORIES, default: "other" },
      priority: { type: "string", enum: TICKET_PRIORITIES, default: "normal" },
    },
    async check(args) {
      return { ok: true, summary: `[${args.category ?? "other"}] ${args.title}` };
    },
    async run(args, t) {
      return {
        applied: false,
        proposal: {
          table: "ticket",
          op: "insert",
          values: {
            title: args.title,
            body: args.body ?? "",
            category: args.category ?? "other",
            priority: args.priority ?? "normal",
            status: "open",
            created_by: t.actor,
          },
        },
      };
    },
  },

  /*
   * T1, same shape as ticket.create. Checked against the real row here (the
   * ticket must exist and still be open enough to talk about) so the /tickets
   * route gets a clear refusal instead of a foreign-key error from the insert.
   */
  "ticket.comment": {
    tier: "T1",
    domain: "tickets",
    stores: ["tickets"],
    minRole: "staff",
    describe:
      "Propose a comment on an existing ticket — the thread is append-only, so this is the " +
      "one way to add to it; there is no edit or delete. Writes nothing.",
    undo: "add a further comment; nothing here can be edited or removed",
    schema: {
      ticket_id: { type: "string", required: true, format: "id" },
      body: { type: "string", required: true, maxLength: CAPS.MAX_TEXT },
    },
    async check(args, t) {
      const ticket = await t.db.tickets
        .prepare("SELECT id, title, status FROM ticket WHERE id = ?")
        .bind(args.ticket_id)
        .first();
      if (!ticket) return { denied: `no ticket '${args.ticket_id}'` };
      return { ok: true, summary: `comment on "${ticket.title}"`, preflight: { ticket } };
    },
    async run(args, t) {
      return {
        applied: false,
        proposal: {
          table: "ticket_comment",
          op: "insert",
          values: { ticket_id: args.ticket_id, author: t.actor, body: args.body },
        },
      };
    },
  },

  /*
   * T1, same shape as ticket.create and ticket.comment: a proposal, applied
   * by the /tickets/<id>/status route, never by this tool. Resolving or
   * closing without a reason is refused here so the refusal is legible
   * ("give a note"), but shared/db/tickets.sql's own triggers
   * (ticket_resolved_needs_time, ticket_archive_only_settled) are the actual
   * enforcement regardless of what this check does — the same "advisory
   * read, the database is the authority" split schedule.draft documents.
   */
  "ticket.set_status": {
    tier: "T1",
    domain: "tickets",
    stores: ["tickets"],
    minRole: "staff",
    describe:
      "Propose moving a ticket to a new status. Resolving or closing requires a note saying " +
      "what was done, which becomes the resolving comment. Writes nothing.",
    undo: "propose reopening with another ticket.set_status call",
    schema: {
      ticket_id: { type: "string", required: true, format: "id" },
      status: { type: "string", required: true, enum: TICKET_STATUSES },
      assigned_to: { type: "string", maxLength: 200 },
      note: { type: "string", maxLength: CAPS.MAX_TEXT },
    },
    async check(args, t) {
      if (["resolved", "closed"].includes(args.status) && !args.note) {
        return { denied: "resolving or closing a ticket needs a 'note' saying what was done" };
      }
      const ticket = await t.db.tickets
        .prepare("SELECT id, title, status FROM ticket WHERE id = ?")
        .bind(args.ticket_id)
        .first();
      if (!ticket) return { denied: `no ticket '${args.ticket_id}'` };
      return { ok: true, summary: `"${ticket.title}" -> ${args.status}` };
    },
    async run(args) {
      return {
        applied: false,
        proposal: {
          table: "ticket",
          op: "update_status",
          values: {
            ticket_id: args.ticket_id,
            status: args.status,
            assigned_to: args.assigned_to,
            note: args.note ?? null,
          },
        },
      };
    },
  },
};
