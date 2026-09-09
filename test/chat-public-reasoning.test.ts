import { describe, expect, it } from "vitest";
import type { ChatHubResult } from "../src/chathub";
import { chatDeliversPublicReasoning, chatReasoningContent } from "../src/openai";

function resultWithSummaries(summaries?: string[]): ChatHubResult {
  return { text: "answer", ...(summaries ? { publicReasoningSummary: summaries } : {}) } as unknown as ChatHubResult;
}

describe("chat completions public reasoning delivery", () => {
  it("defaults to delivering summaries and only honors an explicit none opt-out", () => {
    for (const value of [undefined, {}, { summary: "auto" }, { summary: "detailed" }, { generate_summary: "concise" }]) {
      expect(chatDeliversPublicReasoning(value as never)).toBe(true);
    }
    expect(chatDeliversPublicReasoning({ summary: "none" })).toBe(false);
    expect(chatDeliversPublicReasoning({ generate_summary: "none" })).toBe(false);
    expect(chatDeliversPublicReasoning({ summary: "auto", generate_summary: "none" })).toBe(true);
  });

  it("returns no reasoning_content when upstream emitted no summary", () => {
    expect(chatReasoningContent(resultWithSummaries(undefined))).toBeUndefined();
    expect(chatReasoningContent(resultWithSummaries([]))).toBeUndefined();
  });

  it("joins unique non-empty summaries without truncating source text", () => {
    const first = "核对当前目录。";
    const second = "检查已有文件。";
    expect(chatReasoningContent(resultWithSummaries([first, first, second, " ", ""]))).toBe(`${first}\n\n${second}`);
  });

  it("skips oversized parts and bounds the total budget like the Responses route", () => {
    const exact = "x".repeat(16_384);
    expect(chatReasoningContent(resultWithSummaries(["x".repeat(16_385), exact, "cannot fit"]))).toBe(exact);
  });

  it("keeps summary content out of the visible answer text", () => {
    const result = resultWithSummaries(["Public fixture A"]);
    expect(chatReasoningContent(result)).toBe("Public fixture A");
    expect((result as unknown as { text: string }).text).toBe("answer");
  });
});
