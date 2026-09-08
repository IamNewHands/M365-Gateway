import { describe, expect, it } from "vitest";
import { anthropicRequest, convertAnthropicBody } from "../src/anthropic";
import { modelTone } from "../src/models";
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
