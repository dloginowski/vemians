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
import { CAPS } from "./tools/caps.js";
import { editableFieldsFor } from "./approval-forms.js";
import { firstNameFrom } from "./access.js";

/*
 * ---- the front page -------------------------------------------------------
 *
 * One screen. A phone should show the whole thing without scrolling. In order:
 * a greeting by first name, the built-in assistant — open, typing, no setup,
 * the first thing anyone can actually use (Test-PRD-P0-74-chat_first) — then
 * the same three one-click tasks P0-69 put on the page directly, then
 * everything else folded under "More Options".
 *
 * EVERYTHING PAST THAT IS A CLOSED ROW. Short label, no preamble, opened by
 * the few people who want it: the roster, the tier rules, the machine-readable
 * contract for a developer, the seed data. Out of sight, not out of mind.
 * Nothing is removed and nothing is a second page.
 *
 * An assistant that fetches this URL still reads all of it — `<details>` folds
 * are in the DOM whether or not a person opened them — so the compaction costs
 * the machine reader nothing.
 *
 * Nothing here is a second design system beyond the dark reskin two blocks
 * down (Test-PRD-P0-75-ops_dark_theme) — layout stays integer px, and no new
 * type size was added for it.
 */
/*
 * ---- the dark reskin --------------------------------------------------
 *
 * ops.vemians.com only. Prepended to both OPS_CSS and APPROVAL_CSS (never to
 * shared/design/theme.css, which the storefront also loads) so the shop keeps
 * its own light, warm-cream palette untouched — this is a second `:root`
 * block in the SAME <style> tag, and a later declaration of a variable
 * theme.css already named simply wins the cascade.
 *
 * THE COLOURS ARE AN INTERPRETATION, NOT A LOGO FILE. Nobody handed this
 * codebase Anthropic's brand kit, so "near-black ground, warm off-white ink,
 * one clay-orange accent" is a reasonable reading of the asked-for look, not
 * a value lifted from an official source — said out loud the way this
 * repository already marks a placeholder or an inferred design choice
 * (compare shared/view/enhance.client.js's own INFERRED markers).
 *
 * Two variables theme.css never had: --muted (the `#666` this file used to
 * hardcode seven times for secondary text) and --accent (the one warm colour
 * a mostly-monochrome dark screen gets, spent on the controls that actually
 * do something — a button, a link, a focus ring — never on a whole section).
 */
const OPS_DARK_CSS = `
:root {
  --ground:       #191817;
  --image-ground: #242220;
  --ink:          #F1EEE6;
  --bar:          #000000;
  --rule:         #3A3733;
  --muted:        #9C978C;
  --accent:       #D97757;
}

a { color: var(--accent); }
a:hover { opacity: 0.82; }
`;

const OPS_CSS = `
${OPS_DARK_CSS}
.ops { max-width: 34rem; padding: 12px 16px 32px; }

.id { font-size: var(--eyebrow); margin: 0 0 16px; color: var(--muted); }
.ops .warn { margin: 0 0 14px; }
.id strong { color: var(--ink); }

.key h1 { font-size: var(--type); font-weight: 700; margin: 0 0 4px; }
.hint { font-size: var(--eyebrow); color: var(--muted); margin: 0 0 8px; }
.hint a { color: var(--accent); }

/* The widget itself reads as one contained thing — a border around the
   whole assistant, not just around the log inside it — so it does not look
   like loose page furniture next to the chips below it. */
.chat-top {
  border: 1px solid var(--rule); border-radius: 12px;
  padding: 12px; margin-bottom: 16px;
}
.chat-top h1 { margin-bottom: 8px; }

.greet { margin: 0 0 12px; }
.greet h1 { font-size: var(--type); font-weight: 700; margin: 0 0 4px; }

.menu { margin: 0 0 20px; }
.menu h1 { font-size: var(--type); font-weight: 700; margin: 0 0 4px; }
/* Small chips, not CTAs — three routine tasks and a fold, not the thing on
   the page asking to be pressed hardest. The chat above is that thing now. */
.choices { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.choices .btn {
  display: inline-block; font: inherit; font-size: 13px; line-height: 1.2;
  padding: 5px 10px; border: 1px solid var(--accent); border-radius: 999px;
  background: transparent; color: var(--accent); text-decoration: none; font-weight: 400;
}
.choices .btn:hover { background: var(--accent); color: var(--ground); }

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
/* Top-aligned with the first line of a prompt that wraps to three. Round,
   like every other icon-only control on this surface now (the composer's
   attach and send buttons) — one shape for "this button is an icon", not a
   square one here and a circle there. */
.copy button {
  flex: 0 0 auto; font: inherit; font-size: var(--eyebrow);
  width: 34px; height: 34px; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--rule); border-radius: 50%; background: var(--ground); color: var(--ink);
}
.copy button:hover { border-color: var(--accent); color: var(--accent); }
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
.acc > details.aside > summary { font-size: var(--eyebrow); color: var(--muted); padding: 8px 0; }

.scroll { overflow-x: auto; }
.you td { font-weight: 700; }

/* A footnote, not a control — no background, no border-radius, nothing that
   reads as a boxed UI element sitting right above the input that actually is
   one. Plain small text is what makes it read as metadata. */
.bind { font-size: 11px; color: var(--muted); margin: 0 0 10px; }
.bind code { color: var(--muted); }

/*
 * A real chat widget, not a growing list of paragraphs: a fixed-height,
 * scrolling column of bubbles — same shape as the genre this was asked to
 * match (Telegram). MINE align right in the one accent colour on the page;
 * the agent's align left, quiet and bordered; a TOOL step is neither — it is
 * a system aside (Telegram's own "so-and-so joined"), centred, small, never
 * competing with either side of the conversation. Empty at rest, so the
 * widget does not show a blank grey box before the first message — it grows
 * into place instead.
 */
.log {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 320px; overflow-y: auto;
  margin: 8px 0; padding: 4px 2px;
}
.log:empty { display: none; }
.log p {
  margin: 0; padding: 8px 12px; border-radius: 14px;
  max-width: 82%; font-size: 14px; line-height: 1.4;
  white-space: pre-wrap; word-break: break-word;
}
.log p.you {
  align-self: flex-end; background: var(--accent); color: var(--ground);
  border-bottom-right-radius: 4px;
}
.log p.agent {
  align-self: flex-start; background: var(--image-ground); color: var(--ink);
  border-bottom-left-radius: 4px;
}
.log p.tool {
  align-self: center; max-width: 100%; background: transparent;
  color: var(--muted); font-size: 12px; padding: 2px 8px; text-align: center;
}
.gate { border: 1px solid var(--ink); padding: 12px; margin: 12px 0; border-radius: 10px; }
.gate h3 { margin: 0 0 8px; }
.gate dl { margin: 0; }
.gate dt { font-weight: 700; margin-top: 8px; }
.gate dd { margin: 0; white-space: pre-wrap; word-break: break-word; }
.gate .row { display: flex; gap: 8px; }
.gate button[disabled] { color: var(--muted); border-color: var(--rule); cursor: default; }
/*
 * The composer bar — one rounded pill holding both attach icons, the input
 * and Send, the same shape a phone chat app's own composer takes: round
 * icon buttons on the left, borderless input filling the middle, a filled
 * circular Send on the right. Everything inside shares the bar's own
 * background rather than drawing a second box around itself.
 *
 * Every rule below is scoped ".chat .chat-bar ..." (or by id, for the input),
 * on purpose: shared/design/theme.css already carries ".chat input" and
 * ".chat button" at specificity (0,1,1), and this form still carries
 * class="chat" for the approval gate's own buttons further down to inherit
 * from — so anything here weaker than that would be silently overridden by
 * the shared rule rather than replacing it the way it reads on screen.
 */
.chat .chat-bar {
  display: flex; align-items: center; gap: 2px;
  border: 1px solid var(--rule); border-radius: 24px;
  padding: 4px 4px 4px 6px; background: var(--image-ground);
}
.chat .chat-bar:focus-within { border-color: var(--accent); }
#q {
  flex: 1 1 auto; min-width: 0; border: none; background: transparent;
  padding: 8px 4px; font: inherit; font-size: 14px; color: var(--ink);
}
#q:focus { outline: none; }
.chat .chat-bar button {
  flex: 0 0 auto; margin: 0; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%;
}
.chat .chat-bar .icon-btn { width: 32px; height: 32px; background: transparent; color: var(--muted); }
.chat .chat-bar .icon-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--ink); }
.chat .chat-bar .icon-btn[aria-pressed="true"] { color: var(--accent); background: rgba(217, 119, 87, 0.14); }
.chat .chat-bar .send-btn { width: 34px; height: 34px; background: var(--accent); color: var(--ground); }
.chat .chat-bar .send-btn:hover { opacity: 0.85; }
.chat .chat-bar .send-btn:disabled { opacity: 0.4; cursor: default; }
.attach-name {
  display: block; font-size: 12px; color: var(--muted); margin: 4px 2px 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

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

/* The two attachment icons beside the chat input — same stroke-only style as
   CLIPBOARD above, so a hand-drawn glyph does not read as a different design
   system from the one copy control already on the page. */
const CAMERA_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<path d="M2 5.5h2.2l0.8-1.3h6l0.8 1.3H14v7.5H2z" fill="none" stroke="currentColor"/>` +
  `<circle cx="8" cy="9" r="2.4" fill="none" stroke="currentColor"/></svg>`;
const PAPERCLIP_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<path d="M10.5 3.5 4.8 9.2a2.4 2.4 0 0 0 3.4 3.4l5.3-5.3a1.6 1.6 0 0 0-2.3-2.3L6.2 10a0.8 0.8 0 0 0 1.1 1.1l4.3-4.3" ` +
  `fill="none" stroke="currentColor" stroke-linecap="round"/></svg>`;
const SEND_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<path d="M8 12.5V3.5M8 3.5 3.5 8M8 3.5 12.5 8" fill="none" stroke="currentColor" stroke-width="1.4" ` +
  `stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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

  const firstName = firstNameFrom(identity.claims, identity.email);

  return page(
    "Vemians ops",
    `<div class="bar">ops.vemians.com &middot; employees only</div>
<main class="ops">
${id}

  <section class="greet">
    <h1>Hi ${esc(firstName)} — what would you like to do?</h1>
  </section>

  <section class="key chat-top">
    <h1>Ask the ops assistant</h1>
    ${bindingsLine(bindings, hasKey)}
    <div class="log" id="log"></div>
    <div id="gate"></div>
    <form class="chat" id="chat" method="post" action="/ops/agent">
      <div class="chat-bar">
        <button type="button" class="icon-btn" id="attach-photo-btn" aria-label="Attach a photo" title="Attach a photo">${CAMERA_ICON}</button>
        <button type="button" class="icon-btn" id="attach-file-btn" aria-label="Attach a file" title="Attach a file">${PAPERCLIP_ICON}</button>
        <input name="q" id="q" placeholder='e.g. "Add a wool coat, $450, Outerwear"' autocomplete="off">
        <button type="submit" class="send-btn" aria-label="Send" title="Send">${SEND_ICON}</button>
      </div>
      <span class="attach-name" id="attach-name" aria-live="polite"></span>
      <input type="file" id="attach-photo" accept="image/*" hidden>
      <input type="file" id="attach-file" hidden>
    </form>
  </section>

  <section class="menu">
    <h1>Or, one click</h1>
    <div class="choices">
      <a class="btn" href="/products/batch">Add Merchandise</a>
      <a class="btn" href="/customers/batch">Add Customers</a>
      <a class="btn" href="/expenses/new">Submit Expenses</a>
      <a class="btn" href="#more-options">More Options</a>
    </div>
  </section>

  <div id="more-options">

  <section class="key">
    <h1>Connect your own Claude or ChatGPT instead</h1>
    <p class="hint">For someone who prefers their own assistant, or wants to hand it a photo straight from
       their device. Paste this into it to get started.</p>
    ${copyLine(mcpUrl)}
    <p class="hint">Then say this, so it learns how we do things.</p>
    ${copyLine("Read the vemians skills, then tell me what you can do here.", { wrap: true })}
    ${copyLine("Find every black boot in the catalog and show me what is out of stock.", { wrap: true })}
    ${copyLine("Here is a photo. Draft a product from it: brand, name, description, price.", { wrap: true })}
  </section>

  </div>

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
      <p><strong>Claude Code.</strong> Working from a clone of the <code>vemians</code> repo, the
         server is already registered in the checked-in <code>.mcp.json</code> at its root — the
         first session in that clone shows a one-time pending-approval prompt (run
         <code>claude</code>, or <code>/mcp</code> inside a session, to approve it), then every
         later session there connects on its own. From anywhere else, one line, once per machine:</p>
      ${copyLine(`claude mcp add --transport http vemians ${mcpUrl}`)}
      <p><strong>A remote or headless Claude Code session cannot finish the sign-in itself.</strong>
         The first connection needs an interactive browser to complete Cloudflare Access, so a
         cloud or CI session sees the server listed but unauthenticated until a person approves it
         from an interactive one, or the session is given a pre-issued token.</p>
      <p><strong>Start by reading the skills.</strong> Call <code>skills_list</code>, then
         <code>skills_read</code> for each one, before calling anything else. They carry the argument
         shapes, the refusal rules and the house conventions that are not inferable from the tool
         schemas${skills.length ? `: ${skills.map((s) => `<code>${esc(s.name)}</code>`).join(", ")}` : ""}.
         <strong>This is also where the greeting comes from</strong> — <code>agent-tool-contract</code>
         spells out the "greet by name, offer a short menu" opening, because the server's own
         connect-time <code>instructions</code> are not reliably shown to the model on every
         client: read the skill and every client behaves the same way; wait on <code>instructions</code>
         alone and some clients (Claude.ai and ChatGPT's own web connectors, at least) never show it at all.</p>
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
${COPY_JS}

const log = document.getElementById("log");
const gate = document.getElementById("gate");

/* One builder for every bubble. kind is "" (you), "agent" or "tool" — "you"
   gets an explicit class too (not left bare), since the bubble styling reads
   it the same way the other two do. */
function entry(kind, text) {
  const p = document.createElement("p");
  p.className = kind || "you";
  p.textContent = text;
  log.appendChild(p);
  log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
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

/* ---- attachments ---------------------------------------------------------
 * One row, two icons, one file at a time. Choosing a photo clears anything
 * already chosen through the file icon and vice versa — the agent gets sent
 * exactly one attachment, never a stale second one nobody meant to include.
 * Neither input is required: a photo with no typed text is a normal message,
 * "figure out what to do with it" being exactly the point of handing it to
 * the agent instead of a purpose-built upload form.
 */
const photoInput = document.getElementById("attach-photo");
const fileInput = document.getElementById("attach-file");
const attachName = document.getElementById("attach-name");
const photoBtn = document.getElementById("attach-photo-btn");
const fileBtn = document.getElementById("attach-file-btn");

function clearAttachments() {
  photoInput.value = "";
  fileInput.value = "";
  attachName.textContent = "";
  photoBtn.removeAttribute("aria-pressed");
  fileBtn.removeAttribute("aria-pressed");
}

function pickedFile() {
  return photoInput.files[0] || fileInput.files[0] || null;
}

photoBtn.addEventListener("click", () => photoInput.click());
fileBtn.addEventListener("click", () => fileInput.click());

photoInput.addEventListener("change", () => {
  if (!photoInput.files[0]) return;
  fileInput.value = "";
  attachName.textContent = photoInput.files[0].name;
  photoBtn.setAttribute("aria-pressed", "true");
  fileBtn.removeAttribute("aria-pressed");
});
fileInput.addEventListener("change", () => {
  if (!fileInput.files[0]) return;
  photoInput.value = "";
  attachName.textContent = fileInput.files[0].name;
  fileBtn.setAttribute("aria-pressed", "true");
  photoBtn.removeAttribute("aria-pressed");
});

document.getElementById("chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = document.getElementById("q");
  const q = box.value.trim();
  const file = pickedFile();
  if (!q && !file) return;
  gate.textContent = "";
  entry("", q || ("(attached " + file.name + ")"));
  box.value = "";
  clearAttachments();
  try {
    let res;
    if (file) {
      const form = new FormData();
      form.set("q", q);
      form.set("file", file);
      res = await fetch("/ops/agent", { method: "POST", body: form });
    } else {
      res = await fetch("/ops/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q }),
      });
    }
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
.me th { font-weight: 400; color: var(--muted); font-size: var(--eyebrow); width: 40%; }
.signout { display: inline-block; border: 1px solid var(--accent); background: var(--accent); font-weight: 700; padding: 10px 20px; text-decoration: none; color: var(--ground); margin-top: 4px; }
.signout:hover { background: transparent; color: var(--accent); }
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
    OPS_DARK_CSS,
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

function renderEditableField(f) {
  if (f.kind === "select") {
    return `<div class="field"><label for="f_${esc(f.name)}">${esc(f.label)}</label>
      <select id="f_${esc(f.name)}" name="${esc(f.name)}">
        ${f.options
          .map(
            (o) =>
              `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}>${esc(o.label)}</option>`,
          )
          .join("")}
      </select></div>`;
  }
  if (f.kind === "textarea") {
    return `<div class="field"><label for="f_${esc(f.name)}">${esc(f.label)}</label>
      <textarea id="f_${esc(f.name)}" name="${esc(f.name)}" rows="3">${esc(f.value)}</textarea></div>`;
  }
  return `<div class="field"><label for="f_${esc(f.name)}">${esc(f.label)}</label>
    <input id="f_${esc(f.name)}" name="${esc(f.name)}" type="text" value="${esc(f.value)}"></div>`;
}

export function approvalPage(id, pending, { durable = true, categories = [] } = {}) {
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
  const fields = editableFieldsFor(pending.tool, pending.args, categories);
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

       <form method="POST" action="/approvals/${esc(id)}">
         ${
           fields
             ? `<p class="fine">Review it below — change anything that is wrong, then submit.</p>
                ${fields.map(renderEditableField).join("")}`
             : ""
         }

         <details${pending.summary || fields ? "" : " open"}>
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

/*
 * "Add products/customers from a spreadsheet" — the other half of batch.js.
 * One shape, two kinds, so the two pages cannot say different things about
 * how uploading works while agreeing about what a row needs.
 *
 * GET is one file input and nothing else. Column names, what a row needs, an
 * example — kept OUT of this page and said once, in the CSV template a person
 * downloads, so there is exactly one place the two can drift apart from.
 */
const BATCH_KINDS = Object.freeze({
  products: {
    noun: "product",
    path: "/products/batch",
    columns:
      "Columns: <strong>title</strong>, <strong>category</strong>, <strong>price</strong> — required. " +
      "<strong>description</strong> and <strong>sku</strong> — optional. Category must be spelled " +
      "exactly like one that already exists.",
    createVerb: "create",
  },
  customers: {
    noun: "customer",
    path: "/customers/batch",
    columns:
      "Columns are Square's own names — the same shape a spreadsheet exported from Square, or typed " +
      "at the till, already has: <strong>given_name</strong>, <strong>family_name</strong>, " +
      "<strong>email_address</strong>, <strong>phone_number</strong>, <strong>note</strong>, " +
      "<strong>reference_id</strong>. Every column is optional, but each row needs at least a name, " +
      "an email, or a phone number.",
    createVerb: "add",
  },
});

export function batchUploadPage(kind = "products") {
  const k = BATCH_KINDS[kind];
  return page(
    `Add ${k.noun}s from a spreadsheet`,
    `<main class="wrap">
       <p class="eyebrow">One ${k.noun} per row</p>
       <h1>Add ${k.noun}s from a spreadsheet</h1>
       <p>${k.columns}</p>
       <form method="POST" enctype="multipart/form-data">
         <input type="file" name="file" accept=".csv,text/csv" required>
         <p><button type="submit">Upload</button></p>
       </form>
       <p class="fine">Nothing is added yet. The next page shows what you are about to
          ${k.createVerb}, one at a time, before anything reaches Square.</p>
       <p><a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

/*
 * The result of one upload: a link to review per row that resolved cleanly,
 * and a plain reason for every row that did not. Each link is a normal
 * /approvals/ page — the same prefilled confirmation screen a single chat
 * draft produces, so there is one approval screen in this codebase, not two.
 */
export function batchReviewPage({ ready, skipped, tooMany }, kind = "products") {
  const k = BATCH_KINDS[kind];
  if (tooMany) {
    return page(
      "Too many rows",
      `<main class="wrap">
         <p class="eyebrow">Nothing was added</p>
         <h1>Too many rows</h1>
         <p>This file has ${tooMany} rows. The most one upload can take at once is ${CAPS.BATCH_MAX_ROWS} —
            split it and upload the rest separately.</p>
         <p><a href="${k.path}">Try again</a> &middot; <a href="/">Back to ops</a></p>
       </main>`,
      APPROVAL_CSS,
    );
  }
  return page(
    "Spreadsheet uploaded",
    `<main class="wrap">
       <p class="eyebrow">Spreadsheet uploaded</p>
       <h1>${ready.length} ready to review</h1>
       ${
         ready.length
           ? `<ol>${ready
               .map(
                 (r) =>
                   `<li><a href="${esc(r.url)}">${esc(r.title)}</a>
                      <span class="fine">${esc(r.summary)}</span></li>`,
               )
               .join("")}</ol>
              <p class="fine">Each one is its own approval — nothing is created until you open it and
                 say yes, the same as ${k.createVerb === "add" ? "adding" : "creating"} one ${k.noun} by hand.</p>`
           : "<p>Nothing in this file was ready to add.</p>"
       }
       ${
         skipped.length
           ? `<h2>${skipped.length} not added</h2>
              <ul>${skipped
                .map((s) => `<li>Row ${s.row}, "${esc(s.title)}": ${esc(s.reason)}</li>`)
                .join("")}</ul>`
           : ""
       }
       <p><a href="${k.path}">Upload another spreadsheet</a> &middot; <a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

/*
 * /assets/new — drop a file for the team, no assistant needed. Same "no
 * confirmation screen, just do it" shape as /media/new: there is nothing
 * here for a human to approve, because dropping a document changes nothing
 * else in the business.
 */
export function assetUploadPage() {
  return page(
    "Drop a file for the team",
    `<main class="wrap">
       <p class="eyebrow">Anyone can drop one</p>
       <h1>Drop a file for the team</h1>
       <p>A vendor price list, a policy note, meeting notes — anyone you work with, and any
          assistant connected here, can read it back afterward.</p>
       <p class="fine">Works today: .txt, .md, .csv, .json (read back as text), plus .pdf, spreadsheets
          and Word documents (stored and listed, but not yet readable as text — open the file
          itself for those).</p>
       <form method="POST" enctype="multipart/form-data">
         <input type="file" name="file" required>
         <p><button type="submit">Upload</button></p>
       </form>
       <p><a href="/assets">See what has been dropped</a> &middot; <a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

export function assetUploadedPage({ id, filename, hasText }) {
  return page(
    "File added",
    `<main class="wrap">
       <p class="eyebrow">Added</p>
       <h1>${esc(filename)}</h1>
       <p>${hasText ? "Any assistant connected here can already read its text." : "Stored and listed. There is no text extraction for this file type yet — open it directly to read it."}</p>
       <p><a href="/assets/${esc(id)}">Open the file</a></p>
       <p><a href="/assets/new">Drop another</a> &middot; <a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

export function assetListPage(rows) {
  return page(
    "Files dropped for the team",
    `<main class="wrap">
       <p class="eyebrow">${rows.length} file${rows.length === 1 ? "" : "s"}</p>
       <h1>Files dropped for the team</h1>
       ${
         rows.length
           ? `<ul>${rows
               .map(
                 (r) =>
                   `<li><a href="/assets/${esc(r.id)}">${esc(r.filename)}</a>
                      <span class="fine">${esc(r.uploaded_by)} &middot; ${esc(r.uploaded_at)}</span></li>`,
               )
               .join("")}</ul>`
           : "<p>Nothing has been dropped yet.</p>"
       }
       <p><a href="/assets/new">Drop a file</a> &middot; <a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

/*
 * /expenses/new — the receipt scanner. Take or upload a photo; the next page
 * is where you confirm what it read, not this one.
 */
export function receiptUploadPage() {
  return page(
    "Scan a receipt",
    `<main class="wrap">
       <p class="eyebrow">Files under your name</p>
       <h1>Scan a receipt</h1>
       <p>Take a photo, or upload one. We'll read the vendor, date and total and show them to
          you to confirm before anything is filed — nothing is submitted automatically.</p>
       <form method="POST" enctype="multipart/form-data">
         <input type="file" name="file" accept="image/*" capture="environment" required>
         <p><button type="submit">Scan</button></p>
       </form>
       <p><a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

/*
 * The confirm form. Every field OCR read is here to be checked, not trusted
 * (finance-skills rule 4) — pre-filled when a guess exists, blank and asking
 * to be filled in when it does not, exactly the same either way from the
 * person's side.
 */
export function expenseConfirmPage({ receiptKey, description, amount_minor, currency, incurred_on, vendor, error }) {
  const amountStr = typeof amount_minor === "number" ? (amount_minor / 100).toFixed(2) : "";
  const today = new Date().toISOString().slice(0, 10);
  return page(
    "Confirm this expense",
    `<main class="wrap">
       <p class="eyebrow">Check before it's filed</p>
       <h1>Confirm this expense</h1>
       ${
         vendor || description
           ? `<p class="fine">Read off the photo — fix anything wrong before continuing.</p>`
           : `<p class="fine">Nothing could be read off this photo. Fill in what you can.</p>`
       }
       ${error ? `<div class="warn">${esc(error)}</div>` : ""}
       <form method="POST" action="/expenses/confirm">
         <input type="hidden" name="receipt_key" value="${esc(receiptKey)}">
         <div class="field">
           <label for="description">What was it</label>
           <input id="description" name="description" type="text" value="${esc(description || (vendor ? `Receipt from ${vendor}` : ""))}" required>
         </div>
         <div class="field">
           <label for="amount">Total</label>
           <input id="amount" name="amount" type="text" inputmode="decimal" value="${esc(amountStr)}" placeholder="42.50" required>
         </div>
         <div class="field">
           <label for="currency">Currency</label>
           <input id="currency" name="currency" type="text" value="${esc(currency || "USD")}" maxlength="3" required>
         </div>
         <div class="field">
           <label for="incurred_on">Date</label>
           <input id="incurred_on" name="incurred_on" type="date" value="${esc(incurred_on || today)}" required>
         </div>
         <p><button type="submit">File this expense</button></p>
       </form>
       <p class="fine">Filing does not pay it out — a manager still approves it, and cannot be the
          person who filed it.</p>
       <p><a href="/expenses/new">Scan a different receipt</a> &middot; <a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

export function expenseFiledPage({ id, description, amount_minor, currency }) {
  return page(
    "Expense filed",
    `<main class="wrap">
       <p class="eyebrow">Filed</p>
       <h1>${esc(description)}</h1>
       <p>${(amount_minor / 100).toFixed(2)} ${esc(currency)} &middot; waiting on a manager's approval.</p>
       <p class="fine">Reference: ${esc(id)}</p>
       <p><a href="/expenses/new">Scan another</a> &middot; <a href="/">Back to ops</a></p>
     </main>`,
    APPROVAL_CSS,
  );
}

const APPROVAL_CSS = `
${OPS_DARK_CSS}
.wrap{max-width:44rem;margin:0 auto;padding:2rem 1.25rem}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;opacity:.7;margin:0}
h1{margin:.25rem 0 1rem;font-size:1.5rem;word-break:break-word}
h2{font-size:.9rem;text-transform:uppercase;letter-spacing:.06em;opacity:.7;margin-top:2rem}
.who{margin:0 0 1rem}
dl{margin:0}
dt{font-weight:600;margin-top:.75rem}
dd{margin:.25rem 0 0}
pre{white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.06);padding:.6rem .7rem;border-radius:.4rem;margin:0;font-size:.85rem}
button{margin-top:1.5rem;padding:.85rem 1.4rem;font-size:1rem;border-radius:.5rem;border:0;background:var(--accent);color:var(--ground);font-weight:700;width:100%;max-width:20rem}
.fine{font-size:.85rem;opacity:.75;margin-top:.75rem}
.warn{font-size:.85rem;border-left:3px solid #c60;padding-left:.75rem;margin-top:1.25rem}
.field{margin:0 0 1rem}
.field label{display:block;font-weight:600;font-size:.85rem;margin-bottom:.3rem}
.field input,.field select,.field textarea{width:100%;font:inherit;font-size:1rem;padding:.6rem .7rem;border:1px solid rgba(255,255,255,.25);border-radius:.4rem;background:transparent;color:inherit;box-sizing:border-box}
.field textarea{resize:vertical}
`;
