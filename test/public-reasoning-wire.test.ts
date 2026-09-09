import { describe, expect, it } from "vitest";
import { appendPublicReasoning, publicReasoningEvents, publicReasoningWithDefault, requestsPublicReasoning } from "../src/public-reasoning";

describe("Responses-route public reasoning default", () => {
  it("delivers verified summaries unless the client explicitly opted out", () => {
    for (const value of [undefined, null, {}, "text", { effort: "medium" }, { summary: "auto" }, { generate_summary: "detailed" }]) {
      expect(publicReasoningWithDefault(value)).toBe(true);
    }
    expect(publicReasoningWithDefault({ summary: "none" })).toBe(false);
    expect(publicReasoningWithDefault({ generate_summary: "none" })).toBe(false);
    expect(publicReasoningWithDefault({ summary: "auto", generate_summary: "none" })).toBe(true);
  });
});

describe("optional public reasoning Responses wire", () => {
  it("honors summary and the legacy generate_summary without changing ordinary requests", () => {
    for (const mode of ["auto", "concise", "detailed"]) expect(requestsPublicReasoning({ summary: mode })).toBe(true);
    expect(requestsPublicReasoning({ generate_summary: "auto" })).toBe(true);
    for (const value of [undefined, {}, { effort: "max" }, { summary: "none", generate_summary: "auto" }, { summary: null }, { summary: "hidden" }]) {
      expect(requestsPublicReasoning(value)).toBe(false);
    }
  });

  it("leaves the original output untouched when no real public summary is supplied", () => {
    const output = [{ type: "message", content: [{ text: "I will inspect the file" }] }];
    expect(appendPublicReasoning(output, undefined, true)).toBe(output);
    expect(appendPublicReasoning(output, ["summary"], false)).toBe(output);
    expect(publicReasoningEvents(output)).toEqual([]);
  });

  it("keeps native and custom tool IDs, indices and arguments byte-identical", () => {
    for (const type of ["function_call", "custom_tool_call"]) {
      const tool = { id: "fc_1", type, call_id: "call_original", name: "exec_command", arguments: '[Math]::Max(0, $a); $env:USERPROFILE', input: "await tools.exec_command({cmd:'你好'});" };
      const output = appendPublicReasoning([tool], ["核对当前目录。", "检查已有文件。"], true);
      expect(output[0]).toBe(tool);
      const events = publicReasoningEvents(output);
      expect(events).toHaveLength(10);
      expect(events.every((event) => event.output_index === 1)).toBe(true);
      expect(events.filter((event) => event.type === "response.reasoning_summary_text.done").map((event) => event.text)).toEqual(["核对当前目录。", "检查已有文件。"]);
      expect(events.at(-1)?.item).toBe(output[1]);
    }
  });

  it("bounds public metadata without altering or truncating source text", () => {
    const exact = "😀".repeat(8192);
    const output = appendPublicReasoning([], ["", exact, exact, "cannot fit"], true);
    expect(output).toMatchObject([{ type: "reasoning", summary: [{ text: exact }] }]);
    expect(appendPublicReasoning([], ["x".repeat(16_385)], true)).toEqual([]);
    const many = appendPublicReasoning([], Array.from({ length: 1000 }, (_, i) => String(i)), true);
    expect((many[0] as { summary: unknown[] }).summary).toHaveLength(64);
  });
});
