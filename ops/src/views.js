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
 *
 * --muted and --rule were both raised once already usable, on the owner's
 * own report that they were hard to read on a phone in broad daylight —
 * direct sun washes out exactly the mid-tones a "dim, secondary" colour is
 * built from, so a ratio that reads fine indoors can still disappear
 * outside. #9C978C (muted) was already a passing 6.1:1 against --ground
 * indoors; #B8B3A8 clears 7:1 (WCAG AAA for normal text) against BOTH
 * --ground and --image-ground, the two backgrounds it actually sits on
 * (a plain bubble and a panel like .table-card). #3A3733 (rule) was only
 * 1.5:1 — invisible as a boundary outdoors, never mind a border under one —
 * #7B7369 clears 3:1 (WCAG's own non-text/UI-component minimum) against
 * both, enough to actually see the chat bar, a table's row dividers or the
 * approval gate's own outline in glare.
 */
const OPS_DARK_CSS = `
:root {
  --ground:       #191817;
  --image-ground: #242220;
  --ink:          #F1EEE6;
  --bar:          #000000;
  --rule:         #7B7369;
  --muted:        #B8B3A8;
  --accent:       #D97757;
}

a { color: var(--accent); }
a:hover { opacity: 0.82; }

/* theme.css's .bar sets color: var(--ground) — on the storefront that's a
   light warm off-white against the same black bar, so it reads fine. Here
   --ground is redefined to a near-black for the dark ground itself, which
   left the "ops.vemians.com · employees only" strip nearly invisible: near-
   black text on a black bar. A dim, deliberately unobtrusive gray instead. */
.bar { color: var(--muted); }
`;

/*
 * The one "pill" input bar, shared literally (not independently duplicated
 * matching values in two places) between the chat composer (OPS_CSS,
 * opsPage()) and the Items search box (ITEMS_CSS, itemsPage()) — the
 * owner's own words, after the two drifted out of sync once already:
 * "if you're gonna match, just make the agent input look the same as the
 * search... just make them the same looking." Extracted from the
 * composer's own .chat-bar, which had the more fully worked-out shape.
 *
 * position: fixed, not sticky — the owner's own correction, pointing at a
 * screenshot with the composer sitting right under the quick-action chips
 * and a large empty gap below it: "does that look like it's on the
 * bottom? ... there's not enough content to make them on the bottom."
 * sticky only repositions an element once its own NORMAL position would
 * scroll past the viewport edge; a short page (a fresh chat, a small
 * catalog) never reaches that point, so sticky just left it wherever the
 * document flow put it — nowhere near the bottom. Fixed is anchored to
 * the viewport itself regardless of how much content exists above it.
 * left/right: 8px matches .ops's own side padding exactly, so the bar's
 * edges line up with the content above it rather than floating off-grid.
 */
const INPUT_BAR_CSS = `
/* min-height: 42px explicitly, rather than letting the bar's own height
   fall out of whatever it happens to contain — the composer's own 34px
   icon buttons plus 4px+4px padding reach 42px on their own, but a
   plain search input with no buttons at all would render a few pixels
   shorter without this. The owner's own words: "the inner agent chat
   bar, the gray one, that's our gold standard... make the items search
   bar the same height and radius." Every current and future .input-bar
   — a search box, anything else that takes text — matches this one
   real number instead of happening to come close. */
.input-bar {
  /* gap grew from 2px — the owner's own words, once a bar could hold up to
     four elements (filter, input, mic, send on Items): "a padding between
     the search and the chat entry and microphone so that they're not so
     tight next to each other... a little easier to press them
     individually." 8px still fits every current .input-bar (Items' own
     four-element bar, the narrowest) on a 320px phone with room to spare. */
  display: flex; align-items: center; gap: 8px; min-height: 42px;
  border: 1px solid var(--muted); border-radius: 24px;
  padding: 4px 6px; background: var(--image-ground);
  position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 20;
  /* Caught live on a wide screen: .ops itself is max-width: 64rem with NO
     margin: auto — it sits flush to the left edge, not centred, so its own
     content stops at 64rem while this bar's plain left/right: 8px kept
     stretching all the way to the true viewport edge, ending up far past
     where the content (and the Send button the owner actually wants to
     reach) visually ends. The owner's own words: "you already have a
     padding inside of the content. Just make sure that same padding is
     applied to the search or chat bars." max-width here is .ops's own
     64rem minus its own 16px of left+right padding (8px each) — this bar
     has no padding of its own contributing to that outer width the way
     .ops's does, only its left/right offset — so capping here keeps the
     bar's own right edge exactly where .ops's own content already ends,
     never stretching past it. Below 64rem (every phone, most tablets)
     this is a no-op: left/right: 8px alone already produces a narrower
     width than the cap. */
  max-width: calc(64rem - 16px);
}
.input-bar:focus-within { border-color: var(--ink); }
.input-bar input {
  flex: 1 1 auto; min-width: 0; border: none; background: transparent;
  padding: 8px 4px; font: inherit; font-size: 14px; color: var(--ink);
}
.input-bar input:focus { outline: none; }
/* The round icon/send buttons a bar can hold, moved here from OPS_CSS once
   Items' own search bar gained a filter button and a search button of its
   own (the owner's own words: "it needs a search button... use the same
   kind of font for the hint and stuff like that... just feels just like
   the chat button") — every .input-bar, not only the chat composer,
   should pick these up literally rather than by a second, independently
   matched copy, the same "shared, not duplicated" reasoning .input-bar
   itself already exists for. */
.input-bar button {
  flex: 0 0 auto; margin: 0; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%;
}
/* A filled circle, same 34px size as .send-btn so the two round buttons
   nest into the bar's own left and right ends identically — "flows neatly
   inside of the inner chat border (like the chat submit button)," the
   owner's own words. The fill itself is deliberately NOT a bold solid
   colour like .send-btn's own accent: a first pass tried exactly that
   (var(--ink), full brightness) and the owner's own correction was "A
   faint gray fill for the attachment button. Needs to be just a little
   brighter than the bg" — a translucent white overlay over the bar's own
   --image-ground, not an opaque circle competing with Send for attention.
   The glyph stays --ink (bright) since the fill underneath it is now
   faint rather than opaque, the same contrast pairing --ink text always
   has against a dark ground on this page. */
.input-bar .icon-btn { width: 34px; height: 34px; background: rgba(255, 255, 255, 0.08); color: var(--ink); }
.input-bar .icon-btn:hover { background: rgba(255, 255, 255, 0.16); color: var(--accent); }
.input-bar .icon-btn[aria-pressed="true"] { color: var(--accent); background: rgba(217, 119, 87, 0.14); }
/* The mic is orange in its resting state too, unlike every other icon-btn
   — the owner's own words: "the microphone should be orange because that
   is an agentic input... make sure the microphone in the agentic agent
   window is orange as well because that's an agentic input as well." A
   dedicated class rather than a change to .icon-btn's own shared rule, so
   the attach button (a plain file picker, not agentic) keeps its neutral
   faint fill. Declared after .icon-btn so it wins the tie — both are a
   single class on the same element, so source order decides. */
.input-bar .mic-btn { background: var(--accent); color: var(--ground); }
.input-bar .mic-btn:hover { background: var(--accent); opacity: 0.85; }
.input-bar .mic-btn[aria-pressed="true"] { background: var(--accent); color: var(--ground); opacity: 0.7; }
/* Send is the SAME faint neutral fill as icon-btn by default now, not the
   accent orange it used to always be — the owner's own words: "don't
   style the search button orange, because orange indicates AI input...
   agentic input... that's the only thing that should have that orange
   decoration." Orange is reserved for #chat's own Send below, the one
   button that actually submits to the agent; every other .send-btn
   (Items' search, a ticket's Create/Send) shares this neutral look
   instead of borrowing a meaning that is not true of it. */
.input-bar .send-btn { width: 34px; height: 34px; background: rgba(255, 255, 255, 0.08); color: var(--ink); }
.input-bar .send-btn:hover { background: rgba(255, 255, 255, 0.16); color: var(--accent); }
.input-bar .send-btn:disabled { opacity: 0.4; cursor: default; }
/* #chat is the id ONLY the real agent composer's form carries (opsPage()) —
   the ticket compose/comment forms and Items' search bar all reuse class
   "chat"/"input-bar" for their shared shape but never this id, so this
   stays the one place orange survives. */
#chat .send-btn { background: var(--accent); color: var(--ground); }
#chat .send-btn:hover { background: var(--accent); opacity: 0.85; }
/* The filter menu that opens above a bar's own filter button — Items'
   category picker first (the owner's own words: "a little menu to select
   existing categories... a quick way to filter by category"), then the
   Dashboard's own kind picker (Tickets/Tasks/Expenses/Uploads) reusing the
   same shape rather than a second, independently matched copy. Moved here
   from ITEMS_CSS once a second bar needed it — shared, not duplicated, the
   same reasoning every other rule in this file already gets. Floats the
   same way .menu floats above the agent composer (opsPage(), OPS_CSS):
   position: fixed, anchored a gap above .input-bar's own bottom (8px
   offset + 42px height + 8px gap = 58px), left-aligned near the filter
   button rather than spanning the full bar. */
.category-menu {
  position: fixed; left: 8px; bottom: 58px; z-index: 21; max-width: 70vw;
  display: flex; flex-direction: column; gap: 2px; padding: 6px;
  background: var(--image-ground); border: 1px solid var(--muted); border-radius: 12px;
  max-height: 50vh; overflow-y: auto;
}
/* An explicit display: flex above beats the browser's own default
   [hidden] { display: none } rule — author styles always win over the
   UA stylesheet regardless of specificity — so the menu rendered open on
   every page load, the hidden attribute doing nothing at all. This is
   the fix: restate none for [hidden] specifically, so JS toggling
   .hidden (never .style.display) actually shows and hides it. */
.category-menu[hidden] { display: none; }
/* Same visual language as .choices .btn (the agent page's own quick-prompt
   chips, OPS_CSS) — 11px, pill-ish, a muted border on --image-ground —
   kept as its own rule rather than sharing that class, since .choices
   itself lives in OPS_CSS and neither Items nor the Dashboard imports it. */
.category-menu .category-item {
  display: block; width: 100%; text-align: left; font: inherit; font-size: 11px;
  padding: 6px 10px; border: 1px solid var(--rule); border-radius: 999px;
  background: var(--ground); color: var(--ink); cursor: pointer;
}
.category-menu .category-item:hover { border-color: var(--accent); color: var(--accent); }
/* Checked state — "that menu would automatically select one or more
   categories to satisfy the search," the owner's own words. Multi-select:
   more than one can carry this at once. Same faint-accent-tint language
   .icon-btn[aria-pressed="true"] already uses for an active toggle state,
   not a new visual vocabulary invented for this. */
.category-menu .category-item.active { border-color: var(--accent); color: var(--accent); background: rgba(217, 119, 87, 0.14); }
/* The "Hi Dimitri" spot (opsPage(), formerly OPS_CSS only) — moved here so
   Items' own category status and the Dashboard's own mode status can sit
   in the exact same place and font, rather than floating in a line above
   the search/compose bar the way both used to. The owner's own words:
   "put the categories in there, in the top... use that same font, same
   kind of layout... so that all of these tabs have kinda matching
   layouts." Centred and quiet on purpose — a status line, not the thing
   on the page asking to be read first; 11px matches the smallest de-
   emphasised meta text already used elsewhere (.ticket-meta, badges).
   Always shown, never conditionally hidden: "Hi Dimitri" is there
   whether or not you have typed anything yet, and so is "All
   categories"/"Showing: All" here. */
.greet { margin: 0 0 6px; text-align: center; }
.greet h1 { font-size: 11px; font-weight: 400; color: var(--muted); margin: 0; }
`;

/*
 * A batch preview or draft result — column mapping, or ready/skipped rows —
 * rendered as a real table rather than a wall of text. Shared between the
 * chat log (OPS_CSS, appended as a sibling of the message bubbles by
 * tableCard()) and the dedicated /products/batch, /customers/batch upload
 * pages (APPROVAL_CSS, rendered server-side by batchReviewPage()) — the
 * owner's own words, after seeing both: "I like how the table renders in
 * our chat! Doesn't look like that on our website!" One card style, used
 * from two render paths, rather than the page route quietly staying on
 * the plain <ol>/<ul> list it had before either surface had a real table
 * to show. Selectors are bare .table-card (not .log .table-card) so this
 * works standalone on a page with no #log element at all.
 *
 * The table keeps its own natural width (no forced 100%, no wrapped cells)
 * and the card scrolls sideways when that is wider than its own box —
 * "the ability to scroll... if it exceeds the chat box width," the owner's
 * own words from the chat context — rather than squeezing a real approval
 * URL or a long skip reason into an unreadable wrapped column.
 */
/* Square corners, a full grid (vertical rules between columns, not just a
   line under each row) and a shaded header — the owner's own words: "Make
   sure you follow the [Claude] in chat styling. Respect markups and render
   tables etc," having just compared this card's own look, unfavourably,
   to how a plain markdown table renders in an ordinary chat client. The
   scrolling frame itself (max-height + overflow below) is not the thing
   being changed — "still use a scrolling frame so I can see the entire
   table if cropped" — only the table's own visual grammar is. */
const TABLE_CARD_CSS = `
/* The table now SCALES to the card's own full width instead of sizing to
   its natural content width — the owner's own words: "You can scale the
   table to fit full width if possible! The goal is to avoid cropping as
   much as possible while retaining readability." A previous round
   dropped "min-width: 100%" so a narrow table would not stretch; this
   reverses that on purpose, now for the opposite reason — a table wider
   than the card used to need sideways scrolling to see the cropped-off
   columns at all, which reads as "cropped" even though the rest is one
   scroll away. "width: 100%" with "table-layout: fixed" instead
   guarantees the table never exceeds the card's own width regardless of
   column count, so there is nothing left to scroll past; long content
   (a full URL, a long product title) WRAPS onto more lines within its
   own column ("overflow-wrap: anywhere") instead of being cut off or
   pushing the table wider. Padding is halved again (card 4px -> 2px,
   every cell and the "Full screen" button 1px 4px -> 1px 2px) and the
   font drops to a flat 9px everywhere in the card, matching the title
   bar and button's own size instead of a bigger size just for cells.
   max-height is recomputed once more for the smaller row height this
   produces. */
.table-card {
  align-self: stretch; max-width: 100%; box-sizing: border-box;
  border: 1px solid var(--rule); border-radius: 0; padding: 2px;
  background: var(--image-ground); font-size: 9px;
  max-height: 58px; overflow: auto;
}
.table-card h4 {
  margin: 0 0 2px; padding: 0; font-size: 9px; font-weight: 700;
  color: var(--muted); display: flex; justify-content: space-between;
  align-items: center; gap: 6px; position: sticky; left: 0;
}
.table-card table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.table-card th, .table-card td {
  text-align: left; padding: 1px 2px; border: 1px solid var(--rule);
  overflow-wrap: anywhere; word-break: break-word; vertical-align: top; font-size: 9px;
}
.table-card th { color: var(--ink); font-weight: 700; background: var(--ground); }
.table-card a { color: var(--accent); overflow-wrap: anywhere; }
.table-card button {
  flex: 0 0 auto; font: inherit; font-size: 9px; padding: 1px 2px; cursor: pointer;
  border: 1px solid var(--rule); border-radius: 12px; background: var(--ground); color: var(--ink);
}
.table-card button:hover { border-color: var(--accent); color: var(--accent); }
/* Full screen is a fixed overlay, not a new scroll container elsewhere on
   the page — the same element just grows to cover the viewport in place. */
.table-card.full {
  position: fixed; inset: 12px; z-index: 50; max-height: none;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}
`;

/*
 * The shell — the owner's own correction to the two-links-per-page nav this
 * replaces: "No I WANT tabs in the header. Replace this: the header is
 * always present. Everything else is an iframe." One persistent header
 * (this CSS, this markup) that never reloads; the tab CONTENT is an
 * <iframe> whose src swaps between /chat and /items, each an otherwise
 * ordinary page that no longer draws its own copy of the tab bar (nor, now,
 * its own copy of the "employees only" strip — this is the only place
 * either one is drawn, so the two are not stacked on top of each other the
 * moment this loads inside the iframe below).
 *
 * "Think of tabs in a filing cabinet" led, through several rounds of
 * "bottom radiused too, paper tabs cut out" and then "not pills," back to
 * the classic tabbed-pane shape it started closest to: rounded TOP
 * corners only, a flat square bottom, and the active tab structurally
 * open at the bottom (`border-bottom: none`, background matching the
 * panel) so it merges into what it fronts rather than floating above it
 * as an independent piece. Rounding every corner — even at a
 * deliberately restrained `8px` — read as "pills sitting on top of a
 * line" once actually on screen: the owner's own words, emphatically,
 * "They need to look like tabs! More radiused. NOT PILLS ON TOP OF A
 * LINE." A tab's own top radius can be generous (`14px`, more than any
 * top-only value this shape has used before) without ever becoming a
 * pill, precisely because the bottom stays square — a pill needs BOTH
 * ends rounded, and this one only ever has one.
 *
 * The public storefront is a TAB, not a link out — the owner's own words,
 * emphatically, after a first attempt made it an <a target="_blank">:
 * "A link!!! Its inside a tab! Iframe are you listening??? Header is tabs
 * and everything in tab body is an iframe." No exception for this one: its
 * `src` is the cross-origin `https://vemians.com` instead of a same-origin
 * path, but the click handler below does not know or care — it is the
 * exact same iframe.src swap every other tab already gets. Nothing in this
 * codebase sets X-Frame-Options or a frame-ancestors CSP on the storefront,
 * so embedding it is unblocked.
 */
const SHELL_CSS = `
${OPS_DARK_CSS}
html, body { height: 100%; margin: 0; }
/* height: 100dvh, with a 100vh fallback for browsers that predate it —
   the owner's own words, about the header losing its own bottom edge
   while scrolling the Website tab: "the tabs should be in a header,
   and it should not lose its edge at all because it's part of the
   header." 100vh on a phone is measured against the LARGEST possible
   viewport (address bar collapsed), not the one actually visible when
   the page loads (address bar expanded) — .shell's own flex layout was
   sized taller than the real visible area, so .shell-header (flex: 0 0
   auto, meant to stay fixed) could end up partly below the fold until
   the browser chrome's own height was accounted for. 100dvh tracks the
   dynamic, ACTUAL visible viewport as the address bar shows and hides,
   keeping the header's own bottom border pinned exactly where the real
   viewport ends, not where the largest possible one would. */
.shell { display: flex; flex-direction: column; height: 100vh; height: 100dvh; box-sizing: border-box; background: var(--ground); }
/* Side padding matched .ops's own 8px, then doubled to 16px for more
   visible separation — then the owner's own words, more precisely: "First
   tab on left matches the inner chat left extent." That is not .ops's own
   edge, it is past it AND past .chat-top's own frame: 8px (.ops) + 14px
   (.chat-top's own padding) = 22px, the point .log's own content starts
   at. (.chat-top's own border used to add a 3rd, 1px term here — removed
   entirely since, along with the border itself; the composer also no
   longer lives inside this same padding stack at all, now that it is
   fixed to the screen's own bottom instead, so this aligns with .log's
   own edge specifically rather than a shared log-and-composer one.) */
.shell-header { flex: 0 0 auto; padding: 10px 22px 0; background: var(--bar); }
.shell-nav { --tab-radius: 14px; display: flex; align-items: flex-end; gap: 16px; }
/* Flat and borderless until active — every tab drawn as its own
   bordered box, active or not, was what read as a row of separate
   chips rather than folder tabs in a flat bar. */
.shell-nav button {
  font: inherit; font-size: 12px; font-weight: 600; padding: 7px 16px; cursor: pointer;
  border: none; background: transparent; color: var(--muted); position: relative;
}
.shell-nav button:hover:not(.active) { color: var(--accent); }
/* A TAB, not a pill: rounded top corners, a flat SQUARE bottom (never
   rounded — that is what read as a pill), and the active one
   structurally open at the bottom (no bottom border) so its own
   background flows straight into .shell-panel's with nothing
   separating them — pulled down by the shared 1px border width so its
   own sides land exactly on the panel's own top border rather than
   stopping short of it. This is a real merge, not two colour-matched
   lines standing in for one.
   A "round-out" notch that curved the header's own background smoothly
   up into this shape's base used to sit here — eight straight rounds
   of box-shadow/border-radius/offset corrections chasing each other's
   own artifacts, ending in "looks like a fucking mushroom," the
   owner's own words, then "just make them with a rounded top and
   straight bottom edges. I'm tired of you fucking up." Removed
   entirely. Rounded top, straight square bottom, a plain full border
   (top + both sides) minus the one edge that merges into the panel —
   nothing else. */
.shell-nav button.active {
  background: var(--ground); color: var(--ink);
  border: 1px solid var(--accent); border-bottom: none;
  border-radius: var(--tab-radius) var(--tab-radius) 0 0;
  margin-bottom: -1px; padding-bottom: 8px; z-index: 1;
}
.shell-panel { flex: 1 1 auto; border-top: 1px solid var(--accent); }
.shell-frame { width: 100%; height: 100%; border: 0; display: block; background: var(--ground); }
`;

const SHELL_TABS = [
  { key: "agent", label: "Agent", src: "/chat", href: "/" },
  { key: "items", label: "Items", src: "/items", href: "/?tab=items" },
  /* Test-PRD-P0-100-ticket_messaging, superseded by Test-PRD-P0-108-ops_dashboard:
     "Messages" is renamed "Dashboard" once it stopped being just tickets —
     the owner's own words, "it's not just about messages. It's like a
     bulletin board." Same-origin, so it is a same-iframe-swap tab like
     Agent/Items, unlike Website below (cross-origin, its own tab for that
     reason alone — see the comment on SHELL_TABS' own history). The
     ticket detail/comment/status routes stay at /tickets/<id> — only the
     list page this tab opens moves to /dashboard. */
  { key: "dashboard", label: "Dashboard", src: "/dashboard", href: "/?tab=dashboard" },
  { key: "website", label: "Website", src: "https://vemians.com", href: "/?tab=website" },
];

export function shellPage(active = "agent") {
  const initial = SHELL_TABS.find((t) => t.key === active) ?? SHELL_TABS[0];
  const nav = SHELL_TABS.map(
    (t) =>
      `<button type="button" data-src="${esc(t.src)}" data-href="${esc(t.href)}"${t.key === initial.key ? ' class="active"' : ""}>${esc(t.label)}</button>`,
  ).join("");

  return page(
    "Vemians ops",
    /* No "ops.vemians.com · employees only" banner above the tabs — the
       owner's own words: "GET RID OF THE HEADER... I WANT THE TABS TO BE
       IN PLACE OF HEADER." The tab row itself IS the header now; nothing
       sits above it. */
    `<div class="shell">
  <div class="shell-header">
    <nav class="shell-nav">${nav}</nav>
  </div>
  <div class="shell-panel">
    <iframe class="shell-frame" id="ops-frame" src="${esc(initial.src)}" title="Vemians ops"></iframe>
  </div>
</div>
<script>
document.querySelectorAll(".shell-nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".shell-nav button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("ops-frame").src = btn.dataset.src;
    history.replaceState(null, "", btn.dataset.href);
  });
});
</script>`,
    SHELL_CSS,
  );
}

const OPS_CSS = `
${OPS_DARK_CSS}
${INPUT_BAR_CSS}
/* 34rem was tuned for "one screen on a phone" before this page grew a chat
   widget, tables and an accordion of real content — on an actual desktop
   window it read as a narrow column stranded in the middle of empty space.
   Wide enough now to use a real monitor; still capped, so a line of prose in
   the accordion below does not stretch across a 4K display and become hard
   to read.
 *
 * Side padding is tight (8px, matching .chat-top's own tightened side
 * padding — P0-93) rather than the roomier 24px this used to carry: on an
 * actual phone screen, padding on both sides is width the chat widget and
 * everything else on the page cannot use at all, and "maximize the use of
 * space on mobile" was the owner's own direction. max-width still caps a
 * wide desktop window, where the difference barely registers.
 *
 * Bottom padding grew from 32px to 76px once #chat and .items-search
 * both became position: fixed (see INPUT_BAR_CSS) — a fixed element is
 * removed from normal document flow entirely, so without this the
 * grid's own last row, or the chat log's own last message, would sit
 * PARTLY BEHIND the now-floating bar rather than stopping short of it.
 * 76px clears the bar's own ~42px height plus its 8px offset from the
 * true screen edge, plus a little breathing room above it.
 *
 * Grown again to 108px once .menu (the quick-action chips) also became
 * position: fixed, floating above .input-bar instead of sitting in flow
 * above the greeting — the same reasoning again, one floating row
 * further out: the existing 76px already clears .input-bar itself, +8px
 * for the gap .menu floats above it by, +~24px for .menu's own single
 * row of chips, so .log's own last message stops clear of BOTH floating
 * rows, not just the composer. Ops-page only: itemsPage() has no
 * floating .menu of its own, so ITEMS_CSS never touches this value. */
.ops { max-width: 64rem; padding: 12px 8px 108px; }

.ops .warn { margin: 0 0 14px; }

.hint { font-size: var(--eyebrow); color: var(--muted); margin: 0 0 8px; }
.hint a { color: var(--accent); }

/* The widget itself reads as one contained thing — a border around the
   whole assistant, not just around the log inside it — so it does not look
   like loose page furniture next to the chips below it. Rounder than a
   typical card, closer to the composer shape it wraps, per the reference
   screenshot of a mobile chat composer this was asked to match. */
/* Same orange as the quick-prompt chips below it (.choices .btn) — one
   accent colour tying the widget to the shortcuts that feed it, rather than
   the plain neutral --rule every other box on the page uses.
 *
 * All FOUR sides are the same 14px again, matching top — the direction
 * this kept getting corrected in was backwards. The owner's own words:
 * "I didn't ask you to make bottom gap smaller I asked the side padding
 * to be bigger to match the bottom padding." The bottom visibly looked
 * bigger in the original screenshot for a real reason (P0-96's own bug,
 * an uncollapsed empty .attach-name span) — but fixing that bug shrank
 * the bottom to match the sides' small 3px, when what was actually asked
 * was the reverse: grow the sides to match how roomy the bottom used to
 * look. Rather than guess a value trying to reproduce a look that came
 * from a bug now removed, this returns to 14px on every side — the
 * original, generous value this padding carried before any tightening
 * request in this whole thread ever touched it, and trivially "sides
 * match bottom" since there is now only one number.
 *
 * No border or radius at all now, not even a plain uniform one — the
 * owner's own words: "maybe lose the orange border around the agent.
 * So it looks like the search bar in the items [tab]." The composer no
 * longer nests inside this frame's own bottom edge (it is fixed to the
 * screen's own bottom instead, sharing .items-search's own shape), and
 * with the border gone there is no background left to round either —
 * .log/#gate now sit as plainly on the page as the Items grid's own
 * tiles do, with only their own padding for spacing. */
.chat-top {
  padding: 14px; margin-bottom: 16px;
}
/* The composer <form> carries class="chat" deliberately (so the
   approval gate's own button row further down inherits from it too),
   which means it also inherits theme.css's own ".chat" margin-top:
   12px — irrelevant now that #chat is position: fixed (below) with
   only the bottom inset set, not top, so a top margin has nothing left
   to offset against. Kept at 0 anyway since it costs nothing and this is
   exactly the kind of inherited-margin bug (P0-96, P0-99) this file
   has been bitten by more than once. */
#chat { margin-top: 0; }

/* Floats directly above the composer now, not in normal document flow above
   the greeting — the owner's own words: "those quick actions to fill the
   agent, let's have them float above the agent input field." position:
   fixed, the same mechanism .input-bar already uses, anchored a gap above
   it rather than below the greeting: bottom = .input-bar's own 8px offset
   + its 42px height + an 8px gap = 58px. left/right match .input-bar's own
   8px so the two floating rows share one edge. Removed from flow entirely,
   so it no longer pushes .chat-top down — see .ops's own bottom padding
   for the corresponding room made below it. */
.menu {
  margin: 0; position: fixed; left: 8px; right: 8px; bottom: 58px; z-index: 19;
}
/* Small chips, not CTAs — three routine tasks and a fold, not the thing on
   the page asking to be pressed hardest. The chat above is that thing now.
   No heading of their own: they read as quick prompts for the composer
   they now float directly above, rather than a second menu competing
   with it. */
.choices { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
/* No longer the accent orange — the owner's own words, once .chat-top's
   own matching accent border was already gone: "get rid of that empty
   orange peel that's left over from the agent." A transparent-fill,
   accent-bordered pill only read as a coherent design tied to the frame
   it echoed; with that frame gone, the same hollow orange ring just
   looked like an unexplained leftover. Filled with the same
   --image-ground/--muted pairing .input-bar already uses, so a chip
   floating over chat content stays legible rather than picking up
   whatever text sits behind it. */
.choices .btn {
  display: inline-block; font: inherit; font-size: 11px; line-height: 1.2;
  padding: 4px 9px; margin: 0; border: 1px solid var(--muted); border-radius: 999px;
  background: var(--image-ground); color: var(--ink); text-decoration: none; font-weight: 400;
  cursor: pointer;
}
.choices .btn:hover { background: var(--muted); color: var(--ground); }

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

/*
 * A real chat widget, not a growing list of paragraphs: a fixed-height,
 * scrolling column of bubbles — same shape as the genre this was asked to
 * match (Telegram). MINE align right in the one accent colour on the page;
 * the agent's align left, quiet and bordered; a TOOL step is neither — it is
 * a system aside (Telegram's own "so-and-so joined"), centred, small, never
 * competing with either side of the conversation. Empty at rest, so the
 * widget does not show a blank grey box before the first message — it grows
 * into place instead.
 *
 * max-height was a flat 320px, sized before this widget ever had to hold a
 * batch preview's own long explanatory reply AND a table in the same
 * scrolling column — the owner's own words, seeing a real one cropped mid-
 * table on a phone with most of the screen still empty below it: "I cant
 * really tell what is being shown." min(62vh, 560px) scales with the actual
 * viewport instead of a single guessed number: room for a real reply plus a
 * few rows of table on a typical phone, capped so a very tall window does
 * not turn the log into most of the page.
 */
/* THE SAME CLASS OF BUG AGAIN (P0-96's .attach-name, P0-99's inherited
   .chat margin) — .log's own margin-top (8px) plus padding-top (4px) was
   12px of unrelated extra space with no side equivalent (side margin: 0,
   side padding: 2px), stacking on top of .chat-top's own uniform 14px
   padding: the first bubble sat noticeably farther from the top edge than
   from either side. The owner's own words, pointing at a real screenshot:
   "See the 'add content' message? Its too far from top edge of outer chat
   box. Needs to match [the] side." margin carries only the bottom gap
   (before the composer form) now; padding is a uniform 2px matching the
   side value exactly, so top and sides both work out to the same total
   distance from .chat-top's own edge. */
.log {
  display: flex; flex-direction: column; gap: 6px;
  max-height: min(62vh, 560px); overflow-y: auto;
  margin: 0 0 8px; padding: 2px;
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
${TABLE_CARD_CSS}
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
 * The pill's own border/radius/padding/background, and the input's own
 * reset, used to live here, hand-tuned across many rounds (a 24px
 * declared radius rendering at a true ~21px on this bar's own ~42px
 * height; sides at 6px against a 4px vertical; kept deliberately
 * concentric with .chat-top's own frame around it). All of that now
 * lives in the shared .input-bar / .input-bar input (INPUT_BAR_CSS,
 * above OPS_CSS) instead — .chat-bar carries that class too, and #q
 * needs no styling of its own beyond what .input-bar input already
 * gives every descendant input — because the composer no longer nests
 * inside .chat-top's own frame at all (see .chat-top below): it is
 * fixed to the screen's own bottom now, sharing its exact shape with
 * Items' own search bar, literally rather than by independently
 * matched values. The button rules (icon-btn, send-btn) live in
 * INPUT_BAR_CSS too now, not here — see that constant's own comment. */
`;

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

/* One attach button, not two — a plain "+" like the reference composer's own,
   same stroke-only style as CLIPBOARD above. It opens one file picker that
   takes a photo or any other file; the agent works out which from what
   actually arrives, so the UI never has to ask first. Once a file IS
   picked, the same button becomes the way to cancel it — swapped to an
   "x" (CANCEL_ICON below) rather than adding a second button for a
   choice that only exists in one of two states at a time. */
const ATTACH_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const CANCEL_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const SEND_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<path d="M8 12.5V3.5M8 3.5 3.5 8M8 3.5 12.5 8" fill="none" stroke="currentColor" stroke-width="1.4" ` +
  `stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* Voice input, next to Send — the owner's own words: "Add the same kind
   of microphone input button as claude next to the submit chat button
   same style as the + button as far as colors." Same .icon-btn class as
   the attach button (below), so it picks up the exact same faint fill,
   hover, and aria-pressed accent colours with no CSS of its own — "same
   style... as far as colors" is exactly what sharing the class gives for
   free, rather than a second, parallel set of button rules to keep in
   sync with the first. Swaps to MIC_STOP_ICON while recording, the same
   swap-in-place pattern the attach button already uses for its own
   plus/cancel states. */
const MIC_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<rect x="6" y="1.5" width="4" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
  `<path d="M4 7.5v1a4 4 0 0 0 8 0v-1M8 12.5V15M5.5 15h5" fill="none" stroke="currentColor" ` +
  `stroke-width="1.4" stroke-linecap="round"/></svg>`;
const MIC_STOP_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor"/></svg>`;

/* Items' own search bar (itemsPage()) — the owner's own words: "it needs a
   search button on the right instead of the submit chat... it might be a
   magnifying glass," matching SEND_ICON's own 16x16/1.4-stroke-width shape
   rather than a differently-drawn icon that happens to also mean search. */
const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<circle cx="6.8" cy="6.8" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
  `<path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

/* The category-filter menu's own opener, on the left where ATTACH_ICON sits
   in the chat composer — the owner's own words: "a hamburger menu like
   button with the little dots on the sides of hamburger lines... a quick
   way to filter by category." Three plain hamburger lines alone are
   already used elsewhere for navigation; the dots at both ends of each
   line are what make this read as a filter control instead of a second
   nav trigger. */
const FILTER_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<circle cx="2" cy="4" r="1" fill="currentColor"/><path d="M5 4h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="13" cy="4" r="1" fill="currentColor"/>` +
  `<circle cx="2" cy="8" r="1" fill="currentColor"/><path d="M5 8h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="13" cy="8" r="1" fill="currentColor"/>` +
  `<circle cx="2" cy="12" r="1" fill="currentColor"/><path d="M5 12h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="13" cy="12" r="1" fill="currentColor"/></svg>`;

/*
 * Plain dictation — click to start, click to stop, the transcript appended
 * to one text field. Deliberately NOT the agentic mic pattern (.mic-btn,
 * orange, hold-to-record `sendToAgent()`): the owner's own words, asked
 * for a ticket's comment box and the Dashboard's own compose bar, "it's
 * not an agentic microphone. It's just a normal microphone where you can
 * speak to make a comment... use the microphone to just input text
 * without typing." No fetch, no model call — the transcript only ever
 * lands in the field. Rendered as class="icon-btn" alone (no "mic-btn"),
 * so it keeps the neutral faint fill every non-agentic button already
 * has rather than borrowing the orange reserved for agentic input.
 */
function dictationScript({ btnId, inputId }) {
  return `(function () {
  const btn = document.getElementById(${JSON.stringify(btnId)});
  const field = document.getElementById(${JSON.stringify(inputId)});
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor || !btn) { if (btn) btn.remove(); return; }
  const recognition = new Ctor();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  const MIC_ICON_HTML = ${JSON.stringify(MIC_ICON)};
  const MIC_STOP_ICON_HTML = ${JSON.stringify(MIC_STOP_ICON)};
  let listening = false;
  function stopListening() {
    listening = false;
    btn.removeAttribute("aria-pressed");
    btn.innerHTML = MIC_ICON_HTML;
  }
  recognition.addEventListener("result", (e) => {
    const transcript = e.results[0][0].transcript.trim();
    if (!transcript) return;
    field.value = field.value ? field.value + " " + transcript : transcript;
    field.focus();
  });
  recognition.addEventListener("end", stopListening);
  recognition.addEventListener("error", stopListening);
  btn.addEventListener("click", () => {
    if (listening) { recognition.stop(); return; }
    listening = true;
    btn.setAttribute("aria-pressed", "true");
    btn.innerHTML = MIC_STOP_ICON_HTML;
    recognition.start();
  });
})();`;
}

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

/*
 * The front page — reduced to the minimum interface (the owner's own words:
 * "No dev. No examples. No mcp. Just chat and common actions. Backed by
 * skills"). Everything that used to explain the system here — the roster,
 * the tier contract, the MCP endpoint, the sample data — is either enforced
 * server-side regardless of whether anyone reads a page about it, or is
 * something the assistant itself now explains in conversation when asked,
 * carried by the skills it reads on connect (P0-54's own machine contract,
 * unchanged, just no longer promoted here). What is left is the two things
 * almost everyone is here to do: talk to the assistant, or tap one of three
 * common actions.
 */
export function opsPage(identity, { hasKey, role }) {
  /* Verified identity used to also print as its own line — email, role, how
     it was granted — directly under the black bar. Redundant on screen: the
     greeting below already names the person. The unverified case is kept as
     a banner regardless — a Worker accepting unsigned assertions is not a
     detail to fold away. */
  const id = identity.verified
    ? ""
    : `<div class="warn">Unsigned assertion accepted — ACCESS_TEAM_DOMAIN and ACCESS_AUD are unset. Prototype mode only. Claimed: <strong>${esc(identity.email)}</strong> &middot; role <strong>${esc(role || "none")}</strong>.</div>`;

  const firstName = firstNameFrom(identity.claims, identity.email);

  return page(
    "Vemians ops",
    /* No "ops.vemians.com · employees only" bar here — this page now loads
       ONLY inside the shell's own iframe (shellPage(), above), which
       already draws that strip once, in its own header. A second copy
       here stacked directly on top of it, every time this loaded. */
    `<main class="ops">
${id}

  <section class="greet">
    <h1>Hi ${esc(firstName)} — what would you like to do?</h1>
  </section>

  <!-- Structurally still ahead of the chat log in the markup (an earlier
       round's "sits above the chat, not below it" — the owner's own
       words: "you can put the quick chat buttons on top of the chat...
       not on the bottom"), but its own visual position is now entirely
       CSS-driven, not order-driven: .menu is position: fixed, floating
       directly above .input-bar (see .menu's own CSS) rather than
       sitting in flow above the greeting — the owner's own words, this
       round: "those quick actions to fill the agent, let's have them
       float above the agent input field." -->
  <section class="menu">
    <div class="choices">
      <button type="button" class="btn" data-prompt="Add products">+ Products</button>
      <button type="button" class="btn" data-prompt="Add customers">+ Customers</button>
      <button type="button" class="btn" data-prompt="Submit an expense">+ Expense</button>
    </div>
  </section>

  <section class="key chat-top">
    ${hasKey ? "" : '<p class="hint">No model connected &mdash; set <code>ANTHROPIC_API_KEY</code> to turn this on.</p>'}
    <div class="log" id="log"></div>
    <div id="gate"></div>
  </section>

  <!-- Fixed to the screen's own bottom (see INPUT_BAR_CSS), not
       structurally last on the page and not nested inside .chat-top's
       own frame — the owner's own words, pointing at a screenshot with
       the composer sitting just under the quick-action chips and a
       large empty gap below it: "does that look like it's on the
       bottom? ... there's not enough content to make them on the
       bottom." Nothing short of fixed positioning keeps this pinned to
       the true bottom of the screen regardless of how little content
       (a fresh chat) exists above it. -->
  <form class="chat" id="chat" method="post" action="/ops/agent">
    <div class="chat-bar input-bar">
      <button type="button" class="icon-btn" id="attach-btn" aria-label="Attach a photo or file" title="Attach a photo or file">${ATTACH_ICON}</button>
      <input name="q" id="q" placeholder='e.g. "Add a wool coat, $450, Outerwear"' autocomplete="off">
      <button type="button" class="icon-btn mic-btn" id="mic-btn" aria-label="Voice input" title="Voice input">${MIC_ICON}</button>
      <button type="submit" class="send-btn" aria-label="Send" title="Send">${SEND_ICON}</button>
    </div>
    <input type="file" id="attach-input" hidden>
  </form>
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

/* One builder for a preview/draft result table — column headings on the
   left, values on the right for a preview; row/title/status/detail for a
   draft result. Lives in the same scrolling log as the message bubbles
   (see .log .table-card above), so the existing scrollTo call below already
   carries it into view. The full-screen toggle just grows the same element
   in place — no second element, no separate scroll state to track. */
function tableCard(t) {
  const wrap = document.createElement("div");
  wrap.className = "table-card";

  const head = document.createElement("h4");
  const title = document.createElement("span");
  title.textContent = t.title || "";
  const full = document.createElement("button");
  full.type = "button";
  full.textContent = "Full screen";
  full.addEventListener("click", () => {
    const isFull = wrap.classList.toggle("full");
    full.textContent = isFull ? "Close" : "Full screen";
  });
  head.appendChild(title);
  head.appendChild(full);
  wrap.appendChild(head);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  (t.columns || []).forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  (t.rows || []).forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  log.appendChild(wrap);
  log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  return wrap;
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
 * One button, one file at a time — a photo or any other file, the agent
 * works out which. Neither the text box nor the attachment is required on
 * its own: a photo with no typed text is a normal message, "figure out what
 * to do with it" being exactly the point of handing it to the agent instead
 * of a purpose-built upload form.
 *
 * A picked file's name used to run in its own line under the composer
 * (.attach-name) — a second thing on the page saying "a file is attached"
 * instead of the one place someone is already looking. The owner's own
 * words: "instead of adding a line under the inner chat box... just update
 * the default text inside of the chat box." The filename now replaces the
 * INPUT'S OWN PLACEHOLDER instead — visible only while the box is empty,
 * the same way a placeholder always works, and gone the moment someone
 * types over it or the attachment is cleared.
 *
 * The SAME button attaches and cancels — never two buttons for a choice
 * that only exists in one of two states at a time. The owner's own words:
 * "I should be able to cancel the attachment! The + button should change
 * to an x button." ATTACH_ICON_HTML/CANCEL_ICON_HTML are this file's own
 * server-side ATTACH_ICON/CANCEL_ICON constants, carried into the client
 * script as plain strings (JSON.stringify handles the escaping) since the
 * button's own innerHTML has to be swappable at runtime, not just set once
 * in the initial markup the way the button's FIRST icon is.
 */
const ATTACH_ICON_HTML = ${JSON.stringify(ATTACH_ICON)};
const CANCEL_ICON_HTML = ${JSON.stringify(CANCEL_ICON)};
const fileInput = document.getElementById("attach-input");
const attachBtn = document.getElementById("attach-btn");
const qInput = document.getElementById("q");
const DEFAULT_PLACEHOLDER = qInput.placeholder;

function clearAttachments() {
  fileInput.value = "";
  qInput.placeholder = DEFAULT_PLACEHOLDER;
  attachBtn.removeAttribute("aria-pressed");
  attachBtn.innerHTML = ATTACH_ICON_HTML;
  attachBtn.setAttribute("aria-label", "Attach a photo or file");
  attachBtn.setAttribute("title", "Attach a photo or file");
}

function pickedFile() {
  return fileInput.files[0] || null;
}

attachBtn.addEventListener("click", () => {
  if (pickedFile()) {
    clearAttachments();
    return;
  }
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  if (!fileInput.files[0]) return;
  qInput.placeholder = 'Attached "' + fileInput.files[0].name + '" — add a note (optional)';
  attachBtn.setAttribute("aria-pressed", "true");
  attachBtn.innerHTML = CANCEL_ICON_HTML;
  attachBtn.setAttribute("aria-label", "Remove attachment");
  attachBtn.setAttribute("title", "Remove attachment");
});

/* Voice input. Support for SpeechRecognition is inconsistent across
   browsers (notably patchy on iOS Safari), so the button is removed
   outright when the API is missing rather than left sitting there as a
   control that silently does nothing when pressed. */
const MIC_ICON_HTML = ${JSON.stringify(MIC_ICON)};
const MIC_STOP_ICON_HTML = ${JSON.stringify(MIC_STOP_ICON)};
const micBtn = document.getElementById("mic-btn");
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognitionCtor) {
  micBtn.remove();
} else {
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;

  function stopListening() {
    listening = false;
    micBtn.removeAttribute("aria-pressed");
    micBtn.innerHTML = MIC_ICON_HTML;
  }

  recognition.addEventListener("result", (e) => {
    const transcript = e.results[0][0].transcript.trim();
    if (!transcript) return;
    qInput.value = qInput.value ? qInput.value + " " + transcript : transcript;
    qInput.focus();
  });
  recognition.addEventListener("end", stopListening);
  recognition.addEventListener("error", stopListening);

  micBtn.addEventListener("click", () => {
    if (listening) {
      recognition.stop();
      return;
    }
    listening = true;
    micBtn.setAttribute("aria-pressed", "true");
    micBtn.innerHTML = MIC_STOP_ICON_HTML;
    recognition.start();
  });
}

document.getElementById("chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = qInput;
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
    /* Table right under the tool step that produced it — "insert table
       right under 'ran catalog_preview_product_batch' text," the owner's
       own words — not after the agent's own text reply, which used to
       leave it looking disconnected from the tool call it actually came
       from once the reply had any real length to it. */
    (data.steps || []).forEach((s) => entry("tool", (s.ok ? "ran " : "refused ") + s.tool + (s.auditId ? " · audit " + s.auditId : "")));
    if (data.table) tableCard(data.table);
    entry("agent", data.reply || data.error || ("Request failed: " + res.status));
    if (data.pending) card(data.pending);
  } catch (err) {
    console.error("agent request failed", err);
    entry("agent", "Request failed: " + err.message);
  }
});

/* The one-click chips are quick PROMPTS now, not links to a separate page —
   chat is the one entry point for everything (the owner's own words: "I
   want them to go to chat"). Filling the box and submitting the same form
   reuses every bit of the handler above rather than duplicating the fetch. */
document.querySelectorAll(".choices .btn[data-prompt]").forEach((btn) => {
  btn.addEventListener("click", () => {
    qInput.value = btn.dataset.prompt;
    document.getElementById("chat").requestSubmit();
  });
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
/*
 * The Items tab — the owner's own words: "it should show all items and all
 * fields that are assigned to these items... this item view is where we
 * actually get to see them all and author them... a flexible grid layout
 * that uses the entire screen... using tiles, very clean tiles. So all the
 * information should be inside of these tiles, no external text outside of
 * the cells." This is the read (and, for a manager+, write) surface
 * custom_fields was built for — catalog.product's own data, rendered as one
 * self-contained card per item rather than a table row that only makes
 * sense next to the row above and below it.
 *
 * Employee-only by the same construction as the rest of ops: this file
 * exists only in the ops package (see the top-of-file comment), the whole
 * host is behind Cloudflare Access, and the storefront's own reads never
 * name `custom_fields` at all (P0-71) — nothing here is a second gate to
 * remember, it is the existing one.
 *
 * Editing goes through the SAME T2 approval gate every other catalog write
 * in this codebase does — catalog.set_channel and catalog.set_custom_fields,
 * both already manager+-gated and human-approved. A tile's own edit form
 * PARKS an approval and sends the browser to the existing /approvals/<id>
 * page (see index.js) rather than writing anything itself: no second,
 * lighter-weight "trusted because a manager clicked a button in ops" write
 * path is introduced alongside the one this whole app already has.
 */
const ITEMS_CSS = `
${OPS_DARK_CSS}
${INPUT_BAR_CSS}
/* Two columns down to phone width — the owner's own words: "on my
   phone, I want a two column layout... as it gets wider, it will just
   fill the entire screen." auto-fill's own minmax(240px, 1fr) never
   fits two columns below ~500px (2 * 240px alone exceeds most phone
   screens), collapsing to one. Fixed at exactly 2 below 480px, then
   auto-fill takes over — more columns as the viewport grows, same as
   before. */
/* Its own frame, its own scrollbar — same technique .log (the chat
   history) already uses for the identical reason. Caught live: typing
   into the search box re-filters tiles, changing the grid's own content
   height on every keystroke, which on a page with no height cap of its
   own made the WHOLE page scroll — losing sight of the grid entirely on
   a short screen. max-height + overflow-y: auto bounds the grid to
   roughly one screen's worth and scrolls internally past that, so
   filtering, and focusing the search box itself, never move the page
   underneath it. */
.items-grid {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 10px; align-items: start;
  max-height: min(72vh, 900px); overflow-y: auto;
}
@media (min-width: 480px) {
  .items-grid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
}
.item-tile {
  box-sizing: border-box; border: 1px solid var(--rule); border-radius: 8px;
  padding: 10px 12px; background: var(--image-ground); font-size: 12px;
  display: flex; flex-direction: column; gap: 6px;
}
/* Expanding one tile to the full screen instead of leaving every field
   crammed into a small grid cell — the owner's own words: "when I
   click on the item, it's gonna expand to my entire phone screen, and
   I should see all of that data." Same convention as .table-card.full
   in the chat log (TABLE_CARD_CSS above): the SAME element grows in
   place, no second element or separate scroll state to track. */
.item-tile.full {
  position: fixed; inset: 12px; z-index: 50; overflow: auto;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}
.item-tile h3 {
  margin: 0; font-size: 13px; color: var(--ink); line-height: 1.3;
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
}
.item-expand {
  flex: 0 0 auto; font: inherit; font-size: 10px; padding: 1px 6px; cursor: pointer;
  border: 1px solid var(--rule); border-radius: 999px; background: var(--ground); color: var(--muted);
}
.item-expand:hover { border-color: var(--accent); color: var(--accent); }
.item-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.item-badges span {
  font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--rule); color: var(--muted);
}
.item-badges .channel-website, .item-badges .channel-direct_link { border-color: var(--accent); color: var(--accent); }
.item-variants, .item-fields { display: flex; flex-direction: column; gap: 2px; }
.item-variants div, .item-fields div { display: flex; justify-content: space-between; gap: 6px; }
.item-variants span:first-child, .item-fields span:first-child { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-fields span:last-child { color: var(--ink); text-align: right; overflow-wrap: anywhere; }
.item-empty { color: var(--muted); font-style: italic; }
.item-edit { border-top: 1px solid var(--rule); margin-top: 2px; padding-top: 6px; }
.item-edit summary { cursor: pointer; color: var(--muted); font-size: 11px; }
.item-edit summary:hover { color: var(--accent); }
.item-edit form { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.item-edit .row { display: flex; gap: 4px; }
.item-edit input, .item-edit select {
  flex: 1 1 auto; min-width: 0; font: inherit; font-size: 11px; padding: 3px 5px;
  border: 1px solid var(--muted); border-radius: 4px; background: var(--ground); color: var(--ink);
}
.item-edit button {
  font: inherit; font-size: 11px; padding: 3px 8px; cursor: pointer; align-self: flex-start;
  border: 1px solid var(--rule); border-radius: 12px; background: var(--ground); color: var(--ink);
}
.item-edit button:hover { border-color: var(--accent); color: var(--accent); }
`;

const CHANNEL_LABEL = { in_store: "In store only", website: "Website", direct_link: "Direct link only" };

function itemTile(product, canEdit) {
  const fieldEntries = Object.entries(product.custom_fields ?? {});
  const searchText = [
    product.title,
    product.handle,
    product.category_name,
    product.status,
    product.channel,
    ...product.variations.map((v) => v.sku ?? ""),
    ...fieldEntries.flat(),
  ]
    .join(" ")
    .toLowerCase();

  const variantRows = product.variations.length
    ? product.variations
        .map((v) => `<div><span>${esc(v.sku || v.title)}</span><span>${esc(money(v.price_minor, v.currency))}</span></div>`)
        .join("")
    : `<p class="item-empty">No variations.</p>`;

  const fieldRows = fieldEntries.length
    ? fieldEntries.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")
    : `<p class="item-empty">No custom fields yet.</p>`;

  /* Up to 3 blank rows past the existing fields, so there is somewhere to
     type a brand-new field without any add-row scripting — the same
     "generous but capped" trade this file makes elsewhere. */
  const blankRows = Math.max(0, Math.min(3, CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS - fieldEntries.length));
  const fieldInputs =
    fieldEntries
      .map(
        ([k, v], i) =>
          `<div class="row"><input name="field_name_${i}" value="${esc(k)}" placeholder="Field name">` +
          `<input name="field_value_${i}" value="${esc(v)}" placeholder="Value (blank removes it)"></div>`,
      )
      .join("") +
    Array.from(
      { length: blankRows },
      (_, i) =>
        `<div class="row"><input name="field_name_${fieldEntries.length + i}" placeholder="Field name">` +
        `<input name="field_value_${fieldEntries.length + i}" placeholder="Value"></div>`,
    ).join("");

  const editForms = canEdit
    ? `<details class="item-edit">
         <summary>Edit</summary>
         <form method="post" action="/items/${esc(product.handle)}/channel">
           <div class="row">
             <select name="channel">
               ${Object.entries(CHANNEL_LABEL)
                 .map(([v, label]) => `<option value="${v}"${v === product.channel ? " selected" : ""}>${label}</option>`)
                 .join("")}
             </select>
             <button type="submit">Update channel</button>
           </div>
         </form>
         <form method="post" action="/items/${esc(product.handle)}/custom-fields">
           ${fieldInputs}
           <button type="submit">Save fields</button>
         </form>
       </details>`
    : "";

  return `<article class="item-tile" data-search="${esc(searchText)}" data-category="${esc(product.category_name || "")}">
    <h3><span>${esc(product.title)}</span><button type="button" class="item-expand">Expand</button></h3>
    <div class="item-badges">
      <span class="channel-${product.channel}">${esc(CHANNEL_LABEL[product.channel] ?? product.channel)}</span>
      <span>${esc(product.status)}</span>
      <span>${esc(product.category_name || "Uncategorized")}</span>
    </div>
    <div class="item-variants">${variantRows}</div>
    <div class="item-fields">${fieldRows}</div>
    ${editForms}
  </article>`;
}

export function itemsPage({ role }, products) {
  const canEdit = role === "manager" || role === "owner";
  const tiles = products.length
    ? products.map((p) => itemTile(p, canEdit)).join("\n")
    : `<p class="hint">No products in the mirror yet.</p>`;

  /* Existing categories only — the ones actually on a product here, not the
     full catalog.categories list a manager could create from. The owner's
     own words: "a quick way to filter by category," a filter over what is
     visibly on screen, not a second, separate category picker. */
  const categories = [...new Set(products.map((p) => p.category_name).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  const categoryMenu = categories.length
    ? `<div class="category-menu" id="category-menu" hidden>
    <button type="button" class="category-item" data-category="">All categories</button>
    ${categories.map((c) => `<button type="button" class="category-item" data-category="${esc(c)}">${esc(c)}</button>`).join("\n    ")}
  </div>`
    : "";

  return page(
    "Items — Vemians ops",
    /* No bar here either — see the same note on opsPage(). No "Items"
       title either — the owner's own words: "we have the tab, we know
       we're in items right now. Get rid of all that stuff." The tab
       bar itself already names the page; a second, page-drawn label
       right under it was pure wasted vertical space on a phone. The
       .greet section right below is not that title — it is the live
       category status ("All categories", "Category: Outerwear",
       "Agent: Dresses, Blue"), reusing the agent page's own "Hi
       Dimitri" spot and font (.greet h1) rather than a new one, moved
       up from a floating line above the search bar — the owner's own
       words: "on the bottom, you're just eating up useful space... so
       that all of these tabs have kinda matching layouts." Search sits
       BELOW the grid,
       not above it — the owner's own words: "it's not easy to put in
       stuff at the top of the screen of the phone." A thumb reaches
       the bottom of a phone screen far more easily than the top, so
       the one thing on this page that's typed into every time belongs
       where a thumb already rests, not up where it has to stretch.
       Fixed to the screen's own bottom (INPUT_BAR_CSS's own .input-bar,
       shared literally with the chat composer, not independently
       matched values) rather than structurally last on the page — the
       owner's own words, after the two drifted out of sync once
       already and after a screenshot showed a short catalog leaving it
       stranded mid-screen: "make them the same looking... there's not
       enough content to make them on the bottom." */
    `<main class="ops">
  <section class="greet">
    <h1 id="category-label">All categories</h1>
  </section>
  <div class="items-grid" id="items-grid">
${tiles}
  </div>
  ${categoryMenu}
  <div class="input-bar">
    <button type="button" class="icon-btn" id="category-btn" aria-label="Filter by category" title="Filter by category"${categories.length ? "" : " hidden"}>${FILTER_ICON}</button>
    <input type="text" id="item-search" placeholder="Search title, handle, SKU, custom fields...">
    <button type="button" class="icon-btn mic-btn" id="item-mic-btn" aria-label="Hold and describe what you're looking for" title="Hold and describe what you're looking for">${MIC_ICON}</button>
    <button type="button" class="send-btn" id="item-search-btn" aria-label="Search" title="Search">${SEARCH_ICON}</button>
  </div>
</main>
<script>
const itemSearch = document.getElementById("item-search");
const categoryLabel = document.getElementById("category-label");
const categoryBtn = document.getElementById("category-btn");
const categoryMenuEl = document.getElementById("category-menu");
/* The category filter lives here, never in the search box's own value —
   the owner's own words: "I don't wanna eat up the input area with text...
   it's part of the actual selector. It's not necessarily me putting text."
   A Set, not a single string — "the agent would pass the category as part
   of its result, and that menu would automatically select one or more
   categories to satisfy the search." The status line lives in the SAME
   spot and font as the agent page's own "Hi Dimitri" (.greet h1) rather
   than floating above the bar — the owner's own words: "on the bottom,
   you're just eating up useful space... so that all of these tabs have
   kinda matching layouts." Always shown, never hidden: "All categories"
   is itself the answer when nothing is picked, the same way "Hi Dimitri"
   is always there whether or not you have typed anything yet. */
const selectedCategories = new Set();
function markCategoryMenu() {
  if (!categoryMenuEl) return;
  categoryMenuEl.querySelectorAll(".category-item").forEach((btn) => {
    const isAll = btn.dataset.category === "";
    btn.classList.toggle("active", isAll ? selectedCategories.size === 0 : selectedCategories.has(btn.dataset.category));
  });
}
function updateCategoryLabel(source) {
  categoryLabel.textContent = selectedCategories.size
    ? source + ": " + [...selectedCategories].join(", ")
    : "All categories";
  markCategoryMenu();
}
/* Manual pick: toggles ONE category in or out of the set, multi-select,
   the menu stays open — the owner's own words allow "one or more." */
function toggleCategory(name) {
  if (!name) selectedCategories.clear();
  else if (selectedCategories.has(name)) selectedCategories.delete(name);
  else selectedCategories.add(name);
  updateCategoryLabel("Category");
}
/* Agent pick: REPLACES the whole set with exactly what the agent decided
   satisfies the request — a switch, not an addition, matching "it knows
   that I need to switch my category to dresses." */
function setAgentCategories(names) {
  selectedCategories.clear();
  names.forEach((n) => selectedCategories.add(n));
  updateCategoryLabel("Agent");
}
function filterItems() {
  const q = itemSearch.value.trim().toLowerCase();
  document.querySelectorAll(".item-tile").forEach((el) => {
    const matchesCategory = selectedCategories.size === 0 || selectedCategories.has(el.dataset.category);
    const matchesSearch = !q || el.dataset.search.includes(q);
    el.hidden = !matchesCategory || !matchesSearch;
  });
}
itemSearch.addEventListener("input", filterItems);
/* A visual match for the chat composer's own Send, not a second way to
   submit something the input already filters live on every keystroke —
   clicking it re-applies the same filter and returns focus to typing. */
document.getElementById("item-search-btn").addEventListener("click", () => {
  filterItems();
  itemSearch.focus();
});

/* The category menu — the owner's own words: "a little menu to select
   existing categories... a quick way to filter by category." Opened by
   the filter button; picking a category no longer closes it (multi-select
   needs to stay open for a second or third pick) — closed instead by the
   filter button again, clicking anywhere else, or Escape. The status
   line above no longer shares this spot (it moved to the top of the
   page, see updateCategoryLabel()'s own comment), so opening or closing
   the menu has nothing to do with it any more. */
if (categoryBtn && categoryMenuEl) {
  categoryBtn.addEventListener("click", () => {
    categoryMenuEl.hidden = !categoryMenuEl.hidden;
  });
  categoryMenuEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".category-item");
    if (!btn) return;
    toggleCategory(btn.dataset.category);
    filterItems();
  });
  document.addEventListener("click", (e) => {
    if (categoryMenuEl.hidden) return;
    if (categoryMenuEl.contains(e.target) || categoryBtn.contains(e.target)) return;
    categoryMenuEl.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || categoryMenuEl.hidden) return;
    categoryMenuEl.hidden = true;
  });
}

/* Voice search — the owner's own words: "by holding that microphone
   input, you can... describe what items you're looking for, and then
   the agent will just fill in the search bar with the proper filters
   or search pattern... it's not an agentic chat per se... I don't want
   to have a chat inside of the items view." Worked example: "let's say
   we have categories dresses, shoes, and jewelry... I'm currently set
   to jewelry... if I ask the agent to find all blue dresses, it knows
   that I need to switch my category to dresses... and then it's gonna
   do a filter for the color... blue." HELD, not toggled like the agent
   page's own mic — speech is transcribed client-side the same way, but
   the transcript goes to /items/search-intent (a single, non-agentic
   model call, agent.js's searchIntent()), which answers with a category
   and/or keywords rather than one blended string: a category switch
   applies through the SAME selector a manual click uses (labelled
   "Agent:" instead of "Category:", so it's visibly the agent's own
   call), and keywords fill the search box. Naming no category leaves
   whatever is already selected alone, matching the worked example:
   the model is told switching is expected only when the request
   actually names a different one. */
const DEFAULT_ITEM_SEARCH_PLACEHOLDER = itemSearch.placeholder;
const MIC_ICON_HTML = ${JSON.stringify(MIC_ICON)};
const MIC_STOP_ICON_HTML = ${JSON.stringify(MIC_STOP_ICON)};
const itemMicBtn = document.getElementById("item-mic-btn");
const ItemSpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!ItemSpeechRecognitionCtor) {
  itemMicBtn.remove();
} else {
  const recognition = new ItemSpeechRecognitionCtor();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;
  let heard = "";

  function resetMic() {
    listening = false;
    itemMicBtn.removeAttribute("aria-pressed");
    itemMicBtn.innerHTML = MIC_ICON_HTML;
  }

  async function sendToAgent(transcript) {
    itemSearch.placeholder = "Thinking...";
    const knownCategories = categoryMenuEl
      ? [...categoryMenuEl.querySelectorAll(".category-item[data-category]")].map((b) => b.dataset.category).filter(Boolean)
      : [];
    try {
      const res = await fetch("/items/search-intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: transcript, categories: knownCategories }),
      });
      const data = await res.json();
      /* One or more, comma-separated — "that menu would automatically
         select one or more categories to satisfy the search." Each named
         category is matched case-insensitively back to its real, exact
         name; anything that matches nothing real is dropped rather than
         inventing a category the menu does not have. */
      const matches = data && data.category
        ? data.category
            .split(",")
            .map((c) => c.trim().toLowerCase())
            .filter(Boolean)
            .map((c) => knownCategories.find((real) => real.toLowerCase() === c))
            .filter(Boolean)
        : [];
      if (matches.length) setAgentCategories(matches);
      if (data && data.keywords) itemSearch.value = data.keywords;
      else if (!matches.length) itemSearch.value = transcript;
    } catch (err) {
      /* The model or the network failed — the literal transcript still
         becomes a keyword search, so holding the mic never does nothing. */
      itemSearch.value = transcript;
    }
    itemSearch.placeholder = DEFAULT_ITEM_SEARCH_PLACEHOLDER;
    filterItems();
    itemSearch.focus();
  }

  recognition.addEventListener("result", (e) => {
    heard = e.results[0][0].transcript.trim();
  });
  recognition.addEventListener("end", () => {
    resetMic();
    if (heard) sendToAgent(heard);
    else itemSearch.placeholder = DEFAULT_ITEM_SEARCH_PLACEHOLDER;
    heard = "";
  });
  recognition.addEventListener("error", () => {
    resetMic();
    itemSearch.placeholder = DEFAULT_ITEM_SEARCH_PLACEHOLDER;
  });

  function startListening() {
    if (listening) return;
    listening = true;
    heard = "";
    itemMicBtn.setAttribute("aria-pressed", "true");
    itemMicBtn.innerHTML = MIC_STOP_ICON_HTML;
    itemSearch.placeholder = "Listening...";
    try {
      recognition.start();
    } catch (err) {
      /* Already started, most likely a duplicate mousedown/touchstart on
         the same press — not a real failure. */
    }
  }
  function stopListening() {
    if (!listening) return;
    recognition.stop();
  }

  itemMicBtn.addEventListener("mousedown", startListening);
  itemMicBtn.addEventListener("mouseup", stopListening);
  itemMicBtn.addEventListener("mouseleave", stopListening);
  itemMicBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startListening();
  });
  itemMicBtn.addEventListener("touchend", stopListening);
  itemMicBtn.addEventListener("touchcancel", stopListening);
}

/* One delegated listener for every tile's own Expand button, rather
   than one per tile — the same "no per-item wiring" trade the search
   filter above already makes. Toggling .full on the tile itself grows
   the SAME element in place (TABLE_CARD_CSS's own .table-card.full
   convention in the chat log) instead of opening a second element or
   tracking separate scroll state. */
document.getElementById("items-grid").addEventListener("click", (e) => {
  const btn = e.target.closest(".item-expand");
  if (!btn) return;
  const tile = btn.closest(".item-tile");
  const isFull = tile.classList.toggle("full");
  btn.textContent = isFull ? "Close" : "Expand";
});
</script>`,
    ITEMS_CSS,
  );
}

/*
 * Tickets — internal messages, staff to staff (Test-PRD-P0-100-ticket_messaging).
 * The owner's own words, once a shared company email domain was retired as the
 * way staff reach each other: "we will handle communication entirely through
 * our website internal messages." Reads the same `ticket`/`ticket_comment`
 * rows shared/db/tickets.sql already defines for P0-32 — this is that store's
 * first real UI, not a second, simpler thing built beside it.
 *
 * Same shape as itemsPage(): OPS_DARK_CSS + INPUT_BAR_CSS for the theme and
 * the shared pill, a list/detail split, and a compose bar fixed to the
 * screen's own bottom rather than structurally last on the page — every
 * input on every page looks and behaves the same, the rule the chat composer
 * and the Items search box already settled.
 */
const TICKET_CATEGORY_LABEL = {
  stock: "Stock", fulfilment: "Fulfilment", customer: "Customer", site: "Site",
  supplier: "Supplier", facilities: "Facilities", other: "Other",
};
const TICKET_STATUS_LABEL = {
  open: "Open", in_progress: "In progress", blocked: "Blocked", resolved: "Resolved", closed: "Closed",
};

const TICKETS_CSS = `
${OPS_DARK_CSS}
${INPUT_BAR_CSS}
.ticket-list { display: flex; flex-direction: column; gap: 8px; }
.ticket-tile {
  display: block; text-decoration: none; color: inherit;
  border: 1px solid var(--rule); border-radius: 8px;
  padding: 10px 12px; background: var(--image-ground); font-size: 12px;
}
.ticket-tile h3 { margin: 0 0 4px; font-size: 13px; color: var(--ink); line-height: 1.3; }
.ticket-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.ticket-badges span {
  font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--rule); color: var(--muted);
}
.ticket-badges .priority-high, .ticket-badges .priority-urgent { border-color: var(--accent); color: var(--accent); }
.ticket-meta { color: var(--muted); font-size: 11px; }
.ticket-empty { color: var(--muted); font-style: italic; }

/* One plain bubble per comment — no "you vs them" colour split like .log's
   chat bubbles, since every comment here is a coworker, not the assistant.
   The author line is what tells them apart, same as any plain message app. */
.ticket-thread { display: flex; flex-direction: column; gap: 8px; margin: 0 0 8px; }
.ticket-comment {
  padding: 8px 12px; border-radius: 14px; background: var(--image-ground);
  font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;
}
.ticket-comment .who { display: block; font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.ticket-status-form { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.ticket-status-form select, .ticket-status-form input {
  font: inherit; font-size: 12px; padding: 4px 6px;
  border: 1px solid var(--muted); border-radius: 6px; background: var(--ground); color: var(--ink);
}
.ticket-status-form input[name="note"] { flex: 1 1 160px; }
.ticket-status-form button {
  font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
  border: 1px solid var(--rule); border-radius: 999px; background: var(--ground); color: var(--ink);
}
.ticket-status-form button:hover { border-color: var(--accent); color: var(--accent); }
.ticket-back { display: inline-block; margin: 0 0 10px; color: var(--muted); font-size: 12px; text-decoration: none; }
.ticket-back:hover { color: var(--ink); }
.ticket-detail h2 { margin: 0 0 4px; font-size: 16px; }
.ticket-detail .ticket-meta { margin: 0 0 12px; }
.ticket-detail .ticket-body { font-size: 13px; white-space: pre-wrap; margin: 0 0 12px; }
.ticket-detail .hint { color: var(--accent); }
`;

function ticketBadges(ticket) {
  return `<div class="ticket-badges">
    <span>${esc(TICKET_CATEGORY_LABEL[ticket.category] ?? ticket.category)}</span>
    <span class="priority-${esc(ticket.priority)}">${esc(ticket.priority)}</span>
    <span>${esc(TICKET_STATUS_LABEL[ticket.status] ?? ticket.status)}</span>
  </div>`;
}

/* `viewerEmail` is only ever passed by dashboardPage() below — ticketsPage()
   calls this with one argument, so `mine` is always false there and every
   tile carries plain data-kind="ticket". A ticket assigned to the viewer
   also carries "task" (space-separated, like a class list), which is what
   lets the SAME tile satisfy both the "Tickets" and "Tasks" dashboard
   filters without a second, duplicate row for it. */
function ticketTile(ticket, viewerEmail) {
  const mine = Boolean(viewerEmail) && ticket.assigned_to === viewerEmail;
  return `<a class="ticket-tile" data-kind="ticket${mine ? " task" : ""}" href="/tickets/${esc(ticket.id)}">
    <h3>#${ticket.number ?? "?"} — ${esc(ticket.title)}</h3>
    ${ticketBadges(ticket)}
    <div class="ticket-meta">${esc(ticket.created_by)} &middot; ${esc(ticket.updated_at)}${ticket.assigned_to ? ` &middot; assigned: ${esc(ticket.assigned_to)}` : ""}</div>
  </a>`;
}

export function ticketsPage(tickets) {
  const list = tickets.length
    ? `<div class="ticket-list">${tickets.map((t) => ticketTile(t)).join("\n")}</div>`
    : `<p class="ticket-empty">No open tickets. Whatever comes up, start one below.</p>`;

  return page(
    "Messages — Vemians ops",
    /* No page title of its own — the shell's Messages tab already names the
       page, the same reasoning itemsPage() gives for dropping its own. The
       compose bar is a plain title-only quick-add (category/priority default
       to other/normal); a fuller edit happens once a ticket exists, from its
       own detail page, matching how Items keeps its quick search plain too. */
    `<main class="ops">
  ${list}
  <form class="chat" method="post" action="/tickets/new">
    <div class="chat-bar input-bar">
      <input type="text" name="title" placeholder="Start a new ticket..." required maxlength="200">
      <button type="submit" class="send-btn" aria-label="Create" title="Create">${SEND_ICON}</button>
    </div>
  </form>
</main>`,
    TICKETS_CSS,
  );
}

export function ticketPage(ticket, comments, { error } = {}) {
  const thread = comments.length
    ? `<div class="ticket-thread">${comments
        .map((c) => `<div class="ticket-comment"><span class="who">${esc(c.author)} &middot; ${esc(c.created_at)}</span>${esc(c.body)}</div>`)
        .join("\n")}</div>`
    : `<p class="ticket-empty">No comments yet.</p>`;

  const statusOptions = Object.keys(TICKET_STATUS_LABEL)
    .map((s) => `<option value="${s}"${s === ticket.status ? " selected" : ""}>${esc(TICKET_STATUS_LABEL[s])}</option>`)
    .join("");

  return page(
    `#${ticket.number} ${ticket.title} — Vemians ops`,
    `<main class="ops">
  <div class="ticket-detail">
  <a class="ticket-back" href="/dashboard">&larr; Dashboard</a>
  <h2>#${ticket.number} — ${esc(ticket.title)}</h2>
  ${ticketBadges(ticket)}
  <p class="ticket-meta">${esc(ticket.created_by)} &middot; ${esc(ticket.created_at)}</p>
  ${ticket.body ? `<p class="ticket-body">${esc(ticket.body)}</p>` : ""}
  ${error ? `<p class="hint">${esc(error)}</p>` : ""}
  </div>
  <form class="ticket-status-form" method="post" action="/tickets/${esc(ticket.id)}/status">
    <select name="status">${statusOptions}</select>
    <input type="text" name="note" placeholder="Note (required to resolve or close)" maxlength="${CAPS.MAX_TEXT}">
    <button type="submit">Update</button>
  </form>
  ${thread}
  <form class="chat" method="post" action="/tickets/${esc(ticket.id)}/comment">
    <div class="chat-bar input-bar">
      <input type="text" name="body" id="ticket-comment-body" placeholder="Add a comment..." required maxlength="${CAPS.MAX_TEXT}">
      <button type="button" class="icon-btn" id="ticket-comment-mic" aria-label="Dictate" title="Dictate">${MIC_ICON}</button>
      <button type="submit" class="send-btn" aria-label="Send" title="Send">${SEND_ICON}</button>
    </div>
  </form>
</main>
<script>
${dictationScript({ btnId: "ticket-comment-mic", inputId: "ticket-comment-body" })}
</script>`,
    TICKETS_CSS,
  );
}

function dashboardExpenseTile(expense) {
  const amount = (expense.amount_minor / 100).toFixed(2);
  return `<div class="ticket-tile" data-kind="expense">
    <h3>${esc(expense.description)}</h3>
    <div class="ticket-badges">
      <span>Expense</span>
      <span>${esc(expense.status)}</span>
      <span>${amount} ${esc(expense.currency)}</span>
    </div>
    <div class="ticket-meta">${esc(expense.employee_name || expense.employee_id || "unknown")} &middot; ${esc(expense.incurred_on)}</div>
  </div>`;
}

function dashboardUploadTile(asset) {
  return `<a class="ticket-tile" data-kind="upload" href="/assets/${esc(asset.id)}">
    <h3>${esc(asset.filename)}</h3>
    <div class="ticket-badges">
      <span>Upload</span>
      <span>${asset.has_text ? "text readable" : "download only"}</span>
    </div>
    <div class="ticket-meta">${esc(asset.uploaded_by)} &middot; ${esc(asset.uploaded_at)}</div>
  </a>`;
}

/*
 * Dashboard — the ops home page, once "Messages" stopped being just
 * tickets (Test-PRD-P0-108-ops_dashboard). The owner's own words: "it's
 * not just about messages. It's like a bulletin board. It's a place to
 * share assets... invoices... it could be a ticket from a customer. It
 * could be an expense. It could be just a file upload... or a task."
 *
 * ONE FEED, THREE ALREADY-EXISTING T0 READS
 *   No new store, no new schema — every row here already had a home and a
 *   tool (ticket.list, expense.list, assets.list). "Task" is not a fourth
 *   store or a new ticket.category value (widening that CHECK constraint
 *   on a live D1 table has no supported ALTER path in SQLite, only a
 *   drop/recreate/copy-data rebuild this repo has no tooling for); it is
 *   a computed filter over the same tickets — one assigned to the
 *   viewer — expressed purely by ticketTile()'s own data-kind attribute,
 *   never a stored value. expense.list's own role scoping (staff see only
 *   their own submissions) is untouched — this page reads it exactly as
 *   every other caller does, never widening it.
 *
 * DEFAULT VIEW IS A SERVER-COMPUTED HINT, NOT A HARD RULE
 *   The owner's own words: "by default, it should be on tasks... however,
 *   if there are any tickets, say from a customer, that should take
 *   precedence over tasks." src/index.js's /dashboard route decides which
 *   one before this function ever runs (an open ticket in the 'customer'
 *   category anywhere in the working set switches the default from "task"
 *   to "ticket") and hands the answer in as `defaultKind` — this function
 *   only seeds the filter's initial Set with it. Nothing here is fixed:
 *   the filter menu (the same shape Items' own category picker already
 *   established, reusing its CSS literally rather than a second copy)
 *   lets anyone switch to any of the four views, or "All", at any time.
 *
 * THE MIC HERE IS PLAIN DICTATION, NOT THE AGENTIC ONE
 *   The owner's own words: "it's not an agentic microphone. It's just a
 *   normal microphone where you can speak to make a comment." class=
 *   "icon-btn" alone (no "mic-btn"), so it never borrows the orange
 *   reserved for the two genuinely agentic mics (the agent composer,
 *   Items' own voice search) — see dictationScript()'s own comment.
 */
export function dashboardPage({ tickets, expenses, uploads, viewerEmail, defaultKind }) {
  const items = [
    ...tickets.map((t) => ({ sortKey: t.updated_at || t.created_at || "", html: ticketTile(t, viewerEmail) })),
    ...expenses.map((e) => ({ sortKey: e.incurred_on || "", html: dashboardExpenseTile(e) })),
    ...uploads.map((a) => ({ sortKey: a.uploaded_at || "", html: dashboardUploadTile(a) })),
  ].sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));

  const feed = items.length
    ? `<div class="ticket-list" id="dash-feed">${items.map((i) => i.html).join("\n")}</div>
  <p class="ticket-empty" id="dash-feed-empty" hidden>Nothing to show for this filter.</p>`
    : `<p class="ticket-empty">Nothing here yet.</p>`;

  return page(
    "Dashboard — Vemians ops",
    /* No page title of its own — same reasoning itemsPage() and
       ticketsPage() already give: the shell's own Dashboard tab already
       names the page. The .greet section below is the mode indicator
       instead — "in our dashboard, instead of categories, we essentially
       have a mode selector... indicating the currently selected mode in
       the same space... so that all of these tabs have kinda matching
       layouts," the owner's own words, matching itemsPage()'s own
       category status living in the same spot and font as the agent
       page's "Hi Dimitri" (.greet h1). */
    `<main class="ops">
  <section class="greet">
    <h1 id="kind-label">Showing: All</h1>
  </section>
  ${feed}
  <div class="category-menu" id="kind-menu" hidden>
    <button type="button" class="category-item" data-kind="">All</button>
    <button type="button" class="category-item" data-kind="task">Tasks</button>
    <button type="button" class="category-item" data-kind="ticket">Tickets</button>
    <button type="button" class="category-item" data-kind="expense">Expenses</button>
    <button type="button" class="category-item" data-kind="upload">Uploads</button>
  </div>
  <form class="chat" method="post" action="/tickets/new">
    <div class="chat-bar input-bar">
      <button type="button" class="icon-btn" id="kind-btn" aria-label="Filter" title="Filter">${FILTER_ICON}</button>
      <input type="text" name="title" id="dash-title" placeholder="Start a new ticket..." required maxlength="200">
      <button type="button" class="icon-btn" id="dash-mic" aria-label="Dictate" title="Dictate">${MIC_ICON}</button>
      <button type="submit" class="send-btn" aria-label="Create" title="Create">${SEND_ICON}</button>
    </div>
  </form>
</main>
<script>
const DASH_KIND_LABEL = { ticket: "Tickets", task: "Tasks", expense: "Expenses", upload: "Uploads" };
const kindMenuEl = document.getElementById("kind-menu");
const kindBtn = document.getElementById("kind-btn");
const kindLabel = document.getElementById("kind-label");
const feedEmpty = document.getElementById("dash-feed-empty");
/* Seeded server-side (see this function's own header) — "by default, it
   should be on tasks... however, if there are any tickets, say from a
   customer, that should take precedence." Still just a starting Set: any
   view below is one click away. */
const selectedKinds = new Set(${JSON.stringify(defaultKind ? [defaultKind] : [])});

function markKindMenu() {
  kindMenuEl.querySelectorAll(".category-item").forEach((btn) => {
    const isAll = btn.dataset.kind === "";
    btn.classList.toggle("active", isAll ? selectedKinds.size === 0 : selectedKinds.has(btn.dataset.kind));
  });
}
function updateKindLabel() {
  kindLabel.textContent = selectedKinds.size
    ? "Showing: " + [...selectedKinds].map((k) => DASH_KIND_LABEL[k] || k).join(", ")
    : "Showing: All";
  markKindMenu();
}
function toggleKind(name) {
  if (!name) selectedKinds.clear();
  else if (selectedKinds.has(name)) selectedKinds.delete(name);
  else selectedKinds.add(name);
  updateKindLabel();
}
/* A ticket assigned to the viewer carries BOTH "ticket" and "task" in its
   own data-kind (space-separated, like a class list) — this is what lets
   the same tile satisfy either filter without a second, duplicate row. */
function filterFeed() {
  let visible = 0;
  document.querySelectorAll("#dash-feed .ticket-tile").forEach((el) => {
    const kinds = (el.dataset.kind || "").split(" ");
    const show = selectedKinds.size === 0 || kinds.some((k) => selectedKinds.has(k));
    el.hidden = !show;
    if (show) visible++;
  });
  if (feedEmpty) feedEmpty.hidden = visible !== 0;
}

/* The status line lives at the top of the page now (the .greet section
   above), not sharing this floating spot with the menu any more — see
   updateKindLabel()'s own comment — so opening or closing the menu has
   nothing to do with it. */
if (kindBtn && kindMenuEl) {
  kindBtn.addEventListener("click", () => {
    kindMenuEl.hidden = !kindMenuEl.hidden;
  });
  kindMenuEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".category-item");
    if (!btn) return;
    toggleKind(btn.dataset.kind);
    filterFeed();
  });
  document.addEventListener("click", (e) => {
    if (kindMenuEl.hidden) return;
    if (kindMenuEl.contains(e.target) || kindBtn.contains(e.target)) return;
    kindMenuEl.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || kindMenuEl.hidden) return;
    kindMenuEl.hidden = true;
  });
}

updateKindLabel();
filterFeed();

${dictationScript({ btnId: "dash-mic", inputId: "dash-title" })}
</script>`,
    TICKETS_CSS,
  );
}

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
  /* The "sign in" note only makes sense for an IDENTITY refusal (401/403) —
     it was appended unconditionally, so a 500 or 503 (the Items mirror
     failing to read, a store not configured yet) told the reader to sign
     in with their Vemians email right under a reason that has nothing to
     do with who they are. Confusing on its own; actively misleading right
     under a 500 that already names the real, unrelated fix. */
  const identityNote =
    status === 401 || status === 403
      ? `<p class="note">This page is for Vemians staff and asks you to sign in first. If you are staff and
     landed here, sign in with your Vemians email and try again.</p>`
      : "";
  return page(
    "Refused",
    `<div class="bar">ops.vemians.com</div>
<main class="ops">
  <h2>${status} &mdash; refused</h2>
  <p>${esc(reason)}</p>
  ${identityNote}
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

export function approvalResultPage(ok, detail, { backHref = "/", backLabel = "Back to ops" } = {}) {
  return page(
    ok ? "Approved" : "Not approved",
    `<main class="wrap">
       <h1>${ok ? "Done" : "Not approved"}</h1>
       <pre>${esc(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2))}</pre>
       <p><a href="${esc(backHref)}">${esc(backLabel)}</a></p>
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
  /* One table, not a <ol> of ready links plus a separate <ul> of skip
     reasons — the same Row/Title/Status/Detail shape the chat's own
     tableCard() already uses for this exact data (agent.js's own
     batchDraftTable()), so a spreadsheet reviewed here reads the same
     way as one reviewed in chat. The owner's own words, having seen
     both: "I like how the table renders in our chat! Doesn't look like
     that on our website!" */
  const rows = [
    ...ready.map((r) => ({ row: r.row, title: r.title, status: "ready", detail: r.summary, url: r.url })),
    ...skipped.map((s) => ({ row: s.row, title: s.title, status: "skipped", detail: s.reason, url: null })),
  ].sort((a, b) => a.row - b.row);

  return page(
    "Spreadsheet uploaded",
    `<main class="wrap">
       <p class="eyebrow">Spreadsheet uploaded</p>
       <h1>${ready.length} ready to review, ${skipped.length} not added</h1>
       ${
         ready.length
           ? `<p class="fine">Each ready row is its own approval — nothing is created until you open it and
                 say yes, the same as ${k.createVerb === "add" ? "adding" : "creating"} one ${k.noun} by hand.</p>`
           : "<p>Nothing in this file was ready to add.</p>"
       }
       ${
         rows.length
           ? `<div class="table-card"><table>
                <thead><tr><th>Row</th><th>Title</th><th>Status</th><th>Detail</th></tr></thead>
                <tbody>${rows
                  .map(
                    (r) =>
                      `<tr><td>${r.row}</td><td>${r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title)}</td>` +
                      `<td>${r.status}</td><td>${esc(r.detail)}</td></tr>`,
                  )
                  .join("")}</tbody>
              </table></div>`
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
${TABLE_CARD_CSS}
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
