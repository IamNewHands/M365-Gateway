import { describe, expect, it } from "vitest";
import { clientToolWireName, normalizeClientFunctionCall, parseFunctionCall, parseNativeFunctionCall, type FunctionCall } from "../src/chathub";
import { parseToolRouterDecision, repairFunctionCallTaskAnchors, responsesLiteCustomTools } from "../src/openai";
import type { TaskAnchor } from "../src/task-anchors";

const historicalAnchors: TaskAnchor[] = [{ kind: "windows_path", value: "C:/fixtures/服务器" }];
const legalNewPath = "C:/fixtures/服务器X";
const execTool = { type: "function", name: "exec_command", parameters: {
  type: "object", properties: { cmd: { type: "string" }, workdir: { type: "string" } }, required: ["cmd"], additionalProperties: false,
} };

function legacyAZHEX(value: string): string {
  return Array.from(value, (character) => /[A-Ya-z0-9\u0080-\uFFFF]/u.test(character)
    ? character : `Z${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}X`).join("");
}

describe("Codex native argument integrity with historical path anchors", () => {
  it("does not change an explicit native command or workdir naming a legitimate new X suffix", () => {
    const args = { cmd: `Get-Item -LiteralPath '${legalNewPath}'`, workdir: legalNewPath };
    const native = parseNativeFunctionCall({ functionName: clientToolWireName("exec_command"), functionArguments: args }, [execTool]);
    expect(native).not.toBeNull();
    expect(JSON.parse(native!.arguments)).toEqual(args);
    expect(JSON.parse(repairFunctionCallTaskAnchors(native!, historicalAnchors).arguments)).toEqual(args);
  });

  it("does not rewrite ordinary structured router JSON as though it were legacy encoded text", () => {
    const args = { cmd: `Get-Item -LiteralPath '${legalNewPath}'` };
    const routed = parseToolRouterDecision(JSON.stringify({ calls: [{ name: clientToolWireName("exec_command"), arguments: args }] }), [execTool], "required");
    expect(routed.call).not.toBeNull();
    expect(JSON.parse(repairFunctionCallTaskAnchors(routed.call!, historicalAnchors).arguments)).toEqual(args);
  });

  it("does not remove a literal X from remote stdin script data", () => {
    const args = { session_id: 26957, chars: `printf '%s\\n' '${legalNewPath}'\n` };
    const native = parseNativeFunctionCall({ functionName: clientToolWireName("write_stdin"), functionArguments: args });
    expect(native).not.toBeNull();
    expect(JSON.parse(repairFunctionCallTaskAnchors(native!, historicalAnchors).arguments)).toEqual(args);
  });

  it("does not rewrite native custom-tool patch contents based on an unrelated historical anchor", () => {
    const input = `*** Begin Patch\n*** Add File: fixtures.js\n+const example = '${legalNewPath}';\n*** End Patch`;
    const tools = responsesLiteCustomTools([{ type: "additional_tools", role: "developer", tools: [{
      type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch to the caller workspace." }],
    }] }]);
    const native = parseNativeFunctionCall({ functionName: clientToolWireName("apply_patch"), functionArguments: { input } }, tools);
    expect(native).not.toBeNull();
    expect(JSON.parse(repairFunctionCallTaskAnchors(native!, historicalAnchors).arguments)).toEqual({ input });
  });

  it("retains existing explicit legacy AZHEX compatibility for an actually encoded artifact", () => {
    const encodedArgs = { cmd: legacyAZHEX("Get-Item -LiteralPath 'C:/fixtures/服务X器X'") };
    const legacy = parseFunctionCall(`\`\`\`${clientToolWireName("exec_command")}\n${JSON.stringify(encodedArgs)}\n\`\`\``, [execTool]);
    expect(legacy).not.toBeNull();
    expect(legacy?.argumentEncoding).toBe("legacy_azhex");
    expect(JSON.parse(repairFunctionCallTaskAnchors(legacy!, historicalAnchors).arguments))
      .toEqual({ cmd: "Get-Item -LiteralPath 'C:/fixtures/服务器'" });
  });

  it("retains explicit legacy provenance through JSON storage/RPC serialization and normalization", () => {
    const encodedArgs = { cmd: legacyAZHEX("Get-Item -LiteralPath 'C:/fixtures/服务X器X'") };
    const legacy = parseFunctionCall(`<tool_call>${JSON.stringify({ name: clientToolWireName("exec_command"), arguments: encodedArgs })}</tool_call>`, [execTool]);
    expect(legacy?.argumentEncoding).toBe("legacy_azhex");
    const stored = JSON.parse(JSON.stringify(legacy)) as FunctionCall;
    const restored = normalizeClientFunctionCall(stored, [execTool]);
    expect(restored?.argumentEncoding).toBe("legacy_azhex");
    expect(JSON.parse(repairFunctionCallTaskAnchors(restored!, historicalAnchors).arguments))
      .toEqual({ cmd: "Get-Item -LiteralPath 'C:/fixtures/服务器'" });
  });

  it("does not accept upstream-supplied provenance metadata on native or ordinary JSON calls", () => {
    const args = { cmd: `Get-Item -LiteralPath '${legalNewPath}'` };
    const native = parseNativeFunctionCall({ functionName: clientToolWireName("exec_command"), functionArguments: args, argumentEncoding: "legacy_azhex" }, [execTool]);
    const routed = parseToolRouterDecision(JSON.stringify({ calls: [{ name: clientToolWireName("exec_command"), arguments: args, argumentEncoding: "legacy_azhex" }] }), [execTool], "required");
    expect(native).not.toHaveProperty("argumentEncoding");
    expect(routed.call).not.toHaveProperty("argumentEncoding");
    expect(JSON.parse(repairFunctionCallTaskAnchors(native!, historicalAnchors).arguments)).toEqual(args);
    expect(JSON.parse(repairFunctionCallTaskAnchors(routed.call!, historicalAnchors).arguments)).toEqual(args);
  });

  it("retains a known exact X path when both paths were independently supplied", () => {
    const args = { cmd: `Get-Item -LiteralPath '${legalNewPath}'` };
    const native = parseNativeFunctionCall({ functionName: clientToolWireName("exec_command"), functionArguments: args }, [execTool]);
    expect(JSON.parse(repairFunctionCallTaskAnchors(native!, [...historicalAnchors, { kind: "windows_path", value: legalNewPath }]).arguments))
      .toEqual(args);
  });
});
