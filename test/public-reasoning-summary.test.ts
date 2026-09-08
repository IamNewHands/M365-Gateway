import { afterEach, describe, expect, it, vi } from "vitest";
import { chatHub, clientToolWireName } from "../src/chathub";
import type { OAuthTokenSet } from "../src/types";

const RS = "\u001e";
const account: OAuthTokenSet = {
  accessToken: "public-summary-test-token",
  refreshToken: "public-summary-test-refresh",
  expiresAt: Date.now() + 60_000,
  email: "public-summary@example.test",
  displayName: "Public summary fixture",
  oid: "00000000-0000-4000-8000-000000000001",
  tid: "00000000-0000-4000-8000-000000000002",
};

function summary(text: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { author: "bot", messageType: "Progress", contentOrigin: "ChainOfThoughtSummary", text, ...extra };
}

function installUpstream(events: Record<string, unknown>[]): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    let handshake = false;
    server.addEventListener("message", () => {
      if (!handshake) {
        handshake = true;
        server.send(`{}${RS}`);
        return;
      }
      server.send(events.map((event) => `${JSON.stringify(event)}${RS}`).join(""));
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
}

function update(messages: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 1, target: "update", arguments: [{ messages, ...extra }] };
}

function complete(messages: Record<string, unknown>[] = [], text = "Final answer fixture"): Record<string, unknown>[] {
  return [{ type: 2, item: { messages, result: { message: text } } }, { type: 3 }];
}

function run(extra: Partial<Parameters<typeof chatHub>[1]> = {}, emit?: (text: string) => void) {
  return chatHub(account, {
    text: "Local protocol fixture, no network inference",
    conversationId: "00000000-0000-4000-8000-000000000003",
    sessionId: "00000000-0000-4000-8000-000000000004",
    started: true,
    tone: "chat",
    ...extra,
  }, emit);
}

afterEach(() => vi.restoreAllMocks());

describe("actual public ChatHub reasoning summaries", () => {
  it("collects exact public texts from update and completion, once each, without emitting them as answers", async () => {
    const first = "  **Public fixture A**\nOriginal whitespace stays.  ";
    const second = "Public fixture B 🧪";
    installUpstream([
      update([summary(first)], { writeAtCursor: "must not become answer text" }),
      update([summary(first)]),
      ...complete([summary(first), summary(second)]),
    ]);
    const emitted: string[] = [];
    const result = await run({}, (text) => emitted.push(text));
    expect(result.publicReasoningSummary).toEqual([first, second]);
    expect(result.text).toBe("Final answer fixture");
    expect(emitted.join("")).not.toContain(first);
    expect(emitted.join("")).not.toContain("must not become answer text");
  });

  it("keeps only the latest snapshot for a known summary message ID", async () => {
    installUpstream([
      update([summary("Public draft fixture", { messageId: "summary-a" })]),
      update([summary("Public second fixture", { messageId: "summary-b" })]),
      ...complete([summary("Public revised fixture", { messageId: "summary-a" })]),
    ]);
    expect((await run()).publicReasoningSummary).toEqual(["Public revised fixture", "Public second fixture"]);
  });

  it("excludes answer, code, search, internal, non-bot and malformed content", async () => {
    installUpstream([
      update([
        summary("user fixture", { author: "user" }),
        summary("tool fixture", { author: "tool" }),
        summary("chat fixture", { messageType: "Chat" }),
        summary("internal fixture", { messageType: "InternalSearchQuery" }),
        summary("code fixture", { contentOrigin: "CodeInterpreter", contentType: "Code", addToChainOfThought: true }),
        summary("search fixture", { contentOrigin: "Search", contentType: "SearchResults" }),
        summary("contradictory code fixture", { contentType: "Code" }),
        summary("contradictory search fixture", { contentType: "SearchResults" }),
        summary("unmarked fixture", { contentOrigin: undefined }),
        summary({ text: "object is not public text" }),
        summary(""),
        summary(" \n\t "),
        summary(undefined, { hiddenText: "never copy this field" }),
      ]),
      ...complete(),
    ]);
    const result = await run();
    expect(result).not.toHaveProperty("publicReasoningSummary");
    expect(result.text).toBe("Final answer fixture");
  });

  it("omits an oversized summary without breaking the answer or cutting Unicode", async () => {
    const accepted = "🧪".repeat(8_192);
    installUpstream([
      update([summary("x".repeat(16_385))]),
      update([summary(accepted), summary("over budget")]),
      ...complete(),
    ]);
    const result = await run();
    expect(result.publicReasoningSummary).toHaveLength(1);
    expect(result.publicReasoningSummary?.[0] === accepted).toBe(true);
    expect(result.text).toBe("Final answer fixture");
  });

  it("bounds the number of unique small summary parts", async () => {
    installUpstream([update(Array.from({ length: 100 }, (_, index) => summary(`fixture-${index}`))), ...complete()]);
    const result = await run();
    expect(result.publicReasoningSummary).toHaveLength(64);
    expect(result.publicReasoningSummary?.at(-1)).toBe("fixture-63");
  });

  it("does not retain an obsolete summary if its replacement exceeds the bound", async () => {
    installUpstream([
      update([summary("Public old fixture", { messageId: "summary-a" })]),
      ...complete([summary("x".repeat(16_385), { messageId: "summary-a" })]),
    ]);
    const result = await run();
    expect(result).not.toHaveProperty("publicReasoningSummary");
    expect(result.text).toBe("Final answer fixture");
  });

  it("deduplicates identical public texts even when update and completion IDs differ", async () => {
    installUpstream([
      update([summary("Public repeated fixture", { messageId: "summary-a" })]),
      ...complete([summary("Public repeated fixture", { messageId: "summary-b" })]),
    ]);
    expect((await run()).publicReasoningSummary).toEqual(["Public repeated fixture"]);
  });

  it("does not turn summary-only output into a successful answer", async () => {
    installUpstream([update([summary("Public fixture only")]), ...complete([], "")]);
    await expect(run()).rejects.toThrow("CHAT_RETURNED_NO_CONTENT");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves native caller tool identity and arguments alongside a summary", async () => {
    const command = "Write-Output 'unchanged fixture'";
    const tools = [{ type: "function", function: { name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } } }];
    const toolText = JSON.stringify({ calls: [{ name: clientToolWireName("exec_command"), arguments: { cmd: command } }] });
    installUpstream([update([summary("Public tool choice fixture")]), ...complete([], toolText)]);
    const result = await run({ tools, toolChoice: "required" });
    expect(result.functionCall?.name).toBe("exec_command");
    expect(JSON.parse(result.functionCall!.arguments)).toEqual({ cmd: command });
    expect(result.toolDecision).toBe("tool_call");
    expect(result.publicReasoningSummary).toEqual(["Public tool choice fixture"]);
  });

  it("does not add a result field to a normal answer with no summary", async () => {
    installUpstream(complete());
    expect(await run()).not.toHaveProperty("publicReasoningSummary");
  });
});
