/*
 * The one document an outside agent needs to add or change inventory here:
 * served at /llms.txt (the conventional place an agent looks) and
 * /agent-skill.md (the same text under a name a person can paste).
 *
 * "If we just tell our agent, go to ops.vemians.com and add some items to the
 * inventory, it should have everything necessary to do this and understand how
 * to get the CSV, how to add new items or update existing ones" -- the owner's
 * own words.
 *
 * GENERATED, NOT HAND-COPIED: the column list, the row and size limits, and
 * the routes come from the same constants the code uses, so this text cannot
 * drift from what the app does (a test pins every export column into it).
 */
import { CAPS } from "./tools/caps.js";
import { EXPORT_HEADERS } from "./batch.js";

export function inventoryAgentGuide() {
  const columns = EXPORT_HEADERS.map((h) => `\`${h}\``).join(", ");
  const megabytes = (CAPS.BATCH_MAX_BYTES / (1024 * 1024)).toFixed(0);
  return `# Adding and updating inventory at ops.vemians.com

You are reading the instructions for changing Vemians' catalog by CSV. Follow them in order.

## 1. Sign in as a person

Everything on ops.vemians.com sits behind Cloudflare Access (Google Workspace sign-in). There is
no API key and no service token for this: writes are recorded against a named person, so a
machine identity is refused. Work inside the signed-in browser session of a person who has the
**manager** role. If you are redirected to a Google or Cloudflare login page, stop and ask the
person to sign in; do not try to get around it.

## 2. Always start from the current inventory

Never build a CSV from scratch, and never start from an older file you were handed. Other people
upload sheets too, and a file that has not seen their changes creates duplicates.

    GET https://ops.vemians.com/products/export.csv

It downloads \`vemians-inventory.csv\`: one row per **variation** (one size/colour of a product),
with these columns: ${columns}.

- \`style id\` is how an item is identified. Rows with the same style id are the sizes/colours of
  one product. A product made by hand carries its shop style id (like 01-04-002).
- \`color\` and \`size\` are blank when the product has none. A blank size means one size ("OS").
- \`price\`, \`cost\` and \`quantity\` are plain numbers (price and cost in dollars, e.g. 80.00).

## 3. Change the file

- **Change an item:** edit the values in its existing row(s). Leave \`style id\` as it is.
- **Add a size or colour to an existing item:** copy one of its rows, keep the \`style id\`, and
  set the new \`color\` and/or \`size\` and its \`price\`, \`cost\` and \`quantity\`.
- **Add a new item:** add rows with a style id that is **not** already in the file, written
  NNN-NNN-NNN (category number, subcategory number, then the next unused item number under that
  subcategory), plus \`title\`, \`category\`, \`subcategory\`, \`price\` and \`quantity\`. Look at the
  existing rows for that category and subcategory to see its numbers and the next free item number.
- **Do not** list the same size and colour twice for one item. Two rows that agree are merged;
  two rows with different prices are refused.
- **Do not** reuse a style id for a different item. If you do, the system gives the newcomer its
  own new id and writes a note on it, but it is cleaner not to rely on that.
- Leave rows you are not changing exactly as exported. Unchanged rows are recognised and skipped.

## 4. Upload it

    POST https://ops.vemians.com/products/batch
    multipart/form-data:  file = the CSV,  mode = update

Use \`mode=update\` for a file that started from the export (rows that match an existing item
update it; rows that match nothing become new items). A file may be at most ${CAPS.BATCH_MAX_ROWS} rows and
${megabytes} MB. The page answers with a summary, one line per row.

For anything over a few dozen rows, prefer the chat on ops.vemians.com: attach the CSV with the
paperclip and the assistant shows a checklist and runs it row by row with a progress bar, instead
of in one request.

## 5. Read the result and report it

Each row ends up in one of these: **created**, **updated**, **already matches** (nothing to
change), **needs a person** (it comes with an approval link: a person opens it, edits and
approves), or **skipped** (with the reason). Tell the person plainly which rows landed and which
need them, and give them the approval links. Approval links belong to the run that made them:
after fixing the cause, upload again instead of reusing an old link.

## Rules of the house

- Nothing here deletes. To remove an item, ask a person to do it in the app.
- Stock counts you upload overwrite what is on hand only when the sheet's number differs; a
  count that disagrees with a non-zero figure on hand is held for a person, not applied.
- Photos are not part of this; they are added in the app.
- Ask the person when anything is ambiguous. Do not guess a price, cost, vendor or quantity.
`;
}
