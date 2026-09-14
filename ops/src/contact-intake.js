/*
 * Turn a storefront contact-form submission into a ticket — the other half
 * of "we will handle communication entirely through our website internal
 * messages" (P0-100). store/src/contact.js (ADR-015) already writes each
 * submission into Square's own Customer Directory; this scheduled step is
 * what makes it ALSO show up where staff actually look now, the Dashboard tab.
 *
 * WHY A SCHEDULED PICKUP, NOT A DIRECT WRITE FROM THE STOREFRONT
 *   The storefront Worker is public and unauthenticated. Giving it a binding
 *   to TICKETS would be the same category of widening ADR-015 already
 *   weighed for SQUARE_ACCESS_TOKEN_CONTACT, applied to an internal store
 *   instead of a Square credential — and TICKETS holds ops's own working
 *   notes, not just contact submissions. Instead this rides the SAME cron
 *   ops/src/sync.js already runs every 15 minutes: the storefront's own
 *   half is unchanged, and nothing new is exposed to the public internet.
 *
 * DEDUP IS BY TICKET_LINK, NOT A CURSOR
 *   No new "last processed" state table: every run asks Square for
 *   customers created in the last LOOKBACK_MS (generously overlapping the
 *   15-minute cron, the same overlap-over-precision trade sync.js's own
 *   OVERLAP_MS makes) and skips any whose Square customer id already has a
 *   `ticket_link` row from this job. A missed run costs nothing — the next
 *   one still sees the same customer inside the lookback window.
 *
 * NO Access identity, same as syncFromSquare
 *   A cron has no Access assertion and this never goes through runTool: the
 *   row is written directly, `created_by` set to a literal, recognisable
 *   string rather than a real Access email, so nobody mistakes it for a
 *   staff member having filed it.
 */
import { createSquareClient } from "../../shared/commerce/square/client.js";
import { listContactCustomers } from "../../shared/commerce/square/customers.js";

export const CONTACT_INTAKE_SOURCE = "vemians.com/visit";

/* Generous on purpose: overlapping runs cost nothing (dedup is by
   ticket_link), and this only needs to be wider than the gap between
   scheduled runs, not tuned to it. */
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * One intake run.
 *
 * @param env   TICKETS binding, SQUARE_ACCESS_TOKEN, SQUARE_ENV.
 * @param opts  Injection seams: { ticketsDb, client, clientOptions, now }.
 * @returns {Promise<{ok: boolean, reason?: string, created?: number, scanned?: number}>}
 */
export async function intakeContactTickets(env, opts = {}) {
  const ticketsDb = opts.ticketsDb ?? env?.TICKETS ?? null;
  if (!ticketsDb?.prepare) {
    console.error("ERROR ops/contact-intake: no TICKETS binding on this Worker — nowhere to write");
    return { ok: false, reason: "binding_missing" };
  }

  let client;
  try {
    client =
      opts.client ??
      createSquareClient({ SQUARE_ACCESS_TOKEN: env?.SQUARE_ACCESS_TOKEN, SQUARE_ENV: env?.SQUARE_ENV }, opts.clientOptions);
  } catch (err) {
    console.error(`ERROR ops/contact-intake: ${err.message}`);
    return { ok: false, reason: "credential_unset" };
  }

  const now = opts.now ?? (() => new Date());
  const since = new Date(now().getTime() - LOOKBACK_MS).toISOString();

  let customers;
  try {
    customers = await listContactCustomers(client, { since, source: CONTACT_INTAKE_SOURCE });
  } catch (err) {
    console.error(`ERROR ops/contact-intake: Square search failed — ${err.message}`);
    return { ok: false, reason: "provider_unreachable" };
  }

  let created = 0;
  for (const c of customers) {
    const already = await ticketsDb
      .prepare("SELECT 1 FROM ticket_link WHERE entity_type = 'customer' AND entity_id = ? AND label = ?")
      .bind(c.id, CONTACT_INTAKE_SOURCE)
      .first();
    if (already) continue;

    const name = [c.given_name, c.family_name].filter(Boolean).join(" ") || c.email_address || "a visitor";
    const contact = [c.email_address, c.phone_number].filter(Boolean).join(" · ");
    const body = contact ? `${contact}\n\n${c.note ?? ""}` : (c.note ?? "");

    const id = crypto.randomUUID();
    const next = await ticketsDb.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM ticket").first();
    await ticketsDb
      .prepare(
        "INSERT INTO ticket(id, number, title, body, category, priority, status, created_by) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(id, next.number, `Contact form: ${name}`, body, "customer", "normal", "open", CONTACT_INTAKE_SOURCE)
      .run();
    await ticketsDb
      .prepare("INSERT INTO ticket_link(ticket_id, entity_type, entity_id, label) VALUES (?, 'customer', ?, ?)")
      .bind(id, c.id, CONTACT_INTAKE_SOURCE)
      .run();
    created += 1;
  }

  console.info(
    `INFO ops/contact-intake: ${created} new ticket(s) from ${customers.length} contact-form customer(s) since ${since}`,
  );
  return { ok: true, created, scanned: customers.length };
}
