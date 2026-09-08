import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientToolWireName } from "../src/chathub";
import type { OAuthTokenSet } from "../src/types";

// All requests run in Miniflare. The commands below are protocol fixtures,
// never executed on the caller or any production Cloudflare account.
const RS = "\u001e";
const promise = "检查已经完成，但是提交动作还没执行；我现在继续完成精确暂存、核验并提交桌面端改动。";
const task = "提交 E:\\probe\\clients\\pc-desktop 源码，排除生成物，提交后验证。";
const evidence = "Exit code: 0\n M clients/pc-desktop/src/main.ts\n尚未暂存或提交。";
const parameters = { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false };
const tool = { type: "function", name: "exec_command", description: "Execute a command in the caller workspace.", parameters };
const nextArgs = { cmd: "git add -- 'clients/pc-desktop/src/main.ts'" };
type Protocol = "responses" | "chat/completions" | "messages";
interface Invocation {
  message: { text: string };
  conversationId: string;
  isStartOfSession: boolean;
  tone: string;
  plugins: unknown[];
  toolChoice: unknown;
}
const mutable = env as typeof env & { DIRECT_NATIVE_TOOL_MODE?: string };
let previousMode: string | undefined;
beforeEach(() => { previousMode = mutable.DIRECT_NATIVE_TOOL_MODE; mutable.DIRECT_NATIVE_TOOL_MODE = "true"; });
afterEach(() => { mutable.DIRECT_NATIVE_TOOL_MODE = previousMode; vi.restoreAllMocks(); });

function install(sequence: Array<string | { name: string; args: Record<string, unknown> }>) {
  const invocations: Invocation[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input));
    if (url.hostname !== "substrate.office.com") throw new Error(`unexpected outbound origin: ${url.origin}`);
    const pair = new WebSocketPair();
    const socket = pair[1]; socket.accept();
    let handshake = false;
    socket.addEventListener("message", (event) => {
      if (!handshake) { handshake = true; socket.send(`{}${RS}`); return; }
      const frame = String(event.data).split(RS).find((part) => part.trim());
      if (!frame) return;
      invocations.push(JSON.parse(frame).arguments[0] as Invocation);
      const item = sequence[Math.min(invocations.length - 1, sequence.length - 1)];
      const result = typeof item === "string"
        ? { result: { message: item } }
        : { contentType: "ToolCall", functionName: clientToolWireName(item.name), functionArguments: item.args };
      socket.send(JSON.stringify({ type: 2, item: result }) + RS + JSON.stringify({ type: 3 }) + RS);
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
  return invocations;
}

async function key(): Promise<string> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  await state.upsertAccount({ accessToken: "test", refreshToken: "test", expiresAt: Date.now() + 3_600_000,
    oid: crypto.randomUUID(), tid: crypto.randomUUID(), email: "continuation@example.test", displayName: "Continuation regression" } as OAuthTokenSet);
  return (await state.createAPIKey("continuation", 1)).key;
}

function responsesInput(request = task) {
  return [
    { role: "user", content: request },
    { type: "function_call", call_id: "inspect", name: "exec_command", arguments: '{"cmd":"git status --short"}' },
    { type: "function_call_output", call_id: "inspect", output: evidence },
  ];
}

function body(protocol: Protocol, stream: boolean) {
  const common = { model: "gpt-5.6-sol", stream };
  if (protocol === "responses") return { ...common, tools: [tool], tool_choice: "auto", input: responsesInput() };
  if (protocol === "messages") return {
    ...common, max_tokens: 1024, tools: [{ name: tool.name, description: tool.description, input_schema: parameters }], tool_choice: { type: "auto" },
    messages: [
      { role: "user", content: task },
      { role: "assistant", content: [{ type: "tool_use", id: "inspect", name: "exec_command", input: { cmd: "git status --short" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "inspect", content: evidence }] },
    ],
  };
  return {
    ...common, tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters } }], tool_choice: "auto",
    messages: [
      { role: "user", content: task },
      { role: "assistant", content: null, tool_calls: [{ id: "inspect", type: "function", function: { name: "exec_command", arguments: '{"cmd":"git status --short"}' } }] },
      { role: "tool", tool_call_id: "inspect", content: evidence },
    ],
  };
}

async function post(protocol: string, payload: Record<string, unknown>, apiKey?: string) {
  const credential = apiKey ?? await key();
  return SELF.fetch(`https://example.test/v1/${protocol}`, {
    method: "POST", headers: { Authorization: `Bearer ${credential}`, "x-api-key": credential, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload),
  });
}

describe("production direct-native continuation", () => {
  it.each([
    ["responses", false], ["responses", true], ["chat/completions", false], ["chat/completions", true], ["messages", false], ["messages", true],
  ] as const)("recovers an unfinished promise with native tools: %s stream=%s", async (protocol, stream) => {
    const invocations = install([promise, { name: "exec_command", args: nextArgs }]);
    const response = await post(protocol, body(protocol, stream));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(invocations).toHaveLength(2);
    const [initial, resumed] = invocations;
    expect(resumed.conversationId).toBe(initial.conversationId);
    expect(resumed.tone).toBe(initial.tone);
    expect(resumed.plugins).toEqual(initial.plugins);
    expect(resumed.toolChoice).toEqual(initial.toolChoice);
    expect(resumed.isStartOfSession).toBe(false);
    expect(resumed.message.text).toContain("尚未暂存或提交");
    expect(resumed.message.text).toContain("pc-desktop");
    expect(text).toContain("exec_command");
    expect(text).toContain("git add");
    expect(text).not.toContain(promise);
    expect(text).not.toContain("checkpoint");
    if (stream && protocol === "responses") {
      expect(text.match(/event: response.completed/g)).toHaveLength(1);
      expect(text).toContain('"type":"function_call"');
      expect(text).not.toContain("event: response.failed");
    }
    if (stream && protocol === "messages") {
      expect(text).toContain('"stop_reason":"tool_use"');
      expect(text.match(/event: message_stop/g)).toHaveLength(1);
    }
    if (protocol === "chat/completions") expect(text).toContain('"finish_reason":"tool_calls"');
    if (!stream && protocol === "responses") {
      const parsed = JSON.parse(text);
      expect(JSON.parse(parsed.output[0].arguments)).toEqual(nextArgs);
    }
  });

  it.each([
    "当前验证结果已经通过，但合并发货专项浏览器覆盖和 8 号服务器同步核验仍未完成，因此阶段工作还不能收尾。",
    "正在定位 8 号服务器的现有部署配置并执行部署，部署后会继续完成远端核验。",
  ])("reconsiders a subjectless or explicit incomplete Chinese terminal: %s", async (candidate) => {
    const invocations = install([candidate, { name: "exec_command", args: nextArgs }]);
    const response = await post("responses", body("responses", false));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(invocations).toHaveLength(2);
    expect(invocations[1].conversationId).toBe(invocations[0].conversationId);
    expect(text).toContain("exec_command");
    expect(text).toContain("git add");
    expect(text).not.toContain(candidate);
  });

  it.each([
    ["先停下，等我确认。", "已暂停，等待你的确认。"],
    ["只讨论流程，不执行命令。", "先检查改动，再选择暂存范围，最后核验提交。"],
    ["解释下面的话。", 'The phrase "I will write the file" is only an example.'],
    ["还缺什么信息？", "需要你提供目标分支名称，才能确定提交范围。"],
    ["总结现有检查。", "检查显示 main.ts 有未提交修改。"],
  ])("keeps legitimate terminal answers single-pass: %s", async (request, answer) => {
    const calls = install([answer]);
    const response = await post("responses", { model: "gpt-5.6-sol", tools: [tool], input: responsesInput(request) });
    expect(response.status).toBe(200);
    const result = await response.json<{ output: Array<{ content: Array<{ text: string }> }> }>();
    expect(result.output[0].content[0].text).toBe(answer);
    expect(calls).toHaveLength(1);
  });

  it("allows the same model to resolve a false-positive promise as a pause, not a forced call", async () => {
    const calls = install(["I will run the tests after you approve.", "已暂停，等待你确认后再执行。"]);
    const response = await post("responses", { model: "gpt-5.6-sol", tools: [tool], input: responsesInput("先暂停，不要运行测试。") });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("已暂停");
    expect(text).not.toContain('"type":"function_call"');
    expect(calls).toHaveLength(2);
    expect(calls[1].toolChoice).toEqual(calls[0].toolChoice);
  });

  it.each(["none", "no-tools"])("does not invent tool authority: %s", async (choice) => {
    const calls = install([promise]);
    const response = await post("responses", { model: "gpt-5.6-sol", input: [{ role: "user", content: "只讨论方案" }],
      ...(choice === "none" ? { tools: [tool], tool_choice: "none" } : {}),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('"type":"function_call"');
    expect(calls).toHaveLength(1);
  });

  it.each([false, true])("recovers a repeated same-conversation promise through the isolated native router (stream=%s)", async (stream) => {
    const calls = install([promise, promise, { name: "exec_command", args: nextArgs }]);
    const response = await post("responses", body("responses", stream));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(text).toContain("exec_command");
    expect(text).toContain("git add");
    expect(text).not.toContain(promise);
    expect(text).not.toContain("continuation_decision_invalid");
    if (stream) {
      expect(text.match(/event: response.completed/g)).toHaveLength(1);
      expect(text).not.toContain("event: response.failed");
    }
  }, 15_000);

  it("keeps the account active when a malformed review envelope is repaired by the isolated router", async () => {
    const calls = install([
      promise,
      { name: "not_declared", args: { cmd: "unsafe" } },
      { name: "exec_command", args: nextArgs },
    ]);
    const response = await post("responses", body("responses", false));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(text).toContain("exec_command");
    expect(text).toContain("git add");
    expect(text).not.toContain("continuation_decision_invalid");
  }, 15_000);

  it.each([false, true])("bounds persistent invalid continuation decisions without claiming success (stream=%s)", async (stream) => {
    const calls = install([promise]);
    const response = await post("responses", body("responses", stream));
    const text = await response.text();
    expect(calls).toHaveLength(4);
    expect(text).toContain("continuation_decision_invalid");
    expect(text).not.toContain(promise);
    expect(text).not.toContain("event: response.completed");
    if (stream) {
      expect(text.match(/event: response.failed/g)).toHaveLength(1);
      expect(text).toContain("data: [DONE]");
    } else expect(response.status).toBe(502);
  }, 15_000);

  it("keeps the task and evidence after Responses compaction", async () => {
    const apiKey = await key();
    const calls = install([promise, { name: "exec_command", args: nextArgs }]);
    const compact = await post("responses/compact", { model: "gpt-5.6-sol", tools: [tool], input: responsesInput() }, apiKey);
    expect(compact.status).toBe(200);
    const capsule = await compact.json<{ output: unknown[] }>();
    const response = await post("responses", { model: "gpt-5.6-sol", tools: [tool], input: capsule.output }, apiKey);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].message.text).toContain("pc-desktop");
    expect(text).toContain("git add");
    expect(text).not.toContain(promise);
  });

  it("publishes a resumable tool call and accepts its real result without repeating the review", async () => {
    const apiKey = await key();
    const calls = install([promise, { name: "exec_command", args: nextArgs }, "暂存结果已收到，尚未提交。"]);
    const response = await post("responses", body("responses", false), apiKey);
    expect(response.status).toBe(200);
    const first = await response.json<{ id: string; output: Array<{ call_id: string }> }>();
    const followup = await post("responses", { model: "gpt-5.6-sol", previous_response_id: first.id, tools: [tool],
      input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "Exit code: 0\n暂存完成" },
        { role: "user", content: "先停下，只汇报刚才的结果。" }],
    }, apiKey);
    expect(followup.status).toBe(200);
    expect(await followup.text()).toContain("暂存结果已收到");
    expect(calls).toHaveLength(3);
    expect(calls[2].message.text).toContain("暂存完成");
  });

  it.each([
    { name: "not_declared", args: { cmd: "unsafe" } },
    { name: "exec_command", args: { cmd: 123 } },
    "已完成部署并通过测试。",
  ])("rejects invalid reviewed decisions without cascading into another repair loop: %j", async (decision) => {
    const calls = install([promise, decision]);
    const response = await post("responses", body("responses", false));
    expect(response.status).toBe(502);
    // A malformed tool envelope is a model-decision failure, not an account
    // transport failure. The isolated router gets two bounded repair attempts.
    expect(await response.text()).toContain("continuation_decision_invalid");
    expect(calls).toHaveLength(4);
  }, 15_000);

  it("leaves a valid native call single-pass and preserves command punctuation and Unicode", async () => {
    const args = { cmd: "$name='中文 路径'; Write-Output $name; Write-Output '[Math]::Min(1,2)'" };
    const calls = install([{ name: "exec_command", args }]);
    const response = await post("responses", body("responses", false));
    expect(response.status).toBe(200);
    const result = await response.json<{ output: Array<{ arguments: string }> }>();
    expect(JSON.parse(result.output[0].arguments)).toEqual(args);
    expect(calls).toHaveLength(1);
  });

  it("preserves Responses Lite Code Mode custom calls after review", async () => {
    const input = 'const r = await tools.exec_command({cmd: "Get-Location"}); text(r);';
    const calls = install(["I will inspect the workspace.", { name: "exec", args: { input } }]);
    const response = await post("responses", { model: "gpt-5.6-sol", input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{
        type: "custom", name: "exec", description: 'Run JavaScript. declare const tools: { exec_command(args: { cmd: string }): Promise<unknown>; };',
        format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
      }] }] },
      { role: "user", content: "Inspect my current workspace." },
    ] });
    expect(response.status).toBe(200);
    const result = await response.json<{ output: unknown[] }>();
    expect(result.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", input });
    expect(calls).toHaveLength(2);
    expect(calls[1].plugins).toEqual(calls[0].plugins);
  });

  it("releases a failed review so the same conversation is usable on the next request", async () => {
    const apiKey = await key();
    const conversation = `review-${crypto.randomUUID()}`;
    const calls = install([promise, promise, "检查显示 main.ts 仍有未提交修改。"]);
    const failed = await post("responses", { ...body("responses", false), conversation }, apiKey);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("continuation_decision_invalid");
    const next = await post("responses", { model: "gpt-5.6-sol", conversation, tools: [tool],
      input: responsesInput("不要执行，只报告已有结果。"),
    }, apiKey);
    expect(next.status).toBe(200);
    expect(await next.text()).toContain("仍有未提交修改");
    expect(calls).toHaveLength(5);
  }, 15_000);
});
