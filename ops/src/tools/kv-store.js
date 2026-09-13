/*
 * A tiny byte store over a KV binding — put once (refuses to overwrite an
 * occupied key, since every key here carries a uuid), read back as a
 * Uint8Array. No tool ever holds one of these; only src/index.js's upload and
 * download routes do (agent-tool-contract: scope is a binding, not a
 * promise, and a T0 read tool declaring no resource cannot leak raw bytes to
 * a model even by mistake).
 *
 * Shared by every domain that keeps an uploaded file's bytes in KV rather
 * than R2 (ADR-013 dropped this Worker's one R2 bucket): the asset drop site
 * (ASSET_FILES) and the expense receipt scanner (RECEIPT_FILES) both use
 * this. Sharing the STORAGE SHAPE is fine; each still gets its OWN KV
 * namespace, never a shared one — a working document and a financial record
 * do not belong behind the same binding (agent-tool-contract rule 6).
 */
export function createKvByteStore(kv, { bindingName, maxBytes }) {
  if (!kv || typeof kv.put !== "function") {
    console.error(`ERROR kv-store: no ${bindingName} binding — refusing to construct a byte store`);
    throw new Error(`binding ${bindingName} is not attached to this Worker`);
  }
  return {
    async put(key, bytes) {
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      if (body.byteLength === 0) throw new Error("refusing to store zero bytes as a file");
      if (body.byteLength > maxBytes) {
        throw new Error(`larger than the ${maxBytes}-byte limit for one file`);
      }
      const existing = await kv.get(key, "arrayBuffer");
      if (existing !== null) throw new Error(`${key} already holds bytes`);
      await kv.put(key, body);
      return { key, bytes: body.byteLength };
    },
    async bytes(key) {
      const buf = await kv.get(key, "arrayBuffer");
      return buf === null ? null : new Uint8Array(buf);
    },
  };
}
