/*
 * A D1 binding over an in-memory SQLite database, for tests.
 *
 * D1 IS SQLite, and half the guarantees in this repository live in triggers and
 * views — `mirror_product_index` hiding archived rows, the DELETE triggers that
 * make "nothing is deleted" a property of the database rather than of a module
 * remembering. A hand-rolled fake store with a Map in it proves none of them,
 * and passes happily while the real schema would have refused.
 *
 * So every suite that needs a store loads the REAL .sql file into node:sqlite
 * through here, and talks to it with D1's own
 * `prepare(...).bind(...).all()/first()/run()` shape. One copy, because three
 * suites needing the same fake is exactly how two of them drift into proving
 * something the third does not.
 *
 * `_raw` is the underlying node:sqlite handle, for a test that wants to seed or
 * inspect directly without going through the binding.
 */
import { DatabaseSync } from "node:sqlite";

export function d1FromSql(sql) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(sql);

  const wrap = (text) => {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async all() {
        return { success: true, results: db.prepare(text).all(...bound) };
      },
      async first(column) {
        const row = db.prepare(text).get(...bound);
        if (row === undefined) return null;
        return column === undefined ? row : row[column];
      },
      async run() {
        const r = db.prepare(text).run(...bound);
        return {
          success: true,
          meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) },
        };
      },
    };
    return stmt;
  };

  return { prepare: wrap, _raw: db };
}
