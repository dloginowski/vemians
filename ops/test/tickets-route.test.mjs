/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * /tickets driven the way items-route.test.mjs drives /items: a real Worker
 * fetch, a real-shaped Access assertion, and the real ticket schema over
 * node:sqlite rather than a fake store — the append-only and
 * resolved-needs-a-timestamp triggers are not the point of every check here,
 * but a hand-rolled fake table could still drift from what the real one
 * enforces.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const worker = (await import("../src/index.js")).default;

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

const MANAGER_POLICY = "56e4eee0-0000-4000-8000-000000000003";
const STAFF_POLICY = "f6e1649c-0000-4000-8000-000000000002";
const STAFF = { email: "ana@example.test", policy_id: STAFF_POLICY };
const STRANGER = { email: "stranger@example.test", policy_id: "unmapped-policy" };

function assertion(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

/* The real ticket schema, over node:sqlite — same discipline as
   items-route.test.mjs's mirrorDb(): a hand-rolled fake table could quietly
   drift from what shared/db/tickets.sql actually enforces (append-only
   comments, resolved_at required to resolve or close). */
function ticketsDb() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "db", "tickets.sql"), "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const wrap = (text) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async all() {
        return { success: true, results: db.prepare(text).all(...bound) };
      },
      async first(column) {
        const row = db.prepare(text).get(...bound);
        if (row === undefined) return null;
        return column === undefined ? row : row[column];
      },
      async run() {
        const r = db.prepare(text).run(...bound);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db, db };
}

function seedTicket(db, overrides = {}) {
  db.db.exec(
    `INSERT INTO ticket (id, number, title, body, category, priority, status, created_by)
     VALUES ('tik_1', 1, '${overrides.title ?? "Backroom shelving is loose"}', 'One bracket came away.',
             'facilities', 'high', 'open', 'ana@example.test')`,
  );
}

/* This route needs no AUDIT binding of its own — runTool refuses (and
   auditless) if it is missing, the same fail-closed shape every other T1/T0
   tool call already has, exercised directly in tools.test.mjs. A real
   binding here keeps this file's own checks about the HTTP surface. */
function auditDb() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "..", "..", "shared", "db", "audit.sql"), "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const wrap = (text) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async all() {
        return { success: true, results: db.prepare(text).all(...bound) };
      },
      async first(column) {
        const row = db.prepare(text).get(...bound);
        if (row === undefined) return null;
        return column === undefined ? row : row[column];
      },
      async run() {
        const r = db.prepare(text).run(...bound);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare: wrap, _raw: db };
}

function env(tickets) {
  return {
    SURFACE: "ops",
    MANAGER_POLICY_ID: MANAGER_POLICY,
    STAFF_POLICY_ID: STAFF_POLICY,
    TICKETS: tickets,
    AUDIT: auditDb(),
  };
}

function get(path, claims, e) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { "Cf-Access-Jwt-Assertion": assertion(claims) } }), e);
}

function postForm(path, claims, e, fields) {
  const form = new URLSearchParams(fields);
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": assertion(claims), "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    e,
  );
}

check("test_PRD_P0_100_ticket_messaging__the_messages_tab_lists_open_tickets", async () => {
  const tickets = ticketsDb();
  seedTicket(tickets);
  const res = await get("/tickets", STAFF, env(tickets));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Backroom shelving is loose/);
  assert.match(body, /href="\/tickets\/tik_1"/);
});

check("test_PRD_P0_100_ticket_messaging__a_stranger_with_no_mapped_role_is_refused", async () => {
  const tickets = ticketsDb();
  const res = await get("/tickets", STRANGER, env(tickets));
  assert.equal(res.status, 403);
});

check("test_PRD_P0_100_ticket_messaging__starting_a_ticket_creates_a_row_and_redirects_to_it", async () => {
  const tickets = ticketsDb();
  const res = await postForm("/tickets/new", STAFF, env(tickets), { title: "Window display needs refreshing" });
  assert.equal(res.status, 303);
  const location = res.headers.get("location");
  assert.match(location, /^\/tickets\/[a-z0-9-]+$/);

  const row = tickets.db.prepare("SELECT title, category, priority, status, created_by FROM ticket").get();
  assert.equal(row.title, "Window display needs refreshing");
  assert.equal(row.category, "other");
  assert.equal(row.priority, "normal");
  assert.equal(row.status, "open");
  assert.equal(row.created_by, "ana@example.test");
});

check("test_PRD_P0_100_ticket_messaging__starting_a_ticket_with_no_title_is_refused_not_filed", async () => {
  const tickets = ticketsDb();
  const res = await postForm("/tickets/new", STAFF, env(tickets), { title: "" });
  assert.equal(res.status, 400);
  const count = tickets.db.prepare("SELECT count(*) AS n FROM ticket").get().n;
  assert.equal(count, 0, "no row was filed for an empty title");
});

check("test_PRD_P0_100_ticket_messaging__the_new_ticket_route_only_accepts_post", async () => {
  const tickets = ticketsDb();
  const res = await get("/tickets/new", STAFF, env(tickets));
  assert.equal(res.status, 405);
});

check("test_PRD_P0_100_ticket_messaging__opening_a_ticket_shows_its_thread", async () => {
  const tickets = ticketsDb();
  seedTicket(tickets);
  tickets.db.exec(
    "INSERT INTO ticket_comment (id, ticket_id, author, body) VALUES ('tic_1', 'tik_1', 'mara@example.test', 'On it.')",
  );
  const res = await get("/tickets/tik_1", STAFF, env(tickets));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Backroom shelving is loose/);
  assert.match(body, /On it\./);
  assert.match(body, /mara@example\.test/);
});

check("test_PRD_P0_108_ops_dashboard__a_ticket_page_links_back_to_the_dashboard_not_tickets", async () => {
  /* Superseded from "&larr; All tickets" -> "/tickets" once the Messages
     tab (and its list page) became the Dashboard tab -> /dashboard. */
  const tickets = ticketsDb();
  seedTicket(tickets);
  const res = await get("/tickets/tik_1", STAFF, env(tickets));
  const body = await res.text();
  assert.match(body, /<a class="ticket-back" href="\/dashboard">&larr; Dashboard<\/a>/);
});

check("test_PRD_P0_108_ops_dashboard__the_comment_bar_has_a_plain_dictation_mic_not_agentic", async () => {
  /* The owner's own words: "it's not an agentic microphone... just input
     text without typing." class="icon-btn" alone, never "mic-btn" — the
     orange agentic look stays reserved for the agent composer and Items'
     own voice search. */
  const tickets = ticketsDb();
  seedTicket(tickets);
  const res = await get("/tickets/tik_1", STAFF, env(tickets));
  const body = await res.text();
  assert.match(body, /<button type="button" class="icon-btn" id="ticket-comment-mic"/);
  assert.doesNotMatch(body, /id="ticket-comment-mic"[^>]*mic-btn/);
});

check("test_PRD_P0_100_ticket_messaging__an_unknown_ticket_id_is_a_404_not_a_crash", async () => {
  const tickets = ticketsDb();
  const res = await get("/tickets/nope", STAFF, env(tickets));
  assert.equal(res.status, 404);
});

check("test_PRD_P0_100_ticket_messaging__commenting_appends_to_the_thread_and_redirects_back", async () => {
  const tickets = ticketsDb();
  seedTicket(tickets);
  const res = await postForm("/tickets/tik_1/comment", STAFF, env(tickets), { body: "Landlord called back." });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/tickets/tik_1");

  const row = tickets.db.prepare("SELECT author, body FROM ticket_comment WHERE ticket_id='tik_1'").get();
  assert.equal(row.author, "ana@example.test");
  assert.equal(row.body, "Landlord called back.");
});

check("test_PRD_P0_100_ticket_messaging__resolving_without_a_note_is_refused_and_the_ticket_stays_open", async () => {
  const tickets = ticketsDb();
  seedTicket(tickets);
  const res = await postForm("/tickets/tik_1/status", STAFF, env(tickets), { status: "resolved" });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /needs a &#39;note&#39;/);
  const row = tickets.db.prepare("SELECT status FROM ticket WHERE id='tik_1'").get();
  assert.equal(row.status, "open", "the ticket must not have moved");
});

check("test_PRD_P0_100_ticket_messaging__resolving_with_a_note_closes_the_loop_and_records_it_as_a_comment", async () => {
  const tickets = ticketsDb();
  seedTicket(tickets);
  const res = await postForm("/tickets/tik_1/status", STAFF, env(tickets), {
    status: "resolved",
    note: "Bracket replaced by the landlord's contractor.",
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/tickets/tik_1");

  const row = tickets.db.prepare("SELECT status, resolved_at FROM ticket WHERE id='tik_1'").get();
  assert.equal(row.status, "resolved");
  assert.ok(row.resolved_at, "resolved_at must be set — the database itself refuses a resolved row without it");

  const comment = tickets.db.prepare("SELECT author, body FROM ticket_comment WHERE ticket_id='tik_1'").get();
  assert.equal(comment.author, "ana@example.test");
  assert.equal(comment.body, "Bracket replaced by the landlord's contractor.");
});

check("test_PRD_P0_100_ticket_messaging__the_thread_is_shared_by_everyone_no_per_person_scoping", async () => {
  /* shared/db/tickets.sql's own line: "tickets are read and written by
     everyone." Unlike expenses (own submissions only for staff), a staff
     caller sees every ticket, not just their own. */
  const tickets = ticketsDb();
  tickets.db.exec(
    "INSERT INTO ticket (id, number, title, category, priority, status, created_by) " +
      "VALUES ('tik_2', 2, 'Reorder tissue paper', 'supplier', 'normal', 'open', 'mara@example.test')",
  );
  const res = await get("/tickets", STAFF, env(tickets));
  const body = await res.text();
  assert.match(body, /Reorder tissue paper/, "a ticket filed by someone else must still be visible");
});
