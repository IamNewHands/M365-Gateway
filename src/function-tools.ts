type JSONObject = Record<string, unknown>;

export interface FunctionToolDefinition {
  raw: unknown;
  name: string;
  description: string;
  parameters: unknown;
}

function isObject(value: unknown): value is JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a caller-provided function tool without depending on one client SDK's
 * intermediate schema spelling. The public OpenAI formats use `parameters`,
 * Anthropic uses `input_schema`, and ZCode/AI SDK adapters use `inputSchema`
 * before serializing the provider request.
 */
export function functionToolDefinition(raw: unknown): FunctionToolDefinition | null {
  if (!isObject(raw)) return null;
  if (raw.type !== undefined && raw.type !== "function") return null;
  const candidate = isObject(raw.function) ? raw.function : raw;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) return null;
  const parameters = candidate.parameters ?? candidate.input_schema ?? candidate.inputSchema;
  return {
    raw,
    name,
    description: typeof candidate.description === "string" ? candidate.description : "",
    parameters,
  };
}
