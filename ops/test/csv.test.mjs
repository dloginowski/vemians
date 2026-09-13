/*
 * Test contract (RULES.md):
 *
 *   * Every check enforces a NUMBERED PRD feature and carries the visible label
 *     Test-PRD-P0-NN-short_id.
 *   * Unlabeled tests are not acceptable.
 *
 * parseCsv/csvRecords in isolation — pure functions, no fixture needed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { csvRecords, parseCsv } from "../src/tools/csv.js";

const usedLabels = new Set();
const NAME = /^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$/;
function check(name, fn) {
  const parsed = NAME.exec(name);
  assert.ok(parsed, `${name} is not a PRD-labeled check`);
  const [, prio, num, shortId] = parsed;
  usedLabels.add(`Test-PRD-${prio}-${num}-${shortId}`);
  return test(name, fn);
}

check("test_PRD_P0_60_spreadsheet_products__plain_rows_split_on_commas", () => {
  assert.deepEqual(parseCsv("title,price\nCoat,45.00\nHat,20\n"), [
    ["title", "price"],
    ["Coat", "45.00"],
    ["Hat", "20"],
  ]);
});

check("test_PRD_P0_60_spreadsheet_products__a_quoted_field_may_hold_a_comma", () => {
  assert.deepEqual(parseCsv('title,description\n"Trench, belted","Storm shield, horn buttons"\n'), [
    ["title", "description"],
    ["Trench, belted", "Storm shield, horn buttons"],
  ]);
});

check("test_PRD_P0_60_spreadsheet_products__a_doubled_quote_is_one_literal_quote", () => {
  assert.deepEqual(parseCsv('title\n"6"" heel"\n'), [["title"], ['6" heel']]);
});

check("test_PRD_P0_60_spreadsheet_products__crlf_and_bare_cr_both_end_a_row", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r3,4\n"), [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

check("test_PRD_P0_60_spreadsheet_products__blank_lines_are_dropped_not_counted_as_rows", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n\n3,4\n"), [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

check("test_PRD_P0_60_spreadsheet_products__header_names_are_matched_ignoring_case_and_edges", () => {
  const records = csvRecords(parseCsv(" Title , Price \nCoat,45.00\n"));
  assert.deepEqual(records, [{ title: "Coat", price: "45.00" }]);
});

check("test_PRD_P0_60_spreadsheet_products__a_short_row_fills_missing_cells_blank", () => {
  const records = csvRecords(parseCsv("title,price,sku\nCoat\n"));
  assert.deepEqual(records, [{ title: "Coat", price: "", sku: "" }]);
});

test("test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const prd = readFileSync(fileURLToPath(new URL("../../docs/PRD.md", import.meta.url)), "utf8");
  for (const label of usedLabels) {
    assert.ok(prd.includes(label), `${label} is used here but is not a PRD feature`);
  }
});
