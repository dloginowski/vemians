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
/* A sentence you say to an assistant is not code. It wraps, and it wears the
   body face — monospace here would make three plain requests look like config. */
.copy.wrap pre {
  overflow-x: visible; white-space: pre-wrap; word-break: break-word;
  font-family: var(--face); font-size: var(--type);
}
/* Top-aligned with the first line of a prompt that wraps to three. */
.copy button {
  flex: 0 0 auto; font: inherit; font-size: var(--eyebrow);
  width: 34px; height: 34px; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--rule); background: var(--ground); color: var(--ink);
}
.copy button:hover { border-color: var(--ink); }
/* The confirmation replaces the icon in place — same box, same width, so the
   line beside it does not move when someone taps. */
.copy button[data-state] svg { display: none; }
.copy button[data-state="ok"]::after { content: "\\2713"; }
.copy button[data-state="manual"]::after { content: "\\2715"; }

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
const CLIPBOARD = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">` +
  `<rect x="4.5" y="2.5" width="7" height="2.5" rx="0.6" fill="none" stroke="currentColor"/>` +
  `<path d="M4.5 3.75H3.5v9.75h9V3.75h-1" fill="none" stroke="currentColor"/></svg>`;

/* The behaviour half of copyLine, as a string, so the front page and the
   identity page share one implementation rather than two that drift. */
export const COPY_JS = `/* One delegated listener for every copy button on the page. The button reads
   the <pre> beside it, so a button can never copy something other than the
   text shown above it, and adding a copyable line adds no script. */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const src = b.parentElement.querySelector("pre");
  if (!src) return;
  try {
    await navigator.clipboard.writeText(src.textContent);
    b.dataset.state = "ok";
    b.title = "Copied";
  } catch (err) {
    /* Clipboard is refused without a secure context or a user gesture the
       browser believes in. Select the text so the person can copy it by hand
       rather than leaving a button that silently did nothing — and say so,
       rather than showing a tick for something that did not happen. */
    console.error("clipboard write failed", err);
    const r = document.createRange();
    r.selectNodeContents(src);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    b.dataset.state = "manual";
    b.title = "Selected — copy it yourself";
  }
  setTimeout(() => {
    delete b.dataset.state;
    b.title = "Copy";
  }, 2000);
});
`;

export function copyLine(text, { wrap = false } = {}) {
  /* The button says nothing. Its label is a clipboard and an aria-label, so it
     stays a tap target rather than a word competing with the line it copies —
     and the confirmation is a state on the same button, not a layout shift. */
  return `<div class="copy${wrap ? " wrap" : ""}"><pre>${esc(text)}</pre>` +
    `<button type="button" data-copy aria-label="Copy" title="Copy">${CLIPBOARD}</button></div>`;
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
    <p class="hint">Paste this into your Claude or ChatGPT to get started.</p>
    ${copyLine(mcpUrl)}
    <p class="hint">Then say this, so it learns how we do things.</p>
    ${copyLine("Read the vemians skills, then tell me what you can do here.", { wrap: true })}
    ${copyLine("Find every black boot in the catalog and show me what is out of stock.", { wrap: true })}
    ${copyLine("Here is a photo. Draft a product from it: brand, name, description, price.", { wrap: true })}
  </section>

  <div class="acc">

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
      <p>Jobs are set when someone is given access, and read from your sign-in. Nothing on this
         page can change one, and neither can any assistant you connect &mdash; not even yours.</p>
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
      <p>You are talking to your own assistant. It is talking to the shop.</p>
      <ul>
        <li><strong>You sign in with your Vemians email.</strong> No second password. If you can
            read this page, you are already signed in.</li>
        <li><strong>Ask it to read the rules first.</strong> That is the line in step two above. It
            is a short manual on how we do things here, and your assistant is much better once it
            has read it.</li>
        <li><strong>Looking things up is instant.</strong> What is in stock, what something costs,
            what sold last week. Just ask.</li>
        <li><strong>Changing things stops and waits for you.</strong> Ask it to add a product or set
            a price and it does not just do it. It sends you a link. You open the link, read what is
            about to happen, and press a button. Nothing changes until you press it.</li>
        <li><strong>Everything is filed under your name</strong>, not the assistant's.</li>
        <li><strong>You only get the parts of the shop your job needs.</strong> Anything else is
            simply not there for you, so you cannot break it by accident.</li>
      </ul>
    </details>

    <details>
      <summary>Something is not working</summary>
      <p><strong>Your assistant asks you to sign in and nothing happens.</strong> Open this page
         first in the same browser, sign in here, then try connecting again.</p>
      <p><strong>It says it cannot do anything, or you see "role: none" at the top of this
         page.</strong> Sign out and sign back in &mdash; that usually fixes it, because your
         browser can be holding an old sign-in from before you were added.
         <a href="/cdn-cgi/access/logout">Sign out now</a>, then come back here.</p>
      <p><strong>Still stuck?</strong> Open <a href="/whoami">the check-me page</a>. It says in
         plain words what is wrong, and gives you something to send on.</p>
      <p><strong>Wrong email.</strong> Sign out, and pick your Vemians address when the Google
         chooser appears.</p>
    </details>

    <details class="aside" id="for-assistants">
      <summary>For assistants and developers</summary>
      <p>If you are a model reading this page: the text above is the short version. What follows is
         the contract.</p>
      <p><strong>Endpoint.</strong> <code>${esc(mcpUrl)}</code>, MCP over HTTP, behind Cloudflare
         Access. Unauthenticated requests get 401 with a <code>WWW-Authenticate</code> challenge and
         the protected-resource metadata.</p>
      <p><strong>Claude Code.</strong> One line, once per machine:</p>
      ${copyLine(`claude mcp add --transport http vemians ${mcpUrl}`)}
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
      <summary>Ask here instead</summary>
      <p>A box for a quick question without connecting anything. Your own assistant, set up at the
         top of this page, is the one worth using.</p>
      ${bindingsLine(bindings, hasKey)}
      <div class="log" id="log"></div>
      <div id="gate"></div>
      <form class="chat" id="chat" method="post" action="/ops/agent">
        <input name="q" id="q" placeholder="Ask about the catalog, orders, stock or the schedule" autocomplete="off">
        <button type="submit">Send</button>
      </form>
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
${COPY_JS}

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

/*
 * /whoami, for a person.
 *
 * The endpoint answered JSON, which is the right answer for a tool and the
 * wrong one for the shopkeeper who has been told to open it: "role": null is a
 * fact, not an explanation, and nobody reading it learns that signing out and
 * back in is what fixes it. So a browser gets this page and everything else
 * still gets the JSON.
 *
 * It says the one thing that is true and useful in each case, and hands over a
 * copyable block for the case where it is neither.
 */
export function whoamiPage(detail) {
  const ok = Boolean(detail.role);
  const source =
    detail.role_from === "policy"
      ? "the rule that let you in"
      : detail.role_from === "group"
        ? "your group"
        : detail.role_from || "nothing yet";

  /* The whole answer, for sending on when the page cannot resolve it. Pretty
     printed, because it is going into a message to a person. */
  const dump = JSON.stringify(detail, null, 2);

  const verdict = ok
    ? `<p class="lead">You are set up. Your assistant can use everything an
         <strong>${esc(detail.role)}</strong> is allowed to use.</p>
       <p><a href="/">Back to the start page</a></p>`
    : `<p class="lead">You are signed in, but you have not been given a job here yet, so your
         assistant cannot do anything useful.</p>
       <h2>Try this first</h2>
       <p>Sign out and sign back in. Your browser can hold on to an old sign-in from before you
          were added, and that old sign-in is what this page is reading.</p>
       ${copyLine("Sign out, then open ops.vemians.com again", { wrap: true })}
       <p><a class="signout" href="/cdn-cgi/access/logout">Sign out now</a></p>
       <h2>If that did not work</h2>
       <p>Send this to whoever set up access for you. It is everything they need and none of it
          is secret.</p>`;

  return page(
    "Who you are",
    `<div class="bar">ops.vemians.com &middot; employees only</div>
<main class="ops">
  <p class="eyebrow">check me</p>
  <h1>${ok ? "You are good to go" : "Not quite set up yet"}</h1>

  <table class="me">
    <tbody>
      <tr><th scope="row">Signed in as</th><td>${esc(detail.email ?? "unknown")}</td></tr>
      <tr><th scope="row">Your job here</th><td>${esc(detail.role ?? "none yet")}</td></tr>
      <tr><th scope="row">Set by</th><td>${esc(source)}</td></tr>
      <tr><th scope="row">Sign-in checked</th><td>${detail.verified ? "yes" : "no"}</td></tr>
    </tbody>
  </table>

  ${verdict}

  ${ok ? "" : copyLine(dump, { wrap: true })}

  <details class="aside">
    <summary>The full detail</summary>
    ${ok ? copyLine(dump, { wrap: true }) : ""}
    <p>Same thing as JSON, for anything that is not a person:
       add <code>?format=json</code> to this address.</p>
  </details>
</main>
<script>
${COPY_JS}
</script>`,
    OPS_CSS + WHOAMI_CSS,
  );
}

const WHOAMI_CSS = `
h1 { font-size: var(--type); font-weight: 700; margin: 4px 0 16px; }
h2 { font-size: var(--type); font-weight: 700; margin: 24px 0 8px; }
.lead { margin: 0 0 16px; max-width: 34rem; }
.me { border-collapse: collapse; width: 100%; max-width: 34rem; margin-bottom: 20px; }
.me th, .me td { text-align: left; padding: 8px 16px 8px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
.me th { font-weight: 400; color: #666; font-size: var(--eyebrow); width: 40%; }
.signout { display: inline-block; border: 1px solid var(--ink); padding: 10px 20px; text-decoration: none; color: var(--ink); margin-top: 4px; }
`;

export function refusalPage(status, reason) {
  return page(
    "Refused",
    `<div class="bar">ops.vemians.com</div>
<main class="ops">
  <h2>${status} &mdash; refused</h2>
  <p>${esc(reason)}</p>
  <p class="note">This page is for Vemians staff and asks you to sign in first. If you are staff and
     landed here, sign in with your Vemians email and try again.</p>
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
/* Plain words for a non-technical coworker, not the tool's own dotted name.
   Falls back to the raw name for anything not listed rather than guessing at
   one — an unlabeled tool is rare enough that it should look unfamiliar, not
   be papered over with a wrong-sounding guess. */
const PLAIN_ACTION = Object.freeze({
  "catalog.create_product": "Add a new product",
  "catalog.update_product": "Change a product",
  "catalog.create_category": "Add a new category",
});

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
  const label = PLAIN_ACTION[pending.tool] ?? pending.tool;
  return page(
    `Approve ${esc(pending.tool)}`,
    `<main class="wrap">
       <p class="eyebrow">Someone is asking you to say yes</p>
       <h1>${esc(label)}</h1>
       <p class="who">Asked by <strong>${esc(pending.actor ?? "unknown")}</strong>.</p>

       ${
         pending.summary
           ? `<p class="summary"><strong>In short:</strong> ${esc(pending.summary)}</p>`
           : ""
       }

       <details${pending.summary ? "" : " open"}>
         <summary>Full details (${esc(pending.tool)})</summary>
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
       </details>

       <form method="POST" action="/approvals/${esc(id)}">
         <button type="submit">Yes, do this</button>
       </form>
       <p><a href="/">No, do nothing</a></p>
       <p class="fine">Nothing has been written yet. Clicking "Yes" does it as <em>you</em>,
          not the assistant, and saves your name with it.</p>
       ${
         durable
           ? ""
           : `<p class="warn">This link can go stale fast on this setup — click "Yes" soon after opening it.</p>`
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
