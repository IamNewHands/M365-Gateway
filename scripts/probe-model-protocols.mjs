const baseUrl = String(process.env.M365_BASE_URL || "").replace(/\/$/u, "");
if (!baseUrl) throw new Error("M365_BASE_URL is required");
const apiKey = String(process.env.M365_TEST_API_KEY || "");
if (!apiKey) throw new Error("M365_TEST_API_KEY is required");
const requested = String(process.env.M365_PROBE_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean);
const timeoutMs = Number(process.env.M365_PROBE_TIMEOUT_MS || 120_000);
const runId = `probe-${Date.now().toString(36)}`;
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "m365-gateway-model-probe/1.0" };

function safeError(value) {
  return String(value ?? "").replaceAll(apiKey, "[REDACTED]").replace(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]").slice(0, 240);
}

async function request(path, body, { stream = false } = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (stream) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("stream body unavailable");
    const decoder = new TextDecoder();
    let buffer = "";
    let firstChunkMs = 0;
    let firstDeltaMs = 0;
    let done = false;
    let completed = false;
    let failed = false;
    let outputChars = 0;
    let raw = "";
    const consume = (chunk) => {
      raw += chunk;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; continue; }
        if (!data) continue;
        try {
          const event = JSON.parse(data);
          if (event.type === "response.output_text.delta") {
            if (!firstDeltaMs) firstDeltaMs = Math.round(performance.now() - started);
            outputChars += String(event.delta || "").length;
          }
          if (event.type === "response.completed") completed = true;
          if (event.type === "response.failed") failed = true;
          outputChars += String(event?.choices?.[0]?.delta?.content || "").length;
        } catch { /* a split SSE record will be completed by the next chunk */ }
      }
    };
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = decoder.decode(part.value, { stream: true });
      if (!firstChunkMs) firstChunkMs = Math.round(performance.now() - started);
      consume(chunk);
    }
    consume(decoder.decode());
    return { status: response.status, elapsed: Math.round(performance.now() - started), firstChunkMs, firstDeltaMs, done, completed, failed, outputChars, text: raw };
  }
  const text = await response.text();
  const elapsed = Math.round(performance.now() - started);
  if (!stream) {
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* reported below */ }
    return { status: response.status, elapsed, json, text };
  }
}

function errorCode(result) {
  return String(result?.json?.error?.code || result?.json?.error?.type || "");
}

function print(kind, model, result, extra = "") {
  const detail = result.status === 200
    ? (kind.endsWith(".stream")
      ? `status=200;elapsed=${result.elapsed};first_chunk=${result.firstChunkMs};first_delta=${result.firstDeltaMs};done=${result.done};completed=${result.completed};failed=${result.failed};chars=${result.outputChars}`
      : `status=200;elapsed=${result.elapsed};state=${String(result.json?.status || "")}`)
    : `status=${result.status};elapsed=${result.elapsed};code=${errorCode(result) || "none"};${safeError(result.text)}`;
  process.stdout.write(`${result.status === 200 ? "PASS" : "FAIL"} ${model}.${kind} — ${detail}${extra ? `;${extra}` : ""}\n`);
}

async function discoverModels() {
  const response = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "m365-gateway-model-probe/1.0" }, signal: AbortSignal.timeout(timeoutMs) });
  const json = await response.json();
  if (response.status !== 200) throw new Error(`models status=${response.status}`);
  const ids = Array.isArray(json.data) ? json.data.map((item) => String(item?.id || "")).filter(Boolean) : [];
  return requested.length ? ids.filter((id) => requested.includes(id)) : ids;
}

const models = await discoverModels();
process.stdout.write(`CATALOG count=${models.length};models=${models.join(",")}\n`);
const tool = {
  type: "function",
  function: {
    name: "probe_value",
    description: "Return the supplied probe value",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  },
};

for (const model of models) {
  const marker = `${runId}-${model}`;
  try {
    const chat = await request("/v1/chat/completions", { model, messages: [{ role: "user", content: `Return exactly ${marker}` }] });
    print("chat.nonstream", model, chat);
  } catch (error) {
    process.stdout.write(`FAIL ${model}.chat.nonstream — transport=${safeError(error)}\n`);
  }
  try {
    const chatStream = await request("/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: `Return exactly ${marker}` }] }, { stream: true });
    print("chat.stream", model, chatStream);
  } catch (error) {
    process.stdout.write(`FAIL ${model}.chat.stream — transport=${safeError(error)}\n`);
  }
  try {
    const responses = await request("/v1/responses", { model, input: `Return exactly ${marker}` });
    print("responses.nonstream", model, responses);
  } catch (error) {
    process.stdout.write(`FAIL ${model}.responses.nonstream — transport=${safeError(error)}\n`);
  }
  try {
    const responsesStream = await request("/v1/responses", { model, stream: true, input: `Return exactly ${marker}` }, { stream: true });
    print("responses.stream", model, responsesStream);
  } catch (error) {
    process.stdout.write(`FAIL ${model}.responses.stream — transport=${safeError(error)}\n`);
  }
  try {
    const toolResult = await request("/v1/responses", {
      model,
      input: "Call probe_value with value tool-probe. Do not answer directly.",
      tools: [tool],
      tool_choice: { type: "function", function: { name: "probe_value" } },
    });
    const call = Array.isArray(toolResult.json?.output) ? toolResult.json.output.find((item) => item?.type === "function_call") : undefined;
    print("responses.tool", model, toolResult, `call=${Boolean(call)}`);
  } catch (error) {
    process.stdout.write(`FAIL ${model}.responses.tool — transport=${safeError(error)}\n`);
  }
}
