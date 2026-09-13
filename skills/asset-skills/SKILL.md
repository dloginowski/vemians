---
name: asset-skills
description: "Use when reading a file a coworker dropped at /assets/new — the employee asset drop site. Covers assets.list / assets.read, which formats are actually readable as text today, and why dropping a file is a browser action with no tool of its own."
version: 1.0.0
tags: [assets, files, documents, agents, tools]
---

# Asset skills — read what was dropped, honestly

Inherits `agent-tool-contract`. Read that first.

## Trigger

Use when:
- Someone asks you to look at, summarize, or find something in a file they dropped
- Deciding whether a file's content is actually available to read, or only its metadata
- Building or reviewing an `assets.*` tool

## Bindings

| Store | Kind | Why this one |
|---|---|---|
| `assets` | D1 | The index — filename, uploader, size, and any extracted text |

No customer, commerce, people or finance binding. An asset tool cannot see any of them. There
is also no binding to the raw bytes: `assets.list` and `assets.read` never touch `ASSET_FILES`
(KV, bound only in `src/index.js`'s upload and download routes), so a model cannot receive raw
file bytes through this domain even by mistake — only the text a human's browser upload already
extracted into a column.

## There is no `assets.upload` tool, on purpose

Dropping a file is a browser action, not something a tool proposes: a coworker picks a file at
`/assets/new` and it is stored in the same request — no draft, no approval, nothing for a human
to confirm, because dropping a document changes nothing else in the business (agent-tool-
contract rule: T2 exists for actions worth a human's "yes", and this is not one). If someone
wants a file added, point them at `/assets/new` (or the "Drop a file for the team" link on the
ops front page) rather than trying to construct an upload from inside a conversation — there is
no argument shape for it and there should not be.

## Operations

| Tool | Tier | Notes | Undo |
|---|---|---|---|
| `assets.list` | T0 | Every dropped file: filename, uploader, when, and `has_text` | — |
| `assets.read` | T0 | One file's extracted text, or a plain note when there is none yet | — |

## What "read" actually returns

`assets.read` returns real text for four formats decoded straight as UTF-8, with no ambiguity
about what "text" means: `.txt`, `.md`, `.csv`, `.json`. For anything else accepted by the drop
site — a PDF, a spreadsheet workbook (`.xlsx`/`.xls`), a Word document (`.docx`/`.doc`) — the
file is stored and listed like everything else, but `text` comes back `null` with a `note`
pointing at the file's own link (`/assets/<id>`) for a person to open. **Never guess at a
format's content from its filename or extension** — an agent that infers "probably a price
list" from `price-list.pdf` and answers as if it had read one is worse than saying plainly that
it cannot read this file yet.

Extracted text is capped (`CAPS.ASSET_TEXT_MAX_CHARS`) and marked `truncated: true` past it. A
long file is not refused — it is still worth having on record — but do not treat a truncated
read as the whole document; say so if what you needed might be past the cut.

## Rules

1. **`has_text` before you read.** `assets.list` says which files have extractable text; check
   it before spending a call on `assets.read` for a PDF you already know returns `null`.
2. **A `null` text is an answer, not a failure.** Relay it as "I can't read this file's content
   yet, but here it is: /assets/<id>" — not as an error, and not by inventing content.
3. **No delete, no edit.** The database refuses both (`asset_no_delete`, `asset_no_edit`) — a
   newer version of a document is a new upload, never a change to the old row. Point someone at
   `/assets/new` again rather than looking for an update tool that does not exist.

## Absent by design (T3)

| Absent | Why |
|---|---|
| `assets.upload` | Bytes cannot reach a tool argument at any reasonable size (agent-tool-contract, same arithmetic as `catalog.upload_image`) and there is nothing here for a human to approve — the browser route is the only path, deliberately |
| `assets.delete` / `assets.edit` | Nothing in this codebase deletes; a correction is a new upload |
| Extraction for PDF, spreadsheet or Word formats | Needs a real parser this environment has not vetted against the Workers runtime — deferred, not forgotten (docs/PRD.md P0-65) |

## Conformance check

- [ ] `assets.list` and `assets.read` declare no resource — the tool layer never holds a binding
      to `ASSET_FILES`
- [ ] `assets.read` returns `text: null` plus a `note`, never a guess, for a type with no
      extraction
- [ ] Extracted text is capped and marked `truncated`, never silently cut
- [ ] Any role may call either tool — this is a working-documents store, not a gated one
