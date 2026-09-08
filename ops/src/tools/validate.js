/*
 * Argument validation, and the one rule the whole contract rests on.
 *
 * Test-PRD-P0-23-group_derived_roles: "`actor` comes from the verified Access
 * identity, never a parameter the agent can set. A tool signature that accepts
 * an actor is a tool that can be impersonated."
 *
 * That is enforced twice, on purpose:
 *   - at module load, `assertNoIdentityFields` rejects any tool whose SCHEMA
 *     declares an identity or binding field. The registry cannot be built with
 *     such a tool in it, so the mistake fails the deploy, not a request.
 *   - at call time, `checkForbiddenArgs` rejects any call whose ARGUMENTS carry
 *     one of those names, even though a closed schema would already drop it.
 *     Belt and braces: the caller learns it was refused rather than quietly
 *     having the field ignored.
 *
 * Schemas are closed. An unknown property is an error, not a shrug: a typo in
 * `customer_id` must not read a different customer's profile by defaulting.
 */

/*
 * Names an argument may never use. `actor`/`on_behalf_of`/`role` are identity;
 * the rest are the shapes a caller would reach for to widen its own scope.
 */
export const FORBIDDEN_ARG_NAMES = Object.freeze([
  "actor",
  "actor_email",
  "on_behalf_of",
  "onBehalfOf",
  "role",
  "roles",
  "as_user",
  "impersonate",
  "email",
  "env",
  "db",
  "binding",
  "bindings",
  "store",
  "stores",
  "sql",
  "query_sql",
  "approval_token",
  "approvalToken",
]);

export function assertNoIdentityFields(name, schema) {
  for (const field of Object.keys(schema || {})) {
    if (FORBIDDEN_ARG_NAMES.includes(field)) {
      throw new Error(
        `tool ${name} declares a forbidden argument '${field}': identity and scope ` +
          "come from Cloudflare Access and the bindings, never from arguments",
      );
    }
  }
}

export function checkForbiddenArgs(args) {
  for (const key of Object.keys(args || {})) {
    if (FORBIDDEN_ARG_NAMES.includes(key)) return key;
  }
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;

const FORMATS = {
  handle: HANDLE,
  id: ID,
  date: ISO_DATE,
  datetime: ISO_TIME,
  currency: CURRENCY,
};

/*
 * Validate `args` against a closed schema.
 *   { field: { type, required?, enum?, min?, max?, maxLength?, format?, of? } }
 * Returns { ok, value } or { ok:false, error }.
 */
export function validate(schema, args) {
  const src = args ?? {};
  if (typeof src !== "object" || Array.isArray(src)) {
    return { ok: false, error: "arguments must be an object" };
  }

  for (const key of Object.keys(src)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      return { ok: false, error: `unknown argument '${key}'` };
    }
  }

  const out = {};
  for (const [field, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(src, field) && src[field] !== undefined;
    if (!present) {
      if (spec.required) return { ok: false, error: `missing required argument '${field}'` };
      if ("default" in spec) out[field] = spec.default;
      continue;
    }
    const v = src[field];
    const bad = checkOne(field, spec, v);
    if (bad) return { ok: false, error: bad };
    out[field] = v;
  }
  return { ok: true, value: out };
}

function checkOne(field, spec, v) {
  switch (spec.type) {
    case "string":
      if (typeof v !== "string") return `'${field}' must be a string`;
      if (v.length === 0) return `'${field}' must not be empty`;
      if (v.length > (spec.maxLength ?? 200)) return `'${field}' is longer than ${spec.maxLength ?? 200}`;
      if (spec.enum && !spec.enum.includes(v)) return `'${field}' must be one of ${spec.enum.join(", ")}`;
      if (spec.format && !FORMATS[spec.format].test(v)) return `'${field}' is not a valid ${spec.format}`;
      return null;
    case "integer":
      if (!Number.isInteger(v)) return `'${field}' must be an integer`;
      if (spec.min !== undefined && v < spec.min) return `'${field}' must be at least ${spec.min}`;
      if (spec.max !== undefined && v > spec.max) return `'${field}' must be at most ${spec.max}`;
      return null;
    case "boolean":
      return typeof v === "boolean" ? null : `'${field}' must be a boolean`;
    case "array": {
      if (!Array.isArray(v)) return `'${field}' must be an array`;
      if (spec.maxItems !== undefined && v.length > spec.maxItems) {
        return `'${field}' holds more than ${spec.maxItems} items`;
      }
      if (spec.of) {
        for (const [i, item] of v.entries()) {
          if (spec.of.type === "object") {
            if (typeof item !== "object" || item === null || Array.isArray(item)) {
              return `'${field}[${i}]' must be an object`;
            }
            const nested = validate(spec.of.schema, item);
            if (!nested.ok) return `'${field}[${i}]': ${nested.error}`;
          } else {
            const bad = checkOne(`${field}[${i}]`, spec.of, item);
            if (bad) return bad;
          }
        }
      }
      return null;
    }
    default:
      return `'${field}' has an unsupported type in its schema`;
  }
}
