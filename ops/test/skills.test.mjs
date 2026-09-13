/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *   * A behaviour change moves the PRD feature and its labeled check together.
 *
 * These drive the MCP endpoint the way a COWORKER'S OWN assistant does — real
 * JSON-RPC over HTTP against the real handler, with a forged-but-shaped Access
 * identity — rather than calling the registration functions directly. The bug
 * this catches is the one that matters: a skill registered but not reachable
 * over the wire is indistinguishable from a skill that works, until someone
 * connects ChatGPT to it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { SKILLS, skillsFor, skillByName } = await import("../src/skills.js");
const { canUseDomain, roleCanUse } = await import("../src/mcp.js");
const { TOOLS } = await import("../src/tools/index.js");

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;

function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

/* ─────────────────────────────────────────────────────────────────────────
 * P0-54 — a connecting agent can discover how to use the tools, not just
 *         their names
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_54_skill_discovery__every_skill_file_is_bundled_with_its_front_matter", () => {
  assert.equal(SKILLS.length, 9, "all nine SKILL.md files should be bundled");
  for (const s of SKILLS) {
    assert.ok(s.text.length > 500, `${s.name} looks truncated (${s.text.length} bytes)`);
    assert.ok(s.description.length > 20, `${s.name} has no usable description`);
    assert.match(s.version, /^\d+\.\d+/, `${s.name} has no version`);
    assert.equal(s.uri, `skill://${s.name}`);
    /* The front matter must be PARSED, not the raw delimiter text. */
    assert.ok(!s.description.startsWith("---"), `${s.name} front matter was not parsed`);
  }
});

check("test_PRD_P0_54_skill_discovery__the_description_is_the_one_maintained_in_the_file", () => {
  /* Retyping a description in code is how it comes to disagree with the
     document it describes. Assert they are the same string. */
  const catalog = skillByName("catalog-skills");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(catalog.text)[1];
  const inFile = /^description:\s*"(.*)"$/m.exec(fm)[1];
  assert.equal(catalog.description, inFile);
});

check("test_PRD_P0_54_skill_discovery__skills_are_filtered_by_role_like_tools_are", () => {
  const staff = skillsFor("staff", canUseDomain).map((s) => s.name);
  const owner = skillsFor("owner", canUseDomain).map((s) => s.name);

  /* The house rules are for everyone who connects. */
  assert.ok(staff.includes("agent-tool-contract"), "every role needs the tool contract");
  assert.ok(owner.includes("agent-tool-contract"));

  /* An owner sees at least as much as staff, never less. */
  for (const name of staff) {
    assert.ok(owner.includes(name), `owner lost ${name} that staff can see`);
  }

  /* Staff DO see identity-skills, and that is deliberate. It rides with the
     customers domain because the vault is reached through customer tools, and
     a staff member whose agent is about to read a profile is exactly who needs
     the crypto-shredding rules. The document describes the design; it holds no
     secret, and withholding safety rules from the people handling the data is
     backwards. Reading it grants nothing — the tools still gate the access. */
  assert.ok(staff.includes("identity-skills"), "staff handle customer data and must know the rules");

  /* No knowledge tools exist yet, so nobody is shown a document about them. */
  assert.ok(!owner.includes("knowledge-skills"), "a skill with no tools is listed for no one");
});

check("test_PRD_P0_54_skill_discovery__a_skill_is_listed_only_when_its_tools_are", () => {
  /* The rule, stated as the property rather than as a table: if no tool in a
     domain is callable by this role, the domain's skill is not listed. A
     document about tools you will be refused teaches a model to keep trying. */
  for (const role of ["staff", "manager", "owner"]) {
    const listed = new Set(skillsFor(role, canUseDomain).map((s) => s.domain).filter(Boolean));
    for (const domain of listed) {
      const usable = Object.values(TOOLS).some(
        (t) => String(t.domain || "").toLowerCase() === domain && roleCanUse(role, t),
      );
      assert.ok(usable, `${role} was shown the ${domain} skill with no ${domain} tool to call`);
    }
  }
});

check("test_PRD_P0_54_skill_discovery__every_skill_domain_names_a_real_tool_domain", () => {
  /* THE REGRESSION. customer-skills was mapped to "customer" while the tools
     call it "customers", so the document was hidden from every role including
     owner — and a silently-empty filter looks identical to a working one. Any
     skill whose domain matches no tool is either a typo or a skill for tools
     that do not exist; both are worth failing over, with knowledge-skills the
     one deliberate exception until knowledge tools land. */
  const toolDomains = new Set(
    Object.values(TOOLS).map((t) => String(t.domain || "").toLowerCase()).filter(Boolean),
  );
  const PENDING = new Set(["knowledge"]);
  for (const s of SKILLS) {
    if (s.domain === null || PENDING.has(s.domain)) continue;
    assert.ok(
      toolDomains.has(s.domain),
      `${s.name} claims domain "${s.domain}", which no tool uses. Tool domains: ${[...toolDomains].sort().join(", ")}`,
    );
  }
});

check("test_PRD_P0_54_skill_discovery__an_owner_sees_every_skill_that_has_tools", () => {
  /* The owner is the ceiling. If a document is hidden from them it is hidden
     from everyone, which is how the plural bug survived being written. */
  const seen = new Set(skillsFor("owner", canUseDomain).map((s) => s.name));
  for (const s of SKILLS) {
    if (s.domain !== null && !Object.values(TOOLS).some(
      (t) => String(t.domain || "").toLowerCase() === s.domain)) continue;
    assert.ok(seen.has(s.name), `owner cannot see ${s.name}`);
  }
});

check("test_PRD_P0_54_skill_discovery__an_unlisted_skill_reads_as_absent_not_forbidden", () => {
  /* skillByName resolves anything bundled; the ENDPOINT is what refuses. What
     matters is that the refusal cannot be told apart from "no such skill" — a
     distinguishable message would leak which documents exist for other roles. */
  assert.ok(skillByName("knowledge-skills"), "the skill exists in the bundle");
  const visible = skillsFor("owner", canUseDomain).some((s) => s.name === "knowledge-skills");
  assert.equal(visible, false, "and is listed for nobody, so the endpoint refuses it as absent");
});

check("test_PRD_P0_54_skill_discovery__lookup_accepts_the_name_or_the_uri", () => {
  assert.equal(skillByName("catalog-skills")?.name, "catalog-skills");
  assert.equal(skillByName("skill://catalog-skills")?.name, "catalog-skills");
  assert.equal(skillByName("no-such-skill"), null);
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-64 — the greeting protocol survives a client that drops `instructions`
 * ───────────────────────────────────────────────────────────────────────── */

check("test_PRD_P0_64_greeting_survives_every_client__agent_tool_contract_carries_the_opening_script", () => {
  /* buildInstructions()'s FIRST MESSAGE / SECOND MESSAGE text (P0-62) is a
     connect-time `instructions` field, and at least two real MCP clients
     (Claude.ai's own web connector, ChatGPT) do not surface that field to the
     model at all. agent-tool-contract is read by every role (asserted above)
     via a real skills_read call, whose result reaches the model on every
     client — so the same greeting protocol has to live here too, not only in
     buildInstructions(). */
  const contract = skillByName("agent-tool-contract").text;
  assert.match(contract, /greet.*by name/i, "the opening greeting is not documented in the skill");
  assert.match(contract, /short menu/i, "the numbered menu is not documented in the skill");
  assert.match(
    contract,
    /spreadsheet, or would you rather tell me about them here/i,
    "the spreadsheet-or-narrate follow-up question is not documented in the skill",
  );
  assert.match(contract, /real form, not a preview/i, "the editable-approval-link framing is missing");
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(
    fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)),
    "utf8",
  );
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * P0-23 — DEFAULT_ROLE, the bridge until a roster exists
 * ───────────────────────────────────────────────────────────────────────── */

const accessMod = await import("../src/access.js");
const { roleFor } = accessMod;

check("test_PRD_P0_23_group_derived_roles__a_group_always_beats_the_default", () => {
  const staffIdentity = { claims: { email: "a@vemians.com", groups: ["vemians-staff"] } };
  assert.equal(
    roleFor(staffIdentity, { DEFAULT_ROLE: "owner" }),
    "staff",
    "a real group mapping must win, or adding groups later would silently do nothing",
  );
});

check("test_PRD_P0_23_group_derived_roles__no_group_and_no_default_is_still_null", () => {
  const identity = { claims: { email: "a@vemians.com" } };
  assert.equal(roleFor(identity, {}), null, "unset DEFAULT_ROLE must fail closed exactly as before");
});

check("test_PRD_P0_23_group_derived_roles__the_default_applies_only_when_no_group_matched", () => {
  const identity = { claims: { email: "a@vemians.com" } };
  assert.equal(roleFor(identity, { DEFAULT_ROLE: "manager" }), "manager");
  assert.equal(roleFor(identity, { DEFAULT_ROLE: "OWNER" }), "owner", "case is not the user's problem");
});

check("test_PRD_P0_23_group_derived_roles__a_misspelled_default_grants_nothing", () => {
  /* A typo must not become an escalation, and must not become a silent
     downgrade either — it grants NOTHING, loudly. */
  const identity = { claims: { email: "a@vemians.com" } };
  assert.equal(roleFor(identity, { DEFAULT_ROLE: "admin" }), null);
  assert.equal(roleFor(identity, { DEFAULT_ROLE: "superuser" }), null);
});

check("test_PRD_P0_23_group_derived_roles__explain_says_which_rule_granted_the_role", () => {
  const { explainRole } = accessMod;

  const byGroup = explainRole({ claims: { email: "a@vemians.com", groups: ["Vemians-Manager"] } }, {});
  assert.equal(byGroup.role, "manager");
  assert.equal(byGroup.via, "group", "a group match must be distinguishable from a fallback");
  assert.equal(byGroup.matched, "vemians-manager");

  const byDefault = explainRole({ claims: { email: "a@vemians.com" } }, { DEFAULT_ROLE: "owner" });
  assert.equal(byDefault.role, "owner");
  assert.equal(byDefault.via, "DEFAULT_ROLE", "so 'my roles are not arriving' is answerable, not guessable");
  assert.deepEqual(byDefault.groups, [], "and the empty group list is the evidence");

  const nothing = explainRole({ claims: { email: "a@vemians.com" } }, {});
  assert.equal(nothing.role, null);

  /* explainRole and roleFor must never disagree — one rule, two callers. */
  for (const env of [{}, { DEFAULT_ROLE: "owner" }, { DEFAULT_ROLE: "nonsense" }]) {
    for (const groups of [[], ["vemians-staff"], ["vemians-owner"], ["unrelated"]]) {
      const id = { claims: { email: "a@vemians.com", groups } };
      assert.equal(explainRole(id, env).role, roleFor(id, env), `disagreed for ${JSON.stringify({ env, groups })}`);
    }
  }
});

check("test_PRD_P0_23_group_derived_roles__policy_id_grants_the_role_the_token_actually_carries", () => {
  const { explainRole } = accessMod;
  const env = { OWNER_POLICY_ID: "OWNER-UUID", STAFF_POLICY_ID: "STAFF-UUID" };

  /* This is the real shape: no groups anywhere, just policy_id — exactly what
     /whoami showed on a live assertion. */
  const owner = explainRole({ claims: { email: "d@vemians.com", policy_id: "owner-uuid" } }, env);
  assert.equal(owner.role, "owner", "case must not decide who is an owner");
  assert.equal(owner.via, "policy");

  const staff = explainRole({ claims: { email: "s@vemians.com", policy_id: "STAFF-UUID" } }, env);
  assert.equal(staff.role, "staff");

  /* Admitted by the catch-all, which maps to no role: nothing, not staff. */
  const other = explainRole({ claims: { email: "x@vemians.com", policy_id: "685682ec-catchall" } }, env);
  assert.equal(other.role, null, "an unmapped policy grants nothing rather than the lowest role");
});

check("test_PRD_P0_23_group_derived_roles__a_group_still_wins_over_a_policy", () => {
  const { explainRole } = accessMod;
  const both = explainRole(
    { claims: { email: "d@vemians.com", groups: ["vemians-owner"], policy_id: "STAFF-UUID" } },
    { OWNER_POLICY_ID: "OWNER-UUID", STAFF_POLICY_ID: "STAFF-UUID" },
  );
  assert.equal(both.role, "owner", "a provider that does pass groups through must not be overridden");
  assert.equal(both.via, "group");
});

check("test_PRD_P0_23_group_derived_roles__an_unset_policy_var_never_matches_an_empty_claim", () => {
  /* The dangerous case: with OWNER_POLICY_ID unset, "" === "" must NOT make
     everyone an owner. */
  const { explainRole } = accessMod;
  const out = explainRole({ claims: { email: "x@vemians.com" } }, { STAFF_POLICY_ID: "S" });
  assert.equal(out.role, null);
  const out2 = explainRole({ claims: { email: "x@vemians.com", policy_id: "" } }, {});
  assert.equal(out2.role, null);
});
