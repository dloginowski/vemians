---
name: voice-search-skill
description: "Use when designing or reviewing Items' own voice/category search — the mic on the Items search bar, ops/src/voice-search.js's searchPlanPrompt(), agent.js's searchIntent(), and the /items/search-intent route. Covers why this is one completion and not a tool, the category-vs-keywords split, multi-category selection, and the Agent-vs-Category label."
version: 1.0.0
tags: [items, search, voice, agent, ui]
---

# Voice Search skill — turning speech into a category + keyword plan, not a chat

The owner's own choice of name, given directly while asking for the microphone on Items'
search bar: "let's call it voice search skill... that skill should design how this microphone
input search looks."

## A different shape of skill — read this before the usual template

Every other file in `skills/` documents a *tool domain*: bindings, a `T0`–`T3` operations
table, a role matrix. This one does not, on purpose. Voice Search has no tool, no tier, and no
audit row — `agent.js`'s `searchIntent()` is a single, non-agentic model completion, never a
tool call and never a conversation. It is not wired into `ops/src/skills.js`'s `SOURCES` array
the way `ticket-skills` or `catalog-skills` are, because that array feeds `agentTurn()`'s own
`skills_list`/`skills_read` meta-tools — machinery for a model deciding whether to read more
before calling a *tool*. `searchIntent()` never enters that loop at all, so there is nothing
for it to read on the way in. This file is the design record for a human (or an agent editing
this codebase) to read; `ops/src/voice-search.js`'s `searchPlanPrompt()` is what the model
itself actually reads, at the moment of the call.

**Trigger.** Use when:
- Adding or changing anything about Items' own mic, category menu, or search box
- Changing what `searchPlanPrompt()` asks the model to return, or how the client applies it
- Deciding whether a new "spoken input → structured result" feature belongs here or needs its
  own thing (a request that should stay conversational — "explain this policy to me," say —
  belongs in the real agent chat, not here)

## Not an agentic chat, on purpose

The owner's own words, having tried the first version: "it's not an agentic chat per se... I
don't want to have a chat inside of the items view." Concretely: no `messages` history is kept
across calls, no `tools` array is ever sent (asserted at the wire level by this skill's own
test, `items-search-intent.test.mjs`), and nothing renders as a reply anywhere on the page —
the only observable effect of holding the mic is the search box and the category selector
changing. `SEARCH_INTENT_MAX_TOKENS` (30, in `agent.js`) reflects that a few words is a
ceiling, not a starting point for this call.

## The plan: category and keywords, never one blended string

The first version filled the search box with whatever the model returned — including a
category name, indistinguishable from typed text. Caught live, twice: "I don't wanna eat up
the input area with text... it's part of the actual selector," then, after actually trying the
mic, "it just converted my text into a search directly, but that's not what I'm looking for."

`searchPlanPrompt()` (`ops/src/voice-search.js`) asks for exactly two lines back:

```
CATEGORY: <one exact category name, several separated by commas, or blank>
KEYWORDS: <remaining search terms, or blank>
```

`searchIntent()` (`agent.js`) parses both into separate fields with `[ \t]*` after each
label — same-line whitespace only, not `\s*`, which matches a newline too and (caught by this
skill's own test) let a blank `CATEGORY` line swallow `KEYWORDS`' own text across the line
break. The route (`/items/search-intent`, `ops/src/index.js`) is a pure passthrough: role
check, body parsing, `searchIntent()`, done.

**The client, not this prompt, decides what a returned category actually does.** `category` is
matched case-insensitively back against the real category list the page already knows (the
same list rendered in the filter menu) — anything that matches nothing real is dropped rather
than inventing a category the menu does not have. `keywords`, if non-empty, becomes the search
box's own value; if the model named a category but no keywords, the box is left as whatever the
person already had typed (or empty), since the whole point was to keep it clean of category
text.

## One or more categories — a Set, not a single string

The owner's own worked example, given directly: "let's say we have categories dresses, shoes,
and jewelry... I'm currently set to jewelry... if I ask the agent to find all blue dresses, it
knows that I need to switch my category to dresses, right, or multiple categories, and then
it's gonna do a filter for the color... blue... Of course, I could get more specific and say a
designer name, then it would also add the designer tag as well."

`itemsPage()`'s own script (`ops/src/views.js`) keeps `selectedCategories` as a `Set`, checked
in `filterItems()` against each tile's own `data-category` attribute (an exact, clean value —
never parsed back out of the combined `data-search` substring blob). Two different ways a
category ends up in that set:

- **A manual click** (`toggleCategory()`) adds or removes ONE category, multi-select — the menu
  stays open so a second or third pick still lands, closed instead by the filter button again,
  clicking elsewhere, or Escape. Each currently-selected category shows a checked state in the
  menu itself (`.category-item.active`) — "that menu would automatically select one or more
  categories to satisfy the search."
- **A voice result** (`setAgentCategories()`) REPLACES the whole set with exactly what the model
  named, comma-split — a switch, matching "it knows that I need to switch my category to
  dresses," not an addition to whatever was already selected. Naming no category at all in a
  voice result leaves the current selection untouched entirely — `searchPlanPrompt()` tells the
  model a switch is expected only when the request actually names a different one.

Category and keyword filters combine with AND, never either/or: a category switch and a colour
keyword from the same utterance both apply to the same search, exactly as in the worked
example above.

## The label says who decided it: Category, or Agent

A small dim line (`#category-label`, fixed above the input bar, the same anchor point the
category menu itself opens from — the two never show at once) names whatever is currently
selected. The owner's own words: "I want to see... the necessary combination of categories
and/or search pattern created by the agent... add an agent colon before the search." The wording
is the only thing that differs by source: `toggleCategory()` labels it "Category: X" for a
manual pick; `setAgentCategories()` labels the exact same slot "Agent: X, Y" when voice decided
it — one glance says whether the current filter was clicked or inferred from speech.

## Conformance check

- [ ] `searchIntent()` sends no `tools` array, ever — this stays one completion, not a turn
- [ ] `searchPlanPrompt()` is the only place this call's instruction text lives — not
      duplicated inline in `agent.js`
- [ ] A category never reaches `itemSearch.value` — only `#category-label` and
      `selectedCategories` change from a category, from a click or from voice alike
- [ ] `toggleCategory()` mutates the existing set; `setAgentCategories()` replaces it outright
- [ ] Every category applied, by either path, is matched against the real list first — nothing
      invented reaches the filter or the label
