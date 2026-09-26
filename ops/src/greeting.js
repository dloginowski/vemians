/*
 * The greeting-and-menu protocol for the built-in browser chat
 * (agent.js's systemPrompt) — the ops surface's only conversational path
 * since P0-81 removed the MCP endpoint that used to share this text
 * verbatim via its own buildInstructions(). Kept in its own dependency-free
 * module regardless: agent.js has no reason to carry this much prompt text
 * inline, and a second consumer is one import away if one ever returns.
 */
export function greetingScript(firstName) {
  return (
    /* The first turn is a coworker opening a new tool, not a developer
       reading an API. Greeting them with a wall of tool names is the
       opposite of the plain, short-choices experience the ops front page
       itself promises — say so here, once, so every connecting agent
       opens the same way instead of each inventing its own tone.
       REVISED — the four choices used to be spelled out inline as prose
       ("1) Add Merchandise  2) Add Customers..."), which is exactly the
       "text stuff" a real transcript asked to have replaced: "I want you
       to give me balloon pop-ups... instead of like the text." The lead-in
       line now names the four choices only so this instruction stays
       readable; the model's own reply says a short greeting line and then
       each choice as its own CHOICE line (systemPrompt's own instruction
       on that format, above this file's own import), never both at once. */
    ` FIRST MESSAGE: greet them BY THEIR ACTUAL FIRST NAME — ${firstName},` +
    ` given above, not a guess of your own — with a short line such as` +
    ` "Hi ${firstName} — what would you like to do?", then these exactly` +
    ` four choices as CHOICE lines, in this order: Add Merchandise, Add` +
    ` Customers, Submit Expenses, More Options. Do not also spell them out` +
    ` as numbered prose in the same reply — the CHOICE lines are the menu.` +
    ` Do not explain tiers, tools or skills unless asked. If they pick` +
    ` "More Options," say plainly what else you can do (look something` +
    ` up, connect their own assistant, anything else this role reaches)` +
    ` rather than a second rigid menu.` +
    /* The front page's own quick-prompt chips send one of these four phrases
       as the person's actual first message — a click already IS the choice.
       Re-presenting the menu they just used is a wasted round-trip, exactly
       the churn a one-click chip exists to avoid. */
    ` IF THEIR FIRST MESSAGE ALREADY NAMES A CHOICE — "Add merchandise,"` +
    ` "Add customers," "Submit an expense," or similar — skip the greeting` +
    ` menu entirely and go straight to whatever comes next for that choice` +
    ` (the second question below, or the expense link). Do NOT greet them` +
    ` by name here — the page itself already shows "Hi ${firstName}" right` +
    ` above the chat, so repeating it in the reply is the owner's own` +
    ` complaint: "you keep on adding Hi Dimitri to all of your responses...` +
    ` I don't really need that, they already have it at the top."` +
    /* Once they pick "Add Merchandise" or "Add Customers" from the first
       menu, ask a second, equally short question before doing anything:
       spreadsheet or narrate it here. Both end at the SAME result — a
       spreadsheet on ops.vemians.com (/products/batch, /customers/batch —
       one file, one approval link per row), or, for a narrated list, draft
       then create one at a time exactly as for a single item, gathering
       every resulting approval link to present together at the end. There
       is no separate "batch" tool for the second path. Never approve on
       the person's behalf; each link still needs its own "yes". */
    ` SECOND MESSAGE, once they pick Merchandise or Customers: ask one more` +
    ` short question before doing anything — "Do you have a spreadsheet,` +
    ` or would you rather tell me about them here?" — as a lead-in line` +
    ` followed by two CHOICE lines (Spreadsheet, Tell you here), the same` +
    ` format as the first menu, never spelled out as prose instead. For a` +
    ` spreadsheet, point them at /products/batch or /customers/batch on` +
    ` ops.vemians.com. For a narrated list, draft and create one at a time` +
    ` as usual — there is no separate "batch" tool — then present every` +
    ` resulting approval link together at the end.` +
    /* Expense is a photo action, not a batch-or-narrate one — there is no
       "narrate a receipt" and no expense.upload tool to call. Send them
       straight to the link, same as a product photo. */
    ` "Submit Expenses" IS DIFFERENT: there is no tool for it and no second` +
    ` question. Point them straight at /expenses/new on ops.vemians.com —` +
    ` they photograph the receipt there, confirm what was read off it, and` +
    ` it is filed under their name. Do not attempt to draft or submit an` +
    ` expense yourself; there is nothing to call.` +
    /* The link either path ends at is not read-only. Say so, or the model's
       own habit is to describe a proposal in the chat and ask the person to
       confirm it there — which is exactly the in-band approval P0-35 exists
       to prevent. The page is the only place a change can be reviewed,
       corrected or said yes to. */
    ` THAT LINK IS A REAL FORM, not just a preview: the person can review` +
    ` what you proposed, fix anything wrong right there (a typo'd title, a` +
    ` wrong price), and submit — all on that page. Do not ask them to` +
    ` confirm details in this chat; send them to the link for that.`
  );
}
