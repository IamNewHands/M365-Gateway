import { afterEach, describe, expect, it, vi } from "vitest";
import { chatHub, chatHubInvocationWasSubmitted } from "../src/chathub";
import type { OAuthTokenSet } from "../src/types";

const RS = "\u001e";
const account: OAuthTokenSet = {
  accessToken: "offline-deadline-fixture", refreshToken: "offline-deadline-fixture",
  expiresAt: Date.now() + 3_600_000, email: "deadline@example.test",
  displayName: "Offline deadline fixture", oid: "fixture-oid", tid: "fixture-tid",
};

/** In-memory SignalR socket: no network, native timers or Microsoft account use. */
class ScriptedSocket extends EventTarget {
  invocationCount = 0;
  closed = false;
  private submittedResolve!: () => void;
  readonly submitted = new Promise<void>((resolve) => { this.submittedResolve = resolve; });
  accept(): void {}
  send(frame: string): void {
    for (const raw of frame.split(RS).filter(Boolean)) {
      const message = JSON.parse(raw);
      if (message.protocol === "json") this.receive({});
      else if (message.type === 4 && message.target === "chat") {
        this.invocationCount += 1;
        this.submittedResolve();
      }
    }
  }
  receive(message: Record<string, unknown>): void {
    if (!this.closed) this.dispatchEvent(new MessageEvent("message", { data: `${JSON.stringify(message)}${RS}` }));
  }
  close(): void {
    this.closed = true;
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
  }
}

function start(signal?: AbortSignal) {
  const socket = new ScriptedSocket();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ webSocket: socket } as unknown as Response);
  const emitted: string[] = [];
  let settled = false;
  const outcome = chatHub(account, {
    text: "Offline transport fixture; await an actual terminal answer.",
    conversationId: "fixture-conversation", sessionId: "fixture-session",
    started: true, tone: "chat", signal,
  }, (text) => emitted.push(text)).then(
    (result) => { settled = true; return { result, error: undefined }; },
    (error: unknown) => { settled = true; return { result: undefined, error }; },
  );
  return { socket, fetchMock, emitted, outcome, settled: () => settled };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("bounded ChatHub idle and overall deadlines", () => {
  it("fails a completely silent submitted invocation at 90 seconds without replay or fabricated completion", async () => {
    vi.useFakeTimers();
    const run = start();
    await run.socket.submitted;
    await vi.advanceTimersByTimeAsync(89_999);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await run.outcome;
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toMatchObject({ message: "CHAT_PROGRESS_TIMEOUT" });
    expect(chatHubInvocationWasSubmitted(outcome.error)).toBe(true);
    expect(run.socket.closed).toBe(true);
    expect(run.socket.invocationCount).toBe(1);
    expect(run.fetchMock).toHaveBeenCalledTimes(1);
    expect(run.emitted).toEqual([]);
  });

  it.each([
    { label: "SignalR heartbeat", frame: { type: 6 } },
    { label: "public progress summary", frame: { type: 1, target: "update", arguments: [{ messages: [
      { author: "bot", messageType: "Progress", contentOrigin: "ChainOfThoughtSummary", text: "Public activity fixture.", messageId: "summary-fixture" },
    ] }] } },
  ])("bounds endless $label at the ten-minute overall deadline, never as a successful answer", async ({ frame }) => {
    vi.useFakeTimers();
    const run = start();
    await run.socket.submitted;
    const interval = setInterval(() => run.socket.receive(frame), 30_000);
    try {
      await vi.advanceTimersByTimeAsync(599_999);
      expect(run.settled()).toBe(false);
      expect(run.emitted).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await run.outcome;
      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toMatchObject({ message: "CHAT_DEADLINE_EXCEEDED" });
      expect(chatHubInvocationWasSubmitted(outcome.error)).toBe(true);
      expect(run.socket.closed).toBe(true);
      expect(run.socket.invocationCount).toBe(1);
      expect(run.fetchMock).toHaveBeenCalledTimes(1);
      expect(run.emitted).toEqual([]);
    } finally { clearInterval(interval); }
  });

  it("cancels a submitted socket waiting for a frame without waiting for idle or replaying it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = start(controller.signal);
    await run.socket.submitted;
    controller.abort();
    const outcome = await run.outcome;
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toMatchObject({ message: "REQUEST_ABORTED" });
    expect(chatHubInvocationWasSubmitted(outcome.error)).toBe(true);
    expect(run.socket.closed).toBe(true);
    expect(run.socket.invocationCount).toBe(1);
    expect(run.fetchMock).toHaveBeenCalledTimes(1);
    expect(run.emitted).toEqual([]);
  });
});
