/*
 * The T2 approval gate — Test-PRD-P0-25-write_approval_gate.
 *
 * A T2 tool called without `ctx.approvalToken` does not execute. It issues a
 * token describing exactly what it would do, audits `pending_approval`, and
 * returns `needsApproval: true`. The human reads the summary and calls again
 * with that token; only then does anything change.
 *
 * WHAT THE TOKEN IS BOUND TO
 *   tool + actor + a canonical fingerprint of the arguments. Change one digit
 *   of the price after the approval and the token no longer matches — an
 *   approval is for a specific change, not for a tool. It is also single use
 *   and expires (CAPS.APPROVAL_TTL_MS): "in-session" means in this session.
 *
 * WHERE IT LIVES
 *   An in-memory Map in the isolate. That is the honest scope of an in-session
 *   approval and it needs no store, but it does mean a token does not survive
 *   an isolate change. The interface is deliberately three methods so a Durable
 *   Object or KV implementation can replace it without touching a tool.
 */
import { CAPS } from "./caps.js";

/* Stable stringify: key order must not change a fingerprint. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(",")}}`;
}

export function fingerprint(tool, actor, args) {
  return canonical({ tool, actor, args });
}

export function createApprovalStore({ now = () => Date.now(), ttlMs = CAPS.APPROVAL_TTL_MS } = {}) {
  const pending = new Map(); /* token -> { fingerprint, expiresAt, summary } */

  function sweep(t) {
    for (const [token, rec] of pending) if (rec.expiresAt <= t) pending.delete(token);
  }

  return {
    /* Issue a token for one specific call. Returns { token, expiresAt }. */
    issue({ tool, actor, args, summary }) {
      const t = now();
      sweep(t);
      const token = `apr_${crypto.randomUUID().replace(/-/g, "")}`;
      pending.set(token, {
        fingerprint: fingerprint(tool, actor, args),
        expiresAt: t + ttlMs,
        summary: summary ?? null,
      });
      return { token, expiresAt: new Date(t + ttlMs).toISOString(), summary: summary ?? null };
    },

    /*
     * Consume a token for one specific call. Returns { ok } or { ok:false,
     * reason }. Single use: a matching token is deleted whether or not the tool
     * then succeeds, so a failed T2 call needs a fresh approval rather than
     * silently holding a live one.
     */
    consume(token, { tool, actor, args }) {
      const t = now();
      sweep(t);
      if (!token) return { ok: false, reason: "no_token" };
      const rec = pending.get(token);
      if (!rec) return { ok: false, reason: "unknown_or_used_token" };
      pending.delete(token);
      if (rec.expiresAt <= t) return { ok: false, reason: "expired_token" };
      if (rec.fingerprint !== fingerprint(tool, actor, args)) {
        /* Approval was for a different change — or a different person. */
        return { ok: false, reason: "token_does_not_match_this_call" };
      }
      return { ok: true };
    },

    /* Diagnostics only; never exposed to a tool. */
    size() {
      sweep(now());
      return pending.size;
    },
  };
}

/* The default store for the Worker. Tests inject their own with a fake clock. */
export const approvals = createApprovalStore();
