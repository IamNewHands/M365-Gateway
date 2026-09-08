import { describe, expect, it } from "vitest";
import {
  compactOversizedResponsesToolOutputs,
  prepareResponsesMultimodal,
  responsesContinuationOutputIssue,
  responsesPrompt,
  selectActiveResponsesInput,
  latestPairedFunctionOutputCallId,
} from "../src/openai";

const image = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" };
const call = { type: "function_call", call_id: "call_image", name: "capture_workspace", arguments: "{}" };

describe("caller tool image continuation", () => {
  it("preserves image parts through early text compaction and call-id validation", () => {
    const output = [image, { type: "input_text", text: "visible window" }];
    const input = [call, { type: "function_call_output", call_id: call.call_id, output }];
    expect(compactOversizedResponsesToolOutputs(input)).toBe(0);
    expect(input[1].output).toBe(output);
    expect(responsesContinuationOutputIssue(input, "")).toBeNull();
    expect(responsesContinuationOutputIssue(input.slice(1), call.call_id)).toBeNull();
    expect(responsesContinuationOutputIssue(input.slice(1), "other_call")).toBe("tool_output_mismatch");
  });

  it("extracts tool images without renaming the tool, promoting its role, or persisting bytes", () => {
    const input = [call, { type: "function_call_output", call_id: call.call_id, output: [image] }];
    const prepared = prepareResponsesMultimodal(input);
    expect(prepared.attachments).toEqual([{ type: "image", url: image.image_url, mimeType: "image/png", detail: "high" }]);
    expect(prepared.value).toMatchObject([call, { type: "function_call_output", call_id: call.call_id }]);
    expect(JSON.stringify(prepared.value)).not.toContain("data:image");
    expect(JSON.stringify(prepared.value)).toContain("IMAGE ATTACHMENTS PRESENT");
    expect(JSON.stringify(prepared.inferenceValue)).not.toContain("IMAGE ATTACHMENTS");
    expect(JSON.stringify(prepared.inferenceValue)).not.toContain("data:image");
    expect(responsesPrompt(prepared.value)).toContain("[TOOL");
    expect(input[1].output).toEqual([image]);
  });

  it("compacts large mixed text only after safely extracting the image", () => {
    const input = [call, { type: "function_call_output", call_id: call.call_id,
      output: [{ type: "input_text", text: "HEAD" + "a".repeat(100_000) + "TAIL" }, image] }];
    compactOversizedResponsesToolOutputs(input);
    const prepared = prepareResponsesMultimodal(input);
    expect(compactOversizedResponsesToolOutputs(prepared.value)).toBe(1);
    expect(prepared.attachments[0].url).toBe(image.image_url);
    expect(responsesPrompt(prepared.value).length).toBeLessThan(65_000);
    expect(JSON.stringify(prepared.value)).toContain("M365 TOOL RESULT COMPACTED");
  });

  it("applies the same aggregate image budget to user and tool images", () => {
    expect(() => prepareResponsesMultimodal([
      { role: "user", content: Array.from({ length: 5 }, () => image) },
      { type: "function_call_output", call_id: call.call_id, output: Array.from({ length: 4 }, () => image) },
    ])).toThrow("TOO_MANY_IMAGES");
  });

  it("still rejects an assistant message introducing input images", () => {
    expect(() => prepareResponsesMultimodal([{ role: "assistant", content: [image] }])).toThrow("INVALID_MULTIMODAL_CONTENT");
  });

  it("selects the new view_image result from a full stateless two-turn replay without reusing the first image", () => {
    const secondImage = { ...image, image_url: "data:image/png;base64,AQID" };
    const secondCall = { ...call, call_id: "call_second_image" };
    const replay = [
      { role: "user", content: "截图并描述画面" }, call,
      { type: "function_call_output", call_id: call.call_id, output: [image] },
      { role: "assistant", content: "第一轮描述" },
      { role: "user", content: "再次截图查看" }, secondCall,
      { type: "function_call_output", call_id: secondCall.call_id, output: [secondImage] },
    ];
    const pendingCallId = latestPairedFunctionOutputCallId(replay);
    expect(pendingCallId).toBe(secondCall.call_id);
    const active = selectActiveResponsesInput(replay, false, { previousResponse: true, pendingCallId, includeMatchingCall: true });
    const prepared = prepareResponsesMultimodal(active);
    expect(prepared.attachments).toEqual([{ type: "image", url: secondImage.image_url, mimeType: "image/png", detail: "high" }]);
    expect(JSON.stringify(prepared.value)).toContain(secondCall.call_id);
    expect(JSON.stringify(prepared.value)).not.toContain(call.call_id);
    expect(JSON.stringify(prepared.value)).not.toContain("data:image/");
    expect(replay[6].output).toEqual([secondImage]);
  });
});
