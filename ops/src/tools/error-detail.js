/*
 * A thrown provider error (SquareError, shared/commerce/square/client.js) carries
 * the REAL reason — category/code/detail/field straight from the provider's own
 * response body — on `.errors`, entirely separate from `.message`, which is only
 * ever the generic "Square POST /v2/catalog/object failed with 400." Duck-typed
 * on `.errors` rather than importing anything Square-specific: every OTHER kind
 * of failure (a bad D1 query, a thrown validation Error) has no `.errors` array
 * and falls straight through to the plain message.
 *
 * Its own module, rather than living in tools/index.js: catalog-writer.js's own
 * per-product catch (applyItemOptionsToProductsInCategory, the "one product's
 * failure does not fail the batch" shape) needs this same formatting too, and
 * tools/index.js already imports FROM catalog-writer.js — importing back the
 * other way would be circular.
 */
export function errorDetail(err) {
  if (!Array.isArray(err?.errors) || err.errors.length === 0) return err?.message ?? "unknown error";
  const detail = err.errors
    .map(
      (e) =>
        `${e.category ?? "?"}/${e.code ?? "?"}${e.field ? ` (field: ${e.field})` : ""}${e.detail ? `: ${e.detail}` : ""}`,
    )
    .join("; ");
  return `${err.message} — ${detail}`;
}
