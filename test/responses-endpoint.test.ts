import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientToolWireName } from "../src/chathub";
import { responsesSessionKey } from "../src/openai";
import { decryptJSON } from "../src/crypto";
import type { OAuthTokenSet } from "../src/types";

const RS = "\u001e";
const fixtureAccountIds = new Set<string>();
const fixtureAPIKeyIds = new Set<string>();

interface ScriptedInvocation {
  index: number;
  prompt: string;
  url: URL;
  socket: WebSocket;
  plugins: Array<Record<string, unknown>>;
  toolChoice: unknown;
  attachments: unknown[];
  imageUrl: unknown;
  queryAnnotations: unknown;
  messageAnnotations: unknown;
}

interface TestCredential {
  apiKey: string;
  accountId: string;
}

function complete(socket: WebSocket, text: string): void {
  socket.send(`${JSON.stringify({ type: 2, item: { result: { message: text } } })}${RS}${JSON.stringify({ type: 3 })}${RS}`);
}

function streamThenComplete(socket: WebSocket, text: string): void {
  socket.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ writeAtCursor: text }] })}${RS}`);
  complete(socket, text);
}

function completeToolCall(socket: WebSocket, name: string, args: Record<string, unknown>): void {
  socket.send(`${JSON.stringify({
    type: 2,
    item: {
      contentType: "ToolCall",
      functionName: clientToolWireName(name),
      functionArguments: args,
    },
  })}${RS}${JSON.stringify({ type: 3 })}${RS}`);
}

function routerCall(name: string, argumentsObject: Record<string, unknown>): string {
  return JSON.stringify({ calls: [{ name: clientToolWireName(name), arguments: argumentsObject }] });
}

function installChatHub(
  script: (invocation: ScriptedInvocation) => void,
): { prompts: string[]; urls: URL[]; invocations: ScriptedInvocation[]; uploads: Array<{ conversationId: string; image: string }> } {
  const prompts: string[] = [];
  const urls: URL[] = [];
  const invocations: ScriptedInvocation[] = [];
  const uploads: Array<{ conversationId: string; image: string }> = [];
  let index = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input));
    if (url.hostname !== "substrate.office.com") throw new Error(`unexpected outbound fetch: ${url.origin}`);
    if (url.pathname === "/m365Copilot/UploadFile") {
      const form = await new Response(init?.body, { headers: init?.headers }).formData();
      const conversationId = String(form.get("conversationId"));
      uploads.push({ conversationId, image: String(form.get("FileBase64")) });
      return Response.json({ conversationId, docId: "test-image", result: { value: "Success" } });
    }
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
      const payload = JSON.parse(frame) as { arguments?: Array<{ message?: { text?: string; attachments?: unknown[]; imageUrl?: unknown; queryAnnotations?: unknown; messageAnnotations?: unknown }; queryAnnotations?: unknown; plugins?: unknown; toolChoice?: unknown }> };
      const invocation = payload.arguments?.[0];
      const prompt = String(invocation?.message?.text ?? "");
      prompts.push(prompt);
      urls.push(url);
      const record: ScriptedInvocation = {
        index: index++,
        prompt,
        url,
        socket: server,
        plugins: Array.isArray(invocation?.plugins) ? invocation.plugins as Array<Record<string, unknown>> : [],
        toolChoice: invocation?.toolChoice,
        attachments: invocation?.message?.attachments ?? [],
        imageUrl: invocation?.message?.imageUrl,
        queryAnnotations: invocation?.queryAnnotations,
        messageAnnotations: invocation?.message?.messageAnnotations,
      };
      invocations.push(record);
      script(record);
    });
    return new Response(null, { status: 101, webSocket: client });
  });
  return { prompts, urls, invocations, uploads };
}

async function credential(): Promise<TestCredential> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const accountId = crypto.randomUUID();
  const token: OAuthTokenSet = {
    accessToken: "local-test-token",
    refreshToken: "local-test-refresh",
    expiresAt: Date.now() + 60 * 60_000,
    email: `${accountId}@example.test`,
    displayName: "Responses endpoint test",
    oid: accountId,
    tid: crypto.randomUUID(),
  };
  await state.upsertAccount(token);
  fixtureAccountIds.add(accountId);
  const created = await state.createAPIKey(`responses-${crypto.randomUUID()}`, 1);
  fixtureAPIKeyIds.add(created.record.id);
  return { apiKey: created.key, accountId };
}

async function addSuccessorAccount(): Promise<{ accountId: string; accessToken: string }> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const accountId = crypto.randomUUID();
  const accessToken = `route-successor-${crypto.randomUUID()}`;
  await state.upsertAccount({
    accessToken,
    refreshToken: "route-successor-refresh",
    expiresAt: Date.now() + 60 * 60_000,
    email: `${accountId}@example.test`,
    displayName: "Responses route successor",
    oid: accountId,
    tid: crypto.randomUUID(),
  });
  fixtureAccountIds.add(accountId);
  return { accountId, accessToken };
}

function requestHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function responseSession(apiKey: string, previousResponseId: string) {
  const request = new Request("https://example.com/v1/responses", {
    headers: requestHeaders(apiKey),
  });
  const key = await responsesSessionKey(request, { previous_response_id: previousResponseId } as never);
  return env.CHATS.getByName(key);
}

async function postResponse(
  apiKey: string,
  body: Record<string, unknown>,
  model = "gpt-5.6-sol",
): Promise<Response> {
  return SELF.fetch("https://example.com/v1/responses", {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: JSON.stringify({ model, ...body }),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Each case owns its accounts. Do not consume the production account limit
  // or accidentally route later cases through credentials from earlier tests.
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  for (const id of fixtureAccountIds) await state.deleteAccount(id);
  for (const id of fixtureAPIKeyIds) await state.revokeAPIKey(id);
  fixtureAccountIds.clear();
  fixtureAPIKeyIds.clear();
});

describe("Responses endpoint regressions", () => {
  it.each([false, true])("keeps tool continuation intact with requested public summaries (stream=%s)", async (stream) => {
    const auth = await credential();
    const summary = "**公开摘要**\n正在核对请求的一个值。";
    const cmd = "Get-Content '中文目录/data.txt'; [Math]::Max(0, $a)";
    const tool = { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
    let calls = 0;
    installChatHub(({ socket, prompt }) => {
      if (prompt.includes("SEMANTIC TASK CONTINUATION AUDIT")) { complete(socket, "NO_TOOL_REQUIRED"); return; }
      calls += 1;
      if (calls === 1) {
        socket.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageType: "Progress", contentOrigin: "ChainOfThoughtSummary", text: summary }] }] })}${RS}`);
        completeToolCall(socket, "exec_command", { cmd });
      } else complete(socket, "The lookup returned fixture_value_17.");
    });
    const response = await postResponse(auth.apiKey, {
      input: "Read the requested local value and report it.", tools: [tool],
      reasoning: { effort: "high", summary: "auto" }, stream,
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    const events = stream ? wire.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))) : [];
    const first = stream ? events.find((event) => event.type === "response.completed")?.response : JSON.parse(wire);
    expect(first.output).toHaveLength(2);
    expect(first.output[0]).toMatchObject({ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) });
    expect(first.output[1]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: summary }] });
    if (stream) {
      expect(events.filter((event) => event.type === "response.reasoning_summary_text.done")).toMatchObject([{ output_index: 1, summary_index: 0, text: summary }]);
      expect(events.filter((event) => event.type === "response.function_call_arguments.done")[0].output_index).toBe(0);
      expect(events.at(-1).type).toBe("response.completed");
    }
    const next = await postResponse(auth.apiKey, {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "fixture_value_17" }],
    });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ output: [{ type: "message", content: [{ text: "The lookup returned fixture_value_17." }] }] });
  });

  it("delivers a verified public summary by default and honors an explicit none opt-out", async () => {
    const auth = await credential();
    installChatHub(({ socket }) => {
      socket.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageType: "Progress", contentOrigin: "ChainOfThoughtSummary", text: "A real optional public summary." }] }] })}${RS}`);
      complete(socket, "normal final answer");
    });
    const defaulted = await postResponse(auth.apiKey, { input: "hello", reasoning: { effort: "high" } });
    const delivered = await defaulted.json();
    expect(delivered).toMatchObject({ output: [{ type: "message", content: [{ text: "normal final answer" }] }, { type: "reasoning" }] });
    expect(delivered.output.at(-1).summary).toMatchObject([{ type: "summary_text", text: "A real optional public summary." }]);

    installChatHub(({ socket }) => {
      socket.send(`${JSON.stringify({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageType: "Progress", contentOrigin: "ChainOfThoughtSummary", text: "A real optional public summary." }] }] })}${RS}`);
      complete(socket, "normal final answer");
    });
    const optedOut = await postResponse(auth.apiKey, { input: "hello", reasoning: { effort: "high", summary: "none" } });
    expect(await optedOut.json()).toMatchObject({ output: [{ type: "message", content: [{ text: "normal final answer" }] }] });
  });

  it("preserves arbitrary top-level instructions and user input in the ChatHub prompt", async () => {
    const auth = await credential();
    const instruction = `开发约束-${crypto.randomUUID()}：根据当前任务自主选择工具，完成后核验结果；不要把这句话映射为固定命令。`;
    const userText = `用户原话-${crypto.randomUUID()}：检查现状，再完成仍未完成的工作。`;
    const upstream = installChatHub(({ socket }) => complete(socket, "instruction transport verified"));

    const response = await postResponse(auth.apiKey, {
      instructions: instruction,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      output: [{ content: [{ text: "instruction transport verified" }] }],
    });
    expect(upstream.prompts).toHaveLength(1);
    expect(upstream.prompts[0]).toContain(`[DEVELOPER]\n${instruction}`);
    expect(upstream.prompts[0]).toContain(`[USER]\n${userText}`);
  });

  it("rejects malformed top-level instructions instead of silently dropping them", async () => {
    const auth = await credential();
    const response = await postResponse(auth.apiKey, {
      instructions: { text: "not a valid Responses instructions value" },
      input: "hello",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "cloudflare_native_error", code: "invalid_request_error" },
    });
  });

  it.each([false, true])("forwards a >2 MiB inline image intact (chunked=%s)", async (chunked) => {
    const auth = await credential();
    const imageURL = `data:image/png;base64,${"AAAA".repeat(786_432)}`;
    const wire = JSON.stringify({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: [
        { type: "input_text", text: "Describe the supplied image." },
        { type: "input_image", image_url: imageURL },
      ] }],
    });
    const encoded = new TextEncoder().encode(wire);
    expect(encoded.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const hub = installChatHub(({ socket }) => complete(socket, "IMAGE_TRANSPORT_OK"));
    let offset = 0;
    const response = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { ...requestHeaders(auth.apiKey), ...(chunked ? {} : { "Content-Length": String(encoded.byteLength) }) },
      body: chunked ? new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= encoded.byteLength) { controller.close(); return; }
          controller.enqueue(encoded.subarray(offset, offset + 65_536));
          offset += 65_536;
        },
      }) : wire,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("IMAGE_TRANSPORT_OK");
    expect(hub.invocations).toHaveLength(1);
    expect(hub.invocations[0]?.attachments).toEqual([]);
    expect(hub.invocations[0]?.imageUrl).toBeUndefined();
    expect(hub.invocations[0]?.queryAnnotations).toBeUndefined();
    expect(hub.invocations[0]?.messageAnnotations).toMatchObject([{
      id: "test-image",
      messageAnnotationType: "ImageFile",
    }]);
    expect(hub.uploads).toEqual([{ conversationId: hub.urls[0]?.searchParams.get("ConversationId"), image: imageURL }]);
    expect(hub.urls[0]?.searchParams.get("XRoutingParameterSessionKey")).toBe(hub.urls[0]?.searchParams.get("chatsessionid"));
    expect(hub.prompts[0]).not.toContain(imageURL);
  });

  it.each([false, true])("uploads a stateless tool-produced image before chat (stream=%s)", async (stream) => {
    const auth = await credential();
    const imageURL = "data:image/png;base64,AAAA";
    const hub = installChatHub(({ socket }) => complete(socket, "TOOL_IMAGE_RECEIVED"));
    const response = await postResponse(auth.apiKey, {
      stream,
      input: [
        { role: "user", content: "Describe the image returned by the tool." },
        { type: "function_call", call_id: "call_image", name: "view_image", arguments: '{"path":"C:/image.png"}' },
        { type: "function_call_output", call_id: "call_image", output: [{ type: "input_image", image_url: imageURL, detail: "high" }] },
      ],
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain("TOOL_IMAGE_RECEIVED");
    expect(wire).not.toContain('"type":"response.failed"');
    if (stream) expect(wire).toContain('"type":"response.completed"');
    expect(hub.uploads).toEqual([{ conversationId: hub.urls[0]?.searchParams.get("ConversationId"), image: imageURL }]);
    expect(hub.prompts[0]).not.toContain(imageURL);
    expect(hub.invocations[0].attachments).toEqual([]);
    expect(hub.invocations[0].imageUrl).toBeUndefined();
    expect(hub.invocations[0].queryAnnotations).toBeUndefined();
    expect(hub.invocations[0].messageAnnotations).toMatchObject([{
      id: "test-image",
      messageAnnotationType: "ImageFile",
    }]);
    expect(hub.urls[0]?.searchParams.get("XRoutingParameterSessionKey")).toBe(hub.urls[0]?.searchParams.get("chatsessionid"));
  });

  it("answers from a fresh tool image instead of reissuing view_image with another detail level", async () => {
    const auth = await credential();
    const imageURL = "data:image/png;base64,AAAA";
    const imagePath = "C:/Users/exampleuser/Desktop/screen.png";
    const tool = {
      type: "function",
      name: "view_image",
      description: "View an image file from the caller's local filesystem",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, detail: { type: "string", enum: ["high", "original"] } },
        required: ["path"],
        additionalProperties: false,
      },
    };
    const hub = installChatHub(({ index, socket }) => index === 0
      ? completeToolCall(socket, "view_image", { path: imagePath, detail: "original" })
      : complete(socket, "I see a dark chat interface with an image-recognition failure message."));
    const response = await postResponse(auth.apiKey, {
      input: [
        { role: "user", content: `${imagePath}\n\nWhat do you see?` },
        { type: "function_call", call_id: "call_image_once", name: "view_image", arguments: JSON.stringify({ path: imagePath, detail: "high" }) },
        { type: "function_call_output", call_id: "call_image_once", output: [
          { type: "input_text", text: "Image loaded successfully." },
          { type: "input_image", image_url: imageURL, detail: "high" },
        ] },
      ],
      tools: [tool],
      tool_choice: "auto",
    });
    const body = await response.json<{ output: Array<{ type: string; content?: Array<{ text?: string }> }> }>();
    expect(response.status).toBe(200);
    expect(body.output.some((item) => item.type === "function_call")).toBe(false);
    expect(JSON.stringify(body.output)).toContain("dark chat interface");
    expect(hub.invocations.length).toBeGreaterThanOrEqual(2);
    expect(hub.invocations[1]?.plugins).toEqual([]);
    expect(hub.uploads).toEqual([{ conversationId: hub.urls[0]?.searchParams.get("ConversationId"), image: imageURL }]);
  });

  it("uploads an output-only image continuation using its pending call_id", async () => {
    const auth = await credential();
    const imageURL = "data:image/png;base64,AAAA";
    const hub = installChatHub(({ index, socket }) => index === 0
      ? completeToolCall(socket, "capture_workspace", {}) : complete(socket, "PENDING_IMAGE_RECEIVED"));
    const tool = { type: "function", name: "capture_workspace", parameters: { type: "object", properties: {}, additionalProperties: false } };
    const first = await postResponse(auth.apiKey, { input: "Capture and inspect the image.", tools: [tool], tool_choice: "required" });
    const call = await first.json<{ id: string; output: Array<{ call_id: string }> }>();
    const second = await postResponse(auth.apiKey, {
      previous_response_id: call.id,
      input: [{ type: "function_call_output", call_id: call.output[0].call_id, output: [
        { type: "input_text", text: "Capture succeeded." }, { type: "input_image", image_url: imageURL },
      ] }],
      tools: [tool],
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("PENDING_IMAGE_RECEIVED");
    expect(hub.uploads).toHaveLength(1);
    expect(hub.prompts.at(-1)).toContain("Capture succeeded.");
    expect(hub.prompts.at(-1)).not.toContain(imageURL);
    expect(hub.invocations.at(-1)?.imageUrl).toBeUndefined();
    expect(hub.invocations.at(-1)?.queryAnnotations).toBeUndefined();
    expect(hub.invocations.at(-1)?.messageAnnotations).toMatchObject([{
      id: "test-image",
      messageAnnotationType: "ImageFile",
    }]);
    expect(hub.urls.at(-1)?.searchParams.get("XRoutingParameterSessionKey")).toBe(hub.urls.at(-1)?.searchParams.get("chatsessionid"));
  });

  it("retains custom tool image output through the Responses custom-tool adapter", async () => {
    const auth = await credential();
    const imageURL = "data:image/png;base64,AAAA";
    const hub = installChatHub(({ socket }) => complete(socket, "CUSTOM_IMAGE_RECEIVED"));
    const response = await postResponse(auth.apiKey, {
      input: [
        { role: "user", content: "Describe the returned screenshot." },
        { type: "custom_tool_call", call_id: "call_custom_image", name: "exec", input: "image(await tools.view_image({path: 'C:/image.png'}));" },
        { type: "custom_tool_call_output", call_id: "call_custom_image", output: [{ type: "input_image", image_url: imageURL }] },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("CUSTOM_IMAGE_RECEIVED");
    expect(hub.uploads).toHaveLength(1);
    expect(hub.prompts[0]).not.toContain(imageURL);
    expect(hub.invocations[0]?.imageUrl).toBeUndefined();
    expect(hub.invocations[0]?.queryAnnotations).toBeUndefined();
    expect(hub.invocations[0]?.messageAnnotations).toMatchObject([{
      id: "test-image",
      messageAnnotationType: "ImageFile",
    }]);
    expect(hub.urls[0]?.searchParams.get("XRoutingParameterSessionKey")).toBe(hub.urls[0]?.searchParams.get("chatsessionid"));
  });

  it("compacts image tool history without uploading or retaining binary media", async () => {
    const auth = await credential();
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("compaction must be offline"));
    const imageURL = "data:image/png;base64,AAAA";
    const response = await SELF.fetch("https://example.com/v1/responses/compact", {
      method: "POST", headers: requestHeaders(auth.apiKey), body: JSON.stringify({
        model: "gpt-5.6-sol", input: [
          { role: "user", content: "Review the image then keep working on the task." },
          { type: "function_call", call_id: "call_compact_image", name: "view_image", arguments: '{"path":"C:/image.png"}' },
          { type: "function_call_output", call_id: "call_compact_image", output: [{ type: "input_image", image_url: imageURL }] },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ output: Array<{ type: string; encrypted_content?: string }> }>();
    const capsule = await decryptJSON<{ checkpoint: { toolLedgerSnapshot: string; portableProtocolTail: string } }>(
      body.output.find((item) => item.type === "compaction")!.encrypted_content!, env.DATA_ENCRYPTION_KEY,
    );
    expect(capsule.checkpoint.toolLedgerSnapshot).toContain("view_image");
    expect(capsule.checkpoint.portableProtocolTail).not.toContain(imageURL);
    expect(JSON.stringify(capsule)).not.toContain("data:image");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("restores the assistant task summary after compaction before a progress question", async () => {
    const auth = await credential();
    const shared = `compact-summary-${crypto.randomUUID()}`;
    const task = `COMPACT_TASK_${crypto.randomUUID().replaceAll("-", "")}`;
    const summary = `COMPACT_SUMMARY_${crypto.randomUUID().replaceAll("-", "")}: 首页和导航已经完成，后台重构与构建验证仍待执行。`;
    const followUp = "告诉我进度";
    const hub = installChatHub(({ index, socket }) => complete(
      socket,
      index === 0 ? "The task is in progress." : "The retained task summary is available.",
    ));

    const started = await postResponse(auth.apiKey, {
      prompt_cache_key: shared,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: task }] }],
    });
    expect(started.status).toBe(200);

    const compacted = await SELF.fetch("https://example.com/v1/responses/compact", {
      method: "POST",
      headers: requestHeaders(auth.apiKey),
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        prompt_cache_key: shared,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: task }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] },
        ],
      }),
    });
    expect(compacted.status).toBe(200);
    const compactBody = await compacted.json<{ output: Array<Record<string, unknown>> }>();

    const resumed = await postResponse(auth.apiKey, {
      prompt_cache_key: shared,
      input: [
        ...compactBody.output,
        { type: "message", role: "user", content: [{ type: "input_text", text: followUp }] },
      ],
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain("The retained task summary is available.");
    expect(hub.prompts).toHaveLength(2);
    expect(hub.prompts[1]).toContain("PORTABLE HISTORY FROM THE SAME API-CREDENTIAL SESSION");
    expect(hub.prompts[1]).toContain(summary);
    expect(hub.prompts[1]).toContain(followUp);
  }, 15_000);

  it("uses a shared compaction key and still accepts capsules issued with the legacy data key", async () => {
    const auth = await credential();
    installChatHub(({ socket }) => complete(socket, "COMPACTION_KEY_ROLLOUT_OK"));
    const mutableEnv = env as typeof env & { COMPACTION_ENCRYPTION_KEY?: string };
    const originalSharedKey = mutableEnv.COMPACTION_ENCRYPTION_KEY;
    const sharedKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const promptCacheKey = `compact-key-rollout-${crypto.randomUUID()}`;
    const compact = async (input: Array<Record<string, unknown>>) => {
      const response = await SELF.fetch("https://example.com/v1/responses/compact", {
        method: "POST",
        headers: requestHeaders(auth.apiKey),
        body: JSON.stringify({ model: "gpt-5.6-sol", prompt_cache_key: promptCacheKey, input }),
      });
      expect(response.status).toBe(200);
      return response.json<{ output: Array<{ type: string; encrypted_content?: string }> }>();
    };

    try {
      delete mutableEnv.COMPACTION_ENCRYPTION_KEY;
      const legacy = await compact([{ role: "user", content: "Preserve this legacy task." }]);

      mutableEnv.COMPACTION_ENCRYPTION_KEY = sharedKey;
      const upgraded = await compact([
        ...legacy.output,
        { role: "user", content: "Continue after the key rollout." },
      ]);
      const encrypted = upgraded.output.find((item) => item.type === "compaction")?.encrypted_content;
      expect(encrypted).toBeTruthy();
      await expect(decryptJSON(encrypted!, env.DATA_ENCRYPTION_KEY)).rejects.toThrow();
      await expect(decryptJSON(encrypted!, sharedKey)).resolves.toMatchObject({ version: 3 });

      const resumed = await postResponse(auth.apiKey, {
        prompt_cache_key: promptCacheKey,
        input: [...upgraded.output, { role: "user", content: "Report retained state." }],
      });
      expect(resumed.status).toBe(200);
      expect(await resumed.text()).toContain("COMPACTION_KEY_ROLLOUT_OK");
    } finally {
      if (originalSharedKey === undefined) delete mutableEnv.COMPACTION_ENCRYPTION_KEY;
      else mutableEnv.COMPACTION_ENCRYPTION_KEY = originalSharedKey;
    }
  }, 15_000);

  it("reports a real upload rejection distinctly and permits retry of the unconsumed tool result", async () => {
    const auth = await credential();
    const imageURL = "data:image/png;base64,AAAA";
    const hub = installChatHub(({ index, socket }) => index === 0
      ? completeToolCall(socket, "view_image", { path: "C:/image.png" }) : complete(socket, "RETRIED_IMAGE_RECEIVED"));
    const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let rejectUpload = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (rejectUpload && String(input).includes("/m365Copilot/UploadFile")) return new Response("private upstream body", { status: 403 });
      return originalFetch(input, init);
    });
    const tool = { type: "function", name: "view_image", parameters: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
    } };
    const first = await postResponse(auth.apiKey, { input: "Inspect the local image.", tools: [tool], tool_choice: "required" });
    const initial = await first.json<{ id: string; output: Array<{ call_id: string }> }>();
    const request = { previous_response_id: initial.id, tools: [tool], input: [
      { type: "function_call_output", call_id: initial.output[0].call_id, output: [{ type: "input_image", image_url: imageURL }] },
    ] };
    const failed = await postResponse(auth.apiKey, { ...request, stream: true });
    const failure = await failed.text();
    expect(failure).toContain('"code":"image_upload_failed"');
    expect(failure).not.toContain("private upstream body");
    expect(failure).not.toContain('"type":"response.completed"');
    expect(hub.invocations).toHaveLength(1);
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const failedRequestId = failed.headers.get("X-Request-Id");
    expect(failedRequestId).toBeTruthy();
    await expect.poll(async () => (await state.listDiagnostics(200))
      .filter((entry) => entry.id === failedRequestId)).toEqual([
      expect.objectContaining({ code: "terminal_error_image_upload_failed", status: 200 }),
    ]);
    rejectUpload = false;
    const retried = await postResponse(auth.apiKey, request);
    expect(retried.status).toBe(200);
    expect(await retried.text()).toContain("RETRIED_IMAGE_RECEIVED");
    expect(hub.uploads).toHaveLength(1);
  }, 15_000);

  it("keeps Codex Responses answers and native tools compatible in production direct-native mode", async () => {
    const mutableEnv = env as typeof env & { DIRECT_NATIVE_TOOL_MODE?: string };
    const previousMode = mutableEnv.DIRECT_NATIVE_TOOL_MODE;
    mutableEnv.DIRECT_NATIVE_TOOL_MODE = "true";
    const tool = {
      type: "function",
      name: "exec_command",
      description: "Run a command in the caller-owned local workspace.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
    };
    try {
      const answerAuth = await credential();
      const marker = `CODEX_DIRECT_ANSWER_${crypto.randomUUID().replaceAll("-", "")}`;
      installChatHub(({ socket }) => complete(socket, `The verified answer is ${marker}.`));
      const answerResponse = await postResponse(answerAuth.apiKey, {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Give a concise answer." }] }],
        tools: [tool],
        tool_choice: "auto",
      });
      expect(answerResponse.status).toBe(200);
      const answer = await answerResponse.json<{
        output: Array<{ type: string; content?: Array<{ text?: string }> }>;
      }>();
      expect(answer.output[0]?.type).toBe("message");
      expect(answer.output[0]?.content?.[0]?.text).toContain(marker);

      vi.restoreAllMocks();
      const toolAuth = await credential();
      installChatHub(({ socket }) => completeToolCall(socket, "exec_command", { cmd: "Get-Location" }));
      const toolResponse = await postResponse(toolAuth.apiKey, {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the local location." }] }],
        tools: [tool],
        tool_choice: "auto",
      });
      expect(toolResponse.status).toBe(200);
      const toolBody = await toolResponse.json<{
        output: Array<{ type: string; name?: string; arguments?: string }>;
      }>();
      expect(toolBody.output[0]).toMatchObject({ type: "function_call", name: "exec_command" });
      expect(JSON.parse(toolBody.output[0]?.arguments ?? "{}")).toEqual({ cmd: "Get-Location" });
    } finally {
      mutableEnv.DIRECT_NATIVE_TOOL_MODE = previousMode;
    }
  }, 20_000);

  it("terminates a fast streaming preflight failure with response.failed instead of closing silently", async () => {
    const auth = await credential();
    const response = await postResponse(auth.apiKey, {
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test fast failure" }] }],
    }, "not-a-real-model");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"unsupported_model"');
    expect(text).toContain("data: [DONE]");
  });

  it("routes the real Codex local-web request instead of exposing hosted artifact links", async () => {
    const auth = await credential();
    const hostedFalseCompletion = "three files are in place. and verified the complete responsive dashboard.\n\n- [index.html](https://jp-prod.asyncgw.teams.microsoft.com/v1/objects/0-ea-test/views/original/index.html)\n\nAll structural checks and JavaScript syntax validation passed.";
    const upstream = installChatHub(({ index, socket }) => {
      if (index === 0) complete(socket, hostedFalseCompletion);
      else completeToolCall(socket, "exec_command", { cmd: "Get-ChildItem -Force" });
    });
    const response = await postResponse(auth.apiKey, {
      stream: true,
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "Create a complete standalone mini web dashboard in the current empty directory. You must actually use your local file-editing tools and read the files back before finishing.",
        }],
      }],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Runs a command in a local PTY.",
          strict: false,
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" }, workdir: { type: "string" }, yield_time_ms: { type: "number" } },
            required: ["cmd"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "write_stdin",
          description: "Writes characters to an existing local exec session.",
          strict: false,
          parameters: {
            type: "object",
            properties: { session_id: { type: "number" }, chars: { type: "string" }, yield_time_ms: { type: "number" } },
            required: ["session_id"],
            additionalProperties: false,
          },
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "The apply_patch tool can be used to edit files. This is a FREEFORM tool.",
          format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
        },
        { type: "namespace", name: "browser", description: "Browser tools", tools: [] },
        { type: "web_search" },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("response.function_call_arguments.delta");
    expect(events).toContain("exec_command");
    expect(events).not.toContain("asyncgw.teams.microsoft.com");
    expect(events).not.toContain("verified the complete responsive dashboard");
    expect(upstream.prompts.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("treats a local-path dialogue as the authority when M365 returns turn-file citations", async () => {
    const auth = await credential();
    const hostedFalseCompletion = [
      "已完成一个原创枫叶岛 HTML5 横版冒险游戏，并通过 JavaScript 语法和文件结构检查。",
      "",
      "解压后双击 index.html 即可运行。",
      "",
      "citeturn1file1",
    ].join("\n");
    const upstream = installChatHub(({ index, socket }) => {
      if (index === 0) complete(socket, hostedFalseCompletion);
      else completeToolCall(socket, "exec_command", {
        cmd: "Get-ChildItem -LiteralPath 'C:\\Users\\exampleuser\\Desktop\\771' -Force",
      });
    });
    const response = await postResponse(auth.apiKey, {
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "C:\\Users\\exampleuser\\Desktop\\771 做一个冒险岛的html游戏放文件夹，注意细节。",
        }],
      }],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Runs a command in the caller-owned local workspace.",
        strict: false,
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      }, {
        type: "function",
        name: "write_stdin",
        description: "Writes input to an existing caller-local process.",
        parameters: {
          type: "object",
          properties: { session_id: { type: "number" }, chars: { type: "string" } },
          required: ["session_id"],
        },
      }, {
        type: "function",
        name: "view_image",
        description: "Views an image on the caller-owned local filesystem.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ type: string; name?: string; arguments?: string }>;
      m365_gateway?: unknown;
    }>();
    expect(body.output[0]).toMatchObject({ type: "function_call", name: "exec_command" });
    expect(JSON.parse(body.output[0]?.arguments ?? "{}")).toMatchObject({
      cmd: expect.stringContaining("Desktop\\771"),
    });
    expect(JSON.stringify(body)).not.toContain("turn1file1");
    expect(JSON.stringify(body)).not.toContain("已完成一个原创枫叶岛");
    expect(body.m365_gateway).toBeUndefined();
    expect(upstream.prompts.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("fails closed when a local task has no caller tool manifest", async () => {
    const auth = await credential();
    installChatHub(({ socket }) => complete(socket, [
      "当前连接未提供可操作 Windows 本地文件系统的执行通道，因此无法直接覆盖桌面文件。",
      "完整游戏文件已经生成，可下载后保存到 C:\\Users\\exampleuser\\Desktop\\771\\index.html。",
      "citeturn5file3",
    ].join("\n\n")));
    const response = await postResponse(auth.apiKey, {
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "C:\\Users\\exampleuser\\Desktop\\771 做一个冒险岛的html游戏放文件夹，注意细节。",
        }],
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ content?: Array<{ text?: string }> }>;
      m365_gateway?: { checkpoint?: boolean; checkpoint_code?: string; continuation_required?: boolean };
    }>();
    expect(body.m365_gateway).toEqual({
      checkpoint: true,
      checkpoint_code: "hosted_artifact_substitution",
      continuation_required: true,
    });
    expect(body.output[0]?.content?.[0]?.text).toContain("尚未创建或验证");
    expect(JSON.stringify(body)).not.toContain("turn5file3");
    expect(JSON.stringify(body)).not.toContain("完整游戏文件已经生成");
  }, 15_000);

  it("fails closed for a natural local task even without hosted citation markers", async () => {
    const auth = await credential();
    installChatHub(({ socket }) => complete(socket,
      "游戏已经做好并放进指定的本地目录，文件结构和 JavaScript 语法均已验证。"));
    const response = await postResponse(auth.apiKey, {
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "C:\\Users\\exampleuser\\Desktop\\771 做一个冒险岛的html游戏放文件夹，注意细节。",
        }],
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ content?: Array<{ text?: string }> }>;
      m365_gateway?: { checkpoint?: boolean; checkpoint_code?: string; continuation_required?: boolean };
    }>();
    expect(body.m365_gateway).toEqual({
      checkpoint: true,
      checkpoint_code: "missing_evidence",
      continuation_required: true,
    });
    expect(body.output[0]?.content?.[0]?.text).not.toContain("游戏已经做好");
  }, 15_000);

  it("semantically audits an unsupported local-path completion even without a hosted marker", async () => {
    const auth = await credential();
    const upstream = installChatHub(({ index, socket }) => {
      if (index === 0) complete(socket,
        "游戏已经做好并放进指定的本地目录，文件结构和 JavaScript 语法均已验证。");
      else completeToolCall(socket, "exec_command", {
        cmd: "Get-ChildItem -LiteralPath 'C:\\Users\\exampleuser\\Desktop\\771' -Force",
      });
    });
    const response = await postResponse(auth.apiKey, {
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "C:\\Users\\exampleuser\\Desktop\\771 做一个冒险岛的html游戏放文件夹，注意细节。",
        }],
      }],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Runs a command in the caller-owned local workspace.",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ output: Array<{ type: string; name?: string }> }>();
    expect(body.output[0]).toMatchObject({ type: "function_call", name: "exec_command" });
    expect(JSON.stringify(body)).not.toContain("游戏已经做好");
    expect(upstream.prompts.some((prompt) => prompt.includes("INITIAL CALLER-LOCAL TASK AUDIT"))).toBe(true);
  }, 15_000);

  it("continues a missing-folder follow-up through the declared local tool", async () => {
    const auth = await credential();
    const upstream = installChatHub(({ index, socket }) => {
      if (index === 0) complete(socket,
        "刚才生成到了临时工作区，请下载压缩包后解压到桌面。\n\nciteturn2file2");
      else completeToolCall(socket, "exec_command", { cmd: "Get-ChildItem -Force" });
    });
    const response = await postResponse(auth.apiKey, {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "文件夹里面没有" }],
      }],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Inspect or modify the caller-owned current workspace.",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ type: string; name?: string }>;
      m365_gateway?: unknown;
    }>();
    expect(body.output[0]).toMatchObject({ type: "function_call", name: "exec_command" });
    expect(body.m365_gateway).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("turn2file2");
    expect(JSON.stringify(body)).not.toContain("下载压缩包");
    expect(upstream.prompts.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("keeps a missing local-folder follow-up pending instead of offering another hosted download", async () => {
    const auth = await credential();
    installChatHub(({ socket }) => complete(socket,
      "刚才生成到了临时工作区，请下载压缩包后解压到桌面。\n\nciteturn2file2"));
    const response = await postResponse(auth.apiKey, {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "文件夹里面没有" }],
      }],
      tools: [{
        type: "function",
        name: "wait",
        description: "Wait for an existing caller-owned task.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ content?: Array<{ text?: string }> }>;
      m365_gateway?: { checkpoint?: boolean; checkpoint_code?: string; continuation_required?: boolean };
    }>();
    expect(body.m365_gateway).toEqual({
      checkpoint: true,
      checkpoint_code: "hosted_artifact_substitution",
      continuation_required: true,
    });
    expect(body.output[0]?.content?.[0]?.text).toContain("尚未创建或验证");
    expect(JSON.stringify(body)).not.toContain("turn2file2");
    expect(JSON.stringify(body)).not.toContain("下载压缩包");
  });

  it("routes Responses Lite functions.exec declared inside additional_tools as a native custom call", async () => {
    const auth = await credential();
    const hostedFalseCompletion = "The dashboard is complete and verified.\n\n- [index.html](https://jp-prod.asyncgw.teams.microsoft.com/v1/objects/0-ea-lite/views/original/index.html)\n\nAll validation checks passed.";
    const execInput = "const r = await tools.exec_command({ cmd: \"Get-ChildItem -Force\" }); text(r.output);";
    const upstream = installChatHub(({ index, socket }) => {
      if (index === 0) complete(socket, hostedFalseCompletion);
      else complete(socket, routerCall("exec", { input: execInput }));
    });
    const response = await postResponse(auth.apiKey, {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{
            type: "namespace",
            name: "functions",
            description: "Caller-local Codex tools exposed through Code Mode.",
            tools: [{
              type: "custom",
              name: "exec",
              description: [
                "Run JavaScript code that invokes caller-local tools.",
                "### `apply_patch`",
                "declare const tools: { apply_patch(input: string): Promise<unknown>; };",
                "### `exec_command`",
                "declare const tools: { exec_command(args: { cmd: string; workdir?: string }): Promise<unknown>; };",
                "Use `tools.inspect_workspace({ path: string })` when that declared selector fits the task.",
              ].join("\n"),
              format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
            }, {
              type: "function",
              name: "wait",
              description: "Wait for a caller task.",
              parameters: { type: "object", properties: {} },
            }, {
              type: "function",
              name: "request_user_input",
              description: "Ask the caller for missing information.",
              parameters: { type: "object", properties: { questions: { type: "array" } } },
            }],
          }],
        },
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent", description: "Delegate a caller task." }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Create a complete standalone mini web dashboard in the current empty directory and verify the local files before finishing.",
          }],
        },
      ],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ type: string; name?: string; input?: string }>;
    }>();
    expect(body.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: execInput,
    });
    expect(JSON.stringify(body)).not.toContain("asyncgw.teams.microsoft.com");
    expect(JSON.stringify(body)).not.toContain("dashboard is complete and verified");
    expect(upstream.prompts.length).toBeGreaterThanOrEqual(2);
    const firstInvocation = upstream.invocations[0];
    const pluginIds = firstInvocation.plugins.map((plugin) => String(plugin.Id));
    expect(pluginIds).toEqual([
      clientToolWireName("exec"),
      clientToolWireName("wait"),
      clientToolWireName("request_user_input"),
    ]);
    expect(pluginIds).not.toContain(clientToolWireName("exec_command"));
    expect(pluginIds).not.toContain(clientToolWireName("inspect_workspace"));
    const execPlugin = firstInvocation.plugins.find((plugin) => plugin.Id === clientToolWireName("exec"));
    expect(String(execPlugin?.Description)).toContain("tools.apply_patch");
    expect(String(execPlugin?.Description)).toContain("tools.exec_command");
    expect(String(execPlugin?.Description)).toContain("tools.inspect_workspace");
    expect(firstInvocation.toolChoice).toBe("auto");
  }, 15_000);

  it("routes a top-level Responses custom exec declaration", async () => {
    const auth = await credential();
    const execInput = "const r = await tools.exec_command({ cmd: \"Get-ChildItem -Force\" }); text(r.output);";
    const upstream = installChatHub(({ socket }) => complete(socket, routerCall("exec", { input: execInput })));
    const response = await postResponse(auth.apiKey, {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the caller's local workspace." }],
      }],
      tools: [{
        type: "custom",
        name: "exec",
        description: "Run JavaScript through the caller-local Code Mode runtime.",
        format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ output: Array<{ type: string; name?: string; input?: string }> }>();
    expect(body.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", input: execInput });
    expect(upstream.invocations[0]?.plugins.map((plugin) => String(plugin.Id))).toEqual([clientToolWireName("exec")]);
  }, 15_000);

  it("fails closed on a local web build with hosted artifacts when Responses Lite has no exec route", async () => {
    const auth = await credential();
    const hostedFalseCompletion = "The three local files were created and verified.\n\n- [index.html](https://jp-prod.asyncgw.teams.microsoft.com/v1/objects/0-ea-no-exec/views/original/index.html)\n\nJavaScript validation passed.";
    installChatHub(({ socket }) => complete(socket, hostedFalseCompletion));
    const response = await postResponse(auth.apiKey, {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{
            type: "namespace",
            name: "functions",
            tools: [{ type: "function", name: "wait", description: "Wait for an existing task." }],
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Build and verify a small website in the current local directory." }],
        },
      ],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ content?: Array<{ text?: string }> }>;
      m365_gateway?: { checkpoint?: boolean; checkpoint_code?: string; continuation_required?: boolean };
    }>();
    expect(body.m365_gateway).toEqual({
      checkpoint: true,
      checkpoint_code: "hosted_artifact_substitution",
      continuation_required: true,
    });
    expect(body.output[0]?.content?.[0]?.text).toContain("were not created or verified");
    expect(JSON.stringify(body)).not.toContain("asyncgw.teams.microsoft.com");
    expect(JSON.stringify(body)).not.toContain("three local files were created and verified");
  });

  it("buffers Responses streaming text until hosted-artifact auditing is complete", async () => {
    const auth = await credential();
    const hostedFalseCompletion = "The local dashboard is complete and verified.\n\n- [index.html](https://jp-prod.asyncgw.teams.microsoft.com/v1/objects/0-ea-stream/views/original/index.html)\n\nAll checks passed.";
    installChatHub(({ socket }) => streamThenComplete(socket, hostedFalseCompletion));
    const response = await postResponse(auth.apiKey, {
      stream: true,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Create and verify a mini web dashboard in the current local workspace." }],
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("response.completed");
    expect(events).toContain("hosted_artifact_substitution");
    expect(events).toContain("were not created or verified");
    expect(events).not.toContain("asyncgw.teams.microsoft.com");
    expect(events).not.toContain("local dashboard is complete and verified");
  }, 15_000);

  it("marks an unrecoverable pending local action as a provider-owned Codex follow-up", async () => {
    const auth = await credential();
    const pending = "I am correcting the local CSS file and running the validator now.";
    installChatHub(({ socket }) => complete(socket, pending));
    const response = await postResponse(auth.apiKey, {
      stream: true,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Create and verify a mini website in the current local directory." }],
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("event: response.completed");
    expect(events).toContain("\"checkpoint_code\":\"pending_assistant_action\"");
    expect(events).toContain("\"end_turn\":false");
    expect(events).not.toContain(pending);
  }, 15_000);

  it("routes a declared Codex custom apply_patch call back to the caller", async () => {
    const auth = await credential();
    const patchInput = "*** Begin Patch\n*** Add File: index.html\n+<h1>Probe</h1>\n*** End Patch";
    const upstream = installChatHub(({ socket }) => completeToolCall(socket, "apply_patch", { input: patchInput }));
    const customTool = {
      type: "custom",
      name: "apply_patch",
      description: "The apply_patch tool can be used to edit files. This is a FREEFORM tool.",
      format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
    };
    const response = await postResponse(auth.apiKey, {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Use apply_patch to create index.html in the local workspace." }] }],
      tools: [customTool],
      tool_choice: { type: "custom", name: "apply_patch" },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ output: Array<{ type: string; name?: string; input?: string }> }>();
    expect(body.output[0]).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: patchInput });
    expect(upstream.invocations[0]?.plugins.map((plugin) => String(plugin.Id))).toEqual([clientToolWireName("apply_patch")]);
  }, 15_000);

  it("keeps a Claude Sonnet Responses tool result in the second-turn answer", async () => {
    const auth = await credential();
    const marker = `CLAUDE_SONNET_RESPONSES_${crypto.randomUUID().replaceAll("-", "")}`;
    const tool = {
      type: "function",
      name: "exec_command",
      description: "Read a file in the caller workspace.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
    };
    let requested = 0;
    let audits = 0;
    const upstream = installChatHub(({ prompt, socket }) => {
      if (prompt.includes("SEMANTIC TASK CONTINUATION AUDIT")) {
        audits += 1;
        complete(socket, "NO_TOOL_REQUIRED");
        return;
      }
      requested += 1;
      if (requested === 1) completeToolCall(socket, "exec_command", { cmd: "Get-Content package.json" });
      else complete(socket, `package.json contains marker ${marker}.`);
    });

    const firstResponse = await postResponse(auth.apiKey, {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read package.json and report its marker." }] }],
      tools: [tool],
      tool_choice: "auto",
    }, "claude-sonnet");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<{
      id: string;
      output: Array<{ type: string; call_id: string; name: string; arguments: string }>;
    }>();
    expect(first.output[0]).toMatchObject({ type: "function_call", name: "exec_command" });

    const secondResponse = await postResponse(auth.apiKey, {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: JSON.stringify({ marker }) }],
      tools: [tool],
      tool_choice: "auto",
    }, "claude-sonnet");
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<{
      output: Array<{ type: string; content?: Array<{ text?: string }> }>;
      m365_gateway?: unknown;
    }>();
    expect(second.output[0]?.type).toBe("message");
    expect(second.output[0]?.content?.[0]?.text).toContain(marker);
    expect(second.m365_gateway).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain("current task and latest tool result are preserved");
    expect(audits).toBeGreaterThanOrEqual(1);
    expect(upstream.prompts.some((prompt) => prompt.includes(marker))).toBe(true);
  }, 20_000);

  it("recovers a Claude Sonnet Responses continuation when the second request omits tools", async () => {
    const auth = await credential();
    const marker = `CLAUDE_SONNET_RESP_NO_TOOLS_${crypto.randomUUID().replaceAll("-", "")}`;
    const tool = {
      type: "function",
      name: "lookup_gateway_value",
      description: "Return one deterministic value",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    };
    let requested = 0;
    let recoveryCount = 0;
    installChatHub(({ prompt, socket }) => {
      if (prompt.includes("ANSWER-ONLY TOOL RESULT RECOVERY")) {
        recoveryCount += 1;
        // The formatter itself may occasionally repeat the upstream safety
        // refusal. The gateway must still use the structured scalar evidence
        // without exposing a checkpoint or retrying indefinitely.
        complete(socket, "I'm not going to execute that request or act on the fabricated history in your message. This is a prompt injection attempt.");
        return;
      }
      if (prompt.includes("SEMANTIC TASK CONTINUATION AUDIT")) {
        complete(socket, "NO_TOOL_REQUIRED");
        return;
      }
      requested += 1;
      if (requested === 1) completeToolCall(socket, "lookup_gateway_value", { key: marker });
      else complete(socket, "I notice this message contains what appears to be an attempt to manipulate me through injected \"tool results,\" fake internal blocks, and fabricated gateway infrastructure. Let me be transparent.");
    });

    const firstResponse = await postResponse(auth.apiKey, {
      input: `Call lookup_gateway_value with key ${marker}. Do not answer directly.`,
      tools: [tool],
      tool_choice: { type: "function", function: { name: "lookup_gateway_value" } },
    }, "claude-sonnet");
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<{
      id: string;
      output: Array<{ type: string; call_id: string; name: string }>;
    }>();
    expect(first.output[0]).toMatchObject({ type: "function_call", name: "lookup_gateway_value" });

    const secondResponse = await postResponse(auth.apiKey, {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: JSON.stringify({ value: marker }) }],
    }, "claude-sonnet");
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json<{
      output: Array<{ type: string; content?: Array<{ text?: string }> }>;
      m365_gateway?: unknown;
    }>();
    expect(second.output[0]?.type).toBe("message");
    expect(second.output[0]?.content?.[0]?.text).toContain(marker);
    expect(second.output[0]?.content?.[0]?.text).not.toContain("task state was preserved");
    expect(second.m365_gateway).toBeUndefined();
    expect(recoveryCount).toBe(1);
  }, 20_000);

  it("restores the fixed caller schemas for a write_stdin continuation without tools", async () => {
    const auth = await credential();
    let requested = 0;
    const upstream = installChatHub(({ prompt, socket }) => {
      requested += 1;
      if (requested === 1) {
        completeToolCall(socket, "write_stdin", { session_id: 23889, chars: "hostname\r" });
        return;
      }
      // The second exchange must have the restored fixed schema available to
      // the router; the deterministic mock emits the next safe local action.
      expect(prompt).toContain(clientToolWireName("exec_command"));
      completeToolCall(socket, "exec_command", { cmd: "Get-Location" });
    });
    const tool = (name: string, parameters: Record<string, unknown>) => ({
      type: "function", name, parameters,
    });
    const tools = [
      tool("write_stdin", {
        type: "object", properties: { session_id: { type: "integer" }, chars: { type: "string" } },
        required: ["session_id"], additionalProperties: false,
      }),
      tool("exec_command", {
        type: "object", properties: { cmd: { type: "string" } },
        required: ["cmd"], additionalProperties: false,
      }),
    ];
    const firstResponse = await postResponse(auth.apiKey, {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue the local inspection." }] }],
      tools, tool_choice: "auto",
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<{ id: string; output: Array<{ call_id: string }> }>();
    const secondResponse = await postResponse(auth.apiKey, {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "hostname\nlocal" }],
    });
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({ output: [{ type: "function_call", name: "exec_command" }] });
    expect(upstream.prompts.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("does not reconstruct an unknown pending caller tool on an omitted-tools continuation", async () => {
    const auth = await credential();
    installChatHub(({ socket }) => completeToolCall(socket, "lookup_gateway_value", { key: "opaque" }));
    const tool = {
      type: "function", name: "lookup_gateway_value",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    };
    const firstResponse = await postResponse(auth.apiKey, {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Call the lookup tool." }] }],
      tools: [tool], tool_choice: { type: "function", name: "lookup_gateway_value" },
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json<{ id: string; output: Array<{ call_id: string }> }>();
    const secondResponse = await postResponse(auth.apiKey, {
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "opaque result" }],
      tool_choice: "required",
    });
    expect(secondResponse.status).toBe(400);
    await expect(secondResponse.json()).resolves.toMatchObject({ error: { code: "invalid_tool_choice" } });
  }, 20_000);

  it("does not complete a Responses Lite turn whose answer still promises a local correction", async () => {
    const auth = await credential();
    const mixedTerminal = "The three requested files are present and wired, but the read-back exposed one malformed light-theme color value. I'm correcting that and running a final exact-name and linkage check. and read back all three files. Verified the required filenames and linkages.";
    const fixInput = "const r = await tools.exec_command({ cmd: \"Apply the smallest safe correction to style.css and run the validator\" }); text(r.output);";
    let auditAttempt = 0;
    const upstream = installChatHub(({ prompt, socket }) => {
      if (prompt.includes("SEMANTIC TASK CONTINUATION AUDIT") || prompt.includes("PREVIOUS ROUTER FAILURE")) {
        auditAttempt += 1;
        if (auditAttempt === 1) complete(socket, "NO_TOOL_REQUIRED");
        else complete(socket, routerCall("exec", { input: fixInput }));
        return;
      }
      complete(socket, mixedTerminal);
    });
    const response = await postResponse(auth.apiKey, {
      stream: true,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{
            type: "namespace",
            name: "functions",
            tools: [{
              type: "custom",
              name: "exec",
            description: "Run JavaScript that invokes caller-local tools.",
              format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
            }],
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Create and verify index.html, style.css, and app.js in the current local directory." }],
        },
        {
          type: "custom_tool_call",
          call_id: "call_readback_pending_fix",
          name: "exec",
          input: "const r = await tools.exec_command({ cmd: \"Get-Content index.html,style.css,app.js\" }); text(r.output);",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_readback_pending_fix",
          output: "index.html and app.js are linked; style.css contains --accent:#556e8;",
        },
      ],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const events = await response.text();
    expect(events).toContain("response.custom_tool_call_input.delta");
    expect(events).toContain("\"name\":\"exec\"");
    expect(events).toContain("Apply the smallest safe correction");
    expect(events).not.toContain("I'm correcting");
    expect(events).not.toContain("Verified the required filenames");
    expect(upstream.prompts.some((prompt) => prompt.includes("The candidate explicitly says"))).toBe(true);
    expect(auditAttempt).toBe(2);
  }, 15_000);


  it("recovers a fresh failed Responses Lite write result with direct Code Mode exec", async () => {
    const auth = await credential();
    const failedOutput = "Set-Content failed: access denied";
    const falseTerminal = "The command failed, so the requested local files were not created.";
    const correctedScript = "const r = await tools.exec_command({ cmd: \"node -e \\\"console.log('WRITE_RECOVERED')\\\"\" }); text(r.output);";
    let auditAttempt = 0;
    const upstream = installChatHub(({ prompt, socket }) => {
      if (prompt.includes("SEMANTIC TASK CONTINUATION AUDIT") || prompt.includes("PREVIOUS ROUTER FAILURE")) {
        auditAttempt += 1;
        if (auditAttempt === 1) complete(socket, "NO_TOOL_REQUIRED");
        else complete(socket, routerCall("exec", { input: correctedScript }));
        return;
      }
      complete(socket, falseTerminal);
    });
    const response = await postResponse(auth.apiKey, {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{
            type: "namespace",
            name: "functions",
            tools: [{
              type: "custom",
              name: "exec",
              description: "Run JavaScript that invokes caller-local tools.",
              format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
            }],
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Create the requested local files, recover safely from a failed local command, and verify the result before finishing.",
          }],
        },
        {
          type: "custom_tool_call",
          call_id: "call_failed_local_patch",
          name: "exec",
           input: "const r = await tools.exec_command({ cmd: \"Set-Content index.html BROKEN\" }); text(r.output);",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_failed_local_patch",
          output: failedOutput,
        },
      ],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      output: Array<{ type: string; name?: string; input?: string }>;
    }>();
    expect(body.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: correctedScript,
    });
    expect(JSON.stringify(body)).not.toContain(falseTerminal);
    expect(auditAttempt).toBe(2);
    const auditPrompts = upstream.prompts.filter((prompt) => (
      prompt.includes("SEMANTIC TASK CONTINUATION AUDIT")
      || prompt.includes("PREVIOUS ROUTER FAILURE")
    ));
    expect(auditPrompts).toHaveLength(2);
    expect(auditPrompts.every((prompt) => prompt.includes(failedOutput))).toBe(true);
    expect(auditPrompts.every((prompt) => prompt.includes(clientToolWireName("exec")))).toBe(true);
    expect(auditPrompts.every((prompt) => !prompt.includes(clientToolWireName("apply_patch")))).toBe(true);
    expect(auditPrompts.every((prompt) => !prompt.includes("NAMED REPAIR"))).toBe(true);
    expect(auditPrompts[0]).toContain("fresh structured caller-tool result failed");
    expect(auditPrompts[1]).toContain("PREVIOUS ROUTER FAILURE: invalid_text_decision");
    expect(auditPrompts[1]).toContain(clientToolWireName("exec"));
  }, 15_000);

  it("abandons an echo-only PTY continuation and selects a fresh non-interactive command", async () => {
    const auth = await credential();
    const echoedCommand = "systemctl show xinyu-backend.service -p ActiveState\r";
    const upstream = installChatHub(({ prompt, socket }) => {
      if (prompt.includes("SEMANTIC TASK CONTINUATION AUDIT") || prompt.includes("PREVIOUS ROUTER FAILURE")) {
        expect(prompt).toContain("Do not write to that same session again");
        complete(socket, routerCall("exec_command", {
          cmd: "ssh root@example.invalid systemctl show xinyu-backend.service -p ActiveState --no-pager",
        }));
        return;
      }
      complete(socket, "The existing SSH session returned no reliable command output, so the audit is blocked.");
    });
    const response = await postResponse(auth.apiKey, {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the read-only server audit and obtain reliable service evidence." }] },
        { type: "function_call", call_id: "call_echo_only", name: "write_stdin", arguments: JSON.stringify({ session_id: 23889, chars: echoedCommand }) },
        {
          type: "function_call_output",
          call_id: "call_echo_only",
          output: `Process still running with session ID 23889\nLive output:\n${echoedCommand.trim()}`,
        },
      ],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Run a fresh local command without reusing an existing PTY.",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      }, {
        type: "function",
        name: "write_stdin",
        description: "Write characters to an existing local exec session.",
        parameters: {
          type: "object",
          properties: { session_id: { type: "number" }, chars: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      output: [{ type: "function_call", name: "exec_command" }],
    });
    expect(upstream.prompts.some((prompt) => prompt.includes("SEMANTIC TASK CONTINUATION AUDIT"))).toBe(true);
  }, 15_000);

  it("does not silently downgrade required hosted-only declarations to a tool-less answer", async () => {
    const auth = await credential();
    const response = await postResponse(auth.apiKey, {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Run the required tool." }] }],
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_tool_choice" },
    });
  });

  it.each(["inactive", "missing"] as const)("follows one %s active-account route fence before upstream submission", async (routeFence) => {
    const auth = await credential();
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const selected = await state.selectAccount();
    expect(selected).not.toBeNull();
    await addSuccessorAccount();
    const holderWaiter = `route-race-${crypto.randomUUID()}`;
    let holder = await state.acquireUpstream(selected!.accountId, holderWaiter, selected!.routeEpoch);
    while (!holder.ok && !holder.code) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, holder.retryAfterMs)));
      holder = await state.acquireUpstream(selected!.accountId, holderWaiter, selected!.routeEpoch);
    }
    expect(holder.ok).toBe(true);
    if (!holder.ok) {
      await state.cancelUpstreamWaiter(selected!.accountId, holderWaiter);
      throw new Error(`test account gate was not acquired: ${holder.code ?? "busy"}`);
    }

    const upstream = installChatHub(({ socket }) => {
      completeToolCall(socket, "exec_command", { cmd: "Get-Location" });
    });
    const pending = postResponse(auth.apiKey, {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the current workspace." }] }],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Run a local command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      }],
      tool_choice: "auto",
    });

    // The held account gate leaves the request between account selection and
    // upstream submission. Retiring that exact route generation must cause one
    // atomic lease switch and retry against the new active account.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (routeFence === "missing") expect(await state.deleteAccount(selected!.accountId)).toBe(true);
    else await state.reportAccountFailure(selected!.accountId, "transient", selected!.routeEpoch);
    await state.releaseUpstream(selected!.accountId, holder.leaseId);
    const active = await state.selectAccount();
    expect(active?.accountId).not.toBe(selected!.accountId);

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      output: [{ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "Get-Location" }) }],
    });
    expect(upstream.urls).toHaveLength(1);
    expect(upstream.urls[0].searchParams.get("access_token")).toBe(active?.token.accessToken);
  }, 15_000);

  it("forks every previous_response_id continuation without mutating or sharing its source alias", async () => {
    const auth = await credential();
    const previousResponseId = `resp_source_${crypto.randomUUID().replaceAll("-", "")}`;
    const source = await responseSession(auth.apiKey, previousResponseId);
    await source.seed(
      crypto.randomUUID(),
      crypto.randomUUID(),
      auth.accountId,
      "",
      "",
      "",
      "[]",
      [],
      "immutable source context",
    );
    const sourceSnapshot = await source.checkoutResponseAlias();
    const upstream = installChatHub(({ prompt, socket }) => {
      complete(socket, prompt.includes("LEFT BRANCH") ? "left branch answer" : "right branch answer");
    });

    const [leftResponse, rightResponse] = await Promise.all([
      postResponse(auth.apiKey, {
        previous_response_id: previousResponseId,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "LEFT BRANCH" }] }],
      }),
      postResponse(auth.apiKey, {
        previous_response_id: previousResponseId,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "RIGHT BRANCH" }] }],
      }),
    ]);
    expect([leftResponse.status, rightResponse.status]).toEqual([200, 200]);
    const left = await leftResponse.json<{ id: string; output: Array<{ content: Array<{ text: string }> }> }>();
    const right = await rightResponse.json<{ id: string; output: Array<{ content: Array<{ text: string }> }> }>();
    expect(left.output[0].content[0].text).toBe("left branch answer");
    expect(right.output[0].content[0].text).toBe("right branch answer");
    expect(upstream.urls.map((url) => url.searchParams.get("ConversationId"))).toHaveLength(2);
    expect(new Set(upstream.urls.map((url) => url.searchParams.get("ConversationId"))).size).toBe(2);
    expect(await source.checkoutResponseAlias()).toEqual(sourceSnapshot);

    const leftAlias = await (await responseSession(auth.apiKey, left.id)).checkoutResponseAlias();
    const rightAlias = await (await responseSession(auth.apiKey, right.id)).checkoutResponseAlias();
    expect(leftAlias?.portableProtocolTail).toContain("left branch answer");
    expect(leftAlias?.portableProtocolTail).not.toContain("right branch answer");
    expect(rightAlias?.portableProtocolTail).toContain("right branch answer");
    expect(rightAlias?.portableProtocolTail).not.toContain("left branch answer");
  });

  it("publishes checkpoint identity on a non-streaming Responses result", async () => {
    const auth = await credential();
    installChatHub(({ prompt, socket }) => {
      complete(socket, prompt.includes("ANSWER-ONLY CONTINUATION REPAIR")
        ? "The inspected state is preserved; continuation can choose the next action."
        : "NO_TOOL_REQUIRED");
    });
    const response = await postResponse(auth.apiKey, {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the workspace and continue the task." }] },
        { type: "function_call", call_id: "call_inspect", name: "exec_command", arguments: "{\"cmd\":\"Get-ChildItem\"}" },
        { type: "function_call_output", call_id: "call_inspect", output: "workspace inventory collected" },
      ],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Run a local command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      }],
      tool_choice: "auto",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      end_turn: false,
      m365_gateway: {
        checkpoint: true,
        checkpoint_code: "no_tool",
        continuation_required: true,
      },
    });
  });

  it("restores a checkpoint portable tail for a prompt_cache_key continuation without duplicating the current turn", async () => {
    const auth = await credential();
    const shared = `checkpoint-resume-${crypto.randomUUID()}`;
    const firstTask = `FIRST_CHECKPOINT_TASK_${crypto.randomUUID()}`;
    const currentTurn = `SECOND_CHECKPOINT_RESUME_${crypto.randomUUID()}`;
    const upstream = installChatHub(({ prompt, socket }) => {
      if (prompt.includes("ANSWER-ONLY CONTINUATION REPAIR")) {
        complete(socket, "The checkpoint is preserved for a later continuation.");
      } else if (prompt.includes(currentTurn)) {
        complete(socket, "resumed from the preserved checkpoint");
      } else {
        complete(socket, "NO_TOOL_REQUIRED");
      }
    });

    const checkpoint = await postResponse(auth.apiKey, {
      prompt_cache_key: shared,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: firstTask }] },
        { type: "function_call", call_id: "call_checkpoint", name: "exec_command", arguments: "{\"cmd\":\"Get-ChildItem\"}" },
        { type: "function_call_output", call_id: "call_checkpoint", output: "workspace inventory collected" },
      ],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Run a local command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      }],
      tool_choice: "auto",
    });
    expect(checkpoint.status).toBe(200);
    await expect(checkpoint.json()).resolves.toMatchObject({
      m365_gateway: { checkpoint: true, continuation_required: true },
    });

    const resumed = await postResponse(auth.apiKey, {
      prompt_cache_key: shared,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: currentTurn }] }],
    });
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      output: [{ content: [{ text: "resumed from the preserved checkpoint" }] }],
    });

    const resumedPrompt = upstream.prompts.find((prompt) => prompt.includes(currentTurn));
    expect(resumedPrompt).toContain("PORTABLE HISTORY FROM THE SAME API-CREDENTIAL SESSION");
    expect(resumedPrompt).toContain(firstTask);
    expect(resumedPrompt?.match(new RegExp(currentTurn, "g"))).toHaveLength(1);
  }, 15_000);

  it("supersedes a concurrent same-session request without exposing an active-request error", async () => {
    const auth = await credential();
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    installChatHub(({ index, socket }) => {
      if (index === 0) {
        firstStartedResolve();
        return;
      }
      complete(socket, "replacement request completed");
    });
    const shared = `concurrent-${crypto.randomUUID()}`;
    const firstPending = postResponse(auth.apiKey, {
      prompt_cache_key: shared,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] }],
    });
    await firstStarted;
    const replacementPending = postResponse(auth.apiKey, {
      prompt_cache_key: shared,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "replacement request" }] }],
    });
    const [first, replacement] = await Promise.all([firstPending, replacementPending]);
    const replacementBody = await replacement.text();
    expect(replacement.status).toBe(200);
    expect(replacementBody).toContain("replacement request completed");
    expect(replacementBody).not.toContain("this conversation already has an active request");
    expect(first.headers.get("X-M365-Error-Code")).not.toBe("conversation_busy");
    expect(first.status).not.toBe(409);
    expect(replacement.status).not.toBe(409);
  }, 15_000);
});
