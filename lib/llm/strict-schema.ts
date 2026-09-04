import { z } from "zod";

/**
 * zod → OpenAI *strict* JSON schema. Strict structured outputs require, on
 * every object, `additionalProperties: false` and `required` listing every
 * property; optional fields therefore become nullable, and the model sends
 * null for them. `optionalPaths` records where that happened so the provider
 * can turn those nulls back into "absent" before zod validation (a field that
 * is `.optional()` but not `.nullable()` would otherwise reject null).
 * Unsupported validation keywords are stripped.
 */
export type StrictSchema = { schema: Record<string, unknown>; optionalPaths: string[] };

const STRIP = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
  "$schema",
  "$id",
  "id",
  "title",
  "examples",
]);

type J = Record<string, unknown>;

function isObj(x: unknown): x is J {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function allowsNull(s: J): boolean {
  if (s.type === "null") return true;
  if (Array.isArray(s.type) && s.type.includes("null")) return true;
  for (const key of ["anyOf", "oneOf"]) {
    const alts = s[key];
    if (Array.isArray(alts) && alts.some((a) => isObj(a) && allowsNull(a))) return true;
  }
  return false;
}

function nullable(s: J): J {
  if (allowsNull(s)) return s;
  if (typeof s.type === "string" && !("properties" in s) && !("items" in s) && !("enum" in s) && !("anyOf" in s)) return { ...s, type: [s.type, "null"] };
  return { anyOf: [s, { type: "null" }] };
}

function walk(node: unknown, path: string, optionalPaths: string[]): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, path, optionalPaths));
  if (!isObj(node)) return node;
  const out: J = {};
  for (const [k, v] of Object.entries(node)) {
    if (STRIP.has(k)) continue;
    out[k] = v;
  }
  if (isObj(out.properties)) {
    const props: J = {};
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const [name, sub] of Object.entries(out.properties)) {
      const childPath = path ? `${path}.${name}` : name;
      let child = walk(sub, childPath, optionalPaths) as J;
      if (!required.has(name)) {
        // `.optional()` without `.nullable()`: the model will send null, which we must remove again.
        if (!allowsNull(child)) optionalPaths.push(childPath);
        child = nullable(child);
      }
      props[name] = child;
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.items !== undefined) out.items = walk(out.items, `${path}[]`, optionalPaths);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map((n) => walk(n, path, optionalPaths));
  }
  if (isObj(out.$defs)) {
    const defs: J = {};
    for (const [k, v] of Object.entries(out.$defs)) defs[k] = walk(v, `$defs.${k}`, optionalPaths);
    out.$defs = defs;
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): StrictSchema {
  const base = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as J;
  const optionalPaths: string[] = [];
  const strict = walk(base, "", optionalPaths) as J;
  return { schema: strict, optionalPaths: [...new Set(optionalPaths)].filter((p) => !p.startsWith("$defs.")) };
}

/** Delete null values at the recorded optional paths (arrays expanded), so `.optional()` fields validate. */
export function stripOptionalNulls(value: unknown, optionalPaths: string[]): unknown {
  const paths = optionalPaths.map((p) => p.split("."));
  const visit = (node: unknown, segs: string[][]): unknown => {
    if (Array.isArray(node)) return node.map((n) => visit(n, segs));
    if (!isObj(node)) return node;
    const out: J = { ...node };
    for (const [key, val] of Object.entries(out)) {
      const here = segs.filter((s) => s[0] === key || s[0] === `${key}[]`);
      if (here.some((s) => s.length === 1) && val === null) {
        delete out[key];
        continue;
      }
      const deeper = here.filter((s) => s.length > 1).map((s) => s.slice(1));
      if (deeper.length && (isObj(val) || Array.isArray(val))) out[key] = visit(val, deeper);
    }
    return out;
  };
  return visit(value, paths);
}

/** Sanity checks used by tests and at provider construction. */
export function assertStrictSchema(schema: unknown, path = "$"): string[] {
  const problems: string[] = [];
  const check = (node: unknown, p: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => check(n, `${p}[${i}]`));
    if (!isObj(node)) return;
    for (const k of Object.keys(node)) if (STRIP.has(k)) problems.push(`${p}: unsupported keyword ${k}`);
    if (isObj(node.properties)) {
      if (node.additionalProperties !== false) problems.push(`${p}: additionalProperties must be false`);
      const keys = Object.keys(node.properties);
      const req = Array.isArray(node.required) ? (node.required as string[]) : [];
      for (const k of keys) if (!req.includes(k)) problems.push(`${p}: property ${k} not required`);
      for (const [k, v] of Object.entries(node.properties)) check(v, `${p}.${k}`);
    }
    if (node.items !== undefined) check(node.items, `${p}[]`);
    for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[key])) check(node[key], `${p}.${key}`);
    if (isObj(node.$defs)) for (const [k, v] of Object.entries(node.$defs)) check(v, `${p}.$defs.${k}`);
  };
  check(schema, path);
  return problems;
}
