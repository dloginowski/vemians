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
 * This surface is read by two kinds of visitor and it has to serve both from
 * one document.
 *
 *   A PERSON arrives having been told "you have access now" and needs to know,
 *   in under a minute: who they are signed in as, what their role lets them do,
 *   and the one command that connects their own assistant. That is the visible
 *   page — hero, three steps, a roster, a short explanation.
 *
 *   AN ASSISTANT arrives because someone pasted the URL into it. It needs the
 *   endpoint, the skill URIs, the tool names bound to this role and the tier
 *   rules. That is `<details>` at the foot: present in the DOM, so anything
 *   that fetches the page reads it, and folded away so a person does not have
 *   to scroll past it.
 *
 * Nothing here is a second design system. The tokens are theme.css; the rules
 * below are layout only, integer px, no new colour and no new type size.
 */
const OPS_CSS = `
.lede { padding: 32px 0 8px; }
.lede h1 { font-size: var(--heading); font-weight: 700; margin: 4px 0 12px; }
.lede p { margin: 0; max-width: 34rem; }
.eyebrow { font-size: var(--eyebrow); text-transform: lowercase; }

.step { border-top: 1px solid var(--rule); padding-top: 16px; margin-top: 28px; }
.step h2 { margin: 0 0 8px; }
.step p { margin: 0 0 12px; max-width: 34rem; }
.num { font-size: var(--eyebrow); }

/* One copyable line. The <pre> scrolls rather than wrapping, so a long command
   never reflows the page on a phone; the button is full width under it below
   480px because a 44px target beside a scrolling box leaves neither room. */
.copy { display: flex; gap: 8px; align-items: stretch; margin: 0 0 12px; }
.copy.wrap pre { overflow-x: visible; white-space: pre-wrap; word-break: break-word; }
.copy pre {
  flex: 1 1 auto; min-width: 0; margin: 0; overflow-x: auto;
  background: var(--image-ground); padding: 12px; font-size: var(--eyebrow);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.copy button {
  flex: 0 0 auto; font: inherit; font-size: var(--eyebrow);
  padding: 0 14px; min-height: 44px; cursor: pointer;
  border: 1px solid var(--ink); background: var(--ground); color: var(--ink);
}
@media (max-width: 480px) {
  .copy { flex-wrap: wrap; }
  .copy button { width: 100%; }
}

.scroll { overflow-x: auto; }
.tag { font-size: var(--eyebrow); }
.you td { font-weight: 700; }

details { border-top: 1px solid var(--rule); margin-top: 28px; padding-top: 12px; }
details summary { cursor: pointer; font-size: var(--type); font-weight: 700; }
details > *:not(summary) { margin-top: 12px; }
details .note { max-width: 34rem; }

.bind { background: var(--image-ground); padding: 10px 12px; font-size: var(--eyebrow); margin-top: 12px; }
.log .tool { color: #666; font-size: var(--eyebrow); }
.gate { border: 1px solid var(--ink); padding: 12px; margin: 12px 0; }
.gate h3 { font-size: var(--type); font-weight: 700; margin: 0 0 8px; }
.gate dl { margin: 0; font-size: var(--eyebrow); }
.gate dt { font-weight: 700; margin-top: 8px; }
.gate dd { margin: 0; white-space: pre-wrap; word-break: break-word; }
.gate .row { display: flex; gap: 8px; }
.gate button[disabled] { color: #666; border-color: var(--rule); cursor: default; }

/* The seven-day grid is unreadable under about 640px — two columns there, one
   per day, in the same order. Nothing is hidden, the wrap point is the width. */
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
  const banner = identity.verified
    ? `<div class="who">Signed in via Cloudflare Access as <strong>${esc(identity.email)}</strong> &middot; role <strong>${esc(role || "none")}</strong> &middot; assertion signature verified against the team JWKS.</div>`
    : `<div class="warn">Assertion accepted <strong>without signature verification</strong> — ACCESS_TEAM_DOMAIN and ACCESS_AUD are unset, so this is prototype mode. Set both in wrangler.toml before this is reachable from the internet. Claimed identity: <strong>${esc(identity.email)}</strong> &middot; role <strong>${esc(role || "none")}</strong>.</div>`;

  const b = bindings || { role, tools: [], stores: [], hidden: 0 };

  return page(
    "Vemians ops",
    `<div class="bar">ops.vemians.com &middot; employees only</div>
${banner}
<main class="ops">

  <section class="lede">
    <p class="eyebrow">vemians ops</p>
    <h1>Bring your own assistant.</h1>
    <p>This page is a doorway, not an app. Connect your own Claude or ChatGPT to it and
       it picks up the house rules and the tools your role is allowed to use. Then you
       talk to your assistant, not to us.</p>
  </section>

  <section class="step">
    <p class="num">Step 1</p>
    <h2>Connect it</h2>
    <p>Paste this into Claude Code, in a terminal. One line, once per machine.</p>
    ${copyLine(`claude mcp add --transport http vemians ${mcpUrl}`)}
    <details>
      <summary>Using something else?</summary>
      <p class="note">Claude Desktop, ChatGPT and anything else that speaks MCP over HTTP want
         the bare address. Add it as a custom connector:</p>
      ${copyLine(mcpUrl)}
      <p class="note">You will be asked to sign in with the same account you used to open this
         page. If your assistant reports 401, that sign-in did not finish.</p>
    </details>
  </section>

  <section class="step">
    <p class="num">Step 2</p>
    <h2>Tell it to read the rules</h2>
    <p>Everything it needs to know is published as skills. Ask for them first and it will
       stop guessing at how this place works.</p>
    ${copyLine("Read the vemians skills, then tell me what you can do here.", { wrap: true })}
    <p class="note">${skills.length} skill${skills.length === 1 ? "" : "s"} are readable at your role.</p>
  </section>

  <section class="step">
    <p class="num">Step 3</p>
    <h2>Ask for something</h2>
    <p>Plain sentences. It picks the tool.</p>
    ${copyLine("Find every black boot in the catalog and show me what is out of stock.", { wrap: true })}
    ${copyLine("Here is a photo. Draft a product from it: brand, name, description, price.", { wrap: true })}
    ${copyLine("Now create it.", { wrap: true })}
    <p class="note">That last one writes. It will not just happen: your assistant hands you a
       link, you open it, you read what is about to be written, and you press the button.
       The write runs under your name, never the assistant's.</p>
  </section>

  <section class="step">
    <h2>Who has what</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Person</th><th>Role</th><th>Granted by</th><th>Status</th></tr></thead>
        <tbody>
${rosterRows(roster, identity, role, roleVia)}
        </tbody>
      </table>
    </div>
    ${rosterNote ? `<p class="note">${esc(rosterNote)}</p>` : ""}
    <p class="note">Roles are granted in Cloudflare Access and read from your sign-in. This page
       cannot change one, and neither can any assistant connected to it &mdash; the employee
       area holds no key that could.</p>

    <div class="scroll">
      <table>
        <thead><tr><th>Role</th><th>Tools</th><th>Can reach</th></tr></thead>
        <tbody>
${perRole
  .map(
    (r) =>
      `      <tr${r.role === role ? ' class="you"' : ""}><td>${esc(r.role)}</td><td>${r.tools.length}</td><td>${esc(r.stores.join(", ") || "nothing")}</td></tr>`,
  )
  .join("\n")}
        </tbody>
      </table>
    </div>
  </section>

  <section class="step">
    <h2>How this actually works</h2>
    <p>Four sentences, then you know as much as anyone.</p>
    <ul>
      <li>Cloudflare Access checks who you are before this page or the endpoint answers at all.</li>
      <li>Your role decides which tools exist. A tool your role may not use is not offered
          to the assistant, so it cannot try it and cannot tell you it was refused.</li>
      <li>Reads happen immediately. Writes stop and wait for a human to press a button.</li>
      <li>Every call is recorded against the person who made it, not against the assistant.</li>
    </ul>
    <p class="note">Signed in as the wrong account? <a href="/whoami">/whoami</a> says exactly what
       the sign-in handed us and where your role came from.</p>
  </section>

  <details id="for-assistants">
    <summary>For assistants and developers</summary>
    <p class="note">If you are a model reading this page: the human-facing text above is the
       short version. What follows is the contract.</p>
    <p class="note"><strong>Endpoint.</strong> <code>${esc(mcpUrl)}</code>, MCP over HTTP,
       behind Cloudflare Access. Unauthenticated requests get 401 with a
       <code>WWW-Authenticate</code> challenge and the protected-resource metadata.</p>
    <p class="note"><strong>Start by reading the skills.</strong> Call <code>skills_list</code>,
       then <code>skills_read</code> for each one, before calling anything else. They carry the
       argument shapes, the refusal rules and the house conventions that are not inferable from
       the tool schemas${skills.length ? `: ${skills.map((s) => `<code>${esc(s.name)}</code>`).join(", ")}` : ""}.</p>
    <p class="note"><strong>Tiers.</strong> T0 reads and returns. T1 proposes &mdash; it writes
       nothing and its output is a draft for a human. T2 writes, and does not run when you call
       it: it parks the intent and returns a URL under <code>/approvals/</code> for a person to
       open. Do not ask the user to approve in conversation, and do not treat a parked call as
       done. T3 tools are absent from every role.</p>
    <p class="note"><strong>Bound at this role (${esc(b.role || "none")}).</strong>
       ${b.tools.length ? b.tools.map((t) => `<code>${esc(t)}</code>`).join(", ") : "none"}${
         b.hidden ? ` &middot; ${b.hidden} withheld by role.` : "."
       }</p>
    <p class="note"><strong>Identity.</strong> The actor and the role come from the Access
       assertion on every request. They are never arguments; a call whose arguments mention
       either is refused.</p>
  </details>

  <details>
    <summary>Or ask here instead</summary>
    <p class="note">Posts to <code>/ops/agent</code> with the same role filter. Useful for a quick
       look without connecting anything; the connected path above is the real one.</p>
    ${bindingsLine(bindings, hasKey)}
    <div class="log" id="log"></div>
    <div id="gate"></div>
    <form class="chat" id="chat" method="post" action="/ops/agent">
      <input name="q" id="q" placeholder="Ask about the catalog, orders, stock or the schedule" autocomplete="off">
      <button type="submit">Send</button>
    </form>
  </details>

  <details>
    <summary>Sample data</summary>
    <p class="note">Seed rows, not live records &mdash; the shapes these stores hold, with
       synthetic values. Ask your assistant for the real thing.</p>

    <h2>Customers</h2>
    <p class="note">Opaque ids only. Name, email and phone live in the <code>identity</code> store
       as ciphertext and this surface holds no binding to it, so these records cannot be
       attributed to a person from here.</p>
    <div class="scroll">
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
    </div>

    <h2>Week of ${esc(week.starting)}</h2>
    <div class="week">${opsShifts(week)}</div>
    <p class="note">Read-only. Overlapping shifts are refused by a database trigger, not by
       this view.</p>
  </details>

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
