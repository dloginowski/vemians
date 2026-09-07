/*
 * The rate cap — the other half of "caps live in code, not in the prompt".
 *
 * Test-PRD-P0-25-write_approval_gate: "Rate and monetary caps are enforced in
 * code, never in the prompt." The monetary ones live in caps.js and are checked
 * at the point of refusal; this is the call-rate one, applied by the registry to
 * EVERY tool call before the tool is reached. An agent in a retry loop is the
 * ordinary case, not the adversarial one, and an unbounded loop over a read tool
 * is a bill and a log flood before it is anything else.
 *
 * SCOPE, HONESTLY
 *   A counter in the isolate, per actor, over a sliding window. It bounds one
 *   isolate's traffic, not the account's, and it resets when the isolate does —
 *   the same scope as the in-session approval store next door. The interface is
 *   one method so a Durable Object (a real global counter) can replace it
 *   without touching the registry. Refusals are audited like any other denial.
 */
import { CAPS } from "./caps.js";

export function createRateLimiter({
  max = CAPS.CALLS_PER_MINUTE,
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const seen = new Map(); /* actor -> number[] of call times */

  return {
    /* Returns { ok } or { ok:false, retry_after_ms, max, window_ms }. */
    take(actor) {
      const t = now();
      const cutoff = t - windowMs;
      const times = (seen.get(actor) ?? []).filter((at) => at > cutoff);
      if (times.length >= max) {
        seen.set(actor, times);
        return {
          ok: false,
          retry_after_ms: Math.max(1, times[0] + windowMs - t),
          max,
          window_ms: windowMs,
        };
      }
      times.push(t);
      seen.set(actor, times);
      return { ok: true, remaining: max - times.length };
    },
  };
}

export const rateLimiter = createRateLimiter();
