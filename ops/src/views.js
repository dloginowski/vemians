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

/*
 * ---- the front page -------------------------------------------------------
 *
 * One screen. A phone should show the whole thing without scrolling, and the
 * only thing above the fold that asks anything of the reader is the command
 * that connects their assistant — because that is what almost everyone is here
 * to do, once, and then never again.
 *
 * EVERYTHING ELSE IS A CLOSED ROW. Short label, no preamble, opened by the few
 * people who want it: the roster, the tier rules, the machine-readable contract
 * for a developer, the seed data. Out of sight, not out of mind. Nothing is
 * removed and nothing is a second page.
 *
 * An assistant that fetches this URL still reads all of it — `<details>` folds
 * are in the DOM whether or not a person opened them — so the compaction costs
 * the machine reader nothing.
 *
 * Nothing here is a second design system. The tokens are theme.css; the rules
 * below are layout only, integer px, no new colour and no new type size.
 */
const OPS_CSS = `
.ops { max-width: 34rem; padding: 12px 16px 32px; }

.id { font-size: var(--eyebrow); margin: 0 0 16px; color: #666; }
.ops .warn { margin: 0 0 14px; }
.id strong { color: var(--ink); }

.key h1 { font-size: var(--type); font-weight: 700; margin: 0 0 4px; }
.hint { font-size: var(--eyebrow); color: #666; margin: 0 0 8px; }
.hint a { color: var(--ink); }

/* One copyable line. The <pre> scrolls rather than wrapping, so a long command
   never reflows the page on a phone; the button stays beside it at every width
   because a full-width button under every line is most of a screen. */
.copy { display: flex; gap: 6px; align-items: stretch; margin: 0 0 8px; }
.copy pre {
  flex: 1 1 auto; min-width: 0; margin: 0; overflow-x: auto;
  background: var(--image-ground); padding: 8px 10px; font-size: var(--eyebrow);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.copy.wrap { align-items: flex-start; }
.copy.wrap pre { overflow-x: visible; white-space: pre-wrap; word-break: break-word; }
/* A button stretched down the side of a three-line prompt reads as a column,
   not a control. Fixed height, top-aligned with the first line of the text. */
.copy.wrap button { min-height: 36px; }
.copy button {
  flex: 0 0 auto; font: inherit; font-size: var(--eyebrow);
  padding: 0 10px; cursor: pointer;
  border: 1px solid var(--ink); background: var(--ground); color: var(--ink);
}

/* The accordion. Every row is one line at rest; everything inside one is small
   print, because a person who opened a fold is reading, not scanning. */
.acc { margin-top: 20px; border-top: 1px solid var(--rule); }
.acc > details { border-bottom: 1px solid var(--rule); }
.acc > details > summary {
  cursor: pointer; list-style-position: inside;
  padding: 10px 0; font-size: var(--type);
}
.acc > details > *:not(summary) { font-size: var(--eyebrow); }
.acc > details > *:last-child { margin-bottom: 12px; }
.acc p { margin: 0 0 8px; }
.acc ul { margin: 0 0 8px; padding-left: 18px; }
.acc li { margin-bottom: 4px; }
.acc h3 { font-size: var(--eyebrow); font-weight: 700; margin: 12px 0 6px; }
.acc table { font-size: var(--eyebrow); }
.acc th, .acc td { padding: 6px 10px 6px 0; }
.acc details { margin: 0 0 8px; }
.acc details summary { cursor: pointer; }

/* The last two rows are for nobody in particular — a developer once, and the
   seed data almost never. Quieter than the rest, still one tap away. */
.acc > details.aside > summary { font-size: var(--eyebrow); color: #666; padding: 8px 0; }

.scroll { overflow-x: auto; }
.you td { font-weight: 700; }

.bind { background: var(--image-ground); padding: 8px 10px; margin: 0 0 8px; }
.log { margin-top: 8px; }
.log p { margin: 0 0 6px; }
.log .agent { color: #666; }
.log .tool { color: #666; }
.gate { border: 1px solid var(--ink); padding: 12px; margin: 12px 0; }
.gate h3 { margin: 0 0 8px; }
.gate dl { margin: 0; }
.gate dt { font-weight: 700; margin-top: 8px; }
.gate dd { margin: 0; white-space: pre-wrap; word-break: break-word; }
.gate .row { display: flex; gap: 8px; }
.gate button[disabled] { color: #666; border-color: var(--rule); cursor: default; }
.chat input { padding: 8px 10px; }
.chat button { margin-top: 6px; padding: 8px 16px; font-size: var(--eyebrow); }

/* The seven-day grid is unreadable under about 640px — two columns there, one
   per day, in the same order. Nothing is hidden, the wrap point is the width. */
.week { font-size: var(--eyebrow); }
@media (max-width: 640px) {
  .week { grid-template-columns: repeat(2, 1fr); }
  .day { min-height: 0; }
}
`;

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
 * One builder for every copyable line on the page. The button carries no text
 * of its own — the script reads the <pre> beside it — so there is never a copy
 * button that copies something other than what is shown above it.
 *
 * A COMMAND scrolls rather than wraps: a shell line broken across three rows on
 * a phone invites someone to retype it by eye and lose half a flag. A PROMPT
 * wraps, because it is a sentence and a sentence clipped at the right edge of a
 * 390px screen cannot be read at all.
 */
function copyLine(text, { wrap = false } = {}) {
  return `<div class="copy${wrap ? " wrap" : ""}"><pre>${esc(text)}</pre><button type="button" data-copy>Copy</button></div>`;
}

function bindingsLine(bindings, hasKey) {
  const b = bindings || { role: "staff", tools: [], stores: [], hidden: 0 };
  const stores = b.stores.length ? b.stores.map((s) => `<code>${esc(s)}</code>`).join(", ") : "<code>none</code>";
  const model = hasKey
    ? "Model: <code>claude-sonnet-5</code>."
    : "Model: none — <code>ANTHROPIC_API_KEY</code> is unset, so the built-in chat echoes. Connect your own assistant instead.";
  return `<div class="bind">Role <strong>${esc(b.role)}</strong> &middot; ${b.tools.length} tool${b.tools.length === 1 ? "" : "s"} bound${b.hidden ? `, ${b.hidden} withheld` : ""} &middot; stores this session can reach: ${stores}. ${model}</div>`;
}

/*
 * WHERE THE ROSTER COMES FROM, AND WHERE IT CANNOT COME FROM.
 *
 * A role on this platform is granted by a Cloudflare Access policy and by
 * nothing else — the assertion carries `policy_id` and the Worker maps it. So
 * the honest roster is the one Access holds, and this Worker cannot read it:
 * ADR-011 says no Worker holds a Cloudflare API token, which is what makes the
 * employee area unable to grant itself admin.
 *
 * What it CAN read is the `people` store, which is the roster someone typed.
 * That is a record of intent, not of authorisation, and the column header says
 * so. When the store is empty or unbuilt the table still has one true row —
 * the person reading it, whose role came from their own live assertion.
 */
function rosterRows(roster, identity, role, roleVia) {
  const source = roleVia === "policy" ? "Access policy" : roleVia === "group" ? "Access group" : roleVia || "not granted";
  const rows = [
    `<tr class="you"><td>${esc(identity.email)}</td><td>${esc(role || "none")}</td><td>${esc(source)}</td><td>you, right now</td></tr>`,
  ];
  for (const p of roster || []) {
    if (String(p.email || "").toLowerCase() === String(identity.email || "").toLowerCase()) continue;
    rows.push(
      `<tr><td>${esc(p.name || p.email)}</td><td>${esc(p.role || "staff")}</td><td>people store</td><td>${p.is_active ? "active" : "inactive"}</td></tr>`,
    );
  }
  return rows.join("\n");
}

/*
 * The front page.
 *
 * `roster` is whatever the people store yielded (possibly none), `rosterNote`
 * says why when it yielded nothing, and `perRole` is the tool count each role
 * gets — computed from the same registry that filters the calls, so the table
 * cannot claim a capability the tool layer would refuse.
 */
export function opsPage(identity, { customers, week, bindings, hasKey, role, roleVia, skills = [], roster = [], rosterNote = "", perRole = [], mcpUrl = "https://ops.vemians.com/mcp" }) {
  const source = roleVia === "policy" ? "Access policy" : roleVia === "group" ? "Access group" : roleVia || "no role granted";
  const b = bindings || { role, tools: [], stores: [], hidden: 0 };

  /* One line, not a banner. The unverified case is the exception and keeps the
     black bar, because a Worker accepting unsigned assertions is not a detail
     to fold away. */
  const id = identity.verified
    ? `<p class="id"><strong>${esc(identity.email)}</strong> &middot; role <strong>${esc(role || "none")}</strong> &middot; ${esc(source)}</p>`
    : `<div class="warn">Unsigned assertion accepted — ACCESS_TEAM_DOMAIN and ACCESS_AUD are unset. Prototype mode only. Claimed: <strong>${esc(identity.email)}</strong> &middot; role <strong>${esc(role || "none")}</strong>.</div>`;

  return page(
    "Vemians ops",
    `<div class="bar">ops.vemians.com &middot; employees only</div>
<main class="ops">
${id}

  <section class="key">
    <h1>Connect your assistant</h1>
    <p class="hint">Paste into Claude Code. Once per machine.</p>
    ${copyLine(`claude mcp add --transport http vemians ${mcpUrl}`)}
    <p class="hint">No terminal? Add this as a connector in Claude or ChatGPT.</p>
    ${copyLine(mcpUrl)}
  </section>

  <div class="acc">

    <details>
      <summary>What to say to it first</summary>
      ${copyLine("Read the vemians skills, then tell me what you can do here.", { wrap: true })}
      <p>${skills.length} skill${skills.length === 1 ? "" : "s"} are readable at your role. They are the
         house rules — the closed category set, the two gates on price and publish, how a photograph
         gets in. It guesses less once it has read them.</p>
      <p>After that, plain sentences:</p>
      ${copyLine("Find every black boot in the catalog and show me what is out of stock.", { wrap: true })}
      ${copyLine("Here is a photo. Draft a product from it: brand, name, description, price.", { wrap: true })}
    </details>

    <details>
      <summary>Who has what</summary>
      <div class="scroll">
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Granted by</th><th>Status</th></tr></thead>
          <tbody>
${rosterRows(roster, identity, role, roleVia)}
          </tbody>
        </table>
      </div>
      ${rosterNote ? `<p>${esc(rosterNote)}</p>` : ""}
      <p>Roles are granted in Cloudflare Access and read from your sign-in. This page cannot change
         one, and neither can any assistant connected to it — the employee area holds no key that
         could.</p>
      <div class="scroll">
        <table>
          <thead><tr><th>Role</th><th>Tools</th><th>Can reach</th></tr></thead>
          <tbody>
${perRole
  .map(
    (r) =>
      `        <tr${r.role === role ? ' class="you"' : ""}><td>${esc(r.role)}</td><td>${r.tools.length}</td><td>${esc(r.stores.join(", ") || "nothing")}</td></tr>`,
  )
  .join("\n")}
          </tbody>
        </table>
      </div>
    </details>

    <details>
      <summary>How this works</summary>
      <ul>
        <li>Cloudflare Access checks who you are before this page or the endpoint answers at all.</li>
        <li>Your role decides which tools exist. A tool your role may not use is not offered to the
            assistant, so it cannot try it and cannot tell you it was refused.</li>
        <li>Reads happen immediately. Anything that writes stops: your assistant hands you a link,
            you read what is about to happen, and you press the button. It runs under your name,
            never the assistant's.</li>
        <li>Every call is recorded against the person who made it.</li>
      </ul>
    </details>

    <details>
      <summary>Something is not working</summary>
      <p><strong>Your assistant says 401.</strong> The sign-in did not finish. Open this page in the
         same browser, then reconnect.</p>
      <p><strong>Wrong account.</strong> <a href="/whoami">/whoami</a> says exactly what the sign-in
         handed us and where your role came from.</p>
      <p><strong>It says it has no tools.</strong> Your identity reached the door but matched no
         role. Ask whoever set up Access to add you to a policy.</p>
    </details>

    <details>
      <summary>Ask here instead</summary>
      <p>Posts to <code>/ops/agent</code> with the same role filter. Fine for a quick look; the
         connected path above is the real one.</p>
      ${bindingsLine(bindings, hasKey)}
      <div class="log" id="log"></div>
      <div id="gate"></div>
      <form class="chat" id="chat" method="post" action="/ops/agent">
        <input name="q" id="q" placeholder="Ask about the catalog, orders, stock or the schedule" autocomplete="off">
        <button type="submit">Send</button>
      </form>
    </details>

    <details class="aside" id="for-assistants">
      <summary>For assistants and developers</summary>
      <p>If you are a model reading this page: the text above is the short version. What follows is
         the contract.</p>
      <p><strong>Endpoint.</strong> <code>${esc(mcpUrl)}</code>, MCP over HTTP, behind Cloudflare
         Access. Unauthenticated requests get 401 with a <code>WWW-Authenticate</code> challenge and
         the protected-resource metadata.</p>
      <p><strong>Start by reading the skills.</strong> Call <code>skills_list</code>, then
         <code>skills_read</code> for each one, before calling anything else. They carry the argument
         shapes, the refusal rules and the house conventions that are not inferable from the tool
         schemas${skills.length ? `: ${skills.map((s) => `<code>${esc(s.name)}</code>`).join(", ")}` : ""}.</p>
      <p><strong>Tiers.</strong> T0 reads and returns. T1 proposes — it writes nothing and its output
         is a draft for a human. T2 writes, and does not run when you call it: it parks the intent
         and returns a URL under <code>/approvals/</code> for a person to open. Do not ask the user
         to approve in conversation, and do not treat a parked call as done. T3 tools are absent from
         every role.</p>
      <p><strong>Bound at this role (${esc(b.role || "none")}).</strong>
         ${b.tools.length ? b.tools.map((t) => `<code>${esc(t)}</code>`).join(", ") : "none"}${
           b.hidden ? ` &middot; ${b.hidden} withheld by role.` : "."
         }</p>
      <p><strong>Identity.</strong> The actor and the role come from the Access assertion on every
         request. They are never arguments; a call whose arguments mention either is refused.</p>
    </details>

    <details class="aside">
      <summary>Sample data</summary>
      <p>Seed rows, not live records — the shapes these stores hold, with synthetic values. Ask your
         assistant for the real thing.</p>

      <h3>Customers</h3>
      <p>Opaque ids only. Name, email and phone live in the <code>identity</code> store as ciphertext
         and this surface holds no binding to it, so these records cannot be attributed to a person
         from here.</p>
      <div class="scroll">
        <table>
          <thead><tr><th>Customer id</th><th>Birth year</th><th>Fit</th><th>Segment</th><th>Orders</th><th>Lifetime</th><th>Consent</th></tr></thead>
          <tbody>
${customers
  .map(
    (c) => `        <tr><td>${esc(c.id)}</td><td>${esc(c.birthYear)}</td><td>${esc(c.fit)}</td><td>${esc(c.segment)}</td><td>${esc(c.orders)}</td><td>${esc(money(c.lifetimeMinor, c.currency))}</td><td>${esc(c.consent.join(", ") || "none")}</td></tr>`,
  )
  .join("\n")}
          </tbody>
        </table>
      </div>

      <h3>Week of ${esc(week.starting)}</h3>
      <div class="week">${opsShifts(week)}</div>
      <p>Read-only. Overlapping shifts are refused by a database trigger, not by this view.</p>
    </details>

  </div>
</main>
<script>
/* One delegated listener for every copy button on the page. The button reads
   the <pre> beside it, so a button can never copy something other than the
   text shown above it, and adding a copyable line adds no script. */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const src = b.parentElement.querySelector("pre");
  if (!src) return;
  try {
    await navigator.clipboard.writeText(src.textContent);
    b.textContent = "Copied";
  } catch (err) {
    /* Clipboard is refused without a secure context or a user gesture the
       browser believes in. Select the text so the person can copy it by hand
       rather than leaving a button that silently did nothing. */
    console.error("clipboard write failed", err);
    const r = document.createRange();
    r.selectNodeContents(src);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    b.textContent = "Press copy";
  }
  setTimeout(() => (b.textContent = "Copy"), 2000);
});

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
    OPS_CSS,
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



/*
 * The approval page — the half of the T2 design that was missing.
 *
 * Every T2 tool call over MCP parks its intent and hands the model a link to
 * /approvals/<id>. There was no such route, so every one of those links 404d
 * and NOTHING that writes could ever complete. An agent could draft a product
 * and never create one, which is a product that does not work rather than a
 * feature that is not finished.
 *
 * P0-35: the model never holds authorisation. It holds a LINK. What executes
 * the write is a human's POST from this page, under their own verified Access
 * identity — which is why the button is a form and not a fetch, and why the id
 * alone is not enough to run anything.
 */
export function approvalPage(id, pending, { durable = true } = {}) {
  if (!pending) {
    return page(
      "Nothing to approve",
      `<main class="wrap">
         <h1>Nothing to approve</h1>
         <p>This approval has expired, was already used, or never existed.</p>
         ${
           durable
             ? ""
             : `<p class="warn"><strong>This deployment keeps approvals in memory.</strong>
                 A link minted by one request can be invisible to the next, which looks
                 exactly like an expired link. Ask again and approve promptly, or bind
                 KV so they outlive the isolate that made them.</p>`
         }
         <p><a href="/">Back to ops</a></p>
       </main>`,
      APPROVAL_CSS,
    );
  }

  const args = Object.entries(pending.args ?? {});
  return page(
    `Approve ${esc(pending.tool)}`,
    `<main class="wrap">
       <p class="eyebrow">Approval required</p>
       <h1>${esc(pending.tool)}</h1>
       <p class="who">Proposed by <strong>${esc(pending.actor ?? "unknown")}</strong>
          as <strong>${esc(pending.role ?? "?")}</strong>.</p>

       <h2>What will happen</h2>
       ${
         args.length
           ? `<dl>${args
               .map(
                 ([k, v]) =>
                   `<dt>${esc(k)}</dt><dd><pre>${esc(
                     typeof v === "string" ? v : JSON.stringify(v, null, 2),
                   )}</pre></dd>`,
               )
               .join("")}</dl>`
           : "<p>No arguments.</p>"
       }

       <form method="POST" action="/approvals/${esc(id)}">
         <button type="submit">Approve and run</button>
       </form>
       <p class="fine">Nothing has been written yet. This runs under <em>your</em> identity,
          not the assistant's, and is recorded against your name.</p>
       ${
         durable
           ? ""
           : `<p class="warn">Approvals are held in memory on this deployment — approve promptly.</p>`
       }
     </main>`,
    APPROVAL_CSS,
  );
}

export function approvalResultPage(ok, detail) {
  return page(
    ok ? "Approved" : "Not approved",
    `<main class="wrap">
       <h1>${ok ? "Done" : "Not approved"}</h1>
       <pre>${esc(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2))}</pre>
       <p><a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

const APPROVAL_CSS = `
.wrap{max-width:44rem;margin:0 auto;padding:2rem 1.25rem}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;opacity:.7;margin:0}
h1{margin:.25rem 0 1rem;font-size:1.5rem;word-break:break-word}
h2{font-size:.9rem;text-transform:uppercase;letter-spacing:.06em;opacity:.7;margin-top:2rem}
.who{margin:0 0 1rem}
dl{margin:0}
dt{font-weight:600;margin-top:.75rem}
dd{margin:.25rem 0 0}
pre{white-space:pre-wrap;word-break:break-word;background:rgba(127,127,127,.12);padding:.6rem .7rem;border-radius:.4rem;margin:0;font-size:.85rem}
button{margin-top:1.5rem;padding:.85rem 1.4rem;font-size:1rem;border-radius:.5rem;border:0;background:#111;color:#fff;width:100%;max-width:20rem}
.fine{font-size:.85rem;opacity:.75;margin-top:.75rem}
.warn{font-size:.85rem;border-left:3px solid #c60;padding-left:.75rem;margin-top:1.25rem}
`;
