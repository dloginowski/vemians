/*
 * The skills, served to whoever connects.
 *
 * The point of the MCP endpoint is that a COWORKER'S OWN agent — their Claude,
 * their ChatGPT — connects and drives the tools itself. Tool names and
 * one-line descriptions are not enough for that. `catalog.create_product`
 * says what it is called; it does not say that the category set is closed, that
 * price and publish are two gates rather than one, or that a photograph goes
 * through an upload ticket because a phone image is a million output tokens of
 * base64. That knowledge lives in skills/<name>/SKILL.md, and until now it was
 * readable in the repository and nowhere else.
 *
 * BUNDLED, NOT FETCHED. Each SKILL.md is a Text module import, so the bytes a
 * connected agent reads are the bytes in the repository at deploy time. There
 * is no drift between the documentation and the deployment, because there is no
 * copy — the same argument shared/design/*.css is imported for.
 *
 * Test-PRD-P0-54-skill_discovery.
 */
import agentToolContract from "../../skills/agent-tool-contract/SKILL.md";
import assetSkills from "../../skills/asset-skills/SKILL.md";
import catalogSkills from "../../skills/catalog-skills/SKILL.md";
import commerceSkills from "../../skills/commerce-skills/SKILL.md";
import customerSkills from "../../skills/customer-skills/SKILL.md";
import financeSkills from "../../skills/finance-skills/SKILL.md";
import identitySkills from "../../skills/identity-skills/SKILL.md";
import knowledgeSkills from "../../skills/knowledge-skills/SKILL.md";
import peopleSkills from "../../skills/people-skills/SKILL.md";

/*
 * `domain` is the join to authorisation. A skill is listed only when the role
 * can call at least one tool in that domain — the same rule toolsFor() applies,
 * and for the same reason: a document describing tools you will be refused
 * teaches a model to keep trying them.
 *
 * `agent-tool-contract` has no domain. It is the house rules for every tool —
 * tiers, approval, audit — and everyone who connects needs it, which is why it
 * is also the one the instructions point at first.
 */
const SOURCES = [
  ["agent-tool-contract", null, agentToolContract],
  ["asset-skills", "assets", assetSkills],
  ["catalog-skills", "catalog", catalogSkills],
  ["commerce-skills", "commerce", commerceSkills],
  /* "customers", PLURAL, because that is what the tools call it. Written
     singular first, which hid this skill from every role including owner and
     looked exactly like a working system. A domain that names no tool is now a
     test failure, not a silence. */
  ["customer-skills", "customers", customerSkills],
  ["finance-skills", "finance", financeSkills],
  /* The vault is reached THROUGH the customer tools — there is no identity.*
     tool and there should not be. So this rides with customers: an agent about
     to touch a profile is exactly who must read the crypto-shredding rules. */
  ["identity-skills", "customers", identitySkills],
  /* No knowledge tools exist yet, so this is listed for nobody. That is the
     rule working, not a bug: when knowledge tools land it appears on its own. */
  ["knowledge-skills", "knowledge", knowledgeSkills],
  ["people-skills", "people", peopleSkills],
];

/*
 * Front matter, parsed rather than duplicated. The description in SKILL.md is
 * the one a human maintains; retyping it here is how the two come to disagree.
 * Deliberately small: the keys we use, from a document we control.
 */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[kv[1].toLowerCase()] = v;
  }
  return out;
}

export const SKILLS = SOURCES.map(([name, domain, text]) => {
  const fm = frontMatter(text);
  return {
    name,
    domain,
    uri: `skill://${name}`,
    title: fm.name || name,
    description: fm.description || "",
    version: fm.version || "0",
    text,
    bytes: text.length,
  };
});

export const skillByName = (name) =>
  SKILLS.find((s) => s.name === name || s.uri === name) || null;

/*
 * Which skills this role should see.
 *
 * `canUseDomain` is injected rather than imported so this module holds no
 * opinion about roles — mcp.js owns that rule, and one copy of it is the point.
 * A skill with no domain is for everyone.
 */
export function skillsFor(role, canUseDomain) {
  return SKILLS.filter((s) => s.domain === null || canUseDomain(role, s.domain));
}
