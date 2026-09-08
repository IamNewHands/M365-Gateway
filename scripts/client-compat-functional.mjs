import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configuredBaseUrl = String(process.env.M365_BASE_URL || "").trim();
if (!configuredBaseUrl) throw new Error("M365_BASE_URL is required");

const target = new URL(configuredBaseUrl);
if (target.username || target.password || target.search || target.hash) {
  throw new Error("M365_BASE_URL must not contain credentials, a query, or a fragment");
}
const baseUrl = configuredBaseUrl.replace(/\/$/u, "");
const protectedHostname = String(process.env.M365_PRODUCTION_HOST || "").trim().toLowerCase();
if (protectedHostname && target.hostname.toLowerCase() === protectedHostname && process.env.M365_ALLOW_PRODUCTION !== "1") {
  throw new Error("refusing to test the configured production hostname without M365_ALLOW_PRODUCTION=1");
}

let configuredApiKey = String(process.env.M365_TEST_API_KEY || "");
delete process.env.M365_TEST_API_KEY;
if (!configuredApiKey) throw new Error("M365_TEST_API_KEY is required");
let authorizationHeader = `Bearer ${configuredApiKey}`;
configuredApiKey = "";
const defaultModel = String(process.env.M365_COMPAT_MODEL || "gpt-5.6-sol").trim();
const models = {
  codex: String(process.env.M365_CODEX_MODEL || defaultModel).trim(),
  opencode: String(process.env.M365_OPENCODE_MODEL || defaultModel).trim(),
  hermes: String(process.env.M365_HERMES_MODEL || defaultModel).trim(),
};
const clientKeyEnvName = String(process.env.M365_COMPAT_CLIENT_KEY_ENV || "M365_GATEWAY_API_KEY").trim();
if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(clientKeyEnvName)) {
  throw new Error("M365_COMPAT_CLIENT_KEY_ENV must be a valid environment variable name");
}
const runClientSmoke = process.env.M365_COMPAT_PROTOCOL_ONLY !== "1";
const runWriteOnly = process.env.M365_COMPAT_WRITE_ONLY === "1";
// OpenCode 1.18.x commonly exposes bash/read/glob but no native writer. Its
// model-side Windows shell quoting is therefore not a reliable Gateway signal
// for a multi-file repair task and can loop for minutes. Keep that write probe
// explicitly opt-in; protocol and read/tool-routing checks remain the default.
const runOpenCodeWriteSmoke = process.env.M365_OPENCODE_WRITE_SMOKE === "1";
const selectedClients = new Set(String(process.env.M365_COMPAT_CLIENTS || "codex,opencode,hermes")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean));
if (selectedClients.size === 0 || [...selectedClients].some((value) => !["codex", "opencode", "hermes"].includes(value))) {
  throw new Error("M365_COMPAT_CLIENTS must be a comma-separated subset of codex,opencode,hermes");
}
if (runWriteOnly && (selectedClients.size !== 1 || !selectedClients.has("opencode"))) {
  throw new Error("M365_COMPAT_WRITE_ONLY=1 is supported only with M365_COMPAT_CLIENTS=opencode");
}
const localAppData = String(process.env.LOCALAPPDATA || "").trim();
const userProfile = String(process.env.USERPROFILE || "").trim();
const installedCodexBinary = process.platform === "win32" && userProfile
  ? resolve(userProfile, "codex-cli/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe")
  : "";
const installedOpenCodeBinary = process.platform === "win32" && localAppData
  ? resolve(localAppData, "hermes/node/node_modules/opencode-ai/bin/opencode.exe")
  : "";
const installedHermesBinary = process.platform === "win32" && localAppData
  ? resolve(localAppData, "hermes/hermes-agent/venv/Scripts/hermes.exe")
  : "";
const clientBinaries = {
  codex: String(process.env.M365_CODEX_BIN || (existsSync(installedCodexBinary) ? installedCodexBinary : process.platform === "win32" ? "codex.exe" : "codex")).trim(),
  opencode: String(process.env.M365_OPENCODE_BIN || (existsSync(installedOpenCodeBinary) ? installedOpenCodeBinary : "opencode")).trim(),
  hermes: String(process.env.M365_HERMES_BIN || (existsSync(installedHermesBinary) ? installedHermesBinary : process.platform === "win32" ? "hermes.exe" : "hermes")).trim(),
};
const codexProvider = String(process.env.M365_CODEX_PROVIDER || "server6").trim();
const hermesProvider = String(process.env.M365_HERMES_PROVIDER || "custom:m365-c").trim();
const runId = `compat-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date();
const checks = [];
const timings = [];

function safeDetail(value) {
  let text = String(value ?? "");
  if (authorizationHeader) {
    const rawCredential = authorizationHeader.replace(/^Bearer\s+/u, "");
    text = text.replaceAll(authorizationHeader, "[REDACTED]");
    if (rawCredential) text = text.replaceAll(rawCredential, "[REDACTED]");
  }
  return text
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|secret)=)[^&#\s]+/giu, "$1[REDACTED]")
    .slice(0, 360);
}

function record(client, name, passed, detail = "", { skipped = false } = {}) {
  const item = { client, name, passed: Boolean(passed), skipped: Boolean(skipped), detail: safeDetail(detail) };
  checks.push(item);
  process.stdout.write(`${item.skipped ? "SKIP" : item.passed ? "PASS" : "FAIL"} ${client}.${name}${item.detail ? ` — ${item.detail}` : ""}\n`);
}

async function stage(client, name, task) {
  try {
    await task();
  } catch (error) {
    record(client, name, false, error instanceof Error ? error.message : String(error ?? "unknown error"));
  }
}

async function jsonRequest(path, body, timeoutMs = 240_000) {
  const started = performance.now();
  const requestPath = baseUrl.endsWith("/v1") && path.startsWith("/v1/") ? path.slice(3) : path;
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: {
      Authorization: authorizationHeader,
      "Content-Type": "application/json",
      "User-Agent": "m365-gateway-client-compat/1.0",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  timings.push({ path, status: response.status, milliseconds: Math.round(performance.now() - started) });
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON status=${response.status}`);
  }
  return { status: response.status, json };
}

async function runClientProcess(client, command, args, cwd, timeoutMs = 240_000) {
  const started = performance.now();
  const childEnvironment = { ...process.env };
  delete childEnvironment.M365_TEST_API_KEY;
  childEnvironment[clientKeyEnvName] = authorizationHeader.replace(/^Bearer\s+/u, "");
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const outputLimit = 4 * 1024 * 1024;
  const append = (current, chunk) => current.length >= outputLimit
    ? current
    : `${current}${String(chunk)}`.slice(0, outputLimit);

  const result = await new Promise((resolveResult, rejectResult) => {
    // The installed OpenCode profile may still point at another Cloudflare
    // deployment.  Keep the user's persistent profile untouched, but make
    // this isolated acceptance child unambiguously target the candidate URL
    // and credential used by the protocol probes above.
    if (client === "opencode") {
      const providerBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
      childEnvironment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: {
          m365: {
            options: {
              apiKey: authorizationHeader.replace(/^Bearer\s+/u, ""),
              baseURL: providerBaseUrl,
            },
          },
        },
      });
    }
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childEnvironment[clientKeyEnvName] = "";
    childEnvironment.OPENCODE_CONFIG_CONTENT = "";
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr, timedOut });
    });
  });
  timings.push({
    path: `client:${client}`,
    status: result.code ?? -1,
    milliseconds: Math.round(performance.now() - started),
  });
  return result;
}

function diagnosticTail(result) {
  const stdout = String(result?.stdout ?? "").replace(/\s+/gu, " ").trim();
  const stderr = String(result?.stderr ?? "").replace(/\s+/gu, " ").trim();
  return `stdout_tail=${stdout.slice(-480)};stderr_tail=${stderr.slice(-480)}`;
}

function terminateProcessTree(child) {
  if (!child || !child.pid) return;
  try { child.kill(); } catch { /* already exited */ }
  if (process.platform === "win32") {
    // A client can spawn a shell and a model worker. Killing only the direct
    // child leaves that subtree alive and can cause a later active-request
    // collision on the next compatibility run.
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
  }
}

function forbiddenPatchReasons(value) {
  const text = String(value ?? "");
  const patterns = [
    /\btools\.(?:apply_patch|patch|git_apply|gitapply)\s*\(/iu,
    /"(?:name|tool_name)"\s*:\s*"(?:apply_patch|patch|git_apply|gitapply)"/iu,
    /(?:^|[\n\r])\s*(?:git\s+apply|apply_patch(?:\.exe)?|patch(?:\.exe)?)(?:\s+(?:[-/<]|[A-Za-z]:)|\s*$)/iu,
    /\*{3}\s+Begin\s+Patch\b/iu,
    /\bcodex\s+apply\b/iu,
  ];
  return patterns.flatMap((pattern) => pattern.test(text) ? [pattern.source] : []);
}

async function withTemporaryFixture(prefix, task) {
  const fixturePath = await mkdtemp(resolve(tmpdir(), `${prefix}-${runId}-`));
  try {
    return await task(fixturePath);
  } finally {
    await rm(fixturePath, { recursive: true, force: true });
  }
}

async function runLocalVerifier(fixturePath) {
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.M365_TEST_API_KEY;
  delete cleanEnvironment.M365_GATEWAY_API_KEY;
  delete cleanEnvironment[clientKeyEnvName];
  return new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(process.execPath, [resolve(fixturePath, "verify.mjs")], {
      cwd: fixturePath,
      env: cleanEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr, timedOut });
    });
  });
}

async function createWebpageRepairFixture(fixturePath, marker) {
  const verifierSource = `import { readFile } from "node:fs/promises";\n\nconst [html, css, js] = await Promise.all([\n  readFile(new URL("./index.html", import.meta.url), "utf8"),\n  readFile(new URL("./style.css", import.meta.url), "utf8"),\n  readFile(new URL("./app.js", import.meta.url), "utf8"),\n]);\nconst failures = [];\nif (!html.includes("<title>Gateway Client Check</title>")) failures.push("title");\nif (!html.includes("id=\\"status\\"")) failures.push("status element");\nif (!html.includes("id=\\"action\\"")) failures.push("action button");\nif (!html.includes("style.css") || !html.includes("app.js")) failures.push("assets");\nif (!html.includes(${JSON.stringify(marker)})) failures.push("marker");\nif (!css.includes("--accent: #2563eb")) failures.push("accent");\nif (!js.includes("addEventListener(\\"click\\"")) failures.push("click handler");\nif (!js.includes(${JSON.stringify(marker)})) failures.push("script marker");\nif (/BROKEN/u.test(html + css + js)) failures.push("broken sentinel");\nif (failures.length) {\n  console.error("VERIFY_FAILED:" + failures.join(","));\n  process.exit(1);\n}\nconsole.log(${JSON.stringify(`VERIFY_OK:${marker}`)});\n`;
  const specification = [
    "# Offline status page repair task",
    "",
    "Repair the existing index.html, style.css and app.js into a small offline status card.",
    "The page must use the exact title Gateway Client Check, preserve the exact marker below visibly in #status, link style.css and app.js, and contain a button with id=action.",
    "The button click handler must be implemented in app.js with addEventListener(\"click\", ...) and the CSS must define --accent: #2563eb.",
    `Exact marker: ${marker}`,
    "Run node verify.mjs, use its first failure as evidence, repair the page, and rerun it until it exits 0.",
    "Local programs are forbidden from invoking or generating apply_patch, patch, diff, or edit-style patch operations. Use only a direct file-write capability. For Codex, use exec_command with a short native one-file write (Node fs.writeFileSync or PowerShell Set-Content), then read it back. For OpenCode without a native writer, use one short Node command through bash to write all three target files, then use verify.mjs as the authoritative readback instead of spending a separate model turn reading each file. Do not claim success until the verifier exits 0.",
    "Do not edit SPEC.md or verify.mjs. Do not use network access.",
    "",
  ].join("\n");
  await Promise.all([
    writeFile(resolve(fixturePath, "SPEC.md"), specification, "utf8"),
    writeFile(resolve(fixturePath, "verify.mjs"), verifierSource, "utf8"),
    writeFile(resolve(fixturePath, "index.html"), "<!doctype html><title>BROKEN</title><main id=\"status\">BROKEN</main>\n", "utf8"),
    writeFile(resolve(fixturePath, "style.css"), "/* BROKEN */\n", "utf8"),
    writeFile(resolve(fixturePath, "app.js"), "throw new Error(\"BROKEN\");\n", "utf8"),
  ]);
  return { verifierSource, specification };
}

async function inspectWebpageRepair(fixturePath, marker, verifierSource) {
  const [html, css, js, verifier] = await Promise.all([
    readFile(resolve(fixturePath, "index.html"), "utf8"),
    readFile(resolve(fixturePath, "style.css"), "utf8"),
    readFile(resolve(fixturePath, "app.js"), "utf8"),
    readFile(resolve(fixturePath, "verify.mjs"), "utf8"),
  ]);
  const verification = await runLocalVerifier(fixturePath);
  return {
    passed: verifier === verifierSource
      && verification.code === 0
      && !verification.timedOut
      && verification.stdout.includes(`VERIFY_OK:${marker}`)
      && html.includes(marker)
      && css.includes("--accent: #2563eb")
      && js.includes(marker)
      && !/BROKEN/u.test(html + css + js),
    verification,
    verifierUnchanged: verifier === verifierSource,
  };
}

const checkpointFallbackPatterns = [
  /\bNO_TOOL_REQUIRED\b/iu,
  /\bCLIENT_TOOL_UNAVAILABLE\b/iu,
  /Tool execution stopped after a repeated or invalid action/iu,
  /The task state was preserved without executing an unverified or malformed tool action/iu,
  /The (?:current )?task and (?:existing|latest) tool results? are preserved/iu,
  /(?:当前任务|任务状态|已有工具结果|刚才的工具结果)[^。\n]{0,100}(?:已保留|都已保留)/u,
  /m365gw_client_[0-9a-f]+/iu,
  /\bAZHEX(?:_FALLBACK)?\b/iu,
];

function leakReasons(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const reasons = checkpointFallbackPatterns.flatMap((pattern) => pattern.test(serialized) ? [pattern.source] : []);
  if (typeof value !== "string"
    && (value?.m365_gateway?.checkpoint === true || value?.m365_gateway?.continuation_required === true)) {
    reasons.push("checkpoint_metadata");
  }
  return reasons;
}

function assertClean(label, response) {
  const reasons = leakReasons(response.json);
  if (reasons.length) throw new Error(`${label} exposed internal routing fallback (${reasons.join(",")})`);
}

function responseText(json) {
  return (Array.isArray(json?.output) ? json.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((item) => item?.type === "output_text")
    .map((item) => String(item.text || ""))
    .join("");
}

function chatText(json) {
  return String(json?.choices?.[0]?.message?.content ?? "");
}

function responseCall(json, expectedName) {
  const call = (Array.isArray(json?.output) ? json.output : []).find((item) => item?.type === "function_call");
  if (!call || call.name !== expectedName || !call.call_id || typeof call.arguments !== "string") return null;
  return call;
}

function chatCall(json, expectedName) {
  const call = json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.id || call?.function?.name !== expectedName || typeof call.function.arguments !== "string") return null;
  return call;
}

function parseArguments(call) {
  try {
    const value = JSON.parse(call?.arguments ?? call?.function?.arguments ?? "");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function jsonValueEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValueEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValueEqual(left[key], right[key]));
}

function compatibleToolArguments(actual, expected, requiredKeys) {
  if (!actual) return false;
  for (const key of requiredKeys) {
    if (!Object.hasOwn(actual, key) || !jsonValueEqual(actual[key], expected[key])) return false;
  }
  // Optional fields may be omitted so the real client can apply its documented
  // defaults. If the model does emit one, its value must still remain exact.
  for (const [key, value] of Object.entries(expected)) {
    if (Object.hasOwn(actual, key) && !jsonValueEqual(actual[key], value)) return false;
  }
  return true;
}

function flatFunction(name, description, properties, required = []) {
  return {
    type: "function",
    name,
    description,
    strict: false,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

function nestedFunction(name, description, properties, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

const codexExecCommand = flatFunction("exec_command", "Run a command in a caller-owned local terminal", {
  cmd: { type: "string" },
  justification: { type: "string" },
  login: { type: "boolean" },
  workdir: { type: "string" },
  yield_time_ms: { type: "number" },
  max_output_tokens: { type: "number" },
  prefix_rule: { type: "array", items: { type: "string" } },
  sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"] },
  shell: { type: "string" },
  tty: { type: "boolean" },
}, ["cmd"]);
const codexWriteStdin = flatFunction("write_stdin", "Write characters to or poll a caller-owned terminal session", {
  session_id: { type: "number" },
  chars: { type: "string" },
  yield_time_ms: { type: "number" },
  max_output_tokens: { type: "number" },
}, ["session_id"]);

const openCodeTools = {
  bash: nestedFunction("bash", "Execute a shell command in the working directory", {
    command: { type: "string" }, timeout: { type: "number" }, workdir: { type: "string" }, description: { type: "string" },
  }, ["command"]),
  read: nestedFunction("read", "Read a file from the local filesystem", {
    filePath: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" },
  }, ["filePath"]),
  glob: nestedFunction("glob", "Find files in the local workspace by glob pattern", {
    pattern: { type: "string" }, path: { type: "string" },
  }, ["pattern"]),
};

const hermesTools = [
  flatFunction("terminal", "Execute shell commands on a Linux environment", {
    command: { type: "string" }, background: { type: "boolean", default: false }, timeout: { type: "integer", minimum: 1 }, workdir: { type: "string" }, pty: { type: "boolean", default: false }, notify_on_complete: { type: "boolean", default: false }, watch_patterns: { type: "array", items: { type: "string" } },
  }, ["command"]),
  flatFunction("process", "Manage background processes started with the terminal tool", {
    action: { type: "string", enum: ["list", "poll", "log", "wait", "kill", "write", "submit", "close"] },
    session_id: { type: "string" },
    data: { type: "string" },
    timeout: { type: "integer", minimum: 1 },
    offset: { type: "integer" },
    limit: { type: "integer", minimum: 1 },
  }, ["action"]),
  flatFunction("read_file", "Read a file from the local filesystem", {
    path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" },
  }, ["path"]),
  flatFunction("search_files", "Search files in the local workspace", {
    pattern: { type: "string" }, target: { type: "string" }, path: { type: "string" }, file_glob: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" }, output_mode: { type: "string" }, context: { type: "integer" },
  }, ["pattern"]),
  flatFunction("write_file", "Write content to a file on the local filesystem", {
    path: { type: "string" }, content: { type: "string" }, cross_profile: { type: "boolean" },
  }, ["path", "content"]),
];
const hermesPatchTool = flatFunction("patch", "Apply a patch to files in the local workspace", {
  mode: { type: "string" }, path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" }, patch: { type: "string" }, cross_profile: { type: "boolean" },
}, ["mode"]);

async function runCodexChecks() {
  const powershellCommand = "Get-ChildItem -LiteralPath 'C:\\Compat_Work\\server=2'; $ConnectTimeout=30; Write-Output $ConnectTimeout";
  const execResultMarker = `CODEX_EXEC_RESULT_${runId}`;
  const first = await jsonRequest("/v1/responses", {
    model: models.codex,
    input: `Call exec_command exactly once. Set cmd to this exact string without wrapping or rewriting it: ${JSON.stringify(powershellCommand)}`,
    tools: [codexExecCommand, codexWriteStdin],
    tool_choice: { type: "function", name: "exec_command" },
  });
  assertClean("Codex exec_command", first);
  const call = responseCall(first.json, "exec_command");
  const args = parseArguments(call);
  record("codex", "responses.exec_command.characters", first.status === 200 && args?.cmd === powershellCommand,
    `status=${first.status};call=${call?.name || "none"};exact=${args?.cmd === powershellCommand}`);
  if (!call || !first.json?.id) throw new Error("Codex exec_command call identity missing");

  const continued = await jsonRequest("/v1/responses", {
    model: models.codex,
    previous_response_id: first.json.id,
    input: [
      { type: "function_call_output", call_id: call.call_id, output: execResultMarker },
      { role: "user", content: [{ type: "input_text", text: `Return exactly this marker and nothing else: ${execResultMarker}` }] },
    ],
  });
  assertClean("Codex previous_response_id continuation", continued);
  record("codex", "responses.previous_response_id", continued.status === 200 && responseText(continued.json).includes(execResultMarker),
    `status=${continued.status};marker=${responseText(continued.json).includes(execResultMarker)}`);

  const stdinArgs = { session_id: 26957, chars: "", yield_time_ms: 1000, max_output_tokens: 2000 };
  const stdinMarker = `CODEX_STDIN_RESULT_${runId}`;
  const stdinFirst = await jsonRequest("/v1/responses", {
    model: models.codex,
    input: `Call write_stdin exactly once with this arguments object: ${JSON.stringify(stdinArgs)}`,
    tools: [codexExecCommand, codexWriteStdin],
    tool_choice: { type: "function", name: "write_stdin" },
  });
  assertClean("Codex write_stdin", stdinFirst);
  const stdinCall = responseCall(stdinFirst.json, "write_stdin");
  record("codex", "responses.write_stdin", stdinFirst.status === 200
    && compatibleToolArguments(parseArguments(stdinCall), stdinArgs, ["session_id"]),
    `status=${stdinFirst.status};call=${stdinCall?.name || "none"};args=${JSON.stringify(parseArguments(stdinCall))}`);
  if (!stdinCall) throw new Error("Codex write_stdin call identity missing");

  const stateless = await jsonRequest("/v1/responses", {
    model: models.codex,
    input: [
      { role: "user", content: [{ type: "input_text", text: `After the terminal result, return the exact marker ${stdinMarker}.` }] },
      { type: "function_call", call_id: stdinCall.call_id, name: stdinCall.name, arguments: stdinCall.arguments },
      { type: "function_call_output", call_id: stdinCall.call_id, output: stdinMarker },
    ],
  });
  assertClean("Codex stateless continuation", stateless);
  record("codex", "responses.stateless_continuation", stateless.status === 200 && responseText(stateless.json).includes(stdinMarker),
    `status=${stateless.status};marker=${responseText(stateless.json).includes(stdinMarker)}`);
}

async function runOpenCodeChecks() {
  const repository = "C:\\Compat_Workspace";
  const originalTask = `Inspect ${repository}. First use glob to find package.json; after the glob result, use read on that exact package.json path.`;
  const first = await jsonRequest("/v1/chat/completions", {
    model: models.opencode,
    messages: [{ role: "user", content: originalTask }],
    tools: [openCodeTools.glob, openCodeTools.read],
    tool_choice: { type: "function", function: { name: "glob" } },
  });
  assertClean("OpenCode glob", first);
  const globCall = chatCall(first.json, "glob");
  record("opencode", "chat.nested.glob", first.status === 200 && Boolean(globCall), `status=${first.status};call=${globCall?.function?.name || "none"}`);
  if (!globCall) throw new Error("OpenCode glob call identity missing");

  const packagePath = `${repository}\\package.json`;
  const secondMessages = [
    { role: "user", content: originalTask },
    { role: "assistant", content: null, tool_calls: [globCall] },
    { role: "tool", tool_call_id: globCall.id, content: packagePath },
  ];
  const second = await jsonRequest("/v1/chat/completions", {
    model: models.opencode,
    messages: secondMessages,
    tools: [openCodeTools.glob, openCodeTools.read],
    tool_choice: "auto",
  });
  assertClean("OpenCode glob-to-read continuation", second);
  const readCall = chatCall(second.json, "read");
  const readArgs = parseArguments(readCall);
  record("opencode", "chat.full_history.glob_to_read", second.status === 200 && readArgs?.filePath === packagePath,
    `status=${second.status};call=${readCall?.function?.name || "none"};path=${readArgs?.filePath === packagePath}`);
  if (!readCall) throw new Error("OpenCode read call identity missing");

  const readMarker = `OPENCODE_READ_RESULT_${runId}`;
  const third = await jsonRequest("/v1/chat/completions", {
    model: models.opencode,
    messages: [
      ...secondMessages,
      { role: "assistant", content: null, tool_calls: [readCall] },
      { role: "tool", tool_call_id: readCall.id, content: JSON.stringify({ name: "compat", marker: readMarker }) },
    ],
    tools: [openCodeTools.glob, openCodeTools.read],
    tool_choice: "auto",
  });
  assertClean("OpenCode read result", third);
  record("opencode", "chat.full_history.result", third.status === 200 && chatText(third.json).includes(readMarker)
    && !third.json?.choices?.[0]?.message?.tool_calls?.length,
  `status=${third.status};marker=${chatText(third.json).includes(readMarker)};extra_call=${Boolean(third.json?.choices?.[0]?.message?.tool_calls?.length)}`);

  const shortFollowup = await jsonRequest("/v1/chat/completions", {
    model: models.opencode,
    messages: [
      { role: "user", content: `Work in ${repository}; inspect the project and then wait for my next instruction.` },
      { role: "assistant", content: "The project target is recorded." },
      { role: "user", content: "继续，运行测试。" },
    ],
    tools: [openCodeTools.bash],
    tool_choice: "auto",
  });
  assertClean("OpenCode short follow-up", shortFollowup);
  const bashCall = chatCall(shortFollowup.json, "bash");
  const bashArgs = parseArguments(bashCall);
  record("opencode", "chat.short_followup.bash", shortFollowup.status === 200 && typeof bashArgs?.command === "string" && bashArgs.command.length > 0,
    `status=${shortFollowup.status};call=${bashCall?.function?.name || "none"};command=${typeof bashArgs?.command === "string"}`);
}

async function runHermesChecks() {
  const cases = [
    ["terminal", { command: "printf 'HERMES_TERMINAL_COMPAT'", timeout: 30 }, ["command"]],
    ["process", { action: "list" }, ["action"]],
    ["read_file", { path: "/workspace/README.md", offset: 0, limit: 5 }, ["path"]],
    ["search_files", { pattern: "README.md", path: "/workspace", limit: 5 }, ["pattern"]],
    ["write_file", { path: "/tmp/m365-compat-probe.txt", content: "HERMES_WRITE_COMPAT", cross_profile: false }, ["path", "content"]],
  ];
  let searchResponse;
  let searchCall;
  for (const [name, expectedArguments, requiredKeys] of cases) {
    const response = await jsonRequest("/v1/responses", {
      model: models.hermes,
      input: `Call ${name} exactly once with this arguments object: ${JSON.stringify(expectedArguments)}`,
      tools: hermesTools,
      tool_choice: { type: "function", name },
    });
    assertClean(`Hermes ${name}`, response);
    const call = responseCall(response.json, name);
    record("hermes", `responses.flat.${name}`, response.status === 200
      && compatibleToolArguments(parseArguments(call), expectedArguments, requiredKeys),
      `status=${response.status};call=${call?.name || "none"};args=${JSON.stringify(parseArguments(call))}`);
    if (!call) throw new Error(`Hermes ${name} call identity missing`);
    if (name === "search_files") {
      searchResponse = response;
      searchCall = call;
    }
  }
  const patchResponse = await jsonRequest("/v1/responses", {
    model: models.hermes,
    input: "Do not execute a patch; this is a policy probe.",
    tools: [hermesPatchTool],
    tool_choice: { type: "function", name: "patch" },
  });
  record("hermes", "responses.patch_is_disabled", patchResponse.status === 400
    && patchResponse.json?.error?.code === "local_patch_disabled",
  `status=${patchResponse.status};code=${patchResponse.json?.error?.code || "none"}`);

  if (!searchResponse?.json?.id || !searchCall) throw new Error("Hermes search_files continuation identity missing");
  const discoveredPath = "/workspace/README.md";
  const readNext = await jsonRequest("/v1/responses", {
    model: models.hermes,
    previous_response_id: searchResponse.json.id,
    input: [{ type: "function_call_output", call_id: searchCall.call_id, output: discoveredPath }],
    tools: hermesTools,
    tool_choice: { type: "function", name: "read_file" },
  });
  assertClean("Hermes search-to-read continuation", readNext);
  const readCall = responseCall(readNext.json, "read_file");
  const readArgs = parseArguments(readCall);
  record("hermes", "responses.search_files_to_read_file", readNext.status === 200 && readArgs?.path === discoveredPath,
    `status=${readNext.status};call=${readCall?.name || "none"};path=${readArgs?.path === discoveredPath}`);
  if (!readCall || !readNext.json?.id) throw new Error("Hermes read_file continuation identity missing");

  const readMarker = `HERMES_READ_RESULT_${runId}`;
  const final = await jsonRequest("/v1/responses", {
    model: models.hermes,
    previous_response_id: readNext.json.id,
    input: [
      { type: "function_call_output", call_id: readCall.call_id, output: readMarker },
      { role: "user", content: [{ type: "input_text", text: `Return exactly this marker and nothing else: ${readMarker}` }] },
    ],
  });
  assertClean("Hermes read result", final);
  record("hermes", "responses.search_read_result", final.status === 200 && responseText(final.json).includes(readMarker),
    `status=${final.status};marker=${responseText(final.json).includes(readMarker)}`);
}

async function runCodexClientSmoke() {
  await withTemporaryFixture("m365-codex", async (fixturePath) => {
    const marker = `CODEX_CLIENT_MARKER_${runId}`;
    await writeFile(resolve(fixturePath, "codex-marker.txt"), `${marker}\n`, "utf8");
    // exec_command itself is launched from PowerShell on Windows.  Keep the
    // child PowerShell program single-quoted so the outer shell cannot expand
    // $ConnectTimeout before the child sees it.  The old double-quoted probe
    // was invalid in that execution context and produced a false transport
    // failure even when the Gateway preserved every character exactly.
    const powershellCommand = "powershell -NoProfile -Command '$ConnectTimeout=30; Get-Content -LiteralPath \".\\codex-marker.txt\"; Start-Sleep -Seconds 12; Write-Output (\"CONNECT=\" + $ConnectTimeout)'";
    const prompt = [
      "Use exec_command with the command below and yield_time_ms=10000.",
      "Preserve its semantic intent. If the local shell rejects its quoting, change only the quoting or split it into short equivalent commands and continue instead of stopping at the first parser error.",
      "If the command remains active, use write_stdin until it completes.",
      "Then return the file's exact first line and the CONNECT value. Do not guess either value.",
      powershellCommand,
    ].join("\n");
    const result = await runClientProcess("codex", clientBinaries.codex, [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      fixturePath,
      "-m",
      models.codex,
      "-c",
      `model_provider=${JSON.stringify(codexProvider)}`,
      prompt,
    ], fixturePath);
    const output = `${result.stdout}\n${result.stderr}`;
    const leaks = leakReasons(output);
    const commandPassed = result.code === 0 && !result.timedOut
      && output.includes(marker) && output.includes("CONNECT=30") && leaks.length === 0;
    record("codex", "client.exec_command_write_stdin", commandPassed,
    `exit=${result.code ?? "none"};timeout=${result.timedOut};marker=${output.includes(marker)};characters=${output.includes("CONNECT=30")};leaks=${leaks.length}${commandPassed ? "" : `;${diagnosticTail(result)}`}`);

    const webpageMarker = `CODEX_WEBPAGE_${runId}`;
    const { verifierSource } = await createWebpageRepairFixture(fixturePath, webpageMarker);
    const webpageResult = await runClientProcess("codex", clientBinaries.codex, [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      fixturePath,
      "-m",
      models.codex,
      "-c",
      `model_provider=${JSON.stringify(codexProvider)}`,
      "Read SPEC.md. Run node verify.mjs once to observe the existing failure. Local patch programs are forbidden: do not call, generate, or mention apply_patch, patch, diff, or edit-style patch tools. Repair only index.html, style.css and app.js with direct one-file writes (use exec_command with a short native Node fs.writeFileSync or PowerShell Set-Content), read each written file back, and rerun node verify.mjs until it exits 0. Do not edit SPEC.md or verify.mjs, do not use network access, and finish by reporting the exact marker only after the verifier exits 0.",
    ], fixturePath, 480_000);
    const webpageOutput = `${webpageResult.stdout}\n${webpageResult.stderr}`;
    const webpageLeaks = leakReasons(webpageOutput);
    const forbiddenPatch = forbiddenPatchReasons(webpageOutput);
    const inspected = await inspectWebpageRepair(fixturePath, webpageMarker, verifierSource);
    const webpagePassed = webpageResult.code === 0 && !webpageResult.timedOut
      && webpageOutput.includes(webpageMarker) && webpageLeaks.length === 0
      && forbiddenPatch.length === 0 && inspected.passed;
    record("codex", "client.webpage_build_repair", webpagePassed,
    `exit=${webpageResult.code ?? "none"};timeout=${webpageResult.timedOut};marker=${webpageOutput.includes(webpageMarker)};verified=${inspected.passed};verifier_unchanged=${inspected.verifierUnchanged};leaks=${webpageLeaks.length};forbidden_patch=${forbiddenPatch.length}${webpagePassed ? "" : `;${diagnosticTail(webpageResult)}`}`);
  });
}

async function runOpenCodeClientSmoke() {
  await withTemporaryFixture("m365-opencode", async (fixturePath) => {
    if (!runWriteOnly) {
      const marker = `OPENCODE_CLIENT_MARKER_${runId}`;
      await writeFile(resolve(fixturePath, "package.json"), `${JSON.stringify({ name: "client-compat", marker }, null, 2)}\n`, "utf8");
      const prompt = [
        "Use glob to find package.json in the current workspace.",
        "Then use read on that exact path and return the marker value from the file exactly.",
        "Do not use bash and do not guess the marker.",
      ].join(" ");
      const result = await runClientProcess("opencode", clientBinaries.opencode, [
        "run",
        "--format",
        "json",
        "--pure",
        // The acceptance child has no stdin.  OpenCode otherwise pauses on its
        // interactive permission prompt as soon as the model selects a write
        // tool, leaving the fixture untouched until the outer timeout kills it.
        // `--auto` is scoped to this disposable temp fixture and does not alter
        // the user's persistent OpenCode profile.
        "--auto",
        "--model",
        `m365/${models.opencode}`,
        "--dir",
        fixturePath,
        prompt,
      ], fixturePath);
      const output = `${result.stdout}\n${result.stderr}`;
      const leaks = leakReasons(output);
      record("opencode", "client.glob_read", result.code === 0 && !result.timedOut
        && output.includes(marker) && leaks.length === 0,
      `exit=${result.code ?? "none"};timeout=${result.timedOut};marker=${output.includes(marker)};leaks=${leaks.length}`);
    }

    const webpageMarker = `OPENCODE_WEBPAGE_${runId}`;
    const { verifierSource } = await createWebpageRepairFixture(fixturePath, webpageMarker);
    if (!runOpenCodeWriteSmoke) {
      record("opencode", "client.webpage_build_repair", true,
        "skipped=true;reason=installed_tool_manifest_has_no_native_writer;set_M365_OPENCODE_WRITE_SMOKE=1_to_run_opt_in_shell_write_probe",
        { skipped: true });
      return;
    }
    const webpageResult = await runClientProcess("opencode", clientBinaries.opencode, [
      "run",
      "--format",
      "json",
      "--pure",
      // Keep this non-interactive smoke deterministic: writes in the isolated
      // fixture must not wait for an approval prompt on the intentionally
      // closed stdin pipe (see the glob/read probe above).
      "--auto",
      "--model",
      `m365/${models.opencode}`,
      "--dir",
      fixturePath,
      "Read SPEC.md and run node verify.mjs once. Local patch programs are forbidden: do not call, generate, or mention apply_patch, patch, diff, or edit-style patch tools. Use one bash call containing a short native Node fs.writeFileSync program to write index.html, style.css and app.js directly; do not spend separate model turns reading each file because verify.mjs is the authoritative readback. Then rerun node verify.mjs and finish by reporting the exact marker only after it exits 0. Do not edit SPEC.md or verify.mjs and do not use network access.",
    ], fixturePath, 300_000);
    const webpageOutput = `${webpageResult.stdout}\n${webpageResult.stderr}`;
    const webpageLeaks = leakReasons(webpageOutput);
    const forbiddenPatch = forbiddenPatchReasons(webpageOutput);
    const inspected = await inspectWebpageRepair(fixturePath, webpageMarker, verifierSource);
    record("opencode", "client.webpage_build_repair", webpageResult.code === 0 && !webpageResult.timedOut
      && webpageOutput.includes(webpageMarker) && webpageLeaks.length === 0
      && forbiddenPatch.length === 0 && inspected.passed,
    `exit=${webpageResult.code ?? "none"};timeout=${webpageResult.timedOut};marker=${webpageOutput.includes(webpageMarker)};verified=${inspected.passed};verifier_unchanged=${inspected.verifierUnchanged};leaks=${webpageLeaks.length};forbidden_patch=${forbiddenPatch.length}${webpageResult.code === 0 && !webpageResult.timedOut && webpageOutput.includes(webpageMarker) && webpageLeaks.length === 0 && forbiddenPatch.length === 0 && inspected.passed ? "" : `;${diagnosticTail(webpageResult)}`}`);
  });
}

async function runHermesClientSmoke() {
  await withTemporaryFixture("m365-hermes", async (fixturePath) => {
    const marker = `HERMES_CLIENT_MARKER_${runId}`;
    await writeFile(resolve(fixturePath, "README.md"), `# Compatibility fixture\n\n${marker}\n`, "utf8");
    const prompt = [
      "Use search_files to find README.md in the current workspace.",
      "Then use read_file on the discovered path and return the marker from the file exactly.",
      "Do not use terminal and do not guess the marker.",
    ].join(" ");
    const result = await runClientProcess("hermes", clientBinaries.hermes, [
      "chat",
      "-q",
      prompt,
      "-Q",
      "--provider",
      hermesProvider,
      "-m",
      models.hermes,
      "-t",
      "coding",
      "--in",
      fixturePath,
      "--max-turns",
      "8",
      "--ignore-rules",
    ], fixturePath);
    const output = `${result.stdout}\n${result.stderr}`;
    const leaks = leakReasons(output);
    record("hermes", "client.search_files_read_file", result.code === 0 && !result.timedOut
      && output.includes(marker) && leaks.length === 0,
    `exit=${result.code ?? "none"};timeout=${result.timedOut};marker=${output.includes(marker)};leaks=${leaks.length}`);
  });
}

try {
  if (!runWriteOnly) {
    if (selectedClients.has("codex")) await stage("codex", "suite", runCodexChecks);
    if (selectedClients.has("opencode")) await stage("opencode", "suite", runOpenCodeChecks);
    if (selectedClients.has("hermes")) await stage("hermes", "suite", runHermesChecks);
  }
  if (runClientSmoke) {
    if (selectedClients.has("codex")) await stage("codex", "client_suite", runCodexClientSmoke);
    if (selectedClients.has("opencode")) await stage("opencode", "client_suite", runOpenCodeClientSmoke);
    if (selectedClients.has("hermes")) await stage("hermes", "client_suite", runHermesClientSmoke);
  }

  const ordered = timings.map((item) => item.milliseconds).sort((a, b) => a - b);
  const percentile = (fraction) => ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] : 0;
  const report = {
    runId,
    baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    models,
    selectedClients: [...selectedClients],
    clientSmoke: {
      enabled: runClientSmoke,
      writeOnly: runWriteOnly,
      credentialEnvironment: clientKeyEnvName,
    },
    passed: checks.length > 0 && checks.every((item) => item.passed || item.skipped),
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
    },
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const reportPath = process.env.M365_COMPAT_REPORT_PATH || resolve(here, `../reports/client-compat-functional-${runId}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`REPORT ${reportPath}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  authorizationHeader = "";
}
