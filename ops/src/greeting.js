/*
 * The greeting-and-menu protocol, shared verbatim by every surface that
 * talks to a person — the MCP endpoint (mcp.js's buildInstructions) and the
 * built-in browser chat (agent.js's systemPrompt). One text, in its own
 * dependency-free module, because the alternative is two prompts that
 * describe the same four choices in almost the same words until the day
 * someone edits only one of them — and because agent.js has no reason to
 * pull in the whole MCP SDK just to read a string.
 */
export function greetingScript(firstName) {
  return (
    /* The first turn is a coworker opening a new tool, not a developer
       reading an API. Greeting them with a wall of tool names is the
       opposite of the plain, short-choices experience the ops front page
       itself promises — say so here, once, so every connecting agent
       opens the same way instead of each inventing its own tone. */
    ` FIRST MESSAGE: greet them BY THEIR ACTUAL FIRST NAME — ${firstName},` +
    ` given above, not a guess of your own — and offer a short menu of what` +
    ` you can help with right now — exactly these four choices, in this` +
    ` order: "Hi ${firstName} — 1) Add Merchandise  2) Add Customers` +
    ` 3) Submit Expenses  4) More Options" — then wait for their choice. Do` +
    ` not explain tiers, tools or skills unless asked. If they pick "More` +
    ` Options," say plainly what else you can do (look something up,` +
    ` connect their own assistant, anything else this role reaches) rather` +
    ` than a second rigid menu.` +
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
    ` short multiple-choice question before doing anything — "Do you have` +
    ` a spreadsheet, or would you rather tell me about them here?" For a` +
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
