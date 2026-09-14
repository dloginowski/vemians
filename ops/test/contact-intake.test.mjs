/*
 * Contact-form intake — PRD-backed regression checks.
 *
 *     Run: node --test test/contact-intake.test.mjs        (from ops/)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD / TEST CONTRACT — read before editing this file
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/PRD.md` is the driving design document. Every check here exists to
 * enforce a NUMBERED PRD FEATURE as written there — not an implementation
 * detail, and not "a thing the code happens to do".
 *   * Each check is named  test_PRD_P0_NN_short_id__specific_behaviour  and so
 *     carries the visible label  Test-PRD-P0-NN-short_id.
 *   * That label MUST exist in docs/PRD.md.
 *   * UNLABELED CHECKS ARE NOT ACCEPTABLE.
 *
 * NO SQUARE ACCOUNT, TOKEN OR NETWORK CALL IS INVOLVED, same discipline as
 * sync.test.mjs: `fakeFetch` stubs the one endpoint this file calls
 * (POST /v2/customers/search), and the REAL ticket schema
 * (shared/db/tickets.sql) runs under node:sqlite, so the append-only and
 * unique-number guarantees are the real ones, not a hand-rolled promise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { d1FromSql } from "../../shared/test/d1.mjs";

const { intakeContactTickets, CONTACT_INTAKE_SOURCE } = await import("../src/contact-intake.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.join(HERE, "..");
const REPO = path.join(OPS, "..");
const PRD = fs.readFileSync(path.join(REPO, "docs", "PRD.md"), "utf8");
const TICKETS_SQL = fs.readFileSync(path.join(REPO, "shared", "db", "tickets.sql"), "utf8");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2,3})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

function fakeFetch(customers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ customers }), { status: 200, headers: { "content-type": "application/json" } });
  };
  impl.calls = calls;
  return impl;
}

const NOW = () => new Date("2026-09-14T12:00:00Z");

function baseEnv(ticketsDb) {
  return { SQUARE_ACCESS_TOKEN: "fixture-token", SQUARE_ENV: "sandbox", TICKETS: ticketsDb };
}

check("test_PRD_P0_100_ticket_messaging__a_contact_form_customer_becomes_a_ticket", async () => {
  const tickets = d1FromSql(TICKETS_SQL);
  const customers = [
    {
      id: "cus_abc",
      given_name: "Priya",
      family_name: "Nair",
      email_address: "priya@example.test",
      note: `${CONTACT_INTAKE_SOURCE} · 2026-09-14T10:00:00Z\nDo you have this coat in size 40?`,
    },
  ];
  const res = await intakeContactTickets(baseEnv(tickets), {
    now: NOW,
    clientOptions: { fetchImpl: fakeFetch(customers) },
  });
  assert.equal(res.ok, true);
  assert.equal(res.created, 1);

  const row = tickets._raw.prepare("SELECT title, body, category, priority, status, created_by FROM ticket").get();
  assert.equal(row.title, "Contact form: Priya Nair");
  assert.match(row.body, /priya@example\.test/);
  assert.match(row.body, /Do you have this coat in size 40\?/);
  assert.equal(row.category, "customer");
  assert.equal(row.status, "open");
  assert.equal(row.created_by, CONTACT_INTAKE_SOURCE, "a system actor, never a real Access identity");

  const link = tickets._raw.prepare("SELECT entity_type, entity_id FROM ticket_link").get();
  assert.equal(link.entity_type, "customer");
  assert.equal(link.entity_id, "cus_abc");
});

check("test_PRD_P0_100_ticket_messaging__a_customer_not_from_the_contact_form_is_skipped", async () => {
  /* A customer created at the till, or by the batch importer, carries no
     CONTACT_INTAKE_SOURCE stamp in its note — listContactCustomers filters
     these out before this function ever sees them, but the whole point is
     that this run creates nothing for them. */
  const tickets = d1FromSql(TICKETS_SQL);
  const customers = [{ id: "cus_till", given_name: "Ana", note: "Prefers navy, in-store regular." }];
  const res = await intakeContactTickets(baseEnv(tickets), {
    now: NOW,
    clientOptions: { fetchImpl: fakeFetch(customers) },
  });
  assert.equal(res.ok, true);
  assert.equal(res.created, 0);
  assert.equal(tickets._raw.prepare("SELECT count(*) AS n FROM ticket").get().n, 0);
});

check("test_PRD_P0_100_ticket_messaging__running_twice_does_not_file_the_same_submission_twice", async () => {
  /* No cursor is tracked — the lookback window overlaps every run on
     purpose (the same trade sync.js's own OVERLAP_MS makes) — so dedup has
     to be by ticket_link, checked before every insert. */
  const tickets = d1FromSql(TICKETS_SQL);
  const customers = [{ id: "cus_dup", given_name: "Sam", note: `${CONTACT_INTAKE_SOURCE} · 2026-09-14T09:00:00Z\nWhere's my order?` }];
  const fetchImpl = fakeFetch(customers);
  await intakeContactTickets(baseEnv(tickets), { now: NOW, clientOptions: { fetchImpl } });
  const second = await intakeContactTickets(baseEnv(tickets), { now: NOW, clientOptions: { fetchImpl } });
  assert.equal(second.ok, true);
  assert.equal(second.created, 0, "the second run must create nothing new");
  assert.equal(tickets._raw.prepare("SELECT count(*) AS n FROM ticket").get().n, 1);
});

check("test_PRD_P0_100_ticket_messaging__two_submissions_in_one_run_get_two_distinct_ticket_numbers", async () => {
  const tickets = d1FromSql(TICKETS_SQL);
  const customers = [
    { id: "cus_1", given_name: "A", note: `${CONTACT_INTAKE_SOURCE} · t\nfirst` },
    { id: "cus_2", given_name: "B", note: `${CONTACT_INTAKE_SOURCE} · t\nsecond` },
  ];
  const res = await intakeContactTickets(baseEnv(tickets), { now: NOW, clientOptions: { fetchImpl: fakeFetch(customers) } });
  assert.equal(res.created, 2);
  const numbers = tickets._raw.prepare("SELECT number FROM ticket ORDER BY number").all().map((r) => r.number);
  assert.deepEqual(numbers, [1, 2]);
});

check("test_PRD_P0_100_ticket_messaging__no_tickets_binding_refuses_rather_than_crashing", async () => {
  const res = await intakeContactTickets({ SQUARE_ACCESS_TOKEN: "x" }, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "binding_missing");
});

check("test_PRD_P0_100_ticket_messaging__no_credential_refuses_rather_than_crashing", async () => {
  const tickets = d1FromSql(TICKETS_SQL);
  const res = await intakeContactTickets({ TICKETS: tickets }, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "credential_unset");
  assert.equal(tickets._raw.prepare("SELECT count(*) AS n FROM ticket").get().n, 0);
});

check("test_PRD_P0_100_ticket_messaging__a_provider_failure_is_named_not_swallowed", async () => {
  const tickets = d1FromSql(TICKETS_SQL);
  const failing = async () => new Response(JSON.stringify({ errors: [] }), { status: 503 });
  const res = await intakeContactTickets(baseEnv(tickets), { now: NOW, clientOptions: { fetchImpl: failing, maxAttempts: 1 } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "provider_unreachable");
});

check("test_PRD_P0_30_prd_traceability__every_label_used_in_this_file_exists_in_the_prd", () => {
  for (const label of usedLabels) {
    assert.ok(PRD.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
