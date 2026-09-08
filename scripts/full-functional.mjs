import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configuredBaseUrl = process.env.M365_BASE_URL || "";
if (!configuredBaseUrl) throw new Error("M365_BASE_URL is required; point it at an isolated candidate deployment");
const baseUrl = configuredBaseUrl.replace(/\/$/u, "");
const target = new URL(baseUrl);
const protectedHostname = (process.env.M365_PRODUCTION_HOST || "").trim().toLowerCase();
if (protectedHostname && target.hostname.toLowerCase() === protectedHostname && process.env.M365_ALLOW_PRODUCTION !== "1") {
  throw new Error("refusing to test the configured production hostname without M365_ALLOW_PRODUCTION=1");
}
let apiKey = process.env.M365_TEST_API_KEY || "";
delete process.env.M365_TEST_API_KEY;
if (!apiKey) throw new Error("M365_TEST_API_KEY is required");

const defaultModels = [
  "gpt-5.5",
  "gpt-5.5-reasoning",
  "gpt-5.6-sol",
  "gpt-5.6-reasoning",
  "gpt-6-astra",
  "claude-sonnet",
  "claude-sonnet-reasoning",
];
const catalogModels = [
  "gpt-5.5",
  "gpt-5.5-reasoning",
  "gpt-5.6-sol",
  "gpt-5.6-reasoning",
  "gpt-6-astra",
  "claude-sonnet",
  "claude-sonnet-reasoning",
];
const requestedModels = (process.env.M365_TEST_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean);
const models = requestedModels.length ? requestedModels : defaultModels;
const runId = `ff-${Date.now().toString(36)}`;
const regressionOnly = process.env.M365_TEST_SCOPE === "regression";
// A four-request pressure burst is useful for isolated load testing, but it is
// not part of correctness acceptance. Free-plan CF2 and a single upstream M365
// account must default to fully serial execution to avoid manufacturing 1101
// resource failures while Codex/OpenCode/Hermes are being verified.
const concurrencyEnabled = process.env.M365_TEST_CONCURRENCY === "1";
// Image/vision checks can consume a separate tenant entitlement.  Keep them
// out of the normal stability run; opt in only when the account explicitly
// has image capacity and image behavior is the subject of the test.
const runVisionInput = process.env.M365_TEST_VISION_INPUT === "1";
const startedAt = new Date();
const checks = [];
const timings = [];

function safeDetail(value) {
  let text = String(value ?? "");
  if (apiKey) text = text.replaceAll(apiKey, "[REDACTED]");
  return text
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|secret)=)[^&#\s]+/giu, "$1[REDACTED]")
    .slice(0, 300);
}

function diagnosticPath(path) {
  const raw = String(path ?? "");
  try {
    // Keep only the URL pathname. Query strings can contain credentials in
    // future probes and do not improve latency diagnosis.
    return new URL(raw, baseUrl).pathname.slice(0, 256);
  } catch {
    return raw.split(/[?#]/u, 1)[0].slice(0, 256);
  }
}

function errorCode(json) {
  return String(json?.error?.code ?? "");
}

function record(name, passed, detail = "", { skipped = false } = {}) {
  const safe = safeDetail(detail);
  checks.push({ name, passed: Boolean(passed), skipped: Boolean(skipped), detail: safe });
  process.stdout.write(`${skipped ? "SKIP" : passed ? "PASS" : "FAIL"} ${name}${safe ? ` — ${safe}` : ""}\n`);
}

async function stage(name, task) {
  try {
    await task();
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error ?? "unknown error"));
  }
}

async function request(path, { method = "POST", body, auth = true, timeoutMs = 240_000, signal } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = { "User-Agent": "m365-gateway-full-functional/1.0" };
  if (auth) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const started = performance.now();
  const safePath = diagnosticPath(path);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: combinedSignal,
    });
    timings.push({ path: safePath, status: response.status, milliseconds: Math.round(performance.now() - started) });
    return response;
  } catch (error) {
    // Preserve transport failures (disconnects/timeouts) in the report without
    // retaining the exception text, URL, request body, or authorization data.
    timings.push({ path: safePath, status: 0, milliseconds: Math.round(performance.now() - started) });
    throw error;
  }
}

async function jsonRequest(path, body, options = {}) {
  const response = await request(path, { ...options, body });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON status=${response.status}`);
  }
  return { response, json, text };
}

function chatText(json) {
  return String(json?.choices?.[0]?.message?.content ?? "");
}

function responseText(json) {
  return (json?.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => String(item.text || ""))
    .join("");
}

function parseChatSSE(raw) {
  let text = "";
  let done = false;
  let finish = "";
  let error = "";
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    if (!data) continue;
    const event = JSON.parse(data);
    text += String(event?.choices?.[0]?.delta?.content ?? "");
    finish ||= String(event?.choices?.[0]?.finish_reason ?? "");
    error ||= String(event?.error?.code ?? "");
  }
  return { text, done, finish, error };
}

function parseResponsesSSE(raw) {
  let text = "";
  let done = false;
  let completed = false;
  let failed = false;
  const sequences = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    if (!data) continue;
    const event = JSON.parse(data);
    if (Number.isInteger(event.sequence_number)) sequences.push(event.sequence_number);
    if (event.type === "response.output_text.delta") text += String(event.delta || "");
    if (event.type === "response.completed") completed = true;
    if (event.type === "response.failed") failed = true;
  }
  const sequenceValid = sequences.every((value, index) => value === index);
  return { text, done, completed, failed, sequenceValid };
}

const tool = {
  type: "function",
  function: {
    name: "lookup_gateway_value",
    description: "Return one deterministic value for gateway verification",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
};

const writeStdinTool = {
  type: "function",
  function: {
    name: "write_stdin",
    description: "Write characters to or poll an existing caller terminal session",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "integer" },
        chars: { type: "string" },
        yield_time_ms: { type: "integer" },
        max_output_tokens: { type: "integer" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
};

await stage("catalog", async () => {
  const { response, json } = await jsonRequest("/v1/models", undefined, { method: "GET" });
  const ids = (json.data || []).map((item) => item.id);
  record("catalog.status", response.status === 200, `status=${response.status}`);
  // M365_TEST_MODELS limits only the request matrix. The public catalog must
  // remain stable and continue advertising every supported model.
  record("catalog.models", JSON.stringify(ids) === JSON.stringify(catalogModels), ids.join(","));
});

for (const model of models) {
  if (!regressionOnly) {
  await stage(`${model}.chat.nonstream`, async () => {
    const marker = `CHAT-${model}-${runId}`;
    const { response, json } = await jsonRequest("/v1/chat/completions", {
      model,
      session_key: `${runId}-${model}-chat-ns`,
      messages: [{ role: "user", content: `Return exactly this marker and nothing else: ${marker}` }],
    });
    record(`${model}.chat.nonstream`, response.status === 200 && chatText(json).includes(marker), `status=${response.status};finish=${json?.choices?.[0]?.finish_reason || ""}`);
  });

  await stage(`${model}.chat.stream`, async () => {
    const marker = `CHAT-STREAM-${model}-${runId}`;
    const response = await request("/v1/chat/completions", { body: {
      model,
      stream: true,
      session_key: `${runId}-${model}-chat-stream`,
      messages: [{ role: "user", content: `Return exactly this marker and nothing else: ${marker}` }],
    } });
    const parsed = parseChatSSE(await response.text());
    record(`${model}.chat.stream`, response.status === 200 && parsed.done && parsed.finish === "stop" && !parsed.error && parsed.text.includes(marker), `status=${response.status};done=${parsed.done};finish=${parsed.finish};chars=${parsed.text.length}`);
  });

  await stage(`${model}.responses.nonstream`, async () => {
    const marker = `RESP-${model}-${runId}`;
    const { response, json } = await jsonRequest("/v1/responses", {
      model,
      session_key: `${runId}-${model}-resp-ns`,
      input: `Return exactly this marker and nothing else: ${marker}`,
    });
    record(`${model}.responses.nonstream`, response.status === 200 && json.status === "completed" && responseText(json).includes(marker), `status=${response.status};state=${json.status || ""}`);
  });

  await stage(`${model}.responses.stream`, async () => {
    const marker = `RESP-STREAM-${model}-${runId}`;
    const response = await request("/v1/responses", { body: {
      model,
      stream: true,
      session_key: `${runId}-${model}-resp-stream`,
      input: `Return exactly this marker and nothing else: ${marker}`,
    } });
    const parsed = parseResponsesSSE(await response.text());
    record(`${model}.responses.stream`, response.status === 200 && parsed.done && parsed.completed && !parsed.failed && parsed.sequenceValid && parsed.text.includes(marker), `status=${response.status};done=${parsed.done};completed=${parsed.completed};sequence=${parsed.sequenceValid};chars=${parsed.text.length}`);
  });
  }

  await stage(`${model}.responses.tool`, async () => {
    const expected = `RESP-TOOL-${model}-${runId}`;
    const first = await jsonRequest("/v1/responses", {
      model,
      input: `Call lookup_gateway_value with key ${model}-${runId}. Do not answer directly.`,
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
    });
    const call = (first.json.output || []).find((item) => item?.type === "function_call");
    if (first.response.status !== 200 || !call?.call_id || call.name !== "lookup_gateway_value") {
      throw new Error(`missing call status=${first.response.status};code=${first.json?.error?.code || "none"}`);
    }
    const second = await jsonRequest("/v1/responses", {
      model,
      previous_response_id: first.json.id,
      input: [{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ value: expected }) }],
    });
    record(`${model}.responses.tool`, second.response.status === 200 && responseText(second.json).includes(expected), `first=${first.response.status};second=${second.response.status};text=${JSON.stringify(responseText(second.json).slice(0, 180))}`);
  });

  if (model === "gpt-5.6-sol") await stage(`${model}.responses.stream-tool-race`, async () => {
    const expected = `RESP-STREAM-TOOL-${runId}`;
    const first = await request("/v1/responses", { body: {
      model,
      stream: true,
      input: `Call lookup_gateway_value with key stream-${runId}. Do not answer directly.`,
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
    } });
    if (first.status !== 200 || !first.body) throw new Error(`stream setup failed status=${first.status}`);
    const reader = first.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let responseId = "";
    let completed = false;
    let continuation;
    const consumeLine = (line) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      if (event.type === "response.created") responseId = String(event.response?.id || "");
      if (event.type === "response.output_item.done" && event.item?.type === "function_call" && !continuation) {
        if (!responseId || !event.item.call_id) throw new Error("stream function call identity missing");
        // Start the continuation as soon as the client can observe the tool
        // call, before response.completed has necessarily reached this reader.
        continuation = jsonRequest("/v1/responses", {
          model,
          previous_response_id: responseId,
          input: [{ type: "function_call_output", call_id: event.item.call_id, output: JSON.stringify({ value: expected }) }],
        });
      }
      if (event.type === "response.completed") completed = true;
      if (event.type === "response.failed") throw new Error(`stream failed code=${event.response?.error?.code || "unknown"}`);
    };
    while (true) {
      const chunk = await reader.read();
      buffered += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() || "";
      for (const line of lines) consumeLine(line);
      if (chunk.done) break;
    }
    if (buffered) consumeLine(buffered);
    if (!continuation) throw new Error("stream function call missing");
    const second = await continuation;
    const visible = responseText(second.json);
    record(
      `${model}.responses.stream-tool-race`,
      completed && second.response.status === 200 && visible.includes(expected),
      `completed=${completed};second=${second.response.status};text=${JSON.stringify(visible.slice(0, 160))}`,
    );
  });

  if (model === "gpt-5.6-reasoning") await stage(`${model}.responses.fixed-tool-continuation`, async () => {
    const first = await jsonRequest("/v1/responses", {
      model,
      input: "Poll terminal session 26957 with write_stdin. If the result says it is still running, poll the same session exactly one more time.",
      tools: [writeStdinTool],
      tool_choice: { type: "function", function: { name: "write_stdin" } },
    });
    const firstCall = (first.json.output || []).find((item) => item?.type === "function_call");
    if (first.response.status !== 200 || !firstCall?.call_id || firstCall.name !== "write_stdin") {
      throw new Error(`missing first write_stdin status=${first.response.status};code=${first.json?.error?.code || "none"}`);
    }
    // Deliberately omit tools here. This reproduces Codex Responses
    // continuations that rely on previous_response_id for the tool catalog.
    const second = await jsonRequest("/v1/responses", {
      model,
      previous_response_id: first.json.id,
      input: [{
        type: "function_call_output",
        call_id: firstCall.call_id,
        output: "Script running with session ID 26957. No new output yet.",
      }],
    });
    const secondCall = (second.json.output || []).find((item) => item?.type === "function_call");
    const serialized = JSON.stringify(second.json);
    const leaked = /m365gw_client_[0-9a-f]+/iu.test(serialized)
      || (serialized.match(/Z[0-9A-F]{2}X/gu) || []).length >= 3;
    record(
      `${model}.responses.fixed-tool-continuation`,
      second.response.status === 200 && secondCall?.name === "write_stdin" && !leaked,
      `first=${first.response.status};second=${second.response.status};name=${secondCall?.name || "none"};leaked=${leaked}`,
    );
  });

  await stage(`${model}.chat.tool`, async () => {
    const expected = `CHAT-TOOL-${model}-${runId}`;
    const sessionKey = `${runId}-${model}-chat-tool`;
    const first = await jsonRequest("/v1/chat/completions", {
      model,
      session_key: sessionKey,
      messages: [{ role: "user", content: `Call lookup_gateway_value with key ${model}-${runId}. Do not answer directly.` }],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
    });
    const call = first.json?.choices?.[0]?.message?.tool_calls?.[0];
    if (first.response.status !== 200 || !call?.id || call?.function?.name !== "lookup_gateway_value") {
      throw new Error(`missing call status=${first.response.status};code=${first.json?.error?.code || "none"}`);
    }
    const second = await jsonRequest("/v1/chat/completions", {
      model,
      session_key: sessionKey,
      messages: [
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: JSON.stringify({ value: expected }) },
      ],
    });
    const visible = chatText(second.json);
    record(
      `${model}.chat.tool`,
      second.response.status === 200 && visible.includes(expected),
      `first=${first.response.status};second=${second.response.status};finish=${second.json?.choices?.[0]?.finish_reason || ""};text=${JSON.stringify(visible.slice(0, 180))}`,
    );
  });
}

if (!regressionOnly) {
await stage("chat.context", async () => {
  const marker = `CHAT-MEMORY-${runId}`;
  const sessionKey = `${runId}-chat-context`;
  let passed = true;
  for (let turn = 0; turn < 8; turn += 1) {
    const prompt = turn === 0
      ? `Remember this exact marker for later turns and output only it: ${marker}`
      : "Output only the exact marker you were told to remember in this conversation.";
    const { response, json } = await jsonRequest("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      session_key: sessionKey,
      messages: [{ role: "user", content: prompt }],
    });
    passed &&= response.status === 200 && chatText(json).includes(marker);
  }
  record("chat.context.8-turn", passed, `marker=${passed ? "preserved" : "missing"}`);
});

await stage("responses.context", async () => {
  const marker = `RESP-MEMORY-${runId}`;
  let previous = "";
  let passed = true;
  for (let turn = 0; turn < 8; turn += 1) {
    const body = turn === 0
      ? { model: "gpt-5.6-sol", session_key: `${runId}-resp-context`, input: `Remember this exact marker and output only it: ${marker}` }
      : { model: "gpt-5.6-sol", previous_response_id: previous, input: "Output only the exact marker you were told to remember." };
    const result = await jsonRequest("/v1/responses", body);
    passed &&= result.response.status === 200 && responseText(result.json).includes(marker);
    previous = String(result.json.id || "");
  }
  record("responses.context.8-turn", passed, `marker=${passed ? "preserved" : "missing"}`);
});

await stage("responses.tool-ledger", async () => {
  const first = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    input: "Call lookup_gateway_value with key ledger-test.",
    tools: [tool],
    tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
  });
  const call = (first.json.output || []).find((item) => item?.type === "function_call");
  if (!call?.call_id) throw new Error("tool call missing");
  const mismatch = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    previous_response_id: first.json.id,
    input: [{ type: "function_call_output", call_id: "call_wrong", output: "wrong" }],
  });
  // Two results for one pending call in one request are a protocol violation.
  // This is intentionally a same-branch/same-request check, unlike the
  // immutable-alias replay below (which starts a fresh independent branch).
  const duplicate = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    previous_response_id: first.json.id,
    input: [
      { type: "function_call_output", call_id: call.call_id, output: "duplicate-a" },
      { type: "function_call_output", call_id: call.call_id, output: "duplicate-b" },
    ],
  });
  const correct = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    previous_response_id: first.json.id,
    input: [{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ value: `LEDGER-${runId}` }) }],
  });
  const replay = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    previous_response_id: first.json.id,
    input: [{ type: "function_call_output", call_id: call.call_id, output: "replayed" }],
  });
  const replayCalls = Array.isArray(replay.json?.output)
    ? replay.json.output.filter((item) => item?.type === "function_call")
    : [];
  const replayedOriginalCall = replayCalls.some((item) => item?.call_id === call.call_id);
  const independentReplay = replay.response.status === 200
    && typeof replay.json?.id === "string"
    && replay.json.id.length > 0
    && replay.json.id !== first.json.id
    && !replayedOriginalCall;
  record(
    "responses.tool-ledger",
    mismatch.response.status === 400
      && errorCode(mismatch.json) === "tool_output_mismatch"
      && duplicate.response.status === 400
      && errorCode(duplicate.json) === "tool_output_mismatch"
      && correct.response.status === 200
      && independentReplay,
    `mismatch=${mismatch.response.status}/${errorCode(mismatch.json)};duplicate=${duplicate.response.status}/${errorCode(duplicate.json)};correct=${correct.response.status};replay=${replay.response.status};replay_id_independent=${independentReplay}`,
  );
});

await stage("error-contracts", async () => {
  const unauth = await jsonRequest("/v1/models", undefined, { method: "GET", auth: false });
  const malformed = await jsonRequest("/v1/responses", "{", {});
  // Use a per-run sentinel that cannot accidentally become supported when the
  // public model catalog grows, and assert the machine-readable contract.
  const unsupportedModel = `__unsupported_model_${runId}__`;
  const unsupported = await jsonRequest("/v1/responses", { model: unsupportedModel, input: "test" });
  const empty = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: "" });
  const unexpectedTool = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: [{ type: "function_call_output", call_id: "call_orphan", output: "x" }] });
  const missingPrevious = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", previous_response_id: `resp_missing_${runId}`, input: "continue" });
  const tooManyTools = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: "test", tools: Array.from({ length: 129 }, (_, index) => ({ ...tool, function: { ...tool.function, name: `tool_${index}` } })) });
  const contractResults = [unauth, malformed, unsupported, empty, unexpectedTool, missingPrevious, tooManyTools];
  const expectedStatuses = [401, 400, 400, 400, 400, 404, 400];
  if (runVisionInput) {
    const unsafeVision = await jsonRequest("/v1/responses", { model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_image", image_url: "http://127.0.0.1/private.png" }] }] });
    contractResults.splice(4, 0, unsafeVision);
    expectedStatuses.splice(4, 0, 400);
  }
  const statuses = contractResults.map((item) => item.response.status);
  const codes = contractResults.map((item) => errorCode(item.json));
  record(
    "error-contracts",
    JSON.stringify(statuses) === JSON.stringify(expectedStatuses)
      && codes[2] === "unsupported_model",
    `statuses=${statuses.join(",")};codes=${codes.join(",")};unsupported_model=${unsupportedModel}`,
  );
});

if (runVisionInput) await stage("vision.input", async () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const result = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Briefly describe the attached image. Return a non-empty answer." },
        { type: "input_image", image_url: `data:image/png;base64,${tinyPng}` },
      ],
    }],
  });
  record("vision.input", result.response.status === 200 && responseText(result.json).trim().length > 0, `status=${result.response.status};chars=${responseText(result.json).length}`);
});
else record("vision.input", true, "skipped=true;reason=optional_image_capability_disabled;set_M365_TEST_VISION_INPUT=1_to_probe", { skipped: true });

// Server-side image generation was removed. Even a stale opt-in environment
// variable must not submit quota-consuming generation requests.
record("image.generation.url", true, "skipped=true;reason=image_generation_removed", { skipped: true });

if (concurrencyEnabled) await stage("concurrency", async () => {
  const jobs = Array.from({ length: 4 }, async (_, index) => {
    const marker = `CONCURRENT-${index}-${runId}`;
    const result = await jsonRequest("/v1/responses", {
      model: "gpt-5.6-sol",
      session_key: `${runId}-concurrent-${index}`,
      input: `Return exactly: ${marker}`,
    });
    return result.response.status === 200 && responseText(result.json).includes(marker);
  });
  const results = await Promise.all(jobs);
  record("concurrency.4-independent-sessions", results.every(Boolean), results.join(","));
});
}

await stage("downstream-cancel", async () => {
  const sessionKey = `${runId}-cancel`;
  const controller = new AbortController();
  const cancellationReason = new Error("functional cancellation test");
  const tolerateIntentionalCancellation = async (operation) => {
    try {
      return await operation;
    } catch (error) {
      const intentionalAbort = controller.signal.aborted
        && controller.signal.reason === cancellationReason
        && (error === cancellationReason || error?.cause === cancellationReason || error?.name === "AbortError");
      if (!intentionalAbort) throw error;
      return undefined;
    }
  };
  const response = await request("/v1/responses", { body: {
    model: "gpt-5.6-reasoning",
    stream: true,
    session_key: sessionKey,
    input: "Produce a detailed 2000-word technical discussion about deterministic state machines.",
  }, signal: controller.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream body unavailable");
  await tolerateIntentionalCancellation(reader.read());
  controller.abort(cancellationReason);
  await tolerateIntentionalCancellation(reader.cancel(cancellationReason));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  const retry = await jsonRequest("/v1/responses", {
    model: "gpt-5.6-sol",
    session_key: sessionKey,
    input: `Return exactly: CANCEL-RECOVERED-${runId}`,
  });
  record("downstream-cancel.lease-release", retry.response.status === 200 && responseText(retry.json).includes(`CANCEL-RECOVERED-${runId}`), `retry=${retry.response.status}`);
});

if (!regressionOnly) await stage("long-stream", async () => {
  const response = await request("/v1/responses", { timeoutMs: 570_000, body: {
    model: "gpt-5.6-reasoning",
    stream: true,
    session_key: `${runId}-long-stream`,
    input: "Write a rigorous Chinese engineering review of a production AI gateway. Cover streaming state machines, cancellation, tool-call ledgers, context persistence, security boundaries and observability. Use at least 1800 Chinese characters and finish with a concise acceptance checklist.",
  } });
  const parsed = parseResponsesSSE(await response.text());
  record("long-stream.completed", response.status === 200 && parsed.done && parsed.completed && !parsed.failed && parsed.sequenceValid && parsed.text.length >= 800, `status=${response.status};chars=${parsed.text.length};done=${parsed.done};completed=${parsed.completed}`);
});

const ordered = timings.map((item) => item.milliseconds).sort((a, b) => a - b);
const percentile = (fraction) => ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] : 0;
const slowest = timings
  .slice()
  .sort((left, right) => right.milliseconds - left.milliseconds)
  .slice(0, 10)
  .map(({ path, status, milliseconds }) => ({ path, status, milliseconds }));
const aggregateTimings = new Map();
for (const item of timings) {
  const key = `${item.path}\u0000${item.status}`;
  const aggregate = aggregateTimings.get(key) || {
    path: item.path,
    status: item.status,
    count: 0,
    totalMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
  };
  aggregate.count += 1;
  aggregate.totalMs += item.milliseconds;
  aggregate.minMs = Math.min(aggregate.minMs, item.milliseconds);
  aggregate.maxMs = Math.max(aggregate.maxMs, item.milliseconds);
  aggregateTimings.set(key, aggregate);
}
const byPathStatus = [...aggregateTimings.values()]
  .map((item) => ({
    ...item,
    avgMs: Math.round(item.totalMs / item.count),
  }))
  .sort((left, right) => right.maxMs - left.maxMs || right.avgMs - left.avgMs || left.path.localeCompare(right.path));
const report = {
  runId,
  scope: regressionOnly ? "regression" : "full",
  executionMode: concurrencyEnabled ? "explicit-concurrency-probe" : "serial",
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  models,
  passed: checks.every((item) => item.passed || item.skipped),
  checks,
  summary: {
    total: checks.length,
    passed: checks.filter((item) => item.passed && !item.skipped).length,
    skipped: checks.filter((item) => item.skipped).length,
    failed: checks.filter((item) => !item.passed && !item.skipped).length,
  },
  latencyMs: {
    count: ordered.length,
    min: ordered[0] || 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1) || 0,
    // Diagnostics intentionally contain only a sanitized path, status and
    // elapsed milliseconds; request bodies, headers and exception text never
    // enter the report. Status 0 denotes a transport failure/timeout.
    slowest,
    byPathStatus,
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = process.env.M365_REPORT_PATH || resolve(here, `../reports/full-functional-${runId}.json`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`REPORT ${reportPath}\n`);
apiKey = "";
if (!report.passed) process.exitCode = 1;
