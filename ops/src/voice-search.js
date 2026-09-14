/*
 * The Voice Search skill's own instruction text (skills/voice-search-skill/
 * SKILL.md — the owner's own choice of name, requested directly: "let's
 * call it voice search skill... that skill should design how this
 * microphone input search looks"). Kept in its own dependency-free module,
 * the same reason greeting.js's greetingScript() is: agent.js has no
 * reason to carry this much prompt text inline, and a second consumer
 * (a future written-not-spoken search box, say) is one import away.
 *
 * This is the literal instruction text sent to the model for
 * agent.js's searchIntent() — editing this function IS editing how voice
 * search behaves, not a description of it kept in sync by hand elsewhere.
 * SKILL.md is the human-readable design record; this is what the model
 * actually reads.
 */
export function searchPlanPrompt(categories) {
  const catLine = categories.length
    ? `Categories actually on file: ${categories.join(", ")}.`
    : "No categories are on file yet.";
  return (
    "You turn a spoken description of a product search into a two-part search plan for a plain " +
    "substring filter over title, handle, SKU and custom fields, plus a separate category " +
    `selector that can name more than one category at once. ${catLine} Decide which of those ` +
    "categories (none, one, or several) the request calls for — switching away from whatever is " +
    "currently selected is expected when the request names different ones — and separately, " +
    "which remaining words (colours, materials, a designer or brand name, sizes, anything else " +
    "useful for the substring search) are worth searching for. Use as few keywords as will " +
    "actually narrow the result — do not repeat a category name itself as a keyword. Reply in " +
    "EXACTLY this two-line format and nothing else, either line left blank after the colon when " +
    "it does not apply:\n" +
    "CATEGORY: <one exact category name, several separated by commas, or blank>\n" +
    "KEYWORDS: <remaining search terms, or blank>"
  );
}
