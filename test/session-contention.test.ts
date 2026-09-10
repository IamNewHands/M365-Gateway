import { describe, expect, it, vi } from "vitest";
import {
  acquireUpstreamGate,
  acquireConversationLease,
  attachResponsesTerminalDelivery,
  bridgePendingResponsesStream,
  conversationLeaseRetryDelay,
  createResponsesTerminalDelivery,
  retireSupersededUpstream,
  responsesAliasSeedRetryDelay,
  retryResponsesAliasSeed,
  upstreamGateRetryDelay,
} from "../src/openai";

describe("Responses session contention", () => {
  it("uses bounded backoff for malformed or zero gate hints", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 20].map((retry) => upstreamGateRetryDelay(retry, 0, 120_000));
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
    expect(upstreamGateRetryDelay(0, Number.NaN, 75)).toBe(75);
    expect(upstreamGateRetryDelay(0, Number.POSITIVE_INFINITY, 75)).toBe(75);
    expect(upstreamGateRetryDelay(0, 20_000, 60_000)).toBe(1_000);
    expect(upstreamGateRetryDelay(1, 20_000, 60_000)).toBe(5_000);
    expect(upstreamGateRetryDelay(0, 0, 0)).toBe(0);
  });

  it("keeps a logical-deadline gate wait below the RPC burst threshold", async () => {
    vi.useFakeTimers();
    try {
      let acquireCalls = 0;
      let cancelled = 0;
      const state = {
        acquireUpstream: async () => {
          acquireCalls += 1;
          return { ok: false, leaseId: "", retryAfterMs: 0 } as const;
        },
        cancelUpstreamWaiter: async () => { cancelled += 1; },
      };
      const env = { TENANTS: { getByName: () => state } };
      const pending = acquireUpstreamGate(
        env as never,
        "account-1",
        1,
        undefined,
        Date.now() + 15_000,
      );
      // Attach the rejection handler before advancing fake time; otherwise
      // Vitest quite correctly reports the intentionally timed-out promise as
      // an unhandled rejection while the clock is being flushed.
      const outcome = pending.then(
        () => null,
        (cause: unknown) => cause,
      );
      // Flush the complete bounded wait.  The exact number is deliberately
      // derived from the exported delay policy instead of a retry-count cap.
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(outcome).resolves.toMatchObject({ message: "CHAT_DEADLINE_EXCEEDED" });
      expect(acquireCalls).toBeLessThanOrEqual(12);
      expect(acquireCalls).toBeGreaterThan(1);
      expect(cancelled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the primary gate error when waiter cleanup RPC fails", async () => {
    vi.useFakeTimers();
    try {
      const state = {
        acquireUpstream: async () => ({ ok: false, leaseId: "", retryAfterMs: 0 } as const),
        cancelUpstreamWaiter: async () => { throw new Error("transient cleanup transport failure"); },
      };
      const env = { TENANTS: { getByName: () => state } };
      const pending = acquireUpstreamGate(env as never, "account-1", 1, undefined, Date.now() + 15_000);
      const outcome = pending.then(() => null, (cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(outcome).resolves.toMatchObject({ message: "CHAT_DEADLINE_EXCEEDED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows one short busy-lease grace retry before returning contention", () => {
    expect([0, 1, 2, 3, 20].map((retry) => conversationLeaseRetryDelay(retry, 15_000)))
      .toEqual([250, 0, 0, 0, 0]);
    expect(conversationLeaseRetryDelay(0, 173)).toBe(173);
  });

  it("acquires a lease that becomes free during the contention grace", async () => {
    vi.useFakeTimers();
    try {
      let acquireCalls = 0;
      const replacement = {
        leaseId: "fresh-lease",
        conversationId: "fresh-conversation",
        sessionId: "fresh-session",
        accountId: "account-1",
        accountLocked: true,
        started: false,
        pendingCallId: "",
        pendingToolName: "",
        pendingToolArguments: "",
        toolLedgerSnapshot: "[]",
        taskAnchors: [],
        portableProtocolTail: "portable context",
      };
      const session = {
        tryAcquire: async () => {
          acquireCalls += 1;
          return acquireCalls === 1
            ? { ok: false, code: "CONVERSATION_BUSY" } as const
            : { ok: true, lease: replacement } as const;
        },
      };
      const pending = acquireConversationLease({} as never, session as never, Date.now() + 10_000);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toBe(replacement);
      expect(acquireCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces contention without cancelling an active Microsoft invocation", async () => {
    vi.useFakeTimers();
    try {
      const session = {
        tryAcquire: async () => ({ ok: false, code: "CONVERSATION_BUSY" } as const),
        supersedeActive: async () => { throw new Error("must not supersede an active request"); },
      };
      const pending = acquireConversationLease({} as never, session as never, Date.now() + 10_000);
      const rejected = expect(pending).rejects.toThrow("CONVERSATION_BUSY");
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an exact old gate only after runner cancellation is confirmed", async () => {
    const upstream = { accountId: "account-1", runId: "run-1", gateLeaseId: "gate-1" };
    const ordered: string[] = [];
    await retireSupersededUpstream(
      upstream,
      async () => { ordered.push("cancel-settled"); return "cancelled"; },
      async () => { ordered.push("release-exact-gate"); },
    );
    expect(ordered).toEqual(["cancel-settled", "release-exact-gate"]);

    let unsafeRelease = false;
    await retireSupersededUpstream(
      upstream,
      async () => { throw new Error("runner unavailable"); },
      async () => { unsafeRelease = true; },
    );
    expect(unsafeRelease).toBe(false);

    await retireSupersededUpstream(
      upstream,
      async () => "invalid",
      async () => { unsafeRelease = true; },
    );
    expect(unsafeRelease).toBe(false);
  });

  it("propagates an early bridge disconnect and cancels a late real stream", async () => {
    let resolvePending!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolvePending = resolve; });
    let cancelCalls = 0;
    let resolveInnerCancellation!: () => void;
    const innerCancelled = new Promise<void>((resolve) => { resolveInnerCancellation = resolve; });

    const bridged = bridgePendingResponsesStream(pending, () => { cancelCalls += 1; });
    const reader = bridged.body!.getReader();
    const created = await reader.read();
    const inProgress = await reader.read();
    expect(new TextDecoder().decode(created.value)).toContain("event: response.created");
    expect(new TextDecoder().decode(inProgress.value)).toContain("event: response.in_progress");

    await reader.cancel();
    expect(cancelCalls).toBe(1);

    resolvePending(new Response(new ReadableStream<Uint8Array>({
      cancel() { resolveInnerCancellation(); },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    await innerCancelled;
    expect(cancelCalls).toBe(1);
  });

  it("publishes a staged alias before direct terminal delivery", async () => {
    const order: string[] = [];
    const delivery = createResponsesTerminalDelivery();
    expect(delivery.claim("direct")).toBe(true);
    await delivery.stage({
      generation: "generation-direct",
      expiresAt: Date.now() + 60_000,
      publish: async () => { order.push("publish"); },
      revoke: async () => { order.push("revoke"); },
    });
    await delivery.deliverInner(() => { order.push("enqueue-terminal"); return true; });
    expect(order).toEqual(["publish", "enqueue-terminal"]);
    await delivery.cancel();
    expect(order).toEqual(["publish", "enqueue-terminal"]);
  });

  it("makes the bridge await alias publication before forwarding response.completed", async () => {
    let finishPublish!: () => void;
    const publishGate = new Promise<void>((resolve) => { finishPublish = resolve; });
    let publishCalls = 0;
    let revokeCalls = 0;
    const delivery = createResponsesTerminalDelivery();
    await delivery.stage({
      generation: "generation-bridge",
      expiresAt: Date.now() + 60_000,
      publish: async () => { publishCalls += 1; await publishGate; },
      revoke: async () => { revokeCalls += 1; },
    });
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.completed\ndata: {}\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    attachResponsesTerminalDelivery(inner, delivery);
    const reader = bridgePendingResponsesStream(Promise.resolve(inner)).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: response.created");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: response.in_progress");
    let terminalDelivered = false;
    const terminal = reader.read().then((value) => { terminalDelivered = true; return value; });
    await vi.waitFor(() => expect(publishCalls).toBe(1));
    expect(terminalDelivered).toBe(false);
    finishPublish();
    expect(new TextDecoder().decode((await terminal).value)).toContain("event: response.completed");
    expect(revokeCalls).toBe(0);
  });

  it("recognizes response.completed when the SSE marker is split across chunks", async () => {
    let publishCalls = 0;
    let revokeCalls = 0;
    const delivery = createResponsesTerminalDelivery();
    await delivery.stage({
      generation: "generation-split-terminal",
      expiresAt: Date.now() + 60_000,
      publish: async () => { publishCalls += 1; },
      revoke: async () => { revokeCalls += 1; },
    });
    const encoder = new TextEncoder();
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.comp"));
        controller.enqueue(encoder.encode("leted\ndata: {}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    attachResponsesTerminalDelivery(inner, delivery);
    const reader = bridgePendingResponsesStream(Promise.resolve(inner)).body!.getReader();
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    expect(text).toContain("event: response.completed");
    expect(publishCalls).toBe(1);
    expect(revokeCalls).toBe(0);
  });

  it("turns an inner SSE EOF without a terminal event into response.failed", async () => {
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const response = bridgePendingResponsesStream(Promise.resolve(inner));
    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"upstream_disconnected"');
    expect(text).toContain("data: [DONE]");
  });

  it("bounds an unread preflight bridge and cancels pending work", async () => {
    vi.useFakeTimers();
    try {
      let cancelCalls = 0;
      const pending = new Promise<Response>(() => undefined);
      const response = bridgePendingResponsesStream(pending, () => { cancelCalls += 1; });
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");

      await vi.advanceTimersByTimeAsync(120_000);
      expect(cancelCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not append another failure after an inner response.failed terminal", async () => {
    const inner = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "event: response.failed\ndata: {\"type\":\"response.failed\"}\n\ndata: [DONE]\n\n",
        ));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const text = await bridgePendingResponsesStream(Promise.resolve(inner)).text();
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(text).not.toContain("upstream_disconnected");
  });

  it("revokes a staged alias when a bridge-owned terminal is never delivered", async () => {
    let revokeCalls = 0;
    const delivery = createResponsesTerminalDelivery();
    expect(delivery.claim("bridge")).toBe(true);
    await delivery.stage({
      generation: "generation-rollback",
      expiresAt: Date.now() + 60_000,
      publish: async () => undefined,
      revoke: async () => { revokeCalls += 1; },
    });
    const innerDelivery = delivery.deliverInner(() => true);
    await delivery.cancel();
    await expect(innerDelivery).rejects.toThrow("STREAM_DELIVERY_FAILED");
    expect(revokeCalls).toBe(1);
  });

  it("publishes a staged alias after commit even when delivery is cancelled", async () => {
    let publishCalls = 0;
    let revokeCalls = 0;
    const delivery = createResponsesTerminalDelivery();
    expect(delivery.claim("direct")).toBe(true);
    await delivery.markCommitted();
    await delivery.cancel();
    await delivery.stage({
      generation: "generation-committed-cancel",
      expiresAt: Date.now() + 60_000,
      publish: async () => { publishCalls += 1; },
      revoke: async () => { revokeCalls += 1; },
    });
    expect(publishCalls).toBe(1);
    expect(revokeCalls).toBe(0);
  });

  it("keeps a committed turn resumable when alias seeding resolves after disconnect", async () => {
    let finishSeed!: () => void;
    const seedFinished = new Promise<void>((resolve) => { finishSeed = resolve; });
    let publishCalls = 0;
    let revokeCalls = 0;
    const delivery = createResponsesTerminalDelivery();
    expect(delivery.claim("direct")).toBe(true);
    await delivery.markCommitted();

    // This is the actual ordering that matters at the Responses boundary:
    // completeFinal() has durably released the lease, the downstream closes,
    // and the second DO call that seeds the alias has not answered yet.
    const pendingAlias = seedFinished.then(() => ({
      generation: "generation-seed-after-disconnect",
      expiresAt: Date.now() + 60_000,
      publish: async () => { publishCalls += 1; },
      revoke: async () => { revokeCalls += 1; },
    }));
    await delivery.cancel();
    finishSeed();
    await delivery.stage(await pendingAlias);

    expect(publishCalls).toBe(1);
    expect(revokeCalls).toBe(0);
  });

  it("does not revoke an already-staged alias when commit is followed by disconnect", async () => {
    let publishCalls = 0;
    let revokeCalls = 0;
    const delivery = createResponsesTerminalDelivery();
    await delivery.stage({
      generation: "generation-staged-commit",
      expiresAt: Date.now() + 60_000,
      publish: async () => { publishCalls += 1; },
      revoke: async () => { revokeCalls += 1; },
    });
    await delivery.markCommitted();
    await delivery.cancel();
    expect(publishCalls).toBe(1);
    expect(revokeCalls).toBe(0);
  });

  it("retries only transient alias admission failures with a bounded backoff", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const result = retryResponsesAliasSeed(async () => {
        calls += 1;
        if (calls < 3) throw new Error("RESPONSE_ALIAS_ADMISSION_CONFLICT");
        return "admitted";
      });
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("admitted");
      expect(calls).toBe(3);
      expect(responsesAliasSeedRetryDelay(0)).toBe(25);
      expect(responsesAliasSeedRetryDelay(1)).toBe(100);
      expect(responsesAliasSeedRetryDelay(99)).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry deterministic alias collisions", async () => {
    let calls = 0;
    await expect(retryResponsesAliasSeed(async () => {
      calls += 1;
      throw new Error("RESPONSE_ALIAS_IMMUTABLE");
    })).rejects.toThrow("RESPONSE_ALIAS_IMMUTABLE");
    expect(calls).toBe(1);
  });
});
