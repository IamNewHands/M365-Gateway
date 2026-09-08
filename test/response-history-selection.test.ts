import { describe, expect, it } from "vitest";
import {
  latestPairedFunctionOutputCallId,
  prepareResponsesMultimodal,
  responsesPrompt,
  selectActiveResponsesInput,
} from "../src/openai";
import { completedToolSnapshots, parseResponsesToolLedger } from "../src/tool-ledger";

const image = { type: "input_image", image_url: "data:image/png;base64,AAAA" };
const call = { type: "function_call", call_id: "call_picture", name: "inspect_render", arguments: "{}" };
const output = { type: "function_call_output", call_id: call.call_id, output: [image] };

describe("Responses history and new user turn selection", () => {
  it("continues a new user request after a completed image tool result", async () => {
    const history = [{ role: "user", content: "Inspect the current rendering." }, call, output];
    const completed = await parseResponsesToolLedger(prepareResponsesMultimodal(history).value);
    expect(completed.pending).toHaveLength(0);
    expect(completed.completed.map((item) => item.callId)).toEqual([call.call_id]);

    const nextUser = { role: "user", content: "Run the existing source checks and report their result." };
    const replay = [...history, nextUser];
    const recoveredCallId = latestPairedFunctionOutputCallId(replay);
    expect(recoveredCallId).toBe("");
    const active = selectActiveResponsesInput(replay, true, {
      previousResponse: Boolean(recoveredCallId),
      pendingCallId: recoveredCallId,
      includeMatchingCall: Boolean(recoveredCallId),
    });
    expect(active).toEqual([nextUser]);
    const prepared = prepareResponsesMultimodal(active);
    const continued = await parseResponsesToolLedger(prepared.value, {
      completedSnapshots: completedToolSnapshots(completed),
    });
    expect(continued.issues).toEqual([]);
    expect(continued.pending).toHaveLength(0);
    expect(continued.completed.map((item) => item.name)).toEqual([call.name]);
    expect(responsesPrompt(prepared.value)).toContain(nextUser.content);
    expect(prepared.attachments).toEqual([]);
  });

  it("keeps an explicitly pending image result with an accompanying new user message", () => {
    const nextUser = { role: "user", content: "Also check the page title." };
    const active = selectActiveResponsesInput([call, output, nextUser], true, {
      previousResponse: true,
      pendingCallId: call.call_id,
    });
    expect(active).toEqual([output, nextUser]);
    expect(prepareResponsesMultimodal(active).attachments).toHaveLength(1);
  });

  it("keeps a pending output-only continuation when the client omits the call", () => {
    expect(latestPairedFunctionOutputCallId([output])).toBe("");
    const active = selectActiveResponsesInput([output], true, {
      previousResponse: true,
      pendingCallId: call.call_id,
    });
    expect(active).toEqual([output]);
    expect(prepareResponsesMultimodal(active).attachments).toHaveLength(1);
  });

  it("recovers the latest causal result when no later user turn supersedes it", () => {
    const input = [{ role: "user", content: "Inspect the current rendering." }, call, output];
    const recoveredCallId = latestPairedFunctionOutputCallId(input);
    expect(recoveredCallId).toBe(call.call_id);
    expect(selectActiveResponsesInput(input, false, {
      previousResponse: true,
      pendingCallId: recoveredCallId,
      includeMatchingCall: true,
    })).toEqual(input);
  });

  it("retains correlation when a pending result arrives after a user clarification", () => {
    const input = [call, { role: "user", content: "Keep the existing theme." }, output];
    expect(latestPairedFunctionOutputCallId(input)).toBe(call.call_id);
  });
});
