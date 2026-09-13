/*
 * A minimal CSV reader — RFC 4180 quoting (a quoted field may hold a comma,
 * a newline or an escaped `""`), nothing else. No dependency: this is the one
 * format Excel and Google Sheets both export natively, so there is nothing a
 * library would buy that "Save as CSV" does not already give a coworker.
 *
 * Pure and synchronous: it turns text into rows of strings and asserts
 * nothing about what those strings mean — that is batch.js's job, which
 * knows about products and Square and this file must not.
 */

/** text -> string[][]. Blank rows (no fields, or one empty field) are dropped. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * rows[0] is the header. Returns one object per data row, keyed by the
 * LOWERCASED, TRIMMED header cell — "Price", " price " and "PRICE" all land
 * on the same key, because a coworker's spreadsheet was not typed to a spec.
 * A row shorter than the header fills the rest with "".
 */
export function csvRecords(rows) {
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])),
  );
}
