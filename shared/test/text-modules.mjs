/*
 * A node module loader that does what wrangler's `[[rules]] type = "Text"` does:
 * resolves *.css, *.client.js and *.md to their source as a default-exported
 * string.
 *
 * Without it the view layer is untestable outside the Worker runtime — views.js
 * imports two stylesheets and index.js imports the browser script, so a plain
 * `node --test` cannot load either, and the tests would be reduced to reading
 * the files as text and asserting about substrings. With it, the tests call the
 * REAL renderer and assert about the REAL HTML it produces.
 *
 * Registered via module.register() before the dynamic import of anything under
 * a Worker's src/ — store/test/storefront.test.mjs for the shop, and
 * ops/test/sync.test.mjs for the ops Worker, whose views.js imports the same
 * stylesheets. Shared rather than copied: two loaders drifting apart would mean
 * two suites disagreeing about what wrangler does.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/* Kept in step with ops/wrangler.toml's [[rules]] globs. *.md is there for
   skills/<name>/SKILL.md, which the MCP endpoint serves from the bundle. */
const TEXT = /\.(?:css|md|client\.js)$/;

export async function load(url, context, next) {
  if (url.startsWith("file:") && TEXT.test(new URL(url).pathname)) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
  }
  return next(url, context);
}
