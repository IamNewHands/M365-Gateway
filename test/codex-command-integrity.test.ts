import { describe, expect, it } from "vitest";
import { clientToolWireName, normalizeClientFunctionCall, parseNativeFunctionCall } from "../src/chathub";
import { boundPublicExecFunctionCall, normalizeResponsesCustomToolInput, responseFunctionCallEvents, responsesLiteCustomTools } from "../src/openai";

describe("Codex public command integrity", () => {
  it("preserves a schema-valid long command instead of substituting a directory inspection", () => {
    const command = "Write-Output '" + "long-program-data-".repeat(180) + "'";
    const args = { cmd: command, workdir: "C:\\Users\\exampleuser\\Desktop\\771", shell: "powershell" };
    const call = boundPublicExecFunctionCall({ name: clientToolWireName("exec_command"), arguments: JSON.stringify(args) });
    expect(command.length).toBeGreaterThan(2400);
    expect(call?.name).toBe("exec_command");
    expect(JSON.parse(call?.arguments ?? "null")).toEqual(args);
  });

  it("preserves caller-local execution controls rather than clamping them to upstream budgets", () => {
    const args = {
      cmd: "npm test",
      workdir: "C:\\Users\\exampleuser\\Desktop\\771",
      shell: "powershell",
      max_output_tokens: 50000,
      yield_time_ms: 60000,
      tty: true,
      login: false,
      justification: "Verify the requested project",
      prefix_rule: ["npm", "test"],
      sandbox_permissions: "use_default",
    };
    const call = boundPublicExecFunctionCall({ name: "exec_command", arguments: JSON.stringify(args) });
    expect(JSON.parse(call?.arguments ?? "null")).toEqual(args);
  });

  it("preserves exact PowerShell, Unicode, Docker template and token-looking literal bytes", () => {
    const args = {
      cmd: String.raw`$n=[Math]::Max(0,$items.Length-180); $env:NODE_PATH='C:\中文路径'; $items | ForEach-Object { $_.FullName }; docker inspect --format '{{json .Config}}'; Write-Output 'AZHEX Z3DX Z5FX Z3D'`,
      workdir: "C:\\Users\\exampleuser\\Desktop\\服务器",
      shell: "powershell",
    };
    const native = parseNativeFunctionCall({ functionName: clientToolWireName("exec_command"), functionArguments: args });
    expect(native).not.toBeNull();
    const call = boundPublicExecFunctionCall(native);
    expect(JSON.parse(call?.arguments ?? "null")).toEqual(args);
  });

  it.each([false, true])("preserves nested JSON and remote shell bytes in native write_stdin (JSON-string=%s)", (stringEncoded) => {
    const args = {
      session_id: 26957,
      chars: "printf '%s\\n' '中文目录'; docker inspect --format '{{json .Config}}' app\r\n" +
        "printf '%s\\n' '{\"nested\":{\"value\":\"literalZ3DXZ5FX\"}}'\n",
      max_output_tokens: 50000,
      yield_time_ms: 60000,
    };
    const native = parseNativeFunctionCall({
      contentType: "ToolCall", functionName: clientToolWireName("write_stdin"),
      functionArguments: stringEncoded ? JSON.stringify(args) : args,
    });
    expect(native?.name).toBe("write_stdin");
    const safeCall = boundPublicExecFunctionCall(native);
    expect(JSON.parse(safeCall?.arguments ?? "null")).toEqual(args);
  });

  it("preserves native function argument content through every public SSE argument event", () => {
    const args = { cmd: "Write-Output '中文 [Math]::Max $_ $env:USERPROFILE {{json .Config}} Z5FX'", yield_time_ms: 60000 };
    const call = boundPublicExecFunctionCall({ name: "exec_command", arguments: JSON.stringify(args) });
    expect(call).not.toBeNull();
    const item = { type: "function_call", id: "fc_test", call_id: "call_test", status: "completed", ...call };
    const events = responseFunctionCallEvents(item, call!);
    const delta = events.find((event) => event.type === "response.function_call_arguments.delta");
    const done = events.find((event) => event.type === "response.function_call_arguments.done");
    expect(JSON.parse(String(delta?.delta))).toEqual(args);
    expect(JSON.parse(String(done?.arguments))).toEqual(args);
    expect(events.at(-1)?.item).toEqual(item);
  });

  it("preserves functions.exec raw source through custom-tool history, native adaptation and SSE", () => {
    const source = "// @exec: {\"yield_time_ms\": 30000}\r\n" +
      "const args = " + JSON.stringify({ cmd: "[Math]::Max(0,1); Write-Output '$_ 中文 {{json .Config}} Z3DX'", workdir: "C:\\中文路径", max_output_tokens: 50000 }) + ";\r\n" +
      "text(await tools.exec_command(args));\n";
    const tools = responsesLiteCustomTools([{ type: "additional_tools", role: "developer", tools: [{
      type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Execute raw caller JavaScript." }],
    }] }]);
    const history = normalizeResponsesCustomToolInput([{ type: "custom_tool_call", call_id: "call_raw", name: "exec", input: source }]) as Array<{ arguments: string }>;
    expect(JSON.parse(history[0].arguments)).toEqual({ input: source });
    const native = parseNativeFunctionCall({ functionName: clientToolWireName("exec"), functionArguments: { input: source } }, tools);
    const normalized = normalizeClientFunctionCall(native, tools);
    expect(normalized?.name).toBe("exec");
    expect(JSON.parse(normalized?.arguments ?? "null")).toEqual({ input: source });
    const item = { type: "custom_tool_call", id: "ctc_test", call_id: "call_raw", name: "exec", input: source, status: "completed" };
    const events = responseFunctionCallEvents(item, normalized!);
    expect(events.find((event) => event.type === "response.custom_tool_call_input.delta")?.delta).toBe(source);
    expect(events.find((event) => event.type === "response.custom_tool_call_input.done")?.input).toBe(source);
    expect(events.at(-1)?.item).toEqual(item);
  });

  it("still rejects malformed sensitive tool arguments without fabricating a replacement command", () => {
    expect(boundPublicExecFunctionCall({ name: "exec_command", arguments: "not-json" })).toBeNull();
    expect(boundPublicExecFunctionCall({ name: clientToolWireName("write_stdin"), arguments: '{"session_id":"wrong type","chars":"pwd"}' })).toBeNull();
  });
});
