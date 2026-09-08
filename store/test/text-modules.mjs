/*
 * A node module loader that does what wrangler's `[[rules]] type = "Text"` does:
 * resolves *.css and *.client.js to their source as a default-exported string.
 *
 * Without it the view layer is untestable outside the Worker runtime — views.js
 * imports two stylesheets and index.js imports the browser script, so a plain
 * `node --test` cannot load either, and the tests would be reduced to reading
 * the files as text and asserting about substrings. With it, the tests call the
 * REAL renderer and assert about the REAL HTML it produces.
 *
 * Registered from storefront.test.mjs via module.register() before the dynamic
 * import of anything under src/.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TEXT = /\.(?:css|client\.js)$/;

export async function load(url, context, next) {
  if (url.startsWith("file:") && TEXT.test(new URL(url).pathname)) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
  }
  return next(url, context);
}
