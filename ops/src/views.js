/*
 * The employee area's HTML. Template literals, no framework, no build step.
 * The page shell, the escaper and the money format are shared/view/html.js;
 * the design tokens are shared/design/theme.css, imported there as a text
 * module. The rules below are layout only, integer px, no new colour and no
 * new type size.
 *
 * This file is in the ops package and nowhere else, so the storefront Worker
 * has no copy of the employee area to serve even if something asked it to.
 */

import { esc, money, page } from "../../shared/view/html.js";

function opsShifts(week) {
  return week.days
    .map((d, i) => {
      const shifts = week.shifts
        .filter((s) => s.day === i)
        .map((s) => `<div class="shift">${esc(s.from)}&ndash;${esc(s.to)}<br>${esc(s.who)}<br>${esc(s.role)}</div>`)
        .join("");
      return `<div class="day"><h3>${esc(d)}</h3>${shifts}</div>`;
    })
    .join("");
}

/*
 * Agent surface. Three pieces, one CSS block, and one builder per repeated
 * element on the client (`entry` for a log row, `card` for the approval) — no
 * second copy of either piece of markup anywhere. Everything below reuses the
 * measured tokens from theme.css; the rules here are layout only, integer px,
 * no new colour and no new type size.
 */
const agentCss = `
.bind { background: var(--image-ground); padding: 10px 12px; font-size: var(--eyebrow); margin-top: 12px; }
.log .tool { color: #666; font-size: var(--eyebrow); }
.gate { border: 1px solid var(--ink); padding: 12px; margin: 12px 0; }
.gate h3 { font-size: var(--type); font-weight: 700; margin: 0 0 8px; }
.gate dl { margin: 0; font-size: var(--eyebrow); }
.gate dt { font-weight: 700; margin-top: 8px; }
.gate dd { margin: 0; white-space: pre-wrap; word-break: break-word; }
.gate .row { display: flex; gap: 8px; }
.gate button[disabled] { color: #666; border-color: var(--rule); cursor: default; }
`;

function bindingsLine(bindings, hasKey) {
  const b = bindings || { role: "staff", tools: [], stores: [], hidden: 0 };
  const stores = b.stores.length ? b.stores.map((s) => `<code>${esc(s)}</code>`).join(", ") : "<code>none</code>";
  const model = hasKey
    ? "Model: <code>claude-sonnet-5</code>."
    : "Model: none — <code>ANTHROPIC_API_KEY</code> is unset, so the agent falls back to the echo stub.";
  return `<div class="bind">Role <strong>${esc(b.role)}</strong> &middot; ${b.tools.length} tool${b.tools.length === 1 ? "" : "s"} bound${b.hidden ? `, ${b.hidden} withheld` : ""} &middot; stores this session can reach: ${stores}. ${model}</div>`;
}

export function opsPage(identity, { customers, week, bindings, hasKey }) {
  const banner = identity.verified
    ? `<div class="who">Signed in via Cloudflare Access as <strong>${esc(identity.email)}</strong> &middot; assertion signature verified against the team JWKS.</div>`
    : `<div class="warn">Assertion accepted <strong>without signature verification</strong> — ACCESS_TEAM_DOMAIN and ACCESS_AUD are unset, so this is prototype mode. Set both in wrangler.toml before this is reachable from the internet. Claimed identity: ${esc(identity.email)}</div>`;

  return page(
    "Vemians ops",
    `<div class="bar">ops.vemians.com &middot; employees only</div>
${banner}
<main class="ops">
  <h2>Customers</h2>
  <p class="note">Opaque ids only. Name, email and phone live in the <code>identity</code> store as ciphertext and this surface holds no binding to it, so these records cannot be attributed to a person from here.</p>
  <table>
    <thead><tr><th>Customer id</th><th>Birth year</th><th>Fit</th><th>Segment</th><th>Orders</th><th>Lifetime</th><th>Consent</th></tr></thead>
    <tbody>
${customers
  .map(
    (c) => `      <tr><td>${esc(c.id)}</td><td>${esc(c.birthYear)}</td><td>${esc(c.fit)}</td><td>${esc(c.segment)}</td><td>${esc(c.orders)}</td><td>${esc(money(c.lifetimeMinor, c.currency))}</td><td>${esc(c.consent.join(", ") || "none")}</td></tr>`,
  )
  .join("\n")}
    </tbody>
  </table>

  <h2>Week of ${esc(week.starting)}</h2>
  <div class="week">${opsShifts(week)}</div>
  <p class="note">Read-only. Overlapping shifts are refused by a database trigger, not by this view.</p>

  <h2>Agent</h2>
  <p class="note">Posts to <code>/ops/agent</code>. Tools are filtered by role before the request leaves the Worker, so a tool this role may not use is not offered to the model at all. A tier&nbsp;2 tool stops here for approval instead of running.</p>
  ${bindingsLine(bindings, hasKey)}
  <div class="log" id="log"></div>
  <div id="gate"></div>
  <form class="chat" id="chat" method="post" action="/ops/agent">
    <input name="q" id="q" placeholder="Ask about the catalog, orders, stock or the schedule" autocomplete="off">
    <button type="submit">Send</button>
  </form>
</main>
<script>
const log = document.getElementById("log");
const gate = document.getElementById("gate");

/* One builder for every log row. kind is "" (you), "agent" or "tool". */
function entry(kind, text) {
  const p = document.createElement("p");
  if (kind) p.className = kind;
  p.textContent = text;
  log.appendChild(p);
  p.scrollIntoView({ block: "nearest" });
  return p;
}

/* One builder for the approval card. The card carries the pending id and
   nothing else — the tool name and arguments shown here are the server's copy,
   and the server re-reads its own copy when it runs. Nothing the page sends
   back can change what executes. */
function card(p) {
  gate.textContent = "";
  const el = document.createElement("div");
  el.className = "gate";
  el.innerHTML =
    "<h3></h3><dl>" +
    "<dt>Tool</dt><dd data-f=tool></dd>" +
    "<dt>Arguments</dt><dd data-f=args></dd>" +
    "<dt>Effect</dt><dd data-f=effect></dd>" +
    "<dt>Stores</dt><dd data-f=stores></dd>" +
    /* class=chat so the buttons reuse theme.css's one button rule — the gate
       adds no second definition of what a button looks like. */
    "</dl><div class='chat row'><button data-a=ok>Approve</button><button data-a=no>Cancel</button></div>";
  el.querySelector("h3").textContent = "Approval required — tier " + p.tier;
  el.querySelector("[data-f=tool]").textContent = p.tool;
  el.querySelector("[data-f=args]").textContent = JSON.stringify(p.args, null, 2);
  el.querySelector("[data-f=effect]").textContent = p.effect;
  el.querySelector("[data-f=stores]").textContent = (p.stores || []).join(", ") || "none";

  const buttons = el.querySelectorAll("button");
  el.querySelector("[data-a=no]").addEventListener("click", () => {
    gate.textContent = "";
    entry("tool", "Cancelled. " + p.tool + " was not run.");
  });
  el.querySelector("[data-a=ok]").addEventListener("click", async () => {
    buttons.forEach((b) => (b.disabled = true));
    const line = entry("tool", "Approving " + p.tool + "…");
    try {
      const res = await fetch("/ops/agent/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: p.id }),
      });
      const data = await res.json();
      gate.textContent = "";
      line.textContent = data.reply || data.error || ("Approve failed: " + res.status);
    } catch (err) {
      console.error("approve request failed", err);
      buttons.forEach((b) => (b.disabled = false));
      line.textContent = "Approve failed: " + err.message;
    }
  });
  gate.appendChild(el);
}

document.getElementById("chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = document.getElementById("q");
  const q = box.value.trim();
  if (!q) return;
  gate.textContent = "";
  entry("", q);
  box.value = "";
  try {
    const res = await fetch("/ops/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q }),
    });
    const data = await res.json();
    (data.steps || []).forEach((s) => entry("tool", (s.ok ? "ran " : "refused ") + s.tool + (s.auditId ? " · audit " + s.auditId : "")));
    entry("agent", data.reply || data.error || ("Request failed: " + res.status));
    if (data.pending) card(data.pending);
  } catch (err) {
    console.error("agent request failed", err);
    entry("agent", "Request failed: " + err.message);
  }
});
</script>`,
    agentCss,
  );
}

export function refusalPage(status, reason) {
  return page(
    "Refused",
    `<div class="bar">ops.vemians.com</div>
<main class="ops">
  <h2>${status} &mdash; refused</h2>
  <p>${esc(reason)}</p>
  <p class="note">This surface is served only behind Cloudflare Access. The Worker fails closed when no verified Access assertion is present.</p>
</main>`,
  );
}

