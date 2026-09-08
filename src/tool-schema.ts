/**
 * A bounded JSON-Schema subset for validating model-produced tool arguments.
 *
 * Tool schemas are supplied by API callers, so validation must not execute
 * remote references or unbounded recursion.  The subset intentionally covers
 * the structural keywords used by OpenAI-compatible function tools and by the
 * server implementation: type, enum/const, object properties/required,
 * additionalProperties, arrays/items and primitive numeric/string limits.
 */

const MAX_SCHEMA_DEPTH = 64;
const MAX_VALIDATION_NODES = 50_000;

type JSONObject = Record<string, unknown>;

interface ValidationState {
  nodes: number;
  root: unknown;
}

function isObject(value: unknown): value is JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index], depth + 1));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key], depth + 1));
  }
  return false;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

function localReference(root: unknown, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let current = root;
  for (const rawPart of reference.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    if (!(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function validate(value: unknown, schema: unknown, state: ValidationState, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH || ++state.nodes > MAX_VALIDATION_NODES) return false;
  if (schema === true || schema === undefined) return true;
  if (schema === false || !isObject(schema)) return false;

  if (typeof schema.$ref === "string") {
    const target = localReference(state.root, schema.$ref);
    if (target === undefined || target === schema) return false;
    if (!validate(value, target, state, depth + 1)) return false;
  }

  if ("const" in schema && !jsonEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(value, candidate))) return false;

  if (Array.isArray(schema.allOf) && !schema.allOf.every((branch) => validate(value, branch, state, depth + 1))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => validate(value, branch, state, depth + 1))) return false;
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const branch of schema.oneOf) if (validate(value, branch, state, depth + 1)) matches += 1;
    if (matches !== 1) return false;
  }
  if (schema.not !== undefined && validate(value, schema.not, state, depth + 1)) return false;

  const declaredTypes = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : [];
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => typeMatches(value, type))) return false;

  if (isObject(value) && (declaredTypes.length === 0 || declaredTypes.includes("object"))) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) return false;
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) return false;
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === "string" && !Object.hasOwn(value, required)) return false;
      }
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of keys) {
      if (Object.hasOwn(properties, key)) {
        if (!validate(value[key], properties[key], state, depth + 1)) return false;
        continue;
      }
      if (schema.additionalProperties === false) return false;
      if (isObject(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
        if (!validate(value[key], schema.additionalProperties, state, depth + 1)) return false;
      }
    }
  }

  if (Array.isArray(value) && (declaredTypes.length === 0 || declaredTypes.includes("array"))) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index += 1) {
        for (let other = index + 1; other < value.length; other += 1) {
          if (jsonEqual(value[index], value[other])) return false;
        }
      }
    }
    if (schema.items !== undefined) {
      for (const item of value) if (!validate(item, schema.items, state, depth + 1)) return false;
    }
  }

  if (typeof value === "string" && (declaredTypes.length === 0 || declaredTypes.includes("string"))) {
    const length = Array.from(value).length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
  }

  if (typeof value === "number" && Number.isFinite(value)
    && (declaredTypes.length === 0 || declaredTypes.includes("number") || declaredTypes.includes("integer"))) {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8) return false;
    }
  }

  return true;
}

function parametersFor(name: string, tools: unknown[]): unknown {
  for (const raw of tools) {
    if (!isObject(raw)) continue;
    const fn = isObject(raw.function) ? raw.function : raw;
    if (fn.name === name) return fn.parameters ?? { type: "object" };
  }
  return undefined;
}

/** Return true only for a declared function and a JSON-object argument set. */
export function validateToolArguments(name: string, encodedArguments: string, tools: unknown[]): boolean {
  const schema = parametersFor(name, tools);
  if (schema === undefined) return false;
  let value: unknown;
  try { value = JSON.parse(encodedArguments); } catch { return false; }
  if (!isObject(value)) return false;
  return validate(value, schema, { nodes: 0, root: schema }, 0);
}

