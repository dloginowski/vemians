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

/* theme.css's own .ops (shared/design/theme.css) is generic across both
   Workers: max-width: 60rem, margin: 0 auto (centred), padding: 24px 16px
   64px. OPS_CSS has long overridden this for the agent page alone —
   64rem, flush left (no margin: auto — see INPUT_BAR_CSS's own comment on
   why that is load-bearing for .input-bar's max-width), tighter 8px sides,
   and a slim 12px top so "Hi Dimitri" sits right under the tab bar rather
   than a generic page's own roomier 24px gap. ITEMS_CSS and TICKETS_CSS
   import THIS shared base already but never carried that same override,
   so Items' and the Dashboard's own status line silently sat twice as far
   from the top as the agent page's "Hi Dimitri" — caught live once the
   two were put side by side: "you need to match the agent exactly...
   that exact place, that exact font." Moved here so every ops page gets
   it, not just the one that happened to declare it first. Bottom is 76px
   here — enough to clear .input-bar alone (its own ~42px height + 8px
   offset + a little breathing room) — the correct default for a page
   with no OTHER floating row above the bar (every ops page today,
   opsPage() included, once its own quick-action chips were removed —
   see OPS_CSS's own comment). */
.ops { max-width: 64rem; padding: 12px 8px 76px; }
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
/* The same [hidden]-vs-explicit-display trap .category-menu was caught by
   earlier: an explicit display: inline-flex above always beats the
   browser's own default [hidden] { display: none }, regardless of
   specificity, so a bar button toggled via the hidden ATTRIBUTE (the
   Dashboard's own mic/attach swap per mode — Test-PRD-P0-110-
   dashboard_modes) would render anyway. Restated here so JS toggling
   .hidden actually hides it. */
.input-bar button[hidden] { display: none; }
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
   single class on the same element, so source order decides.
   :hover restates color: var(--ground) explicitly — the owner's own
   words, reporting a real bug: "after recording something with the
   microphone and pressing stop, the glyph disappears... it should be
   coming back to that dark gray glyph." Root cause, found by rendering
   and inspecting computed styles rather than assumed: clicking a button
   leaves the cursor hovering over it, and .mic-btn:hover never redeclared
   its own color — with only background/opacity here, .icon-btn:hover's
   own "color: var(--accent)" (equal specificity, but that's the only
   rule setting color for a hovered state) won by default, painting the
   icon the SAME orange as its own background and camouflaging it
   completely. Every state of this button needs its own explicit color,
   the same lesson .mic-btn[aria-pressed] already had right. */
.input-bar .mic-btn { background: var(--accent); color: var(--ground); }
.input-bar .mic-btn:hover { background: var(--accent); color: var(--ground); opacity: 0.85; }
.input-bar .mic-btn[aria-pressed="true"] { background: var(--accent); color: var(--ground); opacity: 0.7; }
/* Send is the SAME faint neutral fill as icon-btn by default now, not the
   accent orange it used to always be — the owner's own words: "don't
   style the search button orange, because orange indicates AI input...
   agentic input... that's the only thing that should have that orange
   decoration." Orange is reserved for #chat's own Send and #dash-send
   below, the two buttons whose own active/disabled state actually needs
   a visible ON/OFF read (see the comment on those, below); every other
   .send-btn (Items' search, a ticket's Create/Send) shares this neutral
   look instead of borrowing a meaning that is not true of it. */
.input-bar .send-btn { width: 34px; height: 34px; background: rgba(255, 255, 255, 0.08); color: var(--ink); }
.input-bar .send-btn:hover { background: rgba(255, 255, 255, 0.16); color: var(--accent); }
.input-bar .send-btn:disabled { opacity: 0.4; cursor: default; }
/* #chat is the id ONLY the real agent composer's form carries (opsPage());
   #dash-send is the Dashboard's own compose bar submit button
   (dashboardPage(), id="dash-compose" — a different form, no "chat" id,
   so it needed its own selector added to this group). Both grouped here
   since the owner's own words asked for the Dashboard's own button to
   match exactly: "the send arrow in dashboard also needs a disabled
   state (same dark gray glyph) when there is no entry." Icon is --ink
   (the palette's own bright warm-white) rather than --ground (near-black
   in this dark theme) — the owner's own words, comparing this to a
   reference UI: "when it's active, it's a much brighter orange... and a
   white arrow." Disabled is a distinct look, not just faded: a dim tint
   of the same accent hue (rather than the neutral gray every other
   .send-btn falls back to) so the button still reads as "the one action
   that actually does something," just inactive. The glyph went through
   three tries before landing on the right dark: --muted, then --rule,
   both too faded once actually rendered — the owner's own final
   clarification pointed at a concrete reference already on the same bar,
   the mic's own icon: "it needs to be that microphone icon dark, just
   like the microphone." .mic-btn's own icon is --ground against its own
   bright orange fill — matched here exactly, the same reason this pair
   needs a bright accent background at all: --ground reads as "dark gray"
   only against something bright enough to contrast it, which is also
   why #dash-send couldn't just borrow this glyph color on its own
   previous neutral fill (near-black on near-black is no glyph at all,
   verified directly before assuming otherwise) — the whole scheme moves
   with it, not just the one color. Full opacity (overriding the shared
   .input-bar .send-btn:disabled's own 0.4) since these colors are
   already the dim version on purpose. */
#chat .send-btn, #dash-send { background: var(--accent); color: var(--ink); }
#chat .send-btn:hover, #dash-send:hover { background: var(--accent); opacity: 0.85; }
#chat .send-btn:disabled, #dash-send:disabled { background: rgba(217, 119, 87, 0.35); color: var(--ground); opacity: 1; cursor: default; }
#chat .send-btn:disabled:hover, #dash-send:disabled:hover { background: rgba(217, 119, 87, 0.35); }
/* The filter menu that opens above a bar's own filter button — Items'
   category picker first (the owner's own words: "a little menu to select
   existing categories... a quick way to filter by category"), then the
   Dashboard's own kind picker (Tickets/Tasks/Expenses/Uploads) reusing the
   same shape rather than a second, independently matched copy. Moved here
   from ITEMS_CSS once a second bar needed it — shared, not duplicated, the
   same reasoning every other rule in this file already gets. position:
   fixed, anchored a gap above .input-bar's own bottom (8px offset + 42px
   height + 8px gap = 58px), left-aligned near the filter button rather
   than spanning the full bar. */
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
/* 11px, pill-ish, a muted border on --image-ground — kept as its own
   rule rather than a shared one, since nothing else on these two pages
   needs quite this shape. */
.category-menu .category-item {
  display: block; width: 100%; text-align: left; font: inherit; font-size: 11px;
  padding: 6px 10px; border: 1px solid var(--rule); border-radius: 999px;
  background: var(--ground); color: var(--ink); cursor: pointer;
}
/* Neutral, not the accent — a plain hover affordance, never the "this is
   checked" look. Caught live: "when I uncheck a category selection, I
   expect the button to not be orange anymore, but it is" — the class WAS
   removed correctly (verified directly, not assumed), but :hover shared
   the exact same border/text colour as .active, so a just-unchecked
   button still looked selected for as long as the pointer sat over it,
   which is usually right where a click just happened. */
.category-menu .category-item:hover { border-color: var(--ink); color: var(--ink); }
/* Checked state — "that menu would automatically select one or more
   categories to satisfy the search," the owner's own words. Multi-select:
   more than one can carry this at once. Same faint-accent-tint language
   .icon-btn[aria-pressed="true"] already uses for an active toggle state,
   not a new visual vocabulary invented for this. Declared after :hover so
   it wins the tie while a checked button is also being hovered — the
   only state orange should ever mean here is "checked." */
.category-menu .category-item.active { border-color: var(--accent); color: var(--accent); background: rgba(217, 119, 87, 0.14); }
/* The "Hi Dimitri" spot (opsPage(), formerly OPS_CSS only) — moved here so
   Items' own category status and the Dashboard's own mode status can sit
   in the exact same place and font, rather than floating in a line above
   the search/compose bar the way both used to. The owner's own words:
   "put the categories in there, in the top... use that same font, same
   kind of layout... so that all of these tabs have kinda matching
   layouts." Centred and quiet on purpose — a status line, not the thing
   on the page asking to be read first. Always shown, never conditionally
   hidden: "Hi Dimitri" is there whether or not you have typed anything
   yet, and so is "All categories"/"Showing: All" here.
   15px on every one of the three, not just Dashboard's own — the owner's
   own words: "make sure that the agents and the items also have the
   bigger font size for the top header... just so it's all consistent."
   Dashboard's own #dash-status-heading (below INPUT_BAR_CSS) had already
   been bumped from the shared 11px to 15px on its own, since it also
   carries an interactive control (the status dropdown); rather than
   leave the other two pages' own status line smaller, the SHARED rule
   itself now carries that same 15px, and the Dashboard-specific override
   is gone — one size, one place to look, not the same number declared
   twice. */
.greet { margin: 0 0 6px; text-align: center; }
.greet h1 { font-size: 15px; font-weight: 400; color: var(--muted); margin: 0; }
/* The status filter sits inline in the same "Showing: X" line — the
   owner's own words: "add to the Showing: [mode] - [status dropdown]."
   font: inherit off .greet h1 keeps it the same muted look rather than
   the browser's own default control styling. Shared here (not left in
   TICKETS_CSS, its original home) once Items grew a status filter of its
   own (P0-131) — the same select styling, not a second copy. */
.dash-status-select {
  font: inherit; font-size: 11px; color: var(--muted);
  background: transparent; border: 1px solid var(--rule); border-radius: 4px;
  padding: 1px 4px; vertical-align: baseline;
}
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
/* Headers no longer wrap; data cells still do — the owner's own words,
   after trying it the other way twice: first "I would rather have the
   table expand and scroll horizontally than expand vertically... bump
   up the font," then "actually, cancel that, let it wrap, just make a
   bigger font," then the final correction: "do prevent the headings
   from wrapping because they're hard to read. The data I don't care so
   much about, but the headings should all expand to fit content,
   horizontally." So table-layout goes back from "fixed" to "auto" and
   "width: 100%" is dropped — a header cell's own "white-space: nowrap"
   (below) can only force the column wide enough for its own text if the
   table is actually free to size columns by content again, not forced
   to squeeze every column into one fixed, equal-ish share of the card's
   width. Data cells keep "overflow-wrap: anywhere" / "word-break:
   break-word" exactly as before — wrapping there was never the
   complaint — so a table with one long header and short data still
   reads as mostly narrow columns with one wide one, not every column
   forced as wide as the widest header. The card's own existing
   "overflow: auto" (unchanged) is what actually delivers the "scroll
   sideways rather than crop" the owner asked for, now that a row of
   nowrap headers can legitimately push the table past the card's own
   width.

   One guard the request itself didn't ask for but needs regardless:
   without a floor, a data column that CAN break anywhere (a long title,
   no spaces to wrap on) gets squeezed down to a near-zero, one-character
   width the moment a neighboring nowrap header claims most of the row's
   space — verified directly in a real browser, not assumed, and it read
   as far less legible than simply wrapping onto more lines at a sane
   width would. "min-width: 6em" on data cells only (never on th, which
   already has its own nowrap floor) keeps every column at least a
   handful of characters wide before it starts wrapping.

   The font is bigger too — "bump up the sizes of the font so it's more
   readable... might as well just make the font bigger a couple sizes" —
   9px (this card's smallest round yet) becomes 12px everywhere in the
   card, matching title bar and button as every previous round of this
   card's own sizing already kept in step. Padding is untouched; only
   the font asked to grow. max-height is recomputed once more for the
   taller row height a bigger font produces. */
.table-card {
  align-self: stretch; max-width: 100%; box-sizing: border-box;
  border: 1px solid var(--rule); border-radius: 0; padding: 2px;
  background: var(--image-ground); font-size: 12px;
  max-height: 86px; overflow: auto;
}
.table-card h4 {
  margin: 0 0 2px; padding: 0; font-size: 12px; font-weight: 700;
  color: var(--muted); display: flex; justify-content: space-between;
  align-items: center; gap: 6px; position: sticky; left: 0;
}
.table-card table { table-layout: auto; border-collapse: collapse; }
/* Centered everywhere now, not just headers — the owner's own words,
   right after seeing headers alone centered: "make the data center
   aligned too. Why not? Just make it all center aligned." Superseding
   Test-PRD-P0-122-table_headers_centered's own left-aligned data: one
   rule for the whole table now, rather than a header-only override. */
.table-card th, .table-card td {
  text-align: center; padding: 1px 2px; border: 1px solid var(--rule);
  vertical-align: top; font-size: 12px;
}
.table-card td { overflow-wrap: anywhere; word-break: break-word; min-width: 6em; }
.table-card th { color: var(--ink); font-weight: 700; background: var(--ground); white-space: nowrap; }
.table-card a { color: var(--accent); overflow-wrap: anywhere; }
.table-card button {
  flex: 0 0 auto; font: inherit; font-size: 12px; padding: 1px 2px; cursor: pointer;
  border: 1px solid var(--rule); border-radius: 12px; background: var(--ground); color: var(--ink);
}
.table-card button:hover { border-color: var(--accent); color: var(--accent); }
/* Full screen is a fixed overlay, not a new scroll container elsewhere on
   the page — the same element just grows to cover the viewport in place. */
.table-card.full {
  position: fixed; inset: 12px; z-index: 50; max-height: none;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}
/* A batch preview is one header row plus PREVIEW_SAMPLE_ROWS (1) data row
   now (batch.js) — small and fixed in size, never the hundreds of rows
   batchDraftTable()'s own full result can carry. The owner's own words,
   after the fixed 58px cap still clipped it: "the preview in chat still
   doesn't expand vertically to show the entire table... make sure the
   height fits all the data." No cap at all for this one — the outer .log
   scroll frame already bounds the whole chat column if it ever runs long. */
.table-card.preview { max-height: none; }
/* The preview's own data cells crop with an ellipsis instead of wrapping
   — the owner's own correction, after Test-PRD-P0-119-table_headers_never_wrap
   let data wrap onto as many lines as it needed: "your test is a little
   unrealistic... a real heading is never more than a couple dash-
   separated words. The description, I would maybe add ellipses to it to
   just prevent it from wrapping... this is a preview, I don't care to
   see all of the data inside the table cells. Our number one concern is
   making sure the data in the CSV matches the headings — a legible view
   of the entire heading, and a preview of the data underneath, even if
   it's cropped by ellipses, as long as we get the idea of what's in
   there. We should never have to scroll vertically." Cancels
   .table-card td's own general "overflow-wrap: anywhere; word-break:
   break-word; min-width: 6em" for the PREVIEW card only — that base
   behavior is untouched for batchDraftTable()'s own full ready/skipped
   result (still plain .table-card, still wrapping, since reading a real
   skip reason in full still matters there). "white-space: nowrap" plus
   "overflow: hidden; text-overflow: ellipsis" needs a hard "max-width" to
   have anything to clip against — table-layout: auto alone would just
   let an unwrapped cell claim its own full natural width, the same as a
   header now does. 10em is enough to recognize what a value is without
   guaranteeing the whole thing is visible; "Full screen" is the escape
   hatch for anyone who needs a cropped value in full — it lifts the
   ellipsis crop back to plain wrapping while active, the same as every
   other .table-card's own cells already read. */
.table-card.preview td {
  overflow-wrap: normal; word-break: normal; min-width: 0; max-width: 10em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.table-card.preview.full td {
  overflow-wrap: anywhere; word-break: break-word; max-width: none;
  white-space: normal; overflow: visible; text-overflow: clip;
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
   own edge specifically rather than a shared log-and-composer one.)
   Recomputed twice more since: 8px (.ops) + 7px (.chat-top's own side
   padding, halved) = 15px, then — once .chat-top's own side padding and
   .log's own padding both dropped to 0 entirely, matching the Items
   grid's own flush layout — back down to a flat 8px, the same point
   .items-grid's own content starts at too. The tab now lines up with
   every tab's own content edge, not only the chat's. */
.shell-header { flex: 0 0 auto; padding: 10px 8px 0; background: var(--bar); }
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
/* max-width/top/side/bottom padding all come from the shared .ops rule in
   OPS_DARK_CSS now — this page no longer needs its own wider bottom
   padding for a second floating row, since .menu (the quick-action
   chips) was removed once the Dashboard gave "add a ticket, a task, an
   expense, an upload" an actual place to happen: "remove the quick
   action buttons from agent, I think they're redundant now that we have
   an actual mechanism to add things in our dashboard... it's just
   clutter at this point." The underlying capability is untouched — the
   model still offers the same numbered menu on its own first message
   (greeting.js's greetingScript()) — only the clickable shortcut chips
   are gone: "the functionality should still exist... maybe you can
   suggest... when you say hi to agent... there don't need to be an
   actual button that you click on." */

.ops .warn { margin: 0 0 14px; }

.hint { font-size: var(--eyebrow); color: var(--muted); margin: 0 0 8px; }
.hint a { color: var(--accent); }

/* The widget itself reads as one contained thing — a border around the
   whole assistant, not just around the log inside it — so it does not look
   like loose page furniture. Rounder than a typical card, closer to the
   composer shape it wraps, per the reference screenshot of a mobile chat
   composer this was asked to match. */
/*
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
 * tiles do, with only their own padding for spacing.
 *
 * Sides halved once (14px -> 7px), then dropped entirely — the owner's
 * own words, still not satisfied: "I'm still seeing more padding on the
 * agent chat... if you look at the items page, the items have much less
 * side padding than the agent chat does. Match the agent chat padding
 * to the items, and make sure all of them match the items padding."
 * Items' own grid (.items-grid) carries NO padding of its own at all —
 * each item-tile's own border and padding is the only thing between a
 * tile and its neighbor, and the grid sits flush against .ops's own 8px
 * side inset with nothing else in between. .chat-top's own side padding
 * goes to 0 for the same reason: .log's message bubbles already carry
 * their own padding and background exactly the way an item-tile does
 * (.log p, below), so an outer frame around .log serves no purpose
 * .items-grid doesn't already do without one. Top/bottom stay 14px —
 * this was never about vertical rhythm, only "notice how much padding
 * is on the SIDES." */
.chat-top {
  padding: 14px 0; margin-bottom: 16px;
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
   (before the composer form); padding was a uniform 2px matching the side
   value, so top and sides worked out to the same total distance from
   .chat-top's own edge.
   That "top matches side" invariant is superseded now, and on purpose —
   .chat-top's own side padding is 0 (see above), and the owner's own
   later words leave no ambiguity about which side of the trade-off to
   take: "match the agent chat padding to the items... make sure all of
   them match the items padding." Items' own grid has no padding of its
   own at all; .log's own 2px would still leave the bubbles 2px further in
   than an item-tile, so it drops to 0 too — each bubble's own padding
   (.log p, below) is exactly what an item-tile's own padding already is,
   the only spacing either one needs. */
.log {
  display: flex; flex-direction: column; gap: 6px;
  max-height: min(62vh, 560px); overflow-y: auto;
  margin: 0 0 8px; padding: 0;
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

/* A chain link, not CLIPBOARD above — the owner's own words, on Items' own
   "copy a link to this item" button: "pick something better, some better
   icon for a URL, like a share button... you have like a window button."
   CLIPBOARD's own rectangle-with-a-tab reads as a little window or a
   document, not a link, once it is the only thing on the button (no
   adjacent <pre> to give it context the way copyLine()'s own use of it
   always has). Two hooked strokes overlapping on the diagonal is the
   universal "link"/"chain" glyph — what "copy a link" means everywhere
   else this action shows up. */
const LINK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">` +
  `<path d="M7.1 4.4 8.3 3.2a2.3 2.3 0 0 1 3.3 3.3L10.3 7.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>` +
  `<path d="M8.9 11.6 7.7 12.8a2.3 2.3 0 0 1-3.3-3.3l1.2-1.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>` +
  `<path d="M6.4 9.6 9.6 6.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

/* The variations accordion's own expand/collapse control (views.js's own
   itemTile()) — a plain chevron, rotated in place via .expanded rather
   than swapped for a second glyph, the same "one element, one state
   toggle" trade .item-tile.full itself already makes. */
const CARET_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">` +
  `<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* The one Save for a whole expanded item tile — the owner's own words:
   "one save button for the whole page... disabled and becomes enabled
   when any changes are detected." A checkmark, not a floppy disk: nothing
   else on this page reaches for the literal save-icon metaphor, and a
   check reads as "commit this" without implying a file. */
const SAVE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
    /* Setting .value directly fires no native "input" event — dispatch
       one so whatever the field's OWN page already listens for (the
       Dashboard's own updateSendState(), enabling Send once there is
       text) reacts the same way it would to someone actually typing,
       without this shared helper needing to know that listener exists. */
    field.dispatchEvent(new Event("input", { bubbles: true }));
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

/* Open/close-dropdown behaviour (a filter button reveals a `.category-item`
   menu; clicking outside or Escape closes it) — itemsPage()'s own category
   menu and dashboardPage()'s own mode menu had this exact same ~15 lines
   copy-pasted, differing only in what happens when an item inside the menu
   is actually picked. Self-contained (its own getElementById lookups, its
   own local names) so it drops in next to whatever OUTER `const menuEl =
   document.getElementById(...)` a page already keeps around for its own
   other uses (marking the active item, reading known values back out),
   the same reasoning dictationScript() above is already built on. */
function dropdownMenuScript({ btnId, menuId, onSelect }) {
  return `(function () {
  const btn = document.getElementById(${JSON.stringify(btnId)});
  const menu = document.getElementById(${JSON.stringify(menuId)});
  if (!btn || !menu) return;
  btn.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".category-item");
    if (!item) return;
    ${onSelect}
  });
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    menu.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    menu.hidden = true;
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
      <button type="submit" class="send-btn" id="chat-send" aria-label="Send" title="Send" disabled>${SEND_ICON}</button>
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
  wrap.className = t.compact ? "table-card preview" : "table-card";

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
const sendBtn = document.getElementById("chat-send");
const DEFAULT_PLACEHOLDER = qInput.placeholder;

/* Bright and orange only once there is actually something to send — the
   owner's own words, pointing at a reference UI: "if there is nothing in
   the entry field, if there are no attachments added, the submit button
   should always be like a dim inactive version... you should only be
   able to submit something that you actually have something to submit."
   Disabled is the real, native state (not just a look) — the same guard
   the submit handler's own "if (!q && !file) return" already enforced
   silently; this makes that guard visible instead of a click that does
   nothing. Called after every event that can change either input. */
function updateSendState() {
  sendBtn.disabled = !qInput.value.trim() && !pickedFile();
}

function clearAttachments() {
  fileInput.value = "";
  qInput.placeholder = DEFAULT_PLACEHOLDER;
  attachBtn.removeAttribute("aria-pressed");
  attachBtn.innerHTML = ATTACH_ICON_HTML;
  attachBtn.setAttribute("aria-label", "Attach a photo or file");
  attachBtn.setAttribute("title", "Attach a photo or file");
  updateSendState();
}

function pickedFile() {
  return fileInput.files[0] || null;
}

qInput.addEventListener("input", updateSendState);

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
  updateSendState();
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
    updateSendState();
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
/* The tile IS the photo now — the owner's own words: "it really should be
   filled by the image of the item... it should fill the entire square box."
   A plain var(--image-ground) fill (the tile's own long-standing background)
   stands in for a product with no synced photograph yet, rather than the
   storefront's own generated placeholder graphic (store/src/catalog.js's
   toneFor()) — that generated-art aesthetic is the PUBLIC shop's front door;
   this is a plain internal utility grid, and a flat fill reads as "no photo
   yet," not as a design choice needing its own generator. */
.item-tile {
  box-sizing: border-box; position: relative; overflow: hidden; cursor: pointer;
  aspect-ratio: 1; border: 1px solid var(--rule); border-radius: 8px; background: var(--image-ground);
}
/* The same [hidden]-vs-explicit-display trap caught twice already this
   session (.category-menu, .input-bar button): an explicit display above
   always beats the browser's own default [hidden] { display: none },
   regardless of specificity — so filterItems()'s own el.hidden = ... has
   silently never actually hidden a filtered-out tile. Restated here so it
   finally does. */
.item-tile[hidden] { display: none; }
.item-photo {
  position: absolute; inset: 0; background-color: var(--image-ground);
  background-size: cover; background-position: center;
}
/* Title + price on top, SKU + tags on the bottom — the owner's own words:
   "title on top left, price top right, SKU bottom left, and then a few
   of the tags." Everything else (channel, status, every variation, custom
   fields, the edit form) moves into .item-detail, shown only once the
   tile is expanded — "everything else we want to remove... all of that
   should be visible in the full expanded view." A flat, half-transparent
   dark fill rather than a fading gradient — the owner's own words: "a dim
   half transparent gray background for the text on top and bottom... so
   it's almost like we're looking at a letterbox" — so the WHOLE bar reads
   evenly regardless of what part of the photograph sits behind it, not
   just the edge closest to it. (A pure CSS filter that inverted the text
   against the image directly — the owner's own, openly unsure, suggestion
   — was considered and set aside: mix-blend-mode/invert reads reliably
   only against a flat color, not a real photograph, and would go illegible
   on exactly the busy images this tile exists to show.) rgba(25, 24, 23,
   0.75) is --ground itself at 75% opacity — raised from 50%, the owner's
   own words: "make those bars more opaque, so like 75%, because they're
   still too transparent to be visible in the item thumbnail view" — not a
   separate color to keep in sync by hand. */
.item-top, .item-bottom {
  position: absolute; left: 0; right: 0; display: flex; align-items: center;
  justify-content: space-between; gap: 6px; padding: 6px 8px;
  background: rgba(25, 24, 23, 0.75);
}
.item-top { top: 0; }
.item-bottom { bottom: 0; }
.item-tile h3 {
  margin: 0; font-size: 13px; color: #fff; line-height: 1.3;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item-top-right { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.item-price { flex: 0 0 auto; font-size: 11px; color: #fff; }
/* The owner's own words: "I need a button somewhere, maybe top right,
   when I expand the product, I want to get a deep link into that
   expanded view so I can send it to somebody." Hidden on a collapsed
   tile — a link is only meaningful once there is an expanded view to
   send someone to — and shown once .item-tile carries .full. */
.item-share {
  display: none; flex: 0 0 auto; width: 20px; height: 20px; padding: 0;
  align-items: center; justify-content: center; border: none; border-radius: 50%;
  cursor: pointer; background: transparent; color: #fff;
}
.item-share:hover { background: rgba(255, 255, 255, 0.2); }
.item-tile.full .item-share { display: inline-flex; }
.item-share[data-state="ok"] { color: var(--accent); }
/* No SKU, no stable identifier to link — disabled rather than copying a
   link that would break the moment another product also has no SKU. */
.item-share:disabled { opacity: 0.35; cursor: default; }
.item-share:disabled:hover { background: transparent; }
/* The owner's own words: "it's too easy to click somewhere wrong and
   [the expanded view] will close, and that's not a good experience...
   maybe it just needs a proper close button." A click on the tile BODY
   no longer collapses an already-expanded one at all (see the
   click-delegation handler below) — only this button does, the same
   circular-icon treatment as .item-share beside it. */
.item-close {
  display: none; flex: 0 0 auto; width: 20px; height: 20px; padding: 0;
  align-items: center; justify-content: center; border: none; border-radius: 50%;
  cursor: pointer; background: transparent; color: #fff;
}
.item-close:hover { background: rgba(255, 255, 255, 0.2); }
.item-tile.full .item-close { display: inline-flex; }
/* ONE Save for the whole tile — the owner's own words: "one save button
   for the whole page... disabled and becomes enabled when any changes are
   detected." Same circular-icon treatment as Share/Close beside it,
   hidden until expanded the same way both of those already are; :disabled
   is what actually reads as "nothing to save yet." */
.item-save-all {
  display: none; flex: 0 0 auto; width: 20px; height: 20px; padding: 0;
  align-items: center; justify-content: center; border: none; border-radius: 50%;
  cursor: pointer; background: transparent; color: #fff;
}
.item-save-all:hover { background: rgba(255, 255, 255, 0.2); }
.item-tile.full .item-save-all { display: inline-flex; }
.item-save-all:disabled { opacity: 0.35; cursor: default; }
.item-save-all:disabled:hover { background: transparent; }
/* The owner's own words: "any changed fields should be marked with an
   orange highlight, and so is the save button" — enabled (there is
   something dirty to save) IS the highlight; no separate class needed
   since :disabled already carries the opposite state. */
.item-save-all:not(:disabled) { color: var(--accent); }
/* style_id took the SKU's old spot — the owner's own words: "these are
   generated automatically by Square and we should not be editing them at
   all... we don't need to see them in our ops dashboard." */
.item-style-id { font-size: 11px; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* As short as the owner's own words ask: "shorten them, make them as
   short as possible" — CHANNEL_LABEL carries just "Web" now (direct_link
   gets no tag at all — see CHANNEL_LABEL's own comment), and the tag list
   collapses to just "Inactive" — nothing else — the moment the product
   itself is not active: "when the item is not activated, I don't need to
   see any of the other tags... it's just inactive." */
.item-tags { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.item-tag {
  flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.6); color: #fff;
  max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item-tag.channel-website { border-color: var(--accent); color: var(--accent); }
.item-tag-inactive { border-color: rgba(255, 255, 255, 0.35); color: rgba(255, 255, 255, 0.75); }
/* Expanding one tile to the full screen instead of leaving every field
   crammed into a small grid cell — the owner's own words: "when I
   click on the item, it's gonna expand to my entire phone screen, and
   I should see all of that data." Same convention as .table-card.full
   in the chat log (TABLE_CARD_CSS above): the SAME element grows in
   place, no second element or separate scroll state to track. No dedicated
   Expand button any more — "clicking the entire button should expand it
   automatically" — the click-delegation handler below toggles this class
   on a click anywhere in the tile except inside .item-edit. */
.item-tile.full {
  position: fixed; inset: 12px; z-index: 50; overflow: auto; cursor: default;
  aspect-ratio: auto; display: flex; flex-direction: column;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}
.item-tile.full .item-photo { position: relative; inset: auto; aspect-ratio: 4 / 3; max-height: 40vh; flex: 0 0 auto; }
.item-tile.full .item-detail { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 12px; font-size: 12px; }
.item-detail { display: none; }
.item-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.item-badges span {
  font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--rule); color: var(--muted);
}
.item-badges .channel-website { border-color: var(--accent); color: var(--accent); }
.web-toggle-form, .category-form { display: contents; }
/* The Web tag IS the toggle now — the owner's own words: "I don't want to
   have a checkbox for web, the web tag itself should be clickable to
   toggle it, and it should have a little checkbox inside the tag to
   signify that it's a button, not an indicator." A <label> wrapping a
   real checkbox: clicking anywhere on the pill toggles it (native label
   behaviour, no click handler needed for that part), and the checkbox
   itself stays small and visible inside the pill rather than styled away,
   so the pill still reads as something to click rather than a status
   badge. Rendered even OFF — unlike the read-only badge it replaces,
   there has to be something to click to turn it back on. */
.item-tag-toggle {
  display: inline-flex; align-items: center; gap: 3px; font-size: 10px; padding: 1px 6px 1px 4px;
  border-radius: 999px; border: 1px solid var(--rule); color: var(--muted); cursor: pointer;
}
.item-tag-toggle input { width: 10px; height: 10px; margin: 0; accent-color: var(--accent); }
.item-tag-toggle.is-on { border-color: var(--accent); color: var(--accent); }
/* The category dropdown-or-type-in combobox — the owner's own words:
   "uncategorized should be a drop down... select an existing category
   subcategory, or just type in... it will create one if there isn't
   one." list="items-category-list" (itemsPage()) supplies the suggestions;
   typing anything else is still a valid submission. */
.category-input {
  font: inherit; font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--rule); background: transparent; color: var(--muted); width: 8em;
}
.item-variants, .item-fields { display: flex; flex-direction: column; gap: 2px; }
.item-variants div, .item-fields div { display: flex; justify-content: space-between; gap: 6px; }
.item-variants span:first-child, .item-fields span:first-child { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-fields span:last-child { color: var(--ink); text-align: right; overflow-wrap: anywhere; }
.item-empty { color: var(--muted); font-style: italic; }
/* The variations accordion — the owner's own words: "an expandable
   accordion header for the variations." Collapsed by default
   (.variations-body hidden until .variations-accordion carries
   .expanded) — the header alone (style_id, unit cost, MSRP) is the thing
   worth seeing without an extra tap; the per-variation list is the detail
   an accordion exists to defer. */
.variations-accordion { border-top: 1px solid var(--rule); margin-top: 2px; padding-top: 6px; }
/* "Decorate the header so it's obvious it's an expandable accordion...
   a different color header... not just a chevron" — a plain bar (same
   --image-ground/--rule "second surface" pattern .ticket-tile already
   uses) that visibly INVITES a click, since the whole thing now toggles
   the body below, not just the caret. */
.variations-header {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  background: var(--image-ground); border: 1px solid var(--rule); border-radius: 6px; padding: 5px 8px;
}
.variations-header:hover { border-color: var(--accent); }
.variations-toggle {
  flex: 0 0 auto; width: 18px; height: 18px; padding: 0; display: inline-flex; align-items: center;
  justify-content: center; border: none; background: transparent; color: var(--muted); cursor: pointer;
  transition: transform 0.15s;
}
.variations-toggle:hover { color: var(--accent); }
.variations-accordion.expanded .variations-toggle { transform: rotate(90deg); }
/* "The expandable header [needs] the label in it on the left, right next
   to the chevron, variations, so it makes sense, so people know what
   they're looking for" — a plain word, not another control, so it never
   competes with the fields beside it for width. */
.variations-label { flex: 0 0 auto; font-size: 11px; color: var(--muted); }
/* "Then we're going to have style ID label. Then the entry field just
   should have the hint for the format, no parentheses" — a real label,
   not the placeholder doing double duty as one; the placeholder shrinks
   to just the format hint now that the label says what it is. */
.variations-header-label { flex: 0 0 auto; font-size: 11px; color: var(--muted); margin-left: 4px; }
.variations-header form { display: contents; }
/* "The variation label itself is fine, it could be long... but indent
   them a little so it's clearer it's underneath the accordion it belongs
   to" — the body sits visibly inset from the header bar above it. */
.variations-body { display: none; flex-direction: column; margin-top: 6px; padding-left: 10px; }
.variations-accordion.expanded .variations-body { display: flex; }
/* "Too much vertical padding! Needs to match side padding. Reduce by
   2px" — 5px read as more than the row's own fields' own side padding
   (.item-edit input's own 3px 5px), so this comes down to 3px vertical,
   matching that. */
.variations-body .row { display: flex; gap: 6px; align-items: center; padding: 3px 0; }
.item-edit { border-top: 1px solid var(--rule); margin-top: 2px; padding-top: 6px; cursor: default; }
.item-edit form { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.item-add-field { margin: 2px 0; }
.item-add-field summary { cursor: pointer; color: var(--muted); font-size: 11px; }
.item-add-field summary:hover { color: var(--accent); }
.item-edit .row, .variations-header .row { display: flex; gap: 6px; align-items: center; }
/* "Why are they all so wide?" — every text field used to stretch
   (flex: 1 1 auto) to fill an equal share of whatever row it shared, so
   a 0-100 commission or a style_id ended up as wide as a vendor name.
   Reasonably sized by DEFAULT now — a fixed width, no grow — and only the
   handful of fields whose content genuinely varies without a bound
   (a vendor's own name, a custom field's own value, a variation's own
   name) opt back into flexible/grow sizing below; everything short and
   format-bounded (commission, a vendor code, a custom field's own name,
   style_id/unit cost/MSRP) stays a fixed, content-sized width instead. */
.item-edit input, .item-edit select, .variations-header input, .variations-body input {
  flex: 0 1 auto; min-width: 0; width: 10em; font: inherit; font-size: 11px; padding: 3px 5px;
  border: 1px solid var(--muted); border-radius: 4px; background: var(--ground); color: var(--ink);
}
/* "Hint text smaller so it's legible and readable" — a placeholder like
   "Style ID (NN-NN-NNN)" no longer fights the box it sits in for room. */
.item-edit input::placeholder, .variations-header input::placeholder, .variations-body input::placeholder {
  font-size: 10px;
}
.item-edit input[name="vendor"], .item-edit input[name^="field_value_"], .variations-body input[name^="title_"], .item-title-input {
  flex: 1 1 auto; width: auto;
}
.item-edit input[name="commission"] { width: 4em; }
.item-edit input[name="vendor_code"], .item-edit input[name^="field_name_"] { width: 8em; }
/* Title and description — the owner's own words: "where's the item label
   and where is the description fields? Shouldn't we be able to change
   that?" A plain-weight input rather than a second, competing heading
   style, and a real multi-line box for the description instead of the
   single-line inputs everything else here uses. */
.item-title-input { font-weight: 600; }
.item-edit textarea {
  font: inherit; font-size: 11px; padding: 5px 6px; min-height: 4.5em; resize: vertical;
  border: 1px solid var(--muted); border-radius: 4px; background: var(--ground); color: var(--ink);
}
.item-edit textarea::placeholder { font-size: 10px; }
/* "Make the header, the values in the header, right justified" — applied
   to every header input, and carried down to the matching column in each
   variation row below so the two stay visually aligned, "the same size
   and aligned properly with the contents." */
.variations-header input, .variations-body input[name^="price_"], .variations-body input[name^="unit_cost_"] {
  text-align: right;
}
/* "Make the style ID longer" — the one header field with no per-variation
   counterpart to line up with, so it is free to be wider. */
.variations-header input[name="style_id"] { flex: 0 0 auto; width: 9em; text-align: left; }
/* "Unit cost and MSRP boxes are way too big... ten thousand dollars is
   the maximum we'll charge for a piece of clothing" — $10,000.00 is 8
   characters; narrower than the old 6.5em, not the 10em default. */
.variations-header input.variations-msrp,
.variations-header input.variations-unit-cost,
.variations-body input[name^="price_"],
.variations-body input[name^="unit_cost_"] {
  flex: 0 0 auto; width: 5em;
}
/* Stock — "a row of 3 small components [-][##][+], then [COST][MSRP]" —
   the stepper sits right after the variation's own name, ahead of its
   cost/price, since it is a command, not a fact about the variation the
   way price/cost are. REVISED: "one continuous row with no padding! Fixed
   width of parent, with buttons and number fitting around value, +/-
   taking up the rest of the space" — the three pieces are one joined
   control now, not three separately-gapped ones: a single fixed-width,
   single-bordered wrapper (overflow: hidden clips the two inner children
   to its own rounded corners), the two buttons a fixed small width, and
   the count field between them set to flex: 1 1 auto so it absorbs
   whatever width is left inside the fixed parent — the count's own digits
   are never wider than that leftover space is guaranteed to be, so this
   reads as "fits the value" without the count ever driving the wrapper's
   own (fixed) total width. */
.variation-stock-stepper {
  display: flex; flex: 0 0 auto; width: 5.5em;
  border: 1px solid var(--muted); border-radius: 4px; overflow: hidden;
}
.variation-stock-count {
  flex: 1 1 auto; width: auto; min-width: 0; text-align: center;
  border: none; border-left: 1px solid var(--muted); border-right: 1px solid var(--muted); border-radius: 0;
  background: var(--image-ground); color: var(--muted); cursor: default;
}
.variation-stock-step {
  flex: 0 0 auto; width: 20px; height: 20px; padding: 0; line-height: 1; font: inherit; font-size: 13px;
  border: none; border-radius: 0; background: var(--ground); color: var(--muted); cursor: pointer;
}
.variation-stock-step:hover { color: var(--accent); background: var(--image-ground); }
.variation-stock-step:disabled { opacity: 0.5; cursor: default; }
/* "Any changed fields should be marked with an orange highlight" — added
   to the specific field that changed (onItemsGridChange, below), not just
   the form it lives in. Specific enough (element + class, twice over) to
   beat every input-styling rule above regardless of source order — a
   checkbox has no visible border to recolour, so it gets an outline
   instead of the same border-color change every text/select field gets. */
.item-tile input.field-dirty, .item-tile select.field-dirty { border-color: var(--accent); }
.item-tile input.field-dirty[type="checkbox"] { outline: 1.5px solid var(--accent); outline-offset: 1px; }
/* A check() refusal (a malformed style_id, a vendor with no commission, a
   unit cost with no vendor) shows up right here, next to the form that was
   refused — not on a separate page. The owner's own words: "I don't want
   these errors to send me to a new page." */
.item-edit-error { margin: 4px 0 0; font-size: 11px; color: var(--accent); }
`;

/* ONE label, for ONE state worth tagging. The owner's own words, a
   revision on top of the original "shorten them" pass: "I don't want to
   see the in-store tag... why do I want to see two tags? Web is a much
   shorter, cleaner tag... what's the in-store for?" Every item is in
   store already (this shop has one physical location) — that state is
   assumed and unremarkable, the same reasoning "Active" never gets a tag
   either. Only being ALSO on the website is worth calling out, so this is
   a single constant now, not a map with a direct_link entry nobody
   should render. Used both on the compact tile's own tag and the full
   view's badge. */
const CHANNEL_LABEL = { website: "Web" };

/* Where a mirrored photograph actually lives, once the backfill job
   (media-backfill.js) has fetched it off Square's CDN and .put() it into
   OUR bucket under OUR key. The same constant, deliberately not shared —
   store/src/catalog.js already defines this locally rather than exporting
   it, since a storefront Worker and this ops Worker have no other reason to
   import from one another; this file follows that same established
   precedent rather than introducing the first cross-package import for it. */
const MEDIA_BASE_URL = "https://media.vemians.com";

function itemTile(product, canEdit) {
  const fieldEntries = Object.entries(product.custom_fields ?? {});
  const searchText = [
    product.title,
    product.handle,
    product.category_name,
    product.status,
    product.channel,
    product.style_id,
    product.vendor,
    ...product.variations.map((v) => v.sku ?? ""),
    ...fieldEntries.flat(),
  ]
    .join(" ")
    .toLowerCase();

  /* The bottom row's own left side used to be the primary variation's SKU.
     Not any more — the owner's own words: "these are generated
     automatically by Square and we should not be editing them at all...
     we don't need to see them in our ops dashboard" — style_id (this
     shop's own nomenclature, never Square's) takes that spot instead. SKU
     still exists, just never displayed: shareLink()'s own deep link is
     still keyed on it (data-sku below, unchanged), because a direct link
     is the one place the owner said a SKU still makes sense ("if you do a
     direct link, that makes sense... otherwise it's completely not our
     problem"). The top row keeps ONE price, the first variation's own,
     matching how a multi-size garment is already priced "from" its
     lowest-ordinal variation everywhere else in this codebase. */
  const primaryVariant = product.variations[0];
  const primarySku = primaryVariant?.sku || primaryVariant?.title || "";
  const priceText = primaryVariant ? money(primaryVariant.price_minor, primaryVariant.currency) : "";

  /* isActive drives BOTH the status filter (data-status below) and which
     tags a collapsed tile shows at all — the owner's own words: "when the
     item is not activated, I don't need to see any of the other tags...
     it's just inactive," and conversely no "Active" tag either, since
     active is the assumed, unremarkable state. Draft and archived both
     collapse into the same "inactive" bucket — the owner thinks of the
     catalog as a two-state thing (live or not), not Square's own
     three-value status lifecycle. */
  const isActive = product.status === "active";
  /* No "In store" tag: "why do I want to see two tags? Web is a much
     shorter, cleaner tag... what's the in-store for?" — every item is in
     store already (this shop has one physical location), so that state is
     assumed and unremarkable, the same reasoning direct_link already gets
     no tag at all here versus "Active" getting none either. Only the
     REMARKABLE state — also on the website — earns a tag. This COLLAPSED
     tile's own tag stays a plain, non-interactive indicator; the toggle
     control lives once-expanded, in .item-badges below. */
  const tags = isActive
    ? (product.channel === "website" ? `<span class="item-tag channel-website">${CHANNEL_LABEL.website}</span>` : "") +
      (product.category_name ? `<span class="item-tag">${esc(product.category_name)}</span>` : "")
    : `<span class="item-tag item-tag-inactive">Inactive</span>`;

  /* Never a SKU here either — the read-only view every role gets. A
     manager's own expanded view replaces this whole thing with the
     interactive accordion below instead, so this only ever renders for
     someone who cannot edit anyway. */
  const variantRows = product.variations.length
    ? product.variations.map((v) => `<div><span>${esc(v.title)}</span><span>${esc(money(v.price_minor, v.currency))}</span></div>`).join("")
    : `<p class="item-empty">No variations.</p>`;

  const fieldRows = fieldEntries.length
    ? fieldEntries.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")
    : `<p class="item-empty">No custom fields yet.</p>`;

  /* For someone who CAN edit, style_id and unit cost moved into the
     variations accordion's own header below — shown and edited there
     instead, so they are not repeated here. Someone who cannot (staff)
     never sees that accordion at all (canEdit-gated, like every edit
     surface on this tile), so they stay here, read-only, exactly as
     before — otherwise a staff member would lose visibility of them
     entirely. vendor/vendor_code/commission are unaffected either way:
     still their own Square Vendor entity (Retail Plus/Premium, P0-136
     revised), shown in their own rows, blank rather than an empty-state
     paragraph when none is set yet (an empty text field already says
     that, the same way the edit form below will). */
  const attrRows =
    (!canEdit && product.style_id ? `<div><span>Style ID</span><span>${esc(product.style_id)}</span></div>` : "") +
    (product.vendor ? `<div><span>Vendor</span><span>${esc(product.vendor)}</span></div>` : "") +
    (product.vendor_code ? `<div><span>Vendor code</span><span>${esc(product.vendor_code)}</span></div>` : "") +
    (!canEdit && product.vendor && product.unit_cost_minor
      ? `<div><span>Unit cost</span><span>${esc(money(product.unit_cost_minor, product.unit_cost_currency ?? "USD"))}</span></div>`
      : "") +
    (product.commission_pct != null ? `<div><span>Commission</span><span>${esc(String(product.commission_pct))}%</span></div>` : "");

  /* Up to 3 blank rows for a brand-new field, tucked inside its own "Add
     custom field" disclosure — collapsed by default, opened only when
     actually adding one. The owner's own words: "that section that opens
     up the add custom fields dropdown should only be opened when you're
     trying to add a field, otherwise all the fields that are added need to
     be easily accessible and visible" — so an EXISTING field's own row
     (name + value, both still editable) stays outside the disclosure,
     always visible, and only the blank rows for a field that doesn't exist
     yet live inside it. Both sets post to the same form/endpoint
     (catalog.set_custom_fields' own merge treats them identically), so
     index.js's field_name_N/field_value_N parsing (contiguous from 0)
     needs no change at all. */
  const blankRows = Math.max(0, Math.min(3, CAPS.CATALOG_CUSTOM_FIELDS_MAX_KEYS - fieldEntries.length));
  const existingFieldInputs = fieldEntries
    .map(
      ([k, v], i) =>
        `<div class="row"><input name="field_name_${i}" value="${esc(k)}" placeholder="Field name">` +
        `<input name="field_value_${i}" value="${esc(v)}" placeholder="Value (blank removes it)"></div>`,
    )
    .join("");
  const blankFieldInputs = Array.from(
    { length: blankRows },
    (_, i) =>
      `<div class="row"><input name="field_name_${fieldEntries.length + i}" placeholder="Field name">` +
      `<input name="field_value_${fieldEntries.length + i}" placeholder="Value"></div>`,
  ).join("");

  /* The variations accordion — the owner's own words: "an expandable
     accordion header for the variations... I want to see in the header
     the unit cost and the MSRP, editable in the header. So if I change it
     in the header, it gets applied to all of its variations at the same
     time. And individual variations I can also edit individually... on
     the left side I want to see the style number, editable as well." No
     SKU anywhere in it — variation NAME (title) and price only, matching
     the same "generated by Square, not ours to edit or show" reasoning
     style_id's own move already established.

     Revised again once unit cost stopped being one value applied
     uniformly: "all the variants can have a different unit cost too" — so
     unit_cost moved OUT of the style_id form below (catalog.set_square_
     attributes, unchanged for style_id alone) and now works exactly like
     MSRP already did: a header input with no form of its own, purely the
     client's own "type once here, and every variation's own cost input
     updates to match" convenience, wired in the page script below —
     typing directly into one variation's own cost afterward still
     overrides just that one. Both header inputs broadcast into the SAME
     .variations-body <form>, which reaches catalog.update_product through
     the /variations route — a variant always carries its OWN mirror id
     (variant_id_N) so mergeVariations (catalog-writer.js) edits that one
     row and leaves every other variation exactly as it was, never
     destructively. */
  /* Revised again — "all the variants can have a different unit cost too,
     so we need to have the double rows": unit cost is no longer a single
     value applied uniformly to every variation (catalog-writer.js's own
     "one vendor per product" comment is now ONLY about the vendor itself,
     never the cost) — each row below carries its own, gated the same way
     the read-only attrRows above is: a fact about a VENDOR's product, so
     it renders only once a vendor exists. */
  const hasVendor = Boolean(product.vendor);
  /* Stock (P0-31, revised) — "show current count, adjust with +/-," the
     owner's own choice over a plain "type a target count" box, once it was
     clear a stock count is never overwritten directly, only adjusted.
     REVISED again: "a small read-only entry field and two small buttons on
     the sides, - and +" — not a free-typed delta plus one Adjust button, a
     stepper: a read-only field showing the current count, flanked by its
     own minus and plus. Each click posts a delta of exactly &plusmn;1
     immediately and updates the field in place (no page reload — a
     stepper implies rapid repeat clicks, e.g. receiving 10 units one at a
     time). This lives INSIDE the same pricing <form> purely for layout
     (one visual row per variation); it is deliberately NOT part of that
     form's own dirty-tracking or the tile's one big Save — a stock
     movement is an EVENT with its own moment in time, never batched with
     an unrelated price edit someone happens to also be mid-typing.
     `readonly`, not `disabled` — a disabled field submits nothing AND
     cannot be selected/copied; this one only needs to refuse typing. */
  const variationRows = product.variations
    .map(
      (v, i) =>
        `<div class="row">` +
        `<input type="hidden" name="variant_id_${i}" value="${esc(v.id)}">` +
        `<input type="hidden" name="currency_${i}" value="${esc(v.currency)}">` +
        `<input class="variation-title" name="title_${i}" value="${esc(v.title)}" placeholder="Variation name">` +
        `<span class="variation-stock-stepper">` +
        `<button type="button" class="variation-stock-step" data-variant-id="${esc(v.id)}" data-delta="-1" aria-label="Remove one from stock" title="Remove one from stock">&minus;</button>` +
        `<input type="text" class="variation-stock-count" value="${esc(String(v.on_hand ?? 0))}" readonly aria-label="Current stock">` +
        `<button type="button" class="variation-stock-step" data-variant-id="${esc(v.id)}" data-delta="1" aria-label="Add one to stock" title="Add one to stock">+</button>` +
        `</span>` +
        (hasVendor
          ? `<input class="variation-unit-cost" name="unit_cost_${i}" value="${v.unit_cost_minor ? esc((v.unit_cost_minor / 100).toFixed(2)) : ""}" placeholder="Cost">`
          : "") +
        `<input class="variation-price" name="price_${i}" value="${esc((v.price_minor / 100).toFixed(2))}" placeholder="Price">` +
        `</div>`,
    )
    .join("");
  const variationsAccordion = canEdit
    ? `<div class="variations-accordion">
         <div class="variations-header">
           <button type="button" class="variations-toggle" aria-label="Show every variation" title="Show every variation">${CARET_ICON}</button>
           <span class="variations-label">Variations</span>
           <form method="post" action="/items/${esc(product.handle)}/square-attributes" class="row">
             <span class="variations-header-label">Style ID</span>
             <input name="style_id" value="${esc(product.style_id ?? "")}" placeholder="NN-NN-NNN" pattern="\\d{2}-\\d{2}-\\d{3}" title="NN-NN-NNN — a 2-digit category, a 2-digit subcategory, a 3-digit item number, e.g. 01-04-001. Leave blank to keep it as it is.">
           </form>
           ${hasVendor ? `<input class="variations-unit-cost" placeholder="Cost — every variation's cost">` : ""}
           <input class="variations-msrp" placeholder="MSRP — every variation's price">
         </div>
         <div class="variations-body">
           ${
             product.variations.length
               ? `<form method="post" action="/items/${esc(product.handle)}/variations">${variationRows}</form>`
               : `<p class="item-empty">No variations.</p>`
           }
         </div>
       </div>`
    : `<div class="item-variants">${variantRows}</div>`;

  /* The website channel and the category are both edited right here in
     .item-badges now, not in a separate section further down —
     .item-badges is already inside .item-detail, covered by the same
     click-delegation guard as .item-edit (see the script below), so a
     click on either control never collapses the tile. */
  const webToggle = canEdit
    ? `<form method="post" action="/items/${esc(product.handle)}/channel" class="web-toggle-form">
         <label class="item-tag-toggle${product.channel === "website" ? " is-on" : ""}">
           <input type="checkbox" name="on_website"${product.channel === "website" ? " checked" : ""}>
           Web
         </label>
       </form>`
    : product.channel === "website"
      ? `<span class="channel-website">${CHANNEL_LABEL.website}</span>`
      : "";
  /* "Uncategorized should be a drop down... select an existing category
     subcategory, or just type in... category slash subcategory manually,
     it will create one if there isn't one." A <datalist> combobox: pick a
     suggestion from every category that exists (items-category-list,
     rendered once per page in itemsPage()), or type something that
     matches none of them, which /items/<handle>/category (index.js)
     resolves-or-creates the same way a vendor name already is. Not a real
     two-level Square hierarchy — this schema has never had a subcategory
     concept (see style_id's own NN-NN-NNN comment) — "Category/
     Subcategory" is a flat category whose own name happens to contain a
     "/", same as any other name. */
  const categoryControl = canEdit
    ? `<form method="post" action="/items/${esc(product.handle)}/category" class="category-form">
         <input class="category-input" list="items-category-list" name="category" value="${esc(product.category_name ?? "")}" placeholder="Uncategorized">
       </form>`
    : `<span>${esc(product.category_name || "Uncategorized")}</span>`;

  /* ONE Save for the whole expanded tile, not one per section — the
     owner's own words: "let's just have one save button for the whole
     page... disabled and becomes enabled when any changes are detected...
     instead of having a per field kind of save button." Starts disabled;
     the page script below enables it the moment ANY field inside this
     tile changes, and its own click handler submits every form that
     actually changed (and only those), in turn, reloading once at the
     end only if all of them succeeded. Lives beside Share/Close so it is
     reachable without scrolling back up from a long expanded view. */
  const saveButton = canEdit
    ? `<button type="button" class="item-save-all" aria-label="Save changes" title="Save changes" disabled>${SAVE_ICON}</button>`
    : "";

  /* "Where's the item label and where is the description fields? Shouldn't
     we be able to change that?" — title and description reach
     catalog.update_product exactly the way it always could, through a new
     `/items/<handle>/details` route; the collapsed tile's own `<h3>` stays
     the plain, read-only heading it always was (everyone sees it, staff
     included), and this form is the one place a manager actually edits
     it, same as every other field on this tile. */
  const editForms = canEdit
    ? `<div class="item-edit">
         <form method="post" action="/items/${esc(product.handle)}/details">
           <input class="item-title-input" name="title" value="${esc(product.title)}" placeholder="Title">
           <textarea name="description" placeholder="Description">${esc(product.description ?? "")}</textarea>
         </form>
         <form method="post" action="/items/${esc(product.handle)}/square-attributes">
           <div class="row">
             <input name="vendor" value="${esc(product.vendor ?? "")}" placeholder="Vendor">
             <input name="vendor_code" value="${esc(product.vendor_code ?? "")}" placeholder="Vendor's own SKU/code">
             <input name="commission" value="${esc(product.commission_pct != null ? String(product.commission_pct) : "")}" placeholder="Commission % (0-100)">
           </div>
         </form>
         <form method="post" action="/items/${esc(product.handle)}/custom-fields">
           ${existingFieldInputs}
           ${
             blankFieldInputs
               ? `<details class="item-add-field"><summary>Add custom field</summary>${blankFieldInputs}</details>`
               : ""
           }
         </form>
       </div>`
    : "";

  const photoStyle = product.image_key ? ` style="background-image:url('${MEDIA_BASE_URL}/${esc(product.image_key)}')"` : "";

  return `<article class="item-tile" data-search="${esc(searchText)}" data-category="${esc(product.category_name || "")}" data-status="${isActive ? "active" : "inactive"}" data-channel="${esc(product.channel)}" data-handle="${esc(product.handle)}" data-sku="${esc(primarySku)}">
    <div class="item-photo"${photoStyle}>
      <div class="item-top"><h3>${esc(product.title)}</h3>
        <div class="item-top-right">
          <span class="item-price">${esc(priceText)}</span>
          <button type="button" class="item-share" aria-label="Copy a link to this item" title="Copy a link to this item"${primarySku ? "" : " disabled"}>${LINK_ICON}</button>
          ${saveButton}
          <button type="button" class="item-close" aria-label="Close" title="Close">${CANCEL_ICON}</button>
        </div>
      </div>
      <div class="item-bottom"><span class="item-style-id">${esc(product.style_id ?? "")}</span><div class="item-tags">${tags}</div></div>
    </div>
    <div class="item-detail">
      <div class="item-badges">
        ${webToggle}
        <span>${esc(product.status)}</span>
        ${categoryControl}
      </div>
      ${variationsAccordion}
      ${attrRows ? `<div class="item-fields">${attrRows}</div>` : ""}
      <div class="item-fields">${fieldRows}</div>
      ${editForms}
    </div>
  </article>`;
}

export function itemsPage({ role }, products, allCategories = []) {
  const canEdit = role === "manager" || role === "owner";
  const tiles = products.length
    ? products.map((p) => itemTile(p, canEdit)).join("\n")
    : `<p class="hint">No products in the mirror yet.</p>`;

  /* ONE shared list of every category that exists (the closed set,
     catalog.categories — not just the ones a product here already uses),
     referenced by every tile's own category input via list="..." rather
     than repeated per tile. The owner's own words: "uncategorized should
     be a drop down... select an existing category subcategory, or just
     type in... it will create one if there isn't one" — a <datalist>
     gives both in one native control: pick a suggestion, or type
     something that matches none of them at all, which /items/<handle>/
     category (index.js) resolves-or-creates the same way a vendor name
     already is. */
  const categoryDatalist = canEdit
    ? `<datalist id="items-category-list">${[...allCategories]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => `<option value="${esc(c.name)}">`)
        .join("")}</datalist>`
    : "";

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
    <h1><span id="category-label">All categories</span>
      <select id="item-status-filter" class="dash-status-select">
        <option value="in_store" selected>In Store</option>
        <option value="web">Web</option>
        <option value="inactive">Inactive</option>
      </select>
    </h1>
  </section>
  <div class="items-grid" id="items-grid">
${tiles}
  </div>
  ${categoryMenu}
  ${categoryDatalist}
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
/* In Store / Web / Inactive — the owner's own words: "let's have a
   dropdown that's in store, which will show all of the items that we
   have in store that are active... then we have a web, which will show
   us just the items that are on the web... and then we have inactive,
   which will show all of the items that are inactive. By default,
   neither this in store nor the web view should show the inactive
   items." In Store is every active product regardless of channel (the
   owner's own reasoning elsewhere: everything is physically on premises
   anyway); Web narrows that to the website channel; Inactive is the
   complement (draft or archived), hidden from the other two either way. */
function matchesStatusFilter(el) {
  if (statusFilter === "inactive") return el.dataset.status === "inactive";
  if (el.dataset.status === "inactive") return false;
  return statusFilter === "web" ? el.dataset.channel === "website" : true;
}
function filterItems() {
  const q = itemSearch.value.trim().toLowerCase();
  document.querySelectorAll(".item-tile").forEach((el) => {
    const matchesCategory = selectedCategories.size === 0 || selectedCategories.has(el.dataset.category);
    const matchesSearch = !q || el.dataset.search.includes(q);
    el.hidden = !matchesCategory || !matchesSearch || !matchesStatusFilter(el);
  });
}
itemSearch.addEventListener("input", filterItems);
const itemStatusFilterEl = document.getElementById("item-status-filter");
let statusFilter = itemStatusFilterEl.value;
itemStatusFilterEl.addEventListener("change", () => {
  statusFilter = itemStatusFilterEl.value;
  filterItems();
});
/* In Store is the selected default, and it already hides every inactive
   product — that has to take effect the moment the page loads, before
   anyone touches the dropdown or types a single character. */
filterItems();
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
${dropdownMenuScript({
  btnId: "category-btn",
  menuId: "category-menu",
  onSelect: "toggleCategory(item.dataset.category); filterItems();",
})}

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

/* One delegated listener for the whole grid, rather than one per tile —
   the same "no per-item wiring" trade the search filter above already
   makes. No dedicated Expand button any more — the owner's own words:
   "there is no need to have an expand button. Clicking the entire
   button should expand it automatically" — so a click ANYWHERE on a
   COLLAPSED tile expands it, except inside .item-edit (its own inputs,
   selects, buttons and <summary> stay independently interactive).
   Closing it again is deliberately NOT the same click-anywhere gesture
   any more — the owner's own words, after it shipped that way: "it's
   too easy to click somewhere wrong and it will close, and that's not
   a good experience... maybe it just needs a proper close button." Only
   .item-close collapses an already-expanded tile; a click on its body
   (outside .item-edit and .item-share) now does nothing at all. Toggling
   .full on the tile itself still grows the SAME element in place
   (TABLE_CARD_CSS's own .table-card.full convention in the chat log)
   instead of opening a second element or tracking separate scroll state. */
document.getElementById("items-grid").addEventListener("click", async (e) => {
  const shareBtn = e.target.closest(".item-share");
  if (shareBtn) {
    shareLink(shareBtn);
    return;
  }
  const caret = e.target.closest(".variations-toggle");
  if (caret) {
    caret.closest(".variations-accordion")?.classList.toggle("expanded");
    return;
  }
  /* "Decorate the header so it's obvious it's an expandable accordion...
     not just a chevron" — the whole header bar looks and now acts like
     one, matching the caret's own toggle, except for a click that lands
     on an input or the caret itself (handled above; typing into style_id
     or the MSRP/cost broadcasters must not also collapse the row). */
  const header = e.target.closest(".variations-header");
  if (header && !e.target.closest("input, button")) {
    header.closest(".variations-accordion")?.classList.toggle("expanded");
    return;
  }
  const saveBtn = e.target.closest(".item-save-all");
  if (saveBtn) {
    await saveTile(saveBtn.closest(".item-tile"));
    return;
  }
  const stepBtn = e.target.closest(".variation-stock-step");
  if (stepBtn) {
    await stepStock(stepBtn);
    return;
  }
  const closeBtn = e.target.closest(".item-close");
  if (closeBtn) {
    const tile = closeBtn.closest(".item-tile");
    /* The owner's own words: "if you try to close the expanded page, it
       will warn you that you have unsaved changes." Only the ONE global
       Save button (below) ever clears .dirty, so this is a plain, always-
       accurate check — no separate per-field bookkeeping to keep in sync. */
    if (tile.classList.contains("dirty") && !confirm("You have unsaved changes. Close without saving?")) {
      return;
    }
    tile.classList.remove("full");
    return;
  }
  const tile = e.target.closest(".item-tile");
  if (!tile || e.target.closest(".item-edit, .item-badges, .variations-accordion") || tile.classList.contains("full")) return;
  tile.classList.add("full");
});

/* Dirty-tracking for the ONE Save button per tile — the owner's own
   words: "let's just have one save button for the whole page... disabled
   and becomes enabled when any changes are detected... instead of having
   a per field kind of save button." Then: "resetting values should clear
   save state" — so this is a RECOMPUTE, not a one-way latch: a field
   counts as dirty only while its current value still differs from
   defaultValue/defaultChecked (the browser's own record of the value the
   HTML actually shipped with, untouched by any later .value= assignment),
   so typing something back to what it already was clears that field's own
   highlight, and once nothing in a form differs any more, the form itself
   stops being submitted on Save, and once no form in the tile is dirty,
   the tile's own Save button goes back to disabled.

   The MSRP input is the one exception with no form of its own — the
   owner's own words: "if I change it in the header, it gets applied to
   all of its variations at the same time... individual variations I can
   also edit individually" — so typing into it copies straight into every
   variation's own price input (still just that ONE form, still overridable
   afterward by editing one variation's own price directly, and still
   cleared the same way if that copy happens to land back on the original
   price). */
function isFieldDirty(el) {
  return el.type === "checkbox" ? el.checked !== el.defaultChecked : el.value !== el.defaultValue;
}
function refreshDirtyState(field) {
  field.classList.toggle("field-dirty", isFieldDirty(field));

  const form = field.closest(".item-badges form, .item-edit form, .variations-header form, .variations-body form");
  if (!form) return;
  const formDirty = [...form.querySelectorAll("input")].some(isFieldDirty);
  if (formDirty) {
    form.dataset.dirty = "1";
  } else {
    delete form.dataset.dirty;
  }

  const tile = form.closest(".item-tile");
  if (!tile) return;
  const tileDirty = [...tile.querySelectorAll("form")].some((f) => f.dataset.dirty === "1");
  tile.classList.toggle("dirty", tileDirty);
  const saveBtn = tile.querySelector(".item-save-all");
  if (saveBtn) saveBtn.disabled = !tileDirty;
}
function onItemsGridChange(e) {
  if (e.target.matches(".variations-msrp")) {
    const accordion = e.target.closest(".variations-accordion");
    accordion?.querySelectorAll(".variation-price").forEach((input) => {
      input.value = e.target.value;
      refreshDirtyState(input);
    });
    return;
  }
  if (e.target.matches(".variations-unit-cost")) {
    const accordion = e.target.closest(".variations-accordion");
    accordion?.querySelectorAll(".variation-unit-cost").forEach((input) => {
      input.value = e.target.value;
      refreshDirtyState(input);
    });
    return;
  }
  /* Stock's own read-only field lives inside the pricing form for layout
     only — it is never user-editable (so this never actually fires from a
     real click/keystroke) and must never mark that form or the tile's one
     Save button dirty either way. Its own +/- buttons post immediately
     (below), updating this field's value AND its defaultValue together
     (stepStock, via setAttribute) so isFieldDirty never sees a diff here. */
  if (e.target.matches(".variation-stock-count")) return;
  const form = e.target.closest(".item-badges form, .item-edit form, .variations-header form, .variations-body form");
  if (form) refreshDirtyState(e.target);
}
document.getElementById("items-grid").addEventListener("input", onItemsGridChange);
document.getElementById("items-grid").addEventListener("change", onItemsGridChange);

/* Pressing Enter in a field with no visible submit button any more still
   fires a native submit in most browsers — routed through the exact same
   Save flow as a click, rather than letting it POST just that one form on
   its own (which would skip every other field the tile also asked to
   save together). */
document.getElementById("items-grid").addEventListener("submit", async (e) => {
  const tile = e.target.closest(".item-tile");
  if (!tile) return;
  e.preventDefault();
  await saveTile(tile);
});

/* A check() refusal (a malformed style_id, a vendor with no commission, a
   unit cost with no vendor, a vendor with no commission when it is being
   created) is a rule the SERVER has to check — nothing a client-side
   <input pattern> alone can know. The owner's own words: "I don't want
   these errors to send me to a new page. They need to validate input
   like the style ID." So the refusal still comes from the server, but
   arrives as JSON instead of a whole new refusalPage, and is shown right
   next to the form that sent it — never a navigation. */
async function submitEditForm(form) {
  const existingError = form.nextElementSibling;
  if (existingError?.classList.contains("item-edit-error")) existingError.remove();
  try {
    const res = await fetch(form.action, { method: "POST", body: new FormData(form) });
    if (res.ok) return true;
    const data = await res.json().catch(() => ({}));
    showFormError(form, data.error || "That change was refused.");
    return false;
  } catch {
    showFormError(form, "Could not reach the server — try again.");
    return false;
  }
}
function showFormError(form, message) {
  const p = document.createElement("p");
  p.className = "item-edit-error";
  p.textContent = message;
  form.insertAdjacentElement("afterend", p);
}

/* The tile's own ONE Save: every form marked dirty (see refreshDirtyState
   above) submits in turn, and the page only reloads once, at the end, if every
   one of them succeeded — a form that failed keeps its own inline error
   and the button re-enables so the rest can be fixed and saved again,
   rather than losing track of which of several sections still needs
   attention. */
async function saveTile(tile) {
  if (!tile) return;
  const dirtyForms = [...tile.querySelectorAll("form[data-dirty='1']")];
  if (!dirtyForms.length) return;
  const saveBtn = tile.querySelector(".item-save-all");
  if (saveBtn) saveBtn.disabled = true;
  let allOk = true;
  for (const form of dirtyForms) {
    if (!(await submitEditForm(form))) allOk = false;
  }
  if (allOk) {
    location.reload();
  } else if (saveBtn) {
    saveBtn.disabled = false;
  }
}

/* "A small read-only entry field and two small buttons on the sides, - and
   +" — each click posts a delta of exactly its own button's +-1 the
   instant it is clicked, never batched into the tile's own big Save (see
   the P0-31 comment on variationRows, above, for why). No <form> at all:
   the count field carries no name and belongs to no form's own FormData,
   so there is nothing for saveTile's own dirty-form scan to pick up here
   either way. Updates the field in place on success — a stepper implies
   rapid repeat clicks, and reloading the whole page after every one of
   them would make receiving ten units one at a time unusable. */
async function stepStock(button) {
  const row = button.closest(".row");
  const existingError = row.nextElementSibling;
  if (existingError?.classList.contains("item-edit-error")) existingError.remove();
  const countField = row.querySelector(".variation-stock-count");
  const steppers = row.querySelectorAll(".variation-stock-step");

  const handle = button.closest(".item-tile")?.dataset.handle;
  const body = new FormData();
  body.set("variant_id", button.dataset.variantId);
  body.set("delta", button.dataset.delta);

  steppers.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch("/items/" + handle + "/inventory", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showFormError(row, data.error || "That change was refused.");
      return;
    }
    /* setAttribute, not .value= — updates defaultValue right along with
       it, so isFieldDirty (above) never sees this as a change to save. */
    if (countField && Number.isInteger(data.on_hand)) {
      countField.setAttribute("value", String(data.on_hand));
    }
  } catch {
    showFormError(row, "Could not reach the server — try again.");
  } finally {
    steppers.forEach((b) => (b.disabled = false));
  }
}

/* "I need to have a button somewhere, maybe top right, when I expand the
   product. I want to get a deep link into that expanded view so I can
   send it to somebody." #item-<sku> rather than a server route — the
   whole catalog already renders in one response, so there is nothing a
   real URL segment would fetch that this page does not already hold.
   Keyed on SKU, not handle — the owner's own words: "we do not want to
   be making our deep links based on item names. The titles and
   descriptions may change in the future, and that's going to break our
   linking... the SKU is always going to be a unique number, a unique
   location, a unique product." The button itself is disabled with no
   SKU to link (see itemTile()) — there is no stable identifier to copy. */
async function shareLink(btn) {
  const sku = btn.closest(".item-tile").dataset.sku;
  const url = location.origin + location.pathname + "#item-" + encodeURIComponent(sku);
  try {
    await navigator.clipboard.writeText(url);
    btn.dataset.state = "ok";
    btn.title = "Copied";
  } catch (err) {
    console.error("clipboard write failed", err);
    btn.dataset.state = "failed";
    btn.title = "Could not copy — copy it from the address bar instead";
  }
  setTimeout(() => {
    delete btn.dataset.state;
    btn.title = "Copy a link to this item";
  }, 2000);
}

/* The other half of the link above: opening it lands on the grid like any
   other visit, then this jumps straight to the one product and expands it
   — forced visible regardless of today's category or status filter, since
   the whole point of a link someone sent you is that IT decides what you
   see, not whatever was selected when they made it. Matched by SKU, the
   same stable key shareLink() copies. */
if (location.hash.startsWith("#item-")) {
  const sku = decodeURIComponent(location.hash.slice("#item-".length));
  const linked = [...document.querySelectorAll(".item-tile")].find((el) => el.dataset.sku === sku);
  if (linked) {
    linked.hidden = false;
    linked.classList.add("full");
    linked.scrollIntoView({ block: "start" });
  }
}
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
/* Same [hidden]-vs-explicit-display trap as .item-tile (see that rule's
   own comment) — needed now that the Dashboard's own status filter
   (Test-PRD-P0-112-dashboard_status_filter) toggles hidden on individual
   tiles again, not just whole accordion sections. */
.ticket-tile[hidden] { display: none; }
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

/* The Dashboard's own All-mode accordion (Test-PRD-P0-111-
   dashboard_all_mode_grouping) — one plain <details> per mode, so
   expand/collapse comes free from the element itself rather than a
   second, hand-rolled toggle. The default marker triangle is dropped
   (list-style: none, plus the ::-webkit- one Safari/Chrome draw
   regardless) for a plain chevron matching this page's own understated
   visual language instead of the browser's own bullet-style default. */
.dash-group { margin: 0 0 10px; }
.dash-group summary {
  cursor: pointer; list-style: none; font-size: 12px; font-weight: 700;
  color: var(--ink); padding: 4px 2px; user-select: none;
}
.dash-group summary::-webkit-details-marker { display: none; }
.dash-group summary::before { content: "\\25B8  "; color: var(--muted); font-weight: 400; }
.dash-group[open] summary::before { content: "\\25BE  "; }
.dash-group .ticket-list, .dash-group .ticket-empty { margin-top: 6px; }
/* The horizontal separator between "mine" and everyone else's, within
   one group — the owner's own words: "sort all items assigned or
   related to me at the top with a horizontal separator." */
.dash-mine-sep { border: none; border-top: 1px solid var(--rule); margin: 8px 0; }
/* .dash-status-select itself moved into INPUT_BAR_CSS (shared with Items'
   own status filter, P0-131) — "No Results" still appends alongside the
   dropdown rather than replacing it, specific to Dashboard's own filter:
   "no results still needs a menu selector, no results is appended on the
   end" — once nothing matches the current mode and status together, so
   the selector itself is never taken away; only #status-no-results
   toggles. */
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
  return `<a class="ticket-tile" data-kind="ticket${mine ? " task" : ""}" data-status="${esc(ticket.status)}" href="/tickets/${esc(ticket.id)}">
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
 * One accordion section — Tasks, Tickets, Expenses or Uploads
 * (Test-PRD-P0-111-dashboard_all_mode_grouping). Every row belonging to
 * this kind is split into MINE (the owner's own words: "sort all items
 * assigned or related to me at the top... oldest... at the top") and
 * everyone else's, mine rendered first, oldest first, a horizontal rule
 * between the two groups only when both are non-empty — a lone group
 * needs no rule to separate it from nothing.
 */
function dashboardGroup({ kind, label, rows, dateOf, isMine, tileFn, open, mineOldestFirst = true }) {
  /* Tickets/Tasks: oldest first — the owner's own words, "with oldest
     assignment or ticket at the top," so a stale one surfaces rather than
     hiding behind whatever was just filed. Expenses/Uploads: "sort by
     newest at the top" — the owner's own correction once the same
     oldest-first rule was applied everywhere; both sources already
     arrive newest-first from their own T0 tools, so `mine` here is left
     in that same incoming order rather than re-sorted. */
  const mineRows = rows.filter(isMine);
  const mine = mineOldestFirst
    ? mineRows.slice().sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : 0))
    : mineRows;
  const rest = rows.filter((r) => !isMine(r));
  /* mine/rest each get their own wrapper so the client-side status filter
     (Test-PRD-P0-112-dashboard_status_filter) can tell whether the rule
     between them still has a real "mine" side and a real "everyone
     else's" side left once closed tickets are hidden, not just whether
     the SERVER thought both sides existed. */
  const mineHtml = mine.length ? `<div class="dash-mine">${mine.map(tileFn).join("\n")}</div>` : "";
  const sep = mine.length && rest.length ? `<hr class="dash-mine-sep">` : "";
  const restHtml = rest.length ? `<div class="dash-rest">${rest.map(tileFn).join("\n")}</div>` : "";
  /* No "Nothing here yet." placeholder for an empty group — the owner's
     own words: "get rid of it. It's redundant." The summary's own (0)
     already says so in All mode, and the status line's own "No Results"
     swap already says so for a single narrowed-down mode (P0-112) — a
     third, third-time repetition of the same fact inside the group
     itself added nothing an empty space didn't already say. */
  const body = rows.length ? `<div class="ticket-list">${mineHtml}${sep}${restHtml}</div>` : "";
  return `<details class="dash-group" data-kind="${kind}"${open ? " open" : ""}>
    <summary><span class="dash-group-label">${esc(label)}</span> (<span class="dash-group-count">${rows.length}</span>)</summary>
    ${body}
  </details>`;
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
 * MODES, NOT A FILTER OVER A SELECTION (Test-PRD-P0-110-dashboard_modes)
 *   The owner's own correction, after the first cut treated this as a
 *   multi-select filter like Items' own categories: "we are not dealing
 *   with selections and filtering items. We are dealing with modes...
 *   these are all modes, and they define what happens and what buttons
 *   are available in the rest of the bar." Exactly one mode is active at
 *   a time (a plain string, not a Set) — it both filters the feed AND
 *   decides what the compose bar below does:
 *     - Tickets / Tasks: a text field plus the plain dictation mic; Send
 *       posts to /tickets/new. "When we type in something in the bar and
 *       then hit submit, that's a new ticket... in a task, that's a new
 *       task... but they should not be the same thing" — a hidden `mode`
 *       field tells /tickets/new whether to leave the new ticket
 *       unassigned (Tickets) or assign it to the viewer (Tasks), the same
 *       assigned-to-me signal the feed's own Tasks filter already reads.
 *     - Uploads / Expenses: "we're not necessarily putting in text. We
 *       are literally selecting... instead of the voice, the microphone,
 *       we have a plus button... select [a file] and then hit upload."
 *       The mic slot becomes a plain "+" attach button (ATTACH_ICON, the
 *       same one the agent composer already uses); Send posts the picked
 *       file, multipart, straight to /assets/new (Uploads) or /expenses/
 *       new (Expenses — the existing receipt-scan-then-confirm flow,
 *       unchanged; "uploading" a receipt has always meant landing on its
 *       own review page here, not filing it sight unseen). The submit
 *       button itself never changes — "the submit button always stays
 *       the same" — only what sits to its left does.
 *     - All: browsing only. The bar has nothing to submit, so it is
 *       disabled rather than defaulting to either action.
 *
 * ALL MODE IS AN ACCORDION, NOT ONE FLAT LIST (Test-PRD-P0-111-
 * dashboard_all_mode_grouping)
 *   The owner's own words: "I want an accordion grouping of all items by
 *   mode. With tasks or tickets auto expanding... sort all items assigned
 *   or related to me at the top with a horizontal separator... with
 *   oldest assignment or ticket at the top." Four plain `<details>`
 *   sections, one per mode (dashboardGroup()) — free expand/collapse from
 *   the element itself, no click-handling JS needed for that part. Tasks
 *   and Tickets start `open`; Expenses and Uploads start collapsed,
 *   matching their own "lower priority, just there to be found on
 *   demand" standing from P0-108. Switching to one specific mode hides
 *   the other three sections entirely and forces the remaining one open,
 *   the same "the mode decides what's on screen" rule the compose bar
 *   already follows — the accordion IS how All mode looks, not a
 *   separate view bolted beside it. A mode with nothing in it renders no
 *   `<details>` at all (Test-PRD-P0-115-dashboard_hide_empty_groups) —
 *   "don't show empty accordions at all... only [sections with
 *   something to show are] expandable" — rather than an empty section
 *   with nothing to expand into.
 *
 * DEFAULT VIEW IS A SERVER-COMPUTED HINT, NOT A HARD RULE
 *   The owner's own words: "by default, it should be on tasks... however,
 *   if there are any tickets, say from a customer, that should take
 *   precedence over tasks." src/index.js's /dashboard route decides which
 *   one before this function ever runs (an open ticket in the 'customer'
 *   category anywhere in the working set switches the default from "task"
 *   to "ticket") and hands the answer in as `defaultMode` — this function
 *   only seeds the mode selector's starting value with it. Nothing here
 *   is fixed: the mode menu (the same shape Items' own category picker
 *   established, reusing its CSS literally rather than a second copy)
 *   lets anyone switch to any of the four modes, or "All", at any time.
 */
export function dashboardPage({ tickets, expenses, uploads, viewerEmail, defaultKind }) {
  const isMyTicket = (t) => t.assigned_to === viewerEmail || t.created_by === viewerEmail;
  const groupDefs = [
    {
      kind: "task",
      label: "Tasks",
      rows: tickets.filter((t) => t.assigned_to === viewerEmail),
      dateOf: (t) => t.created_at || "",
      isMine: () => true,
      tileFn: (t) => ticketTile(t, viewerEmail),
      open: true,
    },
    {
      kind: "ticket",
      label: "Tickets",
      rows: tickets,
      dateOf: (t) => t.created_at || "",
      isMine: isMyTicket,
      tileFn: (t) => ticketTile(t, viewerEmail),
      open: true,
    },
    {
      kind: "expense",
      label: "Expenses",
      rows: expenses,
      dateOf: (e) => e.incurred_on || "",
      isMine: (e) => e.employee_id === viewerEmail,
      tileFn: dashboardExpenseTile,
      open: false,
      mineOldestFirst: false,
    },
    {
      kind: "upload",
      label: "Uploads",
      rows: uploads,
      dateOf: (a) => a.uploaded_at || "",
      isMine: (a) => a.uploaded_by === viewerEmail,
      tileFn: dashboardUploadTile,
      open: false,
      mineOldestFirst: false,
    },
  ];
  /* "Don't show empty accordions at all! So when showing all — only
     [the sections with something to show are] expandable sections" — the
     owner's own words. A mode with nothing in it renders no <details> at
     all, rather than an empty, pointless section to expand. Choosing
     that empty mode from the selector still works exactly as before —
     filterFeed() and refreshCounts() simply find no matching group,
     which is indistinguishable from every tile in it already being
     filtered out, so the status line's own "No Results" swap (P0-112)
     covers it for free. */
  const feed = `<div id="dash-feed">
  ${groupDefs
    .filter((def) => def.rows.length > 0)
    .map((def) => dashboardGroup(def))
    .join("\n  ")}
</div>`;

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
    <h1 id="dash-status-heading">Showing: <span id="kind-label">All</span> &mdash;
      <select id="status-filter" class="dash-status-select">
        <option value="open" selected>Open</option>
        <option value="all">All statuses</option>
        <option value="closed">Closed</option>
      </select> <span id="status-no-results" class="dash-status-select" hidden>No Results</span>
    </h1>
  </section>
  ${feed}
  <div class="category-menu" id="kind-menu" hidden>
    <button type="button" class="category-item" data-kind="">All</button>
    <button type="button" class="category-item" data-kind="task">Tasks</button>
    <button type="button" class="category-item" data-kind="ticket">Tickets</button>
    <button type="button" class="category-item" data-kind="expense">Expenses</button>
    <button type="button" class="category-item" data-kind="upload">Uploads</button>
  </div>
  <form class="chat" method="post" action="/tickets/new" enctype="multipart/form-data" id="dash-compose">
    <div class="chat-bar input-bar">
      <button type="button" class="icon-btn" id="kind-btn" aria-label="Mode" title="Mode">${FILTER_ICON}</button>
      <input type="hidden" name="mode" id="dash-mode-field" value="">
      <input type="text" name="title" id="dash-title" placeholder="Pick a mode above to add something" maxlength="200" disabled>
      <input type="file" name="file" id="dash-file-input" hidden>
      <button type="button" class="icon-btn" id="dash-mic" aria-label="Dictate" title="Dictate" hidden>${MIC_ICON}</button>
      <button type="button" class="icon-btn" id="dash-attach" aria-label="Attach a file" title="Attach a file" hidden>${ATTACH_ICON}</button>
      <button type="submit" class="send-btn" aria-label="Submit" title="Submit" id="dash-send" disabled>${SEND_ICON}</button>
    </div>
  </form>
</main>
<script>
const DASH_KIND_LABEL = { ticket: "Tickets", task: "Tasks", expense: "Expenses", upload: "Uploads" };
const DASH_MODE_ACTION = { ticket: "/tickets/new", task: "/tickets/new", expense: "/expenses/new", upload: "/assets/new" };
const DASH_MODE_PLACEHOLDER = { ticket: "Start a new ticket...", task: "Add a task...", expense: "Tap + to attach a receipt photo", upload: "Tap + to choose a file" };
const kindMenuEl = document.getElementById("kind-menu");
const kindLabel = document.getElementById("kind-label");
const dashGroups = document.querySelectorAll("#dash-feed .dash-group");
const statusFilter = document.getElementById("status-filter");
const statusNoResults = document.getElementById("status-no-results");
const composeForm = document.getElementById("dash-compose");
const modeField = document.getElementById("dash-mode-field");
const titleInput = document.getElementById("dash-title");
const fileInput = document.getElementById("dash-file-input");
const micBtn = document.getElementById("dash-mic");
const attachBtn = document.getElementById("dash-attach");
const sendBtn = document.getElementById("dash-send");
const ATTACH_ICON_HTML = ${JSON.stringify(ATTACH_ICON)};
const CANCEL_ICON_HTML = ${JSON.stringify(CANCEL_ICON)};

/* Exactly one mode at a time — a plain string, not a Set (see this
   function's own header for why that changed). "" means All: browsing
   only, nothing to submit. Seeded server-side — "by default, it should
   be on tasks... however, if there are any tickets, say from a customer,
   that should take precedence." */
let currentMode = ${JSON.stringify(defaultKind || "")};
/* "Open" by default — closed tickets stay out of sight until asked for. */
let currentStatus = "open";

/* Bright and orange only once there is actually something to submit —
   the owner's own words: "the send arrow in dashboard also needs a
   disabled state (same dark gray glyph) when there is no entry." Picking
   a mode alone used to enable Send outright (see setMode(), below); this
   is the same principle #chat's own composer already enforces — text
   for a text mode, a picked file for a file mode, nothing otherwise.
   Called after every event that can change either input. */
function updateSendState() {
  const isFileMode = currentMode === "upload" || currentMode === "expense";
  const isTextMode = currentMode === "ticket" || currentMode === "task";
  if (isFileMode) { sendBtn.disabled = !fileInput.files[0]; return; }
  if (isTextMode) { sendBtn.disabled = !titleInput.value.trim(); return; }
  sendBtn.disabled = true;
}

function resetAttachment() {
  fileInput.value = "";
  attachBtn.removeAttribute("aria-pressed");
  attachBtn.innerHTML = ATTACH_ICON_HTML;
  updateSendState();
}

function markKindMenu() {
  kindMenuEl.querySelectorAll(".category-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.kind === currentMode);
  });
}

/* "These are all modes, and they define what happens and what buttons
   are available... in the rest of the bar" — the owner's own words. A
   mode switch changes four things together: which feed tiles show,
   where Send submits, whether the bar takes typed text or a picked
   file, and the status line's own wording. */
function setMode(mode) {
  currentMode = mode;
  modeField.value = mode === "task" ? "task" : "";
  composeForm.action = DASH_MODE_ACTION[mode] || "/tickets/new";
  kindLabel.textContent = mode ? DASH_KIND_LABEL[mode] || mode : "All";

  const isFileMode = mode === "upload" || mode === "expense";
  const isTextMode = mode === "ticket" || mode === "task";
  resetAttachment();
  titleInput.value = "";
  titleInput.disabled = !isTextMode && !isFileMode;
  titleInput.readOnly = isFileMode;
  /* Never required on fileInput itself: it is permanently hidden (only
     ever opened via the + button's own .click()), and a hidden-but-
     required field is a real native-validation footgun — some browsers
     try to focus it to report the error and silently fail instead,
     blocking submission with no visible message at all. Checked in the
     submit handler below instead, where a real message can be shown. */
  titleInput.required = isTextMode;
  titleInput.placeholder = DASH_MODE_PLACEHOLDER[mode] || "Pick a mode above to add something";
  /* Expenses is the existing receipt scanner (receiptUploadPage()) — same
     accept/capture as its own <input>, so the picker offers the camera
     directly on a phone. Uploads takes any file type assets.list already
     accepts, so no restriction. */
  fileInput.accept = mode === "expense" ? "image/*" : "";
  if (mode === "expense") fileInput.setAttribute("capture", "environment");
  else fileInput.removeAttribute("capture");
  micBtn.hidden = !isTextMode;
  attachBtn.hidden = !isFileMode;
  updateSendState();

  markKindMenu();
  filterFeed();
}

composeForm.addEventListener("submit", (e) => {
  const isFileMode = currentMode === "upload" || currentMode === "expense";
  if (isFileMode && !fileInput.files[0]) {
    e.preventDefault();
    attachBtn.animate([{ transform: "scale(1.15)" }, { transform: "scale(1)" }], { duration: 180 });
  }
});

/* "" (All) shows every group, each in whatever open/closed state it
   already carries (Tasks/Tickets start open, Expenses/Uploads start
   collapsed — see dashboardGroup()'s own comment) — switching back to
   All never resets a group someone opened or closed by hand. Narrowing
   to one specific mode hides the other three groups outright and forces
   the remaining one open, since it is now the only thing on screen. */
function filterFeed() {
  dashGroups.forEach((group) => {
    const show = !currentMode || group.dataset.kind === currentMode;
    group.hidden = !show;
    const summary = group.querySelector("summary");
    if (currentMode) {
      group.open = true;
      /* "No need for accordion for selected modes. Accordion is only
         when showing all." — the owner's own words. Hiding the summary
         (not removing it) leaves the content showing plainly with no
         collapse chevron and nothing left to click — a real browser
         falls back to no marker at all for a present-but-hidden summary,
         not a default "Details" label, so this is a clean plain list,
         not a broken accordion. The inline style is belt-and-suspenders
         on top of the hidden attribute — this session has already been
         bitten more than once by an explicit display property elsewhere
         beating the browser's own [hidden] default, so this pins it
         directly rather than trusting cascade order alone. */
      if (summary) {
        summary.hidden = true;
        summary.style.display = "none";
      }
    } else if (summary) {
      summary.hidden = false;
      summary.style.display = "";
    }
  });
  refreshCounts();
}

/* "Don't show any closed tickets unless requested" — the owner's own
   words. Default hides only status "closed" (blocked/in_progress/
   resolved/open all still show); "All statuses" lifts the filter
   entirely; "Closed" flips it to show only closed ones. Expense/upload
   tiles carry no data-status at all, so this never touches them. */
function applyStatusFilter() {
  document.querySelectorAll("#dash-feed .ticket-tile[data-status]").forEach((el) => {
    const status = el.dataset.status;
    const show = currentStatus === "all" || (currentStatus === "open" ? status !== "closed" : status === currentStatus);
    el.hidden = !show;
  });
  refreshCounts();
}

/* Recomputed after either filter changes: each group's own (N) reflects
   what is actually ON SCREEN right now, not the raw row count the server
   sent down; the mine/rest rule (dash-mine-sep) hides itself the moment
   either side it used to separate has nothing left showing; and a plain
   "No Results" appends after the status dropdown — never in place of it,
   "no results still needs a menu selector" — the instant every group
   currently on screen has nothing visible left in it, so switching the
   status right back is still one click away. */
function refreshCounts() {
  let anyVisible = false;
  dashGroups.forEach((group) => {
    const tiles = [...group.querySelectorAll(".ticket-tile")];
    const visible = tiles.filter((t) => !t.hidden).length;
    const countEl = group.querySelector(".dash-group-count");
    if (countEl) countEl.textContent = String(visible);
    if (!group.hidden && visible > 0) anyVisible = true;

    const sep = group.querySelector(".dash-mine-sep");
    if (sep) {
      const mineVisible = [...group.querySelectorAll(".dash-mine .ticket-tile")].some((t) => !t.hidden);
      const restVisible = [...group.querySelectorAll(".dash-rest .ticket-tile")].some((t) => !t.hidden);
      sep.hidden = !(mineVisible && restVisible);
    }
  });
  statusNoResults.hidden = anyVisible;
}

attachBtn.addEventListener("click", () => {
  if (fileInput.files[0]) {
    resetAttachment();
    return;
  }
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  if (!fileInput.files[0]) return;
  titleInput.value = fileInput.files[0].name;
  attachBtn.setAttribute("aria-pressed", "true");
  attachBtn.innerHTML = CANCEL_ICON_HTML;
  updateSendState();
});
titleInput.addEventListener("input", updateSendState);

/* The status line lives at the top of the page now (the .greet section
   above), not sharing this floating spot with the menu any more, so
   opening or closing the menu has nothing to do with it. Picking a mode
   closes the menu — unlike Items' own multi-select category picker,
   exactly one mode is ever active, so there is nothing a second click
   could add. */
${dropdownMenuScript({
  btnId: "kind-btn",
  menuId: "kind-menu",
  onSelect: "setMode(item.dataset.kind); menu.hidden = true;",
})}

statusFilter.addEventListener("change", () => {
  currentStatus = statusFilter.value;
  applyStatusFilter();
});

setMode(currentMode);
applyStatusFilter();

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
       <p class="who">Asked by <strong>${esc(pending.requestedBy ?? "unknown")}</strong>.</p>

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
       <p><a href="/assets/new">Drop another</a> &middot; <a href="/dashboard">Back to the Dashboard</a></p>
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
       <p><a href="/expenses/new">Scan a different receipt</a> &middot; <a href="/dashboard">Back to the Dashboard</a></p>
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
       <p><a href="/expenses/new">Scan another</a> &middot; <a href="/dashboard">Back to the Dashboard</a></p>
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
