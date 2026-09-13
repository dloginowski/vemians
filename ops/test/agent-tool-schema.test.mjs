/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *   * A behaviour change moves the PRD feature and its labeled check together.
 *
 * Test-PRD-P0-76-valid_tool_schema. NO NETWORK CALL IS INVOLVED — this file
 * never reaches Anthropic. What is under test is that `toolDefinitions()`
 * produces something Anthropic's Messages API COULD accept: a real JSON
 * Schema object, not this codebase's own internal validation DSL forwarded
 * unmodified. That DSL shape reaching a live API is exactly the bug this
 * suite exists to catch — every other test of the tool layer exercises
 * runTool()'s own validate(), a completely separate code path that never
 * looks at what gets sent to Claude.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../../shared/test/text-modules.mjs", import.meta.url);

const { toolDefinitions, toJsonSchema } = await import("../src/agent.js");
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

/* Recursively assert a value is a legal JSON Schema node — the property that
   actually matters to Anthropic's API, not just "has some type field". */
function assertValidNode(node, where) {
  assert.ok(node && typeof node === "object" && !Array.isArray(node), `${where} must be an object`);
  assert.ok(typeof node.type === "string", `${where}.type must be a string`);
  assert.ok(
    ["object", "string", "integer", "boolean", "array", "number"].includes(node.type),
    `${where}.type '${node.type}' is not a JSON Schema type`,
  );
  if (node.type === "object") {
    assert.ok(node.properties && typeof node.properties === "object", `${where}.properties must be an object`);
    for (const [k, v] of Object.entries(node.properties)) assertValidNode(v, `${where}.properties.${k}`);
    if ("required" in node) {
      assert.ok(Array.isArray(node.required), `${where}.required must be an array of field names`);
      for (const r of node.required) assert.equal(typeof r, "string");
    }
  }
  if (node.type === "array" && "items" in node) assertValidNode(node.items, `${where}.items`);
}

check("test_PRD_P0_76_valid_tool_schema__every_registered_tool_converts_to_a_legal_json_schema", () => {
  for (const [name, tool] of Object.entries(TOOLS)) {
    const converted = toJsonSchema(tool.schema);
    assertValidNode(converted, name);
  }
});

check("test_PRD_P0_76_valid_tool_schema__tool_definitions_never_forward_the_internal_dsl_raw", () => {
  /* The actual regression: toolDefinitions() used to hand tool.schema straight
     through as input_schema — a flat {field: {type, required, ...}} map with
     no top-level "type": "object" at all, which is exactly what a real
     Anthropic call 400'd on the first time this deployment had a real key. */
  for (const def of toolDefinitions("owner")) {
    assertValidNode(def.input_schema, def.name);
  }
});

check("test_PRD_P0_76_valid_tool_schema__required_is_a_top_level_array_not_a_per_field_flag", () => {
  const defs = toolDefinitions("owner");
  const createProduct = defs.find((d) => d.name === "catalog.create_product");
  assert.ok(createProduct, "catalog.create_product must be visible to the owner role");
  const schema = createProduct.input_schema;
  assert.equal(schema.type, "object");
  assert.ok(Array.isArray(schema.required));
  assert.ok(schema.required.includes("title"));
  assert.ok(schema.required.includes("variations"));
  /* And required must NEVER survive as a stray boolean on the field itself —
     that key means something different in our DSL than it does in JSON
     Schema, and leaving it in place is confusing at best. */
  for (const prop of Object.values(schema.properties)) {
    assert.ok(!("required" in prop), "a per-field 'required' leaked through unconverted");
  }
});

check("test_PRD_P0_76_valid_tool_schema__a_nested_array_of_objects_converts_its_items_too", () => {
  /* catalog.create_product's `variations` is an array of VARIATION objects —
     the one shape in this registry that most directly tests recursion. */
  const defs = toolDefinitions("owner");
  const createProduct = defs.find((d) => d.name === "catalog.create_product");
  const variations = createProduct.input_schema.properties.variations;
  assert.equal(variations.type, "array");
  assert.equal(variations.items.type, "object");
  assert.ok(variations.items.properties.price_minor);
  assert.equal(variations.items.properties.price_minor.type, "integer");
  assert.ok(variations.items.required.includes("title"));
  assert.ok(variations.items.required.includes("price_minor"));
});

check("test_PRD_P0_76_valid_tool_schema__a_tool_with_no_arguments_still_gets_a_well_formed_object", () => {
  const defs = toolDefinitions("staff");
  const noArgTool = defs.find((d) => Object.keys(TOOLS[d.name].schema || {}).length === 0);
  assert.ok(noArgTool, "expected at least one zero-argument tool visible to staff");
  assert.deepEqual(noArgTool.input_schema, { type: "object", properties: {} });
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
