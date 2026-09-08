import { describe, expect, it } from "vitest";
import {
  assertBoundedPayload,
  boundedPayloadDiagnostic,
  boundedPayloadMetadata,
  BoundedPayloadError,
  CHAT_HUB_PAYLOAD_LIMITS,
  chatHubAllowedMessageTypes,
  chatPayload,
  ChatHubAttemptError,
  parseSignalRHandshake,
  reconcileChatHubText,
  syntheticUpstreamFailureCode,
  socketReader,
  type BoundedPayloadPhase,
  type BoundedPayloadSubtype,
} from "../src/chathub";

type SocketEvent = { data?: unknown; code?: number };
type SocketListener = (event: SocketEvent) => void;

class SocketStub {
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, SocketListener[]>();

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  message(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }

  closed(code = 1000): void {
    for (const listener of this.listeners.get("close") ?? []) listener({ code });
  }
}

function asWebSocket(socket: SocketStub): WebSocket {
  return socket as unknown as WebSocket;
}

function invocationFrom(request: Parameters<typeof chatPayload>[0]): Record<string, unknown> {
  return JSON.parse(chatPayload(request, "request-limit-contract").split("\u001e")[0]) as Record<string, unknown>;
}

function allowedTypesFrom(request: Parameters<typeof chatPayload>[0]): string[] {
  const invocation = invocationFrom(request) as {
    arguments: Array<{ allowedMessageTypes: string[] }>;
  };
  return invocation.arguments[0].allowedMessageTypes;
}

describe("ChatHub bounded payload diagnostics", () => {
  it("accepts each exact boundary and rejects limit plus one with closed metadata", () => {
    const cases: Array<{
      subtype: BoundedPayloadSubtype;
      phase: BoundedPayloadPhase;
      limit: number;
    }> = [
      { subtype: "WS_FRAME_TOO_LARGE", phase: "websocket_frame", limit: CHAT_HUB_PAYLOAD_LIMITS.frameCharacters },
      { subtype: "WS_BUFFER_TOO_LARGE", phase: "websocket_queue", limit: CHAT_HUB_PAYLOAD_LIMITS.queuedSocketCharacters },
      { subtype: "CHAT_OUTPUT_TOO_LARGE", phase: "streamed_text", limit: CHAT_HUB_PAYLOAD_LIMITS.outputCharacters },
      { subtype: "CHAT_OUTPUT_TOO_LARGE", phase: "update_snapshot", limit: CHAT_HUB_PAYLOAD_LIMITS.outputCharacters },
      { subtype: "CHAT_OUTPUT_TOO_LARGE", phase: "completion_snapshot", limit: CHAT_HUB_PAYLOAD_LIMITS.outputCharacters },
      { subtype: "CHAT_OUTPUT_TOO_LARGE", phase: "completion_message", limit: CHAT_HUB_PAYLOAD_LIMITS.outputCharacters },
      { subtype: "CHAT_IMAGE_OUTPUT_TOO_LARGE", phase: "image_output", limit: CHAT_HUB_PAYLOAD_LIMITS.upstreamImageURLCharacters },
    ];

    for (const value of cases) {
      expect(() => assertBoundedPayload(value.subtype, value.limit, value.limit, value.phase)).not.toThrow();
      try {
        assertBoundedPayload(value.subtype, value.limit + 1, value.limit, value.phase);
        throw new Error("expected a bounded payload failure");
      } catch (cause) {
        expect(cause).toBeInstanceOf(BoundedPayloadError);
        expect(boundedPayloadMetadata(cause)).toEqual({
          subtype: value.subtype,
          observed: value.limit + 1,
          limit: value.limit,
          phase: value.phase,
        });
      }
    }
  });

  it("preserves numeric metadata through an attempt wrapper and exposes no payload field", () => {
    const raw = new BoundedPayloadError("WS_FRAME_TOO_LARGE", 1_500_001, 1_500_000, "websocket_frame");
    const wrapped = new ChatHubAttemptError(raw, true);
    expect(boundedPayloadMetadata(wrapped)).toEqual({
      subtype: "WS_FRAME_TOO_LARGE",
      observed: 1_500_001,
      limit: 1_500_000,
      phase: "websocket_frame",
    });
    expect(boundedPayloadDiagnostic(wrapped)).toEqual({
      event: "chathub_bounded_payload_rejected",
      subtype: "WS_FRAME_TOO_LARGE",
      phase: "websocket_frame",
      observed_characters: 1_500_001,
      limit_characters: 1_500_000,
    });
    expect(Object.keys(boundedPayloadDiagnostic(wrapped) ?? {}).sort()).toEqual([
      "event",
      "limit_characters",
      "observed_characters",
      "phase",
      "subtype",
    ]);
  });

  it("accepts an exact maximum frame and closes an oversized frame with code 1009", async () => {
    const exactSocket = new SocketStub();
    const exactReader = socketReader(asWebSocket(exactSocket));
    const exactFrame = "x".repeat(CHAT_HUB_PAYLOAD_LIMITS.frameCharacters);
    exactSocket.message(exactFrame);
    await expect(exactReader.next(20)).resolves.toHaveLength(CHAT_HUB_PAYLOAD_LIMITS.frameCharacters);
    expect(exactSocket.closeCalls).toEqual([]);

    const oversizedSocket = new SocketStub();
    const oversizedReader = socketReader(asWebSocket(oversizedSocket));
    oversizedSocket.message(`${exactFrame}x`);
    await expect(oversizedReader.next(20)).rejects.toMatchObject({
      name: "BoundedPayloadError",
      subtype: "WS_FRAME_TOO_LARGE",
      observed: CHAT_HUB_PAYLOAD_LIMITS.frameCharacters + 1,
      limit: CHAT_HUB_PAYLOAD_LIMITS.frameCharacters,
      phase: "websocket_frame",
    });
    expect(oversizedSocket.closeCalls).toEqual([{ code: 1009, reason: "frame too large" }]);
  });

  it("accepts the exact queue cap and rejects the first character over it", async () => {
    const exactSocket = new SocketStub();
    const exactReader = socketReader(asWebSocket(exactSocket), 5);
    exactSocket.message("12");
    exactSocket.message("345");
    await expect(exactReader.next(20)).resolves.toBe("12");
    await expect(exactReader.next(20)).resolves.toBe("345");
    expect(exactSocket.closeCalls).toEqual([]);

    const oversizedSocket = new SocketStub();
    const oversizedReader = socketReader(asWebSocket(oversizedSocket), 5);
    oversizedSocket.message("123");
    oversizedSocket.message("456");
    await expect(oversizedReader.next(20)).rejects.toMatchObject({
      name: "BoundedPayloadError",
      subtype: "WS_BUFFER_TOO_LARGE",
      observed: 6,
      limit: 5,
      phase: "websocket_queue",
    });
    expect(oversizedSocket.closeCalls).toEqual([{ code: 1009, reason: "buffer too large" }]);
  });

  it("rejects a definitely oversized binary frame before decoding and preserves that first error", async () => {
    const socket = new SocketStub();
    const reader = socketReader(asWebSocket(socket));
    const oversized = new Uint8Array(CHAT_HUB_PAYLOAD_LIMITS.frameCharacters * 4 + 1);
    socket.message(oversized.buffer);
    // WebSocket close is delivered after the local 1009 close call. It must
    // not overwrite the actionable bounded-payload error with WS_CLOSED.
    socket.closed(1009);
    await expect(reader.next(20)).rejects.toMatchObject({
      name: "BoundedPayloadError",
      subtype: "WS_FRAME_TOO_LARGE",
      limit: CHAT_HUB_PAYLOAD_LIMITS.frameCharacters,
      phase: "websocket_frame",
    });
    expect(socket.closeCalls).toEqual([{ code: 1009, reason: "frame too large" }]);
  });

  it("bounds coalesced SignalR records before parsing an adversarial tiny-record frame", () => {
    const frame = "{}\u001e".repeat(CHAT_HUB_PAYLOAD_LIMITS.frameRecords + 1);
    expect(() => parseSignalRHandshake(frame)).toThrowError("WS_FRAME_TOO_MANY_RECORDS");
  });
});

describe("ChatHub provider placeholders", () => {
  it("classifies the nominal-success capacity placeholder without matching ordinary prose", () => {
    expect(syntheticUpstreamFailureCode("We're temporarily unable to respond to this volume of requests. Please try again later.")).toBe("CHAT_UPSTREAM_RATE_LIMITED");
    expect(syntheticUpstreamFailureCode("We are temporarily unable to respond to the current volume of requests")).toBe("CHAT_UPSTREAM_RATE_LIMITED");
    expect(syntheticUpstreamFailureCode("Explain why a rate limit may affect an API")).toBeNull();
    expect(syntheticUpstreamFailureCode("We're temporarily unable to respond to this volume of requests. Please try again later. Additional context.")).toBeNull();
  });
});

describe("ChatHub compact upstream message profile", () => {
  const base = {
    text: "route the next caller tool",
    conversationId: "conversation-message-profile",
    sessionId: "session-message-profile",
    started: true,
    tone: "Gpt_5_6_Chat",
  };
  const tool = {
    type: "function",
    function: {
      name: "inspect_workspace",
      description: "Inspect one workspace path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  };
  const essential = ["Chat", "Disengaged", "Progress", "ConfirmationCard", "EndOfRequest", "ReferencesListComplete"];
  const heavy = ["DeveloperLogs", "RenderCardRequest", "SemanticSerp", "GeneratedCode", "SearchQuery"];

  it("uses the compact profile for caller-tool requests", () => {
    const request = { ...base, tools: [tool], toolChoice: "auto" };
    expect(chatHubAllowedMessageTypes(request)).toEqual(essential);
    expect(allowedTypesFrom(request)).toEqual(essential);
    for (const type of heavy) expect(allowedTypesFrom(request)).not.toContain(type);
  });

  it("uses the compact profile for the isolated router without inspecting prompt text", () => {
    const request = { ...base, tools: undefined, toolChoice: "none" };
    expect(chatHubAllowedMessageTypes(request)).toEqual(essential);
    expect(allowedTypesFrom(request)).toEqual(essential);
  });

  it("keeps the full answer profile unless a compact profile is explicit or inferred", () => {
    const answer = chatHubAllowedMessageTypes({ messageProfile: "answer", tools: [tool], toolChoice: "auto" });
    expect(answer).toEqual(expect.arrayContaining([...essential, ...heavy]));
    expect(chatHubAllowedMessageTypes({ messageProfile: "caller_tool" })).toEqual(essential);
    expect(chatHubAllowedMessageTypes({ messageProfile: "router" })).toEqual(essential);
  });
});

describe("ChatHub completion text reconciliation", () => {
  it("uses a final completion snapshot as authority and marks incompatible streams", () => {
    expect(reconcileChatHubText("draft branch A", "final branch B")).toEqual({
      text: "final branch B",
      divergent: true,
      streamedCharacters: 14,
      finalCharacters: 14,
    });
  });

  it("does not mark cumulative prefixes as divergent", () => {
    expect(reconcileChatHubText("final", "final answer")).toEqual({
      text: "final answer",
      divergent: false,
      streamedCharacters: 5,
      finalCharacters: 12,
    });
    expect(reconcileChatHubText("stream only", "")).toEqual({
      text: "stream only",
      divergent: false,
      streamedCharacters: 11,
      finalCharacters: 0,
    });
  });
});
