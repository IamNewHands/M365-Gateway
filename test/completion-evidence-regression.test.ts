import { describe, expect, it } from "vitest";
import {
  classifyCompletionActions,
  evaluateCompletionEvidence,
  summarizeCompletionEvidence,
  type CompletionEvidenceRecord,
} from "../src/completion-evidence";
import {
  completedToolSnapshots,
  parseResponsesToolLedger,
  type ToolLedgerSnapshotEntry,
} from "../src/tool-ledger";

const pollutedPagePatch = `*** Begin Patch
*** Add File: index.html
+<h1>Gateway health and recent activity</h1>
+<p>Identity checks are healthy.</p>
*** Add File: style.css
+.topbar{display:flex;align-items:flex-start}
*** Add File: app.js
+tabs.forEach((item) => item.classList.remove("active"));
*** End Patch`;

const exactMixedTerminal = "The three requested files are present and wired, but the read-back exposed one malformed light-theme color value. I’m correcting that and running a final exact-name and linkage check. and read back the three requested files:\n\n- `index.html`\n- `style.css`\n- `app.js`\n\nVerified the stylesheet and script references, three navigation tabs, status cards, theme toggle, and timestamped activity-entry button.";

function evidence(
  name: string,
  argumentsValue: unknown,
  result = "Process exited with code 0\nSuccess",
): CompletionEvidenceRecord {
  return { name, arguments: argumentsValue, result };
}

function codeModeCommand(cmd: string): { input: string } {
  return { input: `const r = await tools.exec_command(${JSON.stringify({ cmd })}); text(r.output);` };
}

describe("completion evidence operation boundaries", () => {
  it("classifies apply_patch only from patch headers, never from page source vocabulary", () => {
    expect(classifyCompletionActions(evidence("apply_patch", { input: pollutedPagePatch })))
      .toEqual(["fix", "create"]);

    expect(classifyCompletionActions(evidence("apply_patch", {
      input: "*** Begin Patch\n*** Update File: app.js\n+health checks remove flex-start\n*** End Patch",
    }))).toEqual(["fix", "configure"]);
  });

  it("classifies Code Mode exec from a static exec_command cmd and ignores its opaque operands", () => {
    expect(classifyCompletionActions(evidence("exec", codeModeCommand(
      "Set-Content index.html -Value 'health checks remove flex-start npm test'",
    )))).toEqual(["configure"]);

    expect(classifyCompletionActions(evidence("exec", codeModeCommand("Get-Content style.css -Raw"))))
      .toEqual([]);
    expect(classifyCompletionActions(evidence("exec", codeModeCommand("npm test"))))
      .toEqual(["verify"]);
  });

  it("does not accept an ordered write/read-back when only the outer Code Mode wrapper completed", () => {
    const script = [
      'const write = await tools.exec_command({cmd: "Set-Content -Path index.html -Value \'ok\' -NoNewline"});',
      'const read = await tools.exec_command({cmd: "Get-Content -Raw -Path index.html"});',
      "text(read.output);",
    ].join(" ");
    const record = evidence("exec", { input: script }, "Script completed\n\"ok\"");
    const summary = summarizeCompletionEvidence({ completed: [record], pending: [] });

    expect(summary.actions.configure?.latest).toBe("unknown");
    expect(summary.actions.create?.latest).toBe("unknown");
    expect(summary.actions.verify?.latest).toBe("unknown");
    expect(evaluateCompletionEvidence("写入并验证已完成。", summary)).toMatchObject({
      allowed: false,
      reason: "unknown_evidence",
    });
  });

  it("preserves structured child exit codes over wrapper text", async () => {
    const call = { type: "function_call", call_id: "call_verify", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) };
    const succeeded = await parseResponsesToolLedger([
      call,
      { type: "function_call_output", call_id: "call_verify", output: { exit_code: 0, output: "Script completed\nnot found is test fixture text" } },
    ]);
    const failed = await parseResponsesToolLedger([
      { ...call, call_id: "call_failed" },
      { type: "function_call_output", call_id: "call_failed", output: { exit_code: 1, output: "Script completed" } },
    ]);

    expect(succeeded.completed[0]).toMatchObject({ failed: false, status: "success" });
    expect(summarizeCompletionEvidence(succeeded).actions.verify?.latest).toBe("success");
    expect(failed.completed[0]).toMatchObject({ failed: true, status: "failure" });
    expect(summarizeCompletionEvidence(failed).actions.verify?.latest).toBe("failure");
  });

  it("finds a failed command result nested inside a completed Code Mode cell", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_nested", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) },
      {
        type: "function_call_output",
        call_id: "call_nested",
        output: JSON.stringify({
          status: "completed",
          verified: { chunk_id: "fixture", exit_code: 1, output: "TypeScript failed" },
        }),
      },
    ]);

    expect(ledger.completed[0]).toMatchObject({ failed: true, status: "failure" });
    expect(summarizeCompletionEvidence(ledger).actions.verify?.latest).toBe("failure");
  });

  it("does not interpret JSON-like stdout as a nested command status", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_stdout", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) },
      {
        type: "function_call_output",
        call_id: "call_stdout",
        output: JSON.stringify({ exit_code: 0, output: '{"fixture":{"exit_code":1}}' }),
      },
    ]);

    expect(ledger.completed[0]).toMatchObject({ failed: false, status: "success" });
  });

  it("decodes HTML whitespace before classifying a wrapped inner command failure", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_encoded", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) },
      { type: "function_call_output", call_id: "call_encoded", output: "Script completed\n&#x20; not found" },
    ]);

    expect(ledger.completed[0]).toMatchObject({ failed: true, status: "failure" });
    expect(evaluateCompletionEvidence("测试已完成。", ledger)).toMatchObject({
      allowed: false,
      reason: "failed_evidence",
    });
  });

  it("keeps ambiguous wrapper status unknown across Responses snapshots", async () => {
    const ledger = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_ambiguous", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) },
      { type: "function_call_output", call_id: "call_ambiguous", output: "Script completed\nTests produced no child exit code" },
    ]);
    const snapshots = completedToolSnapshots(ledger);
    const restored = await parseResponsesToolLedger([], { completedSnapshots: snapshots });

    expect(ledger.completed[0]).toMatchObject({ failed: false, status: "unknown" });
    expect(snapshots[0]).toMatchObject({ failed: false, status: "unknown" });
    expect(summarizeCompletionEvidence(restored).actions.verify?.latest).toBe("unknown");
  });

  it("rejects the exact mixed Codex terminal after a polluted patch and passive read-back", () => {
    const completed = [
      evidence("apply_patch", { input: pollutedPagePatch }, "Done!"),
      evidence("exec", codeModeCommand("Get-Content style.css -Raw"), "--accent:#556e8"),
    ];

    expect(evaluateCompletionEvidence(exactMixedTerminal, { completed, pending: [] })).toMatchObject({
      allowed: false,
      reason: "missing_evidence",
      claimedActions: ["verify"],
      unsupportedActions: ["verify"],
    });
  });
});

describe("completion evidence freshness", () => {
  const validator = evidence("exec", codeModeCommand("npm test"), "Process exited with code 0\nTests passed");
  const mutation = evidence("apply_patch", { input: pollutedPagePatch }, "Done!");

  it("invalidates verification evidence when a mutation happens afterwards", () => {
    const summary = summarizeCompletionEvidence({ completed: [validator, mutation], pending: [] });
    expect(summary.actions.verify).toBeUndefined();
    expect(evaluateCompletionEvidence("Verified the local files.", summary)).toMatchObject({
      allowed: false,
      reason: "missing_evidence",
      unsupportedActions: ["verify"],
    });
  });

  it("accepts a real successful validator after the latest mutation", () => {
    const summary = summarizeCompletionEvidence({ completed: [mutation, validator], pending: [] });
    expect(summary.actions.verify?.latest).toBe("success");
    expect(evaluateCompletionEvidence("Verified the local files.", summary)).toMatchObject({
      allowed: true,
      reason: "supported",
      claimedActions: ["verify"],
    });
  });

  it("preserves freshness ordering across sanitized Responses snapshots", async () => {
    const parsed = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_verify", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) },
      { type: "function_call_output", call_id: "call_verify", output: "Process exited with code 0\nTests passed" },
      { type: "function_call", call_id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ input: pollutedPagePatch }) },
      { type: "function_call_output", call_id: "call_patch", output: "Done!" },
    ]);
    const snapshots = completedToolSnapshots(parsed);
    const restored = await parseResponsesToolLedger([], { completedSnapshots: snapshots });

    expect(snapshots.every((snapshot) => snapshot.actionSchemaVersion === 2)).toBe(true);
    expect(evaluateCompletionEvidence("Verified the local files.", restored)).toMatchObject({
      allowed: false,
      reason: "missing_evidence",
    });
  });

  it("accepts post-mutation validation across sanitized Responses snapshots", async () => {
    const parsed = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_patch", name: "apply_patch", arguments: JSON.stringify({ input: pollutedPagePatch }) },
      { type: "function_call_output", call_id: "call_patch", output: "Done!" },
      { type: "function_call", call_id: "call_verify", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) },
      { type: "function_call_output", call_id: "call_verify", output: "Process exited with code 0\nTests passed" },
    ]);
    const restored = await parseResponsesToolLedger([], { completedSnapshots: completedToolSnapshots(parsed) });

    expect(evaluateCompletionEvidence("Verified the local files.", restored)).toMatchObject({
      allowed: true,
      reason: "supported",
    });
  });

  it("does not trust action hints persisted by an older classifier schema", async () => {
    const parsed = await parseResponsesToolLedger([
      { type: "function_call", call_id: "call_verify", name: "exec", arguments: JSON.stringify(codeModeCommand("npm test")) },
      { type: "function_call_output", call_id: "call_verify", output: "Process exited with code 0\nTests passed" },
    ]);
    const legacy = completedToolSnapshots(parsed).map((snapshot): ToolLedgerSnapshotEntry => {
      const { actionSchemaVersion: _discarded, ...withoutVersion } = snapshot;
      return withoutVersion;
    });
    const restored = await parseResponsesToolLedger([], { completedSnapshots: legacy });

    expect(evaluateCompletionEvidence("Verified the local files.", restored)).toMatchObject({
      allowed: false,
      reason: "missing_evidence",
    });
  });
});
