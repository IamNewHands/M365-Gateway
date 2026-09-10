import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [fullFunctional, clientCompat, readme, modelsSource] = await Promise.all([
  readFile(resolve(here, "full-functional.mjs"), "utf8"),
  readFile(resolve(here, "client-compat-functional.mjs"), "utf8"),
  readFile(resolve(here, "../README.md"), "utf8"),
  readFile(resolve(here, "../src/models.ts"), "utf8"),
]);

assert.match(fullFunctional, /const concurrencyEnabled = process\.env\.M365_TEST_CONCURRENCY === "1";/u);
assert.match(fullFunctional, /if \(concurrencyEnabled\) await stage\("concurrency"/u);
assert.match(fullFunctional, /executionMode: concurrencyEnabled \? "explicit-concurrency-probe" : "serial"/u);

// Client suites and their real-process smoke checks must remain explicit
// awaited statements. Promise.all around these calls would hit one free-plan
// Worker/upstream account concurrently and invalidate the compatibility run.
for (const statement of [
  'if (selectedClients.has("codex")) await stage("codex", "suite", runCodexChecks);',
  'if (selectedClients.has("opencode")) await stage("opencode", "suite", runOpenCodeChecks);',
  'if (selectedClients.has("hermes")) await stage("hermes", "suite", runHermesChecks);',
  'if (selectedClients.has("claude")) await stage("claude", "suite", runClaudeChecks);',
  'if (selectedClients.has("reasonix")) await stage("reasonix", "suite", () => runGenericClientChecks("reasonix"));',
  'if (selectedClients.has("pi")) await stage("pi", "suite", () => runGenericClientChecks("pi"));',
  'if (selectedClients.has("zcode")) await stage("zcode", "suite", () => runGenericClientChecks("zcode"));',
  'if (selectedClients.has("codex")) await stage("codex", "client_suite", runCodexClientSmoke);',
  'if (selectedClients.has("opencode")) await stage("opencode", "client_suite", runOpenCodeClientSmoke);',
  'if (selectedClients.has("hermes")) await stage("hermes", "client_suite", runHermesClientSmoke);',
  'if (selectedClients.has("claude")) await stage("claude", "client_suite", runClaudeClientSmoke);',
]) assert.ok(clientCompat.includes(statement), `missing serial client statement: ${statement}`);

assert.match(clientCompat, /client\.webpage_build_repair/u);
assert.match(clientCompat, /Run node verify\.mjs once to observe the existing failure/u);
assert.match(clientCompat, /verifier === verifierSource/u);
assert.match(clientCompat, /delete cleanEnvironment\[clientKeyEnvName\]/u);
assert.match(clientCompat, /Local patch programs are forbidden/u);
assert.match(clientCompat, /M365_OPENCODE_WRITE_SMOKE/u);
assert.match(clientCompat, /terminateProcessTree/u);
assert.match(clientCompat, /skipped: checks\.filter/u);
assert.match(fullFunctional, /optional_live_vision_probe_disabled/u);
assert.match(fullFunctional, /M365_TEST_VISION_INPUT/u);
assert.match(fullFunctional, /responses\.compaction\.encrypted-resume/u);
assert.match(fullFunctional, /reason=image_generation_removed/u);
assert.doesNotMatch(fullFunctional, /jsonRequest\("\/v1\/images\//u);
assert.doesNotMatch(fullFunctional, /process\.env\.M365_TEST_IMAGE_GENERATION/u);
assert.match(fullFunctional, /skipped: checks\.filter/u);
// OpenCode's non-interactive child has stdin=ignore.  Keep its smoke calls
// explicitly auto-approved so a write permission prompt cannot park the run
// until the outer timeout and masquerade as a gateway/protocol failure.
assert.ok((clientCompat.match(/"--auto"/gu) || []).length >= 2, "OpenCode smoke must auto-approve its isolated writes");
assert.doesNotMatch(modelsSource, /apply_patch_tool_type\s*:\s*["']freeform["']/u);
assert.match(modelsSource, /vision:\s*true/u);
assert.match(modelsSource, /input_modalities:\s*\["text",\s*"image"\]/u);

assert.match(readme, /依次单独运行 Codex、OpenCode、Hermes、Claude/u);
console.log("functional safety checks passed");
