import { describe, expect, it } from "vitest";
import {
  assistantReportsIncompleteOutcome,
  boundedToolResultForPrompt,
  compactOversizedResponsesToolOutputs,
  unresolvedAssistantCommitment,
} from "../src/openai";

describe("Responses terminal invariants", () => {
  it.each([
    "I'm correcting that and running a final exact-name and linkage check.",
    "I will fix the malformed CSS value and verify the files.",
    "我正在修复这个颜色值，然后会运行最终检查。",
    "接下来我会修改文件并回读验证。",
    "正在定位 8 号服务器的现有部署配置并执行部署。",
  ])("rejects an unresolved caller-local commitment: %s", (text) => {
    expect(unresolvedAssistantCommitment(text)).toBe(true);
  });

  it("separately identifies an explicit incomplete status", () => {
    expect(assistantReportsIncompleteOutcome(
      "合并发货专项浏览器覆盖和 8 号服务器同步核验仍未完成，因此阶段工作还不能收尾。",
    )).toBe(true);
  });

  it.each([
    "I will explain how to run the test without changing local files.",
    "The phrase \"I'm correcting the file\" is only a quoted example.",
    "`I'm running the command` is protocol documentation, not an action.",
    "> I'm fixing the file\nThis is quoted user text.",
    "The files were corrected and the validator passed.",
    "暂存结果已收到，尚未提交。",
  ])("does not convert explanation, quotation, or completed prose into pending work: %s", (text) => {
    expect(unresolvedAssistantCommitment(text)).toBe(false);
  });

  it("keeps normal tool results intact and deterministically compacts oversized results", () => {
    const ordinary = "a".repeat(19_732);
    expect(boundedToolResultForPrompt(ordinary)).toBe(ordinary);

    const oversized = `HEAD-${"x".repeat(90_000)}-TAIL`;
    const first = boundedToolResultForPrompt(oversized);
    const second = boundedToolResultForPrompt(oversized);
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(64_000);
    expect(first).toContain("M365 TOOL RESULT COMPACTED");
    expect(first).toContain("original=90010");
    expect(first.startsWith("HEAD-")).toBe(true);
    expect(first.endsWith("-TAIL")).toBe(true);
    const markerStart = first.indexOf("\n[M365 TOOL RESULT COMPACTED:");
    const markerEnd = first.indexOf("]\n", markerStart) + 2;
    const declaredOmitted = Number(first.match(/omitted=(\d+)/)?.[1]);
    const retainedOriginalCharacters = markerStart + (first.length - markerEnd);
    expect(markerStart).toBeGreaterThanOrEqual(0);
    expect(markerEnd).toBeGreaterThan(markerStart);
    expect(declaredOmitted).toBe(oversized.length - retainedOriginalCharacters);

    for (const limit of [0, 1, 16, 64, 128]) {
      expect(boundedToolResultForPrompt(oversized, limit).length).toBeLessThanOrEqual(limit);
    }
  });

  it("compacts only oversized Responses tool outputs at the request boundary", () => {
    const normalOutput = { type: "function_call_output", call_id: "call_normal", output: "ok" };
    const oversizedOutput = {
      type: "function_call_output",
      call_id: "call_large",
      output: `HEAD-${"x".repeat(1_100_000)}-TAIL`,
    };
    const userMessage = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "keep the original task unchanged" }],
    };
    const input = [userMessage, normalOutput, oversizedOutput];

    expect(compactOversizedResponsesToolOutputs(input)).toBe(1);
    expect(normalOutput.output).toBe("ok");
    expect(userMessage.content[0]?.text).toBe("keep the original task unchanged");
    expect(oversizedOutput.output.length).toBeLessThanOrEqual(64_000);
    expect(oversizedOutput.output).toContain("M365 TOOL RESULT COMPACTED");
    expect(oversizedOutput.output).toContain("original=1100010");
    expect(oversizedOutput.output.startsWith("HEAD-")).toBe(true);
    expect(oversizedOutput.output.endsWith("-TAIL")).toBe(true);
    expect(compactOversizedResponsesToolOutputs(input)).toBe(0);
  });
});
