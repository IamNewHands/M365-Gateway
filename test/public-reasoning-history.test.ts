import { describe, expect, it } from "vitest";
import type { ChatHubResult } from "../src/chathub";
import { portableAssistantResult, responsesPrompt } from "../src/openai";
import { appendPublicReasoning, publicReasoningEvents } from "../src/public-reasoning";

describe("public summary history isolation", () => {
  it("does not turn a round-tripped summary into user input or tool evidence", () => {
    const user = { role: "user", content: "Read the requested fixture." };
    const call = { type: "function_call", name: "exec_command", call_id: "call_fixture", arguments: '{"cmd":"Write-Output fixture"}' };
    const result = { type: "function_call_output", call_id: "call_fixture", output: "fixture" };
    const next = { role: "user", content: "Report the result." };
    const withSummary = appendPublicReasoning([call], ["PUBLIC_SUMMARY_NOT_PROMPT_EVIDENCE"], true);

    const expected = responsesPrompt([user, call, result, next]);
    const actual = responsesPrompt([user, ...withSummary, result, next]);
    expect(actual).toBe(expected);
    expect(actual).toContain("[TOOL RESULT call_fixture]");
    expect(actual).not.toContain("PUBLIC_SUMMARY_NOT_PROMPT_EVIDENCE");
  });

  it("keeps portable answer and tool-call history unchanged by summary metadata", () => {
    const base: ChatHubResult = {
      text: "The fixture was read.", conversationId: "fixture-conversation",
      sessionId: "fixture-session", requestId: "fixture-request",
    };
    const withSummary = { ...base, publicReasoningSummary: ["PUBLIC_SUMMARY_NOT_PORTABLE_HISTORY"] };
    const call = { name: "exec_command", arguments: '{"cmd":"Write-Output fixture"}' };
    expect(portableAssistantResult(withSummary)).toBe(portableAssistantResult(base));
    expect(portableAssistantResult(withSummary, call)).toBe(portableAssistantResult(base, call));
    expect(portableAssistantResult(withSummary)).not.toContain("PUBLIC_SUMMARY_NOT_PORTABLE_HISTORY");
  });

  it("bounds final-only summary delivery to 258 events without answer deltas", () => {
    const business = { id: "msg_fixture", type: "message", content: [{ type: "output_text", text: "Final fixture." }] };
    const summaries = Array.from({ length: 100 }, (_, i) => `Public fixture ${i}`);
    const output = appendPublicReasoning([business], summaries, true);
    const events = publicReasoningEvents(output);
    expect(output[0]).toBe(business);
    expect(events).toHaveLength(2 + 4 * 64);
    expect(events.every((event) => event.output_index === 1)).toBe(true);
    expect(events.some((event) => event.type === "response.output_text.delta")).toBe(false);
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "response.output_item.done", item: output[1] });
  });
});
