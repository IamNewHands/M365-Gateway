import { describe, expect, it } from "vitest";
import { anthropicRequest, convertAnthropicBody } from "../src/anthropic";
import { modelTone } from "../src/models";
import { prepareChatMultimodal } from "../src/openai";
import type { Env } from "../src/types";

const env = {} as Env;

function request(): Request {
  return new Request("https://example.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "test-model", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
}

function toolRequest(): Request {
  return new Request("https://example.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "inspect the project" }],
      tools: [{
        name: "exec_command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    }),
  });
}

function upstream(payload: string): Response {
  return new Response(payload, { headers: { "content-type": "text/event-stream" } });
}

async function bodyText(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe("Anthropic streaming compatibility", () => {
  it("converts Anthropic base64 image blocks into the existing Chat multimodal shape", () => {
    const converted = convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: [
        { type: "text", text: "What is shown?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } },
      ] }],
    });
    expect(converted.openAI.messages).toEqual([{ role: "user", content: [
      { type: "text", text: "What is shown?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==", detail: "high" } },
    ] }]);
  });

  it("keeps tool results separate when an image follows in the same user turn", () => {
    const converted = convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: [
        { type: "tool_result", tool_use_id: "tool_1", content: "captured" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/2Q==" } },
      ] }],
    });
    expect(converted.openAI.messages).toEqual([
      { role: "tool", tool_call_id: "tool_1", content: "captured" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/2Q==", detail: "high" } }] },
    ]);
  });

  it("preserves images nested in Claude Code tool_result content", () => {
    const converted = convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: "tool_image_1",
        content: [
          { type: "text", text: "Read 1 file" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } },
        ],
      }] }],
    });
    expect(converted.openAI.messages).toEqual([{
      role: "tool",
      tool_call_id: "tool_image_1",
      content: [
        { type: "text", text: "Read 1 file" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==", detail: "high" } },
      ],
    }]);
    const prepared = prepareChatMultimodal(converted.openAI.messages as Array<Record<string, unknown>>);
    expect(prepared.attachments).toEqual([{
      type: "image", url: "data:image/png;base64,QUJDRA==", mimeType: "image/png", detail: "high",
    }]);
    expect(prepared.inferenceValue).toEqual([{ role: "tool", tool_call_id: "tool_image_1", content: "Read 1 file" }]);
    expect(String((prepared.value as Array<Record<string, unknown>>)[0].content)).toContain("[IMAGE ATTACHMENTS PRESENT]");
  });

  it.each([
    { type: "url", url: "https://example.com/image.png" },
    { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" },
    { type: "base64", media_type: "image/png", data: "" },
  ])("rejects unsupported Anthropic image sources: %j", (source) => {
    expect(() => convertAnthropicBody({
      model: "claude-sonnet", max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "image", source }] }],
    })).toThrow();
  });

  it.each([
    [{ type: "enabled", budget_tokens: 2048 }, undefined, "Claude_Sonnet_Reasoning"],
    [{ type: "adaptive" }, { effort: "low" }, "Claude_Sonnet_Reasoning"],
    [{ type: "disabled" }, { effort: "high" }, "Claude_Sonnet"],
    [undefined, { effort: "high" }, "Claude_Sonnet_Reasoning"],
    [undefined, undefined, "Claude_Sonnet"],
  ])("routes Messages thinking options through the Chat adapter (%j)", async (thinking, output_config, tone) => {
    const response = await anthropicRequest(new Request("https://example.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet", max_tokens: 4096, thinking, output_config,
        messages: [{ role: "user", content: "solve this" }] }),
    }), env, async (forwarded) => {
      const body = await forwarded.json() as { model: string; reasoning_effort?: string };
      expect(modelTone(body.model, body.reasoning_effort)).toBe(tone);
      return Response.json({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] });
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('"type":"thinking"');
  });

  it("rejects invalid thinking settings before calling the upstream", () => {
    const base = { model: "claude-sonnet", max_tokens: 4096, messages: [{ role: "user", content: "hi" }] };
    for (const thinking of [true, { type: "unknown" }, { type: "enabled", budget_tokens: -1 }]) {
      expect(() => convertAnthropicBody({ ...base, thinking })).toThrow();
    }
  });

  it("keeps a stable Claude Code session from metadata.user_id", () => {
    const converted = convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1024,
      metadata: { user_id: JSON.stringify({ device_id: "device", session_id: "session-123" }) },
      messages: [{ role: "user", content: "continue" }],
    });
    expect(converted.openAI.session_key).toBe("session-123");
  });

  it("accepts Anthropic hosted search declarations without treating them as client functions", () => {
    const converted = convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "search the web" }],
    });
    expect(converted.openAI.tools).toBeUndefined();
    expect(converted.openAI.tool_choice).toBe("none");
    expect(JSON.stringify(converted.openAI.messages)).toContain("Microsoft 365 hosted search");
  });

  it("does not convert an explicitly selected hosted tool into a missing client function", () => {
    const schema = { type: "object", properties: {} };
    const converted = convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1024,
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { name: "Read", input_schema: schema },
      ],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: "search before reading" }],
    });
    expect(converted.openAI.tools).toEqual([{
      type: "function",
      function: { name: "Read", parameters: schema },
    }]);
    expect(converted.openAI.tool_choice).toBe("none");
  });

  it("prevents a Claude subagent from recursively delegating while retaining direct tools", () => {
    const schema = { type: "object", properties: {} };
    const converted = convertAnthropicBody({
      model: "claude-sonnet",
      max_tokens: 1024,
      system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }],
      tools: [
        { name: "Agent", input_schema: schema },
        { name: "Workflow", input_schema: schema },
        { name: "Read", input_schema: schema },
      ],
      messages: [{ role: "user", content: "inspect this directly" }],
    });
    expect(converted.openAI.tools).toEqual([{
      type: "function",
      function: { name: "Read", parameters: schema },
    }]);
    expect(JSON.stringify(converted.openAI.messages)).toContain("already running inside a delegated Claude task");
  });

  it("preserves only a bounded gateway internal diagnostic code", async () => {
    const response = await anthropicRequest(request(), env, async () => Response.json({
      error: { code: "upstream_error", message: "private detail" },
    }, {
      status: 502,
      headers: { "X-M365-Internal-Code": "CHAT_UPSTREAM_ERROR" },
    }));
    expect(response.status).toBe(502);
    expect(response.headers.get("X-M365-Error-Code")).toBe("upstream_error");
    expect(response.headers.get("X-M365-Internal-Code")).toBe("CHAT_UPSTREAM_ERROR");
    expect(await response.text()).not.toContain("private detail");
  });

  it("preserves cancellation as a non-502 client-closed response", async () => {
    const response = await anthropicRequest(request(), env, async () => Response.json({
      error: { code: "request_cancelled", message: "private detail" },
    }, { status: 499 }));
    expect(response.status).toBe(499);
    expect(response.headers.get("X-M365-Error-Code")).toBe("request_cancelled");
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error", message: "request was cancelled" },
    });
  });

  it("flushes a final SSE frame at EOF and emits one terminal", async () => {
    const response = await anthropicRequest(request(), env, async () => upstream(
      `data: {"id":"cmpl_1","model":"test-model","choices":[{"delta":{"content":"hello"}}]}\n\n` +
      `data: {"id":"cmpl_1","model":"test-model","choices":[{"delta":{},"finish_reason":"stop"}]}`,
    ));
    const text = await bodyText(response);
    expect(text).toContain('"text_delta","text":"hello"');
    expect((text.match(/event: message_stop/g) ?? []).length).toBe(1);
  });

  it("treats [DONE] as terminal and suppresses duplicate terminal frames", async () => {
    const response = await anthropicRequest(request(), env, async () => upstream(
      `data: {"choices":[{"delta":{"content":"x"}}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await bodyText(response);
    expect((text.match(/event: message_stop/g) ?? []).length).toBe(1);
    expect((text.match(/event: message_delta/g) ?? []).length).toBe(1);
  });

  it("fails boundedly when an unterminated SSE frame exceeds the buffer cap", async () => {
    const response = await anthropicRequest(request(), env, async () => upstream(`data: ${"x".repeat(1024 * 1024 + 8)}`));
    const text = await bodyText(response);
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: message_stop");
  });

  it("reassembles fragmented OpenAI tool deltas for Hermes", async () => {
    const response = await anthropicRequest(toolRequest(), env, async () => upstream(
      `data: {"id":"cmpl_tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"Get-"}}]}}]}\n\n` +
      `data: {"id":"cmpl_tool","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ChildItem -Force\\"}"}}]}}]}\n\n` +
      `data: {"id":"cmpl_tool","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
      `data: [DONE]\n\n`,
    ));
    const text = await bodyText(response);
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"exec_command"');
    expect(text).toContain('Get-');
    expect(text).toContain('ChildItem -Force');
    expect((text.match(/event: message_stop/g) ?? []).length).toBe(1);
    expect(text).not.toContain('"event":"error"');
  });
});
