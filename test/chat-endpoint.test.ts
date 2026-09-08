import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientToolWireName } from "../src/chathub";
import { chatSessionKey } from "../src/openai";
import { toolCallFingerprint } from "../src/tool-ledger";
import type { OAuthTokenSet } from "../src/types";

const RS = "\u001e";
const GENERIC_NON_ANSWER = "Sorry, I wasn't able to respond to that. Is there something else I can help with?";
const ROUTER_MARKER = "APPLICATION_REQUEST_AND_EVIDENCE:";

interface ScriptedInvocation {
  prompt: string;
  socket: WebSocket;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionBody {
  choices: Array<{
    finish_reason: string;
    message: { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] };
  }>;
  m365_gateway?: { checkpoint?: boolean; checkpoint_code?: string };
}

function complete(socket: WebSocket, text: string): void {
  socket.send(`${JSON.stringify({ type: 2, item: { result: { message: text } } })}${RS}${JSON.stringify({ type: 3 })}${RS}`);
}

function completeToolCall(socket: WebSocket, name: string, argumentsObject: Record<string, unknown>): void {
  complete(socket, routerCall(name, argumentsObject));
}

function installChatHub(script: (invocation: ScriptedInvocation) => void): { prompts: string[] } {
  const prompts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input));
    if (url.hostname !== "substrate.office.com") throw new Error(`unexpected outbound fetch: ${url.origin}`);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    let handshaken = false;
    server.addEventListener("message", (event) => {
      if (!handshaken) {
        handshaken = true;
        server.send(`{}${RS}`);
        return;
      }
      const frame = String(event.data).split(RS).find((part) => part.trim());
      if (!frame) return;
      const payload = JSON.parse(frame) as { arguments?: Array<{ message?: { text?: string } }> };
      const prompt = String(payload.arguments?.[0]?.message?.text ?? "");
      prompts.push(prompt);
      script({ prompt, socket: server });
    });
    return new Response(null, { status: 101, webSocket: client });
  });
  return { prompts };
}

async function credential(): Promise<string> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const accountId = crypto.randomUUID();
  const token: OAuthTokenSet = {
    accessToken: "local-chat-test-token",
    refreshToken: "local-chat-test-refresh",
    expiresAt: Date.now() + 60 * 60_000,
    email: `${accountId}@example.test`,
    displayName: "Chat endpoint test",
    oid: accountId,
    tid: crypto.randomUUID(),
  };
  await state.upsertAccount(token);
  return (await state.createAPIKey(`chat-${crypto.randomUUID()}`, 1)).key;
}

function chatFunctionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

function openCodeTools(): Array<Record<string, unknown>> {
  return [
    chatFunctionTool("invalid", "Report an invalid tool request", { tool: { type: "string" }, error: { type: "string" } }, ["tool", "error"]),
    chatFunctionTool("question", "Ask the user questions during execution", { questions: { type: "array", items: { type: "object" } } }, ["questions"]),
    chatFunctionTool("bash", "Execute a shell command in the working directory", { command: { type: "string" }, timeout: { type: "number" }, workdir: { type: "string" }, description: { type: "string" } }, ["command"]),
    chatFunctionTool("read", "Read a file from the local filesystem", { filePath: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, ["filePath"]),
    chatFunctionTool("glob", "Find files in the local workspace by glob pattern", { pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
    chatFunctionTool("grep", "Search file contents in the local workspace", { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, ["pattern"]),
    chatFunctionTool("webfetch", "Fetch content from a URL", { url: { type: "string" }, format: { type: "string", enum: ["text", "markdown", "html"] }, timeout: { type: "number" } }, ["url", "format"]),
    chatFunctionTool("todowrite", "Manage the session todo list", { todos: { type: "array", items: { type: "object" } } }, ["todos"]),
    chatFunctionTool("skill", "Load a named skill", { name: { type: "string" } }, ["name"]),
    chatFunctionTool("apply_patch", "Apply a patch to files in the local workspace", { patchText: { type: "string" } }, ["patchText"]),
  ];
}

function routerCall(name: string, argumentsObject: Record<string, unknown>): string {
  return JSON.stringify({ calls: [{ name: clientToolWireName(name), arguments: argumentsObject }] });
}

function onlyToolCall(body: ChatCompletionBody): ChatToolCall {
  expect(body.choices[0]?.finish_reason).toBe("tool_calls");
  expect(body.choices[0]?.message.tool_calls).toHaveLength(1);
  return body.choices[0].message.tool_calls![0];
}

async function postChat(
  apiKey: string,
  messages: Array<Record<string, unknown>>,
  sessionKey?: string,
  model = "gpt-5.6-sol",
): Promise<Response> {
  return SELF.fetch("https://example.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(sessionKey ? { "X-Session-Key": sessionKey } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      tools: openCodeTools(),
      tool_choice: "auto",
      parallel_tool_calls: false,
    }),
  });
}

async function postChatBody(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://example.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function stableChatSession(apiKey: string, sessionKey: string) {
  const request = new Request("https://example.com/v1/chat/completions", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Session-Key": sessionKey,
    },
  });
  return env.CHATS.getByName(await chatSessionKey(request, {}));
}

afterEach(() => vi.restoreAllMocks());

describe("Chat Completions endpoint tool continuation regressions", () => {
  it("keeps production direct-native mode compatible with ordinary answers and strict tool calls", async () => {
    const mutableEnv = env as typeof env & { DIRECT_NATIVE_TOOL_MODE?: string };
    const previousMode = mutableEnv.DIRECT_NATIVE_TOOL_MODE;
    mutableEnv.DIRECT_NATIVE_TOOL_MODE = "true";
    try {
      const answerKey = await credential();
      const answerMarker = `DIRECT_ANSWER_${crypto.randomUUID().replaceAll("-", "")}`;
      installChatHub(({ socket }) => complete(socket, `The verified answer is ${answerMarker}.`));

      const answerResponse = await postChat(answerKey, [{ role: "user", content: "Give a concise answer." }]);
      expect(answerResponse.status).toBe(200);
      const answerBody = await answerResponse.json<ChatCompletionBody>();
      expect(answerBody.choices[0]?.finish_reason).toBe("stop");
      expect(answerBody.choices[0]?.message.content).toContain(answerMarker);

      vi.restoreAllMocks();
      const toolKey = await credential();
      const command = "Get-Location";
      installChatHub(({ socket }) => completeToolCall(socket, "bash", { command }));

      const toolResponse = await postChat(toolKey, [{ role: "user", content: "Run the local location check." }]);
      expect(toolResponse.status).toBe(200);
      const toolBody = await toolResponse.json<ChatCompletionBody>();
      const call = onlyToolCall(toolBody);
      expect(call.function.name).toBe("bash");
      expect(JSON.parse(call.function.arguments)).toEqual({ command });

      vi.restoreAllMocks();
      const patchKey = await credential();
      const patchText = "*** Begin Patch\n*** Add File: index.html\n+<h1>Probe</h1>\n*** End Patch";
      installChatHub(({ socket }) => completeToolCall(socket, "apply_patch", { patchText }));

      const patchResponse = await postChat(patchKey, [{ role: "user", content: "Create index.html in the caller workspace." }]);
      expect(patchResponse.status).toBe(200);
      const patchBody = await patchResponse.json<ChatCompletionBody>();
      const patchCall = onlyToolCall(patchBody);
      expect(patchCall.function.name).toBe("apply_patch");
      expect(JSON.parse(patchCall.function.arguments)).toEqual({ patchText });
    } finally {
      mutableEnv.DIRECT_NATIVE_TOOL_MODE = previousMode;
    }
  }, 20_000);

  it("keeps malformed tool-shaped output blocked in production direct-native mode", async () => {
    const mutableEnv = env as typeof env & { DIRECT_NATIVE_TOOL_MODE?: string };
    const previousMode = mutableEnv.DIRECT_NATIVE_TOOL_MODE;
    mutableEnv.DIRECT_NATIVE_TOOL_MODE = "true";
    try {
      const apiKey = await credential();
      installChatHub(({ socket }) => complete(socket, JSON.stringify({
        decision: "tool_call",
        name: clientToolWireName("bash"),
        arguments: "not-an-object",
      })));

      const response = await postChat(apiKey, [{ role: "user", content: "Run a local check." }]);
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "tool_decision_invalid" },
      });
    } finally {
      mutableEnv.DIRECT_NATIVE_TOOL_MODE = previousMode;
    }
  }, 15_000);

  it("semantically routes an OpenCode action when the primary answer only describes a plan", async () => {
    const mutableEnv = env as typeof env & { DIRECT_NATIVE_TOOL_MODE?: string };
    const previousMode = mutableEnv.DIRECT_NATIVE_TOOL_MODE;
    mutableEnv.DIRECT_NATIVE_TOOL_MODE = "true";
    try {
      const apiKey = await credential();
      const command = "npm run check";
      const planOnly = "Apple 化重构计划包括首页、导航、卡片、后台、样式清理和构建验证。这些阶段按顺序推进。";
      const { prompts } = installChatHub(({ prompt, socket }) => {
        complete(socket, prompt.includes(ROUTER_MARKER)
          ? routerCall("bash", { command })
          : planOnly);
      });

      const response = await postChat(apiKey, [{
        role: "user",
        content: "一次性完成已经讨论好的全部重构工作，并在结束前验证结果。",
      }]);
      expect(response.status).toBe(200);
      const body = await response.json<ChatCompletionBody>();
      const call = onlyToolCall(body);
      expect(call.function.name).toBe("bash");
      expect(JSON.parse(call.function.arguments)).toEqual({ command });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("INITIAL CALLER-LOCAL TASK AUDIT");
      expect(prompts[1]).toContain("一次性完成已经讨论好的全部重构工作");
    } finally {
      mutableEnv.DIRECT_NATIVE_TOOL_MODE = previousMode;
    }
  }, 20_000);

  it("repairs one malformed direct-native decision without restarting an OpenCode task", async () => {
    const mutableEnv = env as typeof env & { DIRECT_NATIVE_TOOL_MODE?: string };
    const previousMode = mutableEnv.DIRECT_NATIVE_TOOL_MODE;
    mutableEnv.DIRECT_NATIVE_TOOL_MODE = "true";
    try {
      const apiKey = await credential();
      let invocation = 0;
      const { prompts } = installChatHub(({ socket }) => {
        invocation += 1;
        if (invocation === 1) {
          complete(socket, JSON.stringify({
            decision: "tool_call",
            name: clientToolWireName("read"),
            arguments: "not-an-object",
          }));
          return;
        }
        complete(socket, routerCall("read", { filePath: "C:\\work\\README.md", offset: 1, limit: 40 }));
      });

      const response = await postChat(apiKey, [{ role: "user", content: "Inspect the local README and continue the task." }]);
      expect(response.status).toBe(200);
      const body = await response.json<ChatCompletionBody>();
      const call = onlyToolCall(body);
      expect(call.function.name).toBe("read");
      expect(JSON.parse(call.function.arguments)).toEqual({ filePath: "C:\\work\\README.md", offset: 1, limit: 40 });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(ROUTER_MARKER);
    } finally {
      mutableEnv.DIRECT_NATIVE_TOOL_MODE = previousMode;
    }
  }, 20_000);

  it("does not expose a nominal-success provider capacity placeholder as a completed answer", async () => {
    const apiKey = await credential();
    installChatHub(({ socket }) => complete(socket, "We're temporarily unable to respond to this volume of requests. Please try again later."));
    const response = await postChatBody(apiKey, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Return a short status." }],
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "upstream_rate_limit",
      },
    });
  });

  it("does not spend a hidden router exchange on a safe answer-only request", async () => {
    const apiKey = await credential();
    let requested = 0;
    let routed = 0;
    const answer = `SAFE_ANSWER_${crypto.randomUUID().replaceAll("-", "")}`;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) {
        routed += 1;
        complete(socket, "NO_TOOL_REQUIRED");
      } else {
        requested += 1;
        complete(socket, `The answer is ${answer}.`);
      }
    });

    const response = await postChat(apiKey, [{ role: "user", content: "What is the purpose of a Durable Object?" }]);

    expect(response.status).toBe(200);
    const body = await response.json<ChatCompletionBody>();
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.message.content).toContain(answer);
    expect(body.m365_gateway).toBeUndefined();
    expect(requested).toBe(1);
    expect(routed).toBe(0);
  }, 15_000);

  it("turns a natural-language caller command into a tool call after an availability refusal", async () => {
    const apiKey = await credential();
    const command = "ssh root@example.invalid \"docker ps; systemctl --failed --no-pager\"";
    let routed = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) {
        routed += 1;
        complete(socket, routerCall("bash", { command }));
      } else {
        complete(socket, "Sorry, it looks like I can't chat about this. Let's try a different topic.");
      }
    });

    const response = await postChat(apiKey, [{
      role: "user",
      // Deliberately avoid the historical action/path keywords. The meaning
      // of this sentence is still an instruction to use the caller tool.
      content: "别再让我点窗口，给我把那台机器接上。",
    }]);

    expect(response.status).toBe(200);
    const body = await response.json<ChatCompletionBody>();
    const call = onlyToolCall(body);
    expect(call.function.name).toBe("bash");
    expect(JSON.parse(call.function.arguments)).toEqual({ command });
    expect(routed).toBe(1);
  }, 15_000);

  it("repairs a caller-local availability refusal in production direct-native mode", async () => {
    const mutableEnv = env as typeof env & { DIRECT_NATIVE_TOOL_MODE?: string };
    const previousMode = mutableEnv.DIRECT_NATIVE_TOOL_MODE;
    mutableEnv.DIRECT_NATIVE_TOOL_MODE = "true";
    try {
      const apiKey = await credential();
      const command = "ssh root@example.invalid \"pwd; hostname\"";
      let requested = 0;
      let routed = 0;
      installChatHub(({ prompt, socket }) => {
        if (prompt.includes(ROUTER_MARKER)) {
          routed += 1;
          complete(socket, routerCall("bash", { command }));
        } else {
          requested += 1;
          complete(socket, "我无法读取或操作弹出的远程登录窗口，因此不能替你选择服务器。");
        }
      });

      const response = await postChat(apiKey, [{
        role: "user",
        content: "别再让我点窗口，给我把那台机器接上。",
      }]);

      expect(response.status).toBe(200);
      const body = await response.json<ChatCompletionBody>();
      const call = onlyToolCall(body);
      expect(call.function.name).toBe("bash");
      expect(JSON.parse(call.function.arguments)).toEqual({ command });
      expect(requested).toBe(1);
      expect(routed).toBe(1);
    } finally {
      mutableEnv.DIRECT_NATIVE_TOOL_MODE = previousMode;
    }
  }, 15_000);

  it("keeps a real OpenCode full-history task and narrows one premature no-tool decision from glob to read", async () => {
    const apiKey = await credential();
    const task = `OPENCODE_FULL_HISTORY_${crypto.randomUUID().replaceAll("-", "")}: first list files, then read package.json, then give a concise analysis.`;
    const readMarker = `OPENCODE_READ_RESULT_${crypto.randomUUID().replaceAll("-", "")}`;
    const requestedPrompts: string[] = [];
    const routerPrompts: string[] = [];
    const routerReplies = [
      routerCall("glob", { pattern: "**/*" }),
      "NO_TOOL_REQUIRED",
      routerCall("read", { filePath: "package.json" }),
    ];
    let routerIndex = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) {
        routerPrompts.push(prompt);
        complete(socket, routerReplies[routerIndex++] ?? "NO_TOOL_REQUIRED");
      } else {
        requestedPrompts.push(prompt);
        complete(socket, requestedPrompts.length < 3
          ? GENERIC_NON_ANSWER
          : `package.json contains the expected marker ${readMarker}.`);
      }
    });

    const firstResponse = await postChat(apiKey, [{ role: "user", content: task }]);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<ChatCompletionBody>();
    const glob = onlyToolCall(first);
    expect(glob.function.name).toBe("glob");

    // OpenCode 1.18.18 sends the complete Chat history and no stable session
    // identifier on every tool-result request.
    const secondResponse = await postChat(apiKey, [
      { role: "user", content: task },
      first.choices[0].message,
      { role: "tool", tool_call_id: glob.id, content: "package.json\nsrc/openai.ts\ntest/core.test.ts" },
    ]);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<ChatCompletionBody>();
    const read = onlyToolCall(second);
    expect(read.function.name).toBe("read");
    expect(JSON.parse(read.function.arguments)).toEqual({ filePath: "package.json" });
    expect(second.m365_gateway).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain(GENERIC_NON_ANSWER);

    // The third OpenCode request returns the full history again, now including
    // the read result. This is a terminal answer boundary: the gateway must
    // return the requested-model answer rather than an internal checkpoint.
    const thirdResponse = await postChat(apiKey, [
      { role: "user", content: task },
      first.choices[0].message,
      { role: "tool", tool_call_id: glob.id, content: "package.json\nsrc/openai.ts\ntest/core.test.ts" },
      second.choices[0].message,
      { role: "tool", tool_call_id: read.id, content: JSON.stringify({ name: "compat", marker: readMarker }) },
    ]);
    expect(thirdResponse.status).toBe(200);
    const third = await thirdResponse.json<ChatCompletionBody>();
    expect(third.choices[0]?.finish_reason).toBe("stop");
    expect(third.choices[0]?.message.tool_calls).toBeUndefined();
    expect(third.choices[0]?.message.content).toContain(readMarker);
    expect(third.m365_gateway).toBeUndefined();

    expect(requestedPrompts).toHaveLength(3);
    expect(requestedPrompts[1].match(new RegExp(task, "g"))).toHaveLength(1);
    expect(routerPrompts).toHaveLength(4);
    expect(routerPrompts[1]).not.toContain("NAMED REPAIR:");
    expect(routerPrompts[2]).not.toContain("NAMED REPAIR:");
    expect(routerPrompts[2]).toContain("AVAILABLE_WIRE_TOOL_NAMES");
    expect(routerPrompts[3]).toContain(readMarker);
    expect(routerPrompts[3]).toContain("SEMANTIC TASK CONTINUATION AUDIT:");
  }, 15_000);

  it("keeps a usable OpenCode read answer when the hidden semantic audit is unavailable", async () => {
    const apiKey = await credential();
    const marker = `OPENCODE_ROUTER_FAILURE_${crypto.randomUUID().replaceAll("-", "")}`;
    const call: ChatToolCall = {
      id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ filePath: "package.json" }) },
    };
    const upstream = installChatHub(({ prompt, socket }) => {
      complete(socket, prompt.includes(ROUTER_MARKER)
        ? "not a schema-valid routing decision"
        : `package.json contains the expected marker ${marker}.`);
    });

    const response = await postChat(apiKey, [
      { role: "user", content: "Read package.json and report its marker." },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: JSON.stringify({ marker }) },
    ]);

    expect(response.status).toBe(200);
    const body = await response.json<ChatCompletionBody>();
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.message.content).toContain(marker);
    expect(body.choices[0]?.message.tool_calls).toBeUndefined();
    expect(body.m365_gateway).toBeUndefined();
    expect(upstream.prompts.filter((prompt) => prompt.includes(ROUTER_MARKER))).toHaveLength(2);
  }, 15_000);

  it("keeps a usable OpenCode read answer when both hidden router exchanges disconnect", async () => {
    const apiKey = await credential();
    const marker = `OPENCODE_ROUTER_DISCONNECT_${crypto.randomUUID().replaceAll("-", "")}`;
    const call: ChatToolCall = {
      id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ filePath: "package.json" }) },
    };
    let routerDisconnects = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) {
        routerDisconnects += 1;
        socket.close(1011, "simulated router disconnect");
        return;
      }
      complete(socket, `package.json contains the expected marker ${marker}.`);
    });

    const response = await postChat(apiKey, [
      { role: "user", content: "Read package.json and report its marker." },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: JSON.stringify({ marker }) },
    ]);

    expect(response.status).toBe(200);
    const body = await response.json<ChatCompletionBody>();
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.message.content).toContain(marker);
    expect(body.choices[0]?.message.tool_calls).toBeUndefined();
    expect(body.m365_gateway).toBeUndefined();
    expect(routerDisconnects).toBe(2);
  }, 20_000);

  it("keeps a Claude Sonnet incremental tool result tied to the original task", async () => {
    const apiKey = await credential();
    const sessionKey = `claude-incremental-${crypto.randomUUID()}`;
    const marker = `CLAUDE_SONNET_READ_${crypto.randomUUID().replaceAll("-", "")}`;
    const task = "Read package.json from the caller workspace and report its marker.";
    let requested = 0;
    let audits = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) {
        audits += 1;
        complete(socket, "NO_TOOL_REQUIRED");
        return;
      }
      requested += 1;
      if (requested === 1) {
        complete(socket, routerCall("read", { filePath: "package.json" }));
      } else {
        complete(socket, `package.json marker is ${marker}.`);
      }
    });

    const firstResponse = await postChat(apiKey, [{ role: "user", content: task }], sessionKey, "claude-sonnet");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<ChatCompletionBody>();
    const call = onlyToolCall(first);
    expect(call.function.name).toBe("read");

    // Incremental clients may send only the assistant call and its result on a
    // stable session key. The gateway must recover the causal user task rather
    // than return a checkpoint or leak the internal routing sentence.
    const secondResponse = await postChat(apiKey, [
      first.choices[0].message,
      { role: "tool", tool_call_id: call.id, content: JSON.stringify({ marker }) },
    ], sessionKey, "claude-sonnet");
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<ChatCompletionBody>();
    expect(second.choices[0]?.finish_reason).toBe("stop");
    expect(second.choices[0]?.message.content).toContain(marker);
    expect(second.choices[0]?.message.tool_calls).toBeUndefined();
    expect(second.m365_gateway).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain("current task and latest tool result are preserved");
    expect(audits).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("recovers a Claude Sonnet no-tool sentinel when the second request omits tools", async () => {
    const apiKey = await credential();
    const sessionKey = `claude-no-tools-${crypto.randomUUID()}`;
    const marker = `CLAUDE_SONNET_NO_TOOLS_${crypto.randomUUID().replaceAll("-", "")}`;
    const tool = chatFunctionTool(
      "lookup_gateway_value",
      "Return one deterministic value",
      { key: { type: "string" } },
      ["key"],
    );
    let requestIndex = 0;
    let recoveryCount = 0;
    const prompts: string[] = [];
    installChatHub(({ prompt, socket }) => {
      // Capture the exact active-turn envelope while diagnosing the Claude
      // no-tools continuation; this remains bounded to the local test.
      // (The assertion below checks that the result is recoverable.)
      prompts.push(prompt);
      if (prompt.includes("ANSWER-ONLY TOOL RESULT RECOVERY")) {
        recoveryCount += 1;
        complete(socket, `The value returned by lookup_gateway_value is ${marker}.`);
        return;
      }
      requestIndex += 1;
      if (requestIndex === 1) complete(socket, routerCall("lookup_gateway_value", { key: marker }));
      else complete(socket, "The task and existing tool results are preserved. No new tool call was generated safely, so no arguments were guessed and no completed action was repeated; continuation will resume from the current progress.");
    });

    const firstResponse = await postChatBody(apiKey, {
      model: "claude-sonnet",
      session_key: sessionKey,
      messages: [{ role: "user", content: `Call lookup_gateway_value with key ${marker}. Do not answer directly.` }],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<ChatCompletionBody>();
    const call = onlyToolCall(first);

    // Match full-functional.mjs: the continuation carries only the call and
    // result on the stable key, with no repeated user message/tool manifest.
    const secondResponse = await postChatBody(apiKey, {
      model: "claude-sonnet",
      session_key: sessionKey,
      messages: [
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: JSON.stringify({ value: marker }) },
      ],
    });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<ChatCompletionBody>();
    // This assertion documents the production failure currently seen on CF2:
    // Claude's no-tool sentinel must not become a visible checkpoint sentence.
    expect(second.choices[0]?.message.content).toContain(marker);
    expect(second.choices[0]?.message.content).not.toContain("task and existing tool results are preserved");
    expect(second.m365_gateway).toBeUndefined();
    expect(recoveryCount).toBe(1);
  }, 20_000);

  it("keeps caller tools available after an active-account switch when a follow-up omits tools", async () => {
    const apiKey = await credential();
    const sessionKey = `account-switch-tools-${crypto.randomUUID()}`;
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const selected = await state.selectAccount();
    expect(selected).not.toBeNull();
    const successorId = crypto.randomUUID();
    await state.upsertAccount({
      accessToken: `account-switch-successor-${crypto.randomUUID()}`,
      refreshToken: "account-switch-successor-refresh",
      expiresAt: Date.now() + 60 * 60_000,
      email: `${successorId}@example.test`,
      displayName: "Account switch successor",
      oid: successorId,
      tid: crypto.randomUUID(),
    });
    let requested = 0;
    const upstream = installChatHub(({ socket }) => {
      requested += 1;
      completeToolCall(socket, "exec_command", { cmd: requested === 1 ? "Get-Content index.html" : "Get-Content style.css" });
    });

    const firstResponse = await postChatBody(apiKey, {
      model: "gpt-5.6-sol",
      session_key: sessionKey,
      messages: [{ role: "user", content: "Create the local animation and verify index.html." }],
      tools: [chatFunctionTool("exec_command", "Run a command in the caller's local runtime.", { cmd: { type: "string" } }, ["cmd"])],
      tool_choice: "auto",
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<ChatCompletionBody>();
    const firstCall = onlyToolCall(first);

    expect(await state.reportAccountFailure(selected!.accountId, "transient", selected!.routeEpoch)).toMatchObject({ available: false });
    expect((await state.selectAccount())?.accountId).not.toBe(selected!.accountId);

    const secondResponse = await postChatBody(apiKey, {
      model: "gpt-5.6-sol",
      session_key: sessionKey,
      messages: [
        { role: "assistant", content: null, tool_calls: [firstCall] },
        { role: "tool", tool_call_id: firstCall.id, content: "index.html created and verified" },
        { role: "user", content: "脚踏呢" },
      ],
      // Deliberately omit tools: this is the client behavior seen after a
      // route/account switch. The gateway must recover its fixed caller schema
      // from the durable tool evidence before routing the follow-up.
    });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<ChatCompletionBody>();
    expect(onlyToolCall(second).function.name).toBe("exec_command");
    expect(JSON.stringify(second)).toContain("style.css");
    expect(upstream.prompts.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("restores OpenCode's exact renamed local tools after an account switch", async () => {
    const apiKey = await credential();
    const sessionKey = `account-switch-opencode-tools-${crypto.randomUUID()}`;
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const selected = await state.selectAccount();
    expect(selected).not.toBeNull();
    const successorId = crypto.randomUUID();
    await state.upsertAccount({
      accessToken: `opencode-switch-successor-${crypto.randomUUID()}`,
      refreshToken: "opencode-switch-successor-refresh",
      expiresAt: Date.now() + 60 * 60_000,
      email: `${successorId}@example.test`,
      displayName: "OpenCode switch successor",
      oid: successorId,
      tid: crypto.randomUUID(),
    });
    let requested = 0;
    const upstream = installChatHub(({ socket }) => {
      requested += 1;
      completeToolCall(socket, requested === 1 ? "bash" : "read", requested === 1
        ? { command: "Get-ChildItem -Force", workdir: "C:\\work\\project" }
        : { filePath: "C:\\work\\project\\package.json" });
    });
    const tools = [
      chatFunctionTool("bash", "Execute a command in the caller local workspace.", {
        command: { type: "string" }, workdir: { type: "string" },
      }, ["command"]),
      chatFunctionTool("read", "Read a file from the caller local filesystem.", {
        filePath: { type: "string" },
      }, ["filePath"]),
    ];

    const firstResponse = await postChatBody(apiKey, {
      model: "gpt-5.6-sol",
      session_key: sessionKey,
      messages: [{ role: "user", content: "Inspect the local project and then read package.json." }],
      tools,
      tool_choice: "auto",
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<ChatCompletionBody>();
    const firstCall = onlyToolCall(first);
    expect(firstCall.function.name).toBe("bash");

    expect(await state.reportAccountFailure(selected!.accountId, "transient", selected!.routeEpoch)).toMatchObject({ available: false });
    expect((await state.selectAccount())?.accountId).not.toBe(selected!.accountId);

    const secondResponse = await postChatBody(apiKey, {
      model: "gpt-5.6-sol",
      session_key: sessionKey,
      messages: [
        { role: "assistant", content: null, tool_calls: [firstCall] },
        { role: "tool", tool_call_id: firstCall.id, content: "package.json\nsrc/openai.ts" },
        { role: "user", content: "继续" },
      ],
    });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<ChatCompletionBody>();
    expect(onlyToolCall(second).function.name).toBe("read");
    expect(JSON.stringify(second)).toContain("package.json");
  }, 20_000);

  it("keeps the checkpoint boundary for a failed OpenCode tool result when the audit is unavailable", async () => {
    const apiKey = await credential();
    const call: ChatToolCall = {
      id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "npm test" }) },
    };
    installChatHub(({ prompt, socket }) => {
      complete(socket, prompt.includes(ROUTER_MARKER)
        ? "not a schema-valid routing decision"
        : "The test command failed and still needs a materially different recovery action.");
    });

    const response = await postChat(apiKey, [
      { role: "user", content: "Run the local test suite and repair failures." },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "Process exited with code 1\nTests failed" },
    ]);

    expect(response.status).toBe(200);
    const body = await response.json<ChatCompletionBody>();
    expect(body.m365_gateway?.checkpoint).toBe(true);
    expect(body.m365_gateway?.checkpoint_code).toBe("invalid");
  }, 15_000);

  it("continues an elliptical OpenCode follow-up from the full prior tool history", async () => {
    const apiKey = await credential();
    const priorCallId = `call_${crypto.randomUUID().replaceAll("-", "")}`;
    const followUp = "聊天端呢？";
    const command = "ssh root@example.invalid \"docker ps; systemctl --failed --no-pager\"";
    const requestedPrompts: string[] = [];
    const routerPrompts: string[] = [];
    const routerReplies = [
      "NO_TOOL_REQUIRED",
      routerCall("bash", { command }),
    ];
    let routerIndex = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) {
        routerPrompts.push(prompt);
        complete(socket, routerReplies[routerIndex++] ?? "NO_TOOL_REQUIRED");
      } else {
        requestedPrompts.push(prompt);
        complete(socket, GENERIC_NON_ANSWER);
      }
    });

    const response = await postChat(apiKey, [
      { role: "user", content: "登录4号服务器，去看你部署的项目" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: priorCallId,
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: "ssh root@example.invalid pwd" }) },
        }],
      },
      { role: "tool", tool_call_id: priorCallId, content: "Web r102 is healthy; Chat and PostgreSQL were not inspected." },
      { role: "assistant", content: "Web 项目正在运行；聊天端、PostgreSQL 和公网接口尚未逐项复核。" },
      { role: "user", content: followUp },
    ]);

    expect(response.status).toBe(200);
    const body = await response.json<ChatCompletionBody>();
    const call = onlyToolCall(body);
    expect(call.function.name).toBe("bash");
    expect(JSON.parse(call.function.arguments)).toEqual({ command });
    expect(body.m365_gateway).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(GENERIC_NON_ANSWER);
    expect(JSON.stringify(body)).not.toContain("当前任务和已有工具结果都已保留");
    expect(requestedPrompts).toHaveLength(1);
    expect(requestedPrompts[0]).toContain(followUp);
    expect(requestedPrompts[0]).toContain("尚未逐项复核");
    expect(routerPrompts).toHaveLength(2);
    expect(routerPrompts[1]).not.toContain("NAMED REPAIR:");
    expect(routerPrompts[1]).toContain("AVAILABLE_TOOL_SCHEMAS");
  }, 15_000);

  it("restores one stable-key incremental checkpoint without duplicating the original task", async () => {
    const apiKey = await credential();
    const sessionKey = `chat-checkpoint-${crypto.randomUUID()}`;
    const task = `STABLE_INCREMENTAL_${crypto.randomUUID().replaceAll("-", "")}: list files and then read package.json.`;
    const requestedPrompts: string[] = [];
    const routerReplies = [
      routerCall("glob", { pattern: "**/*" }),
      routerCall("read", { filePath: "package.json" }),
    ];
    let routerIndex = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) complete(socket, routerReplies[routerIndex++] ?? "NO_TOOL_REQUIRED");
      else {
        requestedPrompts.push(prompt);
        complete(socket, GENERIC_NON_ANSWER);
      }
    });

    const firstResponse = await postChat(apiKey, [{ role: "user", content: task }], sessionKey);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<ChatCompletionBody>();
    const glob = onlyToolCall(first);

    const secondResponse = await postChat(apiKey, [
      first.choices[0].message,
      { role: "tool", tool_call_id: glob.id, content: "package.json\nsrc/openai.ts" },
    ], sessionKey);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<ChatCompletionBody>();
    expect(onlyToolCall(second).function.name).toBe("read");
    expect(requestedPrompts).toHaveLength(2);
    expect(requestedPrompts[1]).toContain("PORTABLE HISTORY FROM THE SAME API-CREDENTIAL SESSION");
    expect(requestedPrompts[1].match(new RegExp(task, "g"))).toHaveLength(1);
    expect(requestedPrompts[1]).toContain("package.json");
  }, 15_000);

  it("loads stable-key snapshots so a third identical completed proposal is narrowed to read", async () => {
    const apiKey = await credential();
    const sessionKey = `chat-ledger-${crypto.randomUUID()}`;
    const task = `STABLE_LEDGER_${crypto.randomUUID().replaceAll("-", "")}: inspect the repository and read package.json.`;
    const routerPrompts: string[] = [];
    const routerReplies = [
      routerCall("glob", { pattern: "**/*" }),
      routerCall("glob", { pattern: "**/*" }),
      routerCall("glob", { pattern: "**/*" }),
      routerCall("read", { filePath: "package.json" }),
    ];
    let routerIndex = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes(ROUTER_MARKER)) {
        routerPrompts.push(prompt);
        complete(socket, routerReplies[routerIndex++] ?? "NO_TOOL_REQUIRED");
      } else {
        complete(socket, GENERIC_NON_ANSWER);
      }
    });

    const firstResponse = await postChat(apiKey, [{ role: "user", content: task }], sessionKey);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<ChatCompletionBody>();
    const firstGlob = onlyToolCall(first);

    const secondResponse = await postChat(apiKey, [
      first.choices[0].message,
      { role: "tool", tool_call_id: firstGlob.id, content: "package.json" },
    ], sessionKey);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<ChatCompletionBody>();
    const verificationGlob = onlyToolCall(second);
    expect(verificationGlob.function.name).toBe("glob");
    expect(verificationGlob.function.arguments).toBe(firstGlob.function.arguments);

    const persistedSession = await stableChatSession(apiKey, sessionKey);
    const persisted = await persistedSession.acquire();
    expect(persisted).toMatchObject({ started: false, accountLocked: true });
    expect(persisted.portableProtocolTail).toContain(task);
    const persistedSnapshots = JSON.parse(persisted.toolLedgerSnapshot);
    expect(persistedSnapshots).toEqual([
      expect.objectContaining({ name: "glob", completedCount: 1, trailingConsecutiveCount: 1 }),
    ]);
    expect(persistedSnapshots[0].fingerprint).toBe(
      await toolCallFingerprint("glob", verificationGlob.function.arguments),
    );
    await persistedSession.release(persisted.leaseId);

    const thirdMessages = [
      second.choices[0].message,
      { role: "tool", tool_call_id: verificationGlob.id, content: "package.json" },
    ];
    const thirdResponse = await postChat(apiKey, thirdMessages, sessionKey);
    expect(thirdResponse.status).toBe(200);
    const third = await thirdResponse.json<ChatCompletionBody>();
    expect(routerPrompts).toHaveLength(4);
    expect(onlyToolCall(third).function.name).toBe("read");
    const recoveryPrompt = routerPrompts.find((prompt) => prompt.includes("RECOVERY CONSTRAINT:"));
    expect(recoveryPrompt).toBeDefined();
    expect(recoveryPrompt).not.toContain("NAMED REPAIR:");
    expect(recoveryPrompt).toContain("AVAILABLE_TOOL_SCHEMAS");
  }, 15_000);
});
