import { describe, expect, it } from "vitest";
import { MultimodalInputError, type MultimodalInputErrorCode } from "../src/multimodal";
import { attachResponsesTerminalDelivery, bridgePendingResponsesStream, createResponsesTerminalDelivery, publicFailure } from "../src/openai";
import { RequestMetricTracker, trackStreamingResponse } from "../src/request-metrics";
import type { RequestMetricInput } from "../src/types";

function metricFixture() {
  const records: RequestMetricInput[] = [];
  const tracker = new RequestMetricTracker({
    requestId: "multimodal-preflight",
    sink: { recordRequest: async (input) => { records.push(input); } },
  });
  return { records, tracker };
}

const multimodalCodes: MultimodalInputErrorCode[] = [
  "audio_not_supported", "image_too_large", "invalid_image",
  "invalid_multimodal_content", "too_many_images", "unsupported_content_part",
];

describe("multimodal failure boundaries", () => {
  it.each(multimodalCodes)("preserves the local %s validation code in SSE", async (code) => {
    const cause = new MultimodalInputError(code);
    expect(publicFailure(cause).code).toBe(code);
    expect(publicFailure(cause).message).not.toContain("Microsoft 365 upstream request failed");
    const text = await bridgePendingResponsesStream(Promise.reject(cause)).text();
    expect(text).toContain(`"code":"${code}"`);
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(text).not.toContain('"code":"upstream_error"');
  });

  it("identifies unnormalized tool media as a local content error", () => {
    expect(publicFailure(new Error("UNNORMALIZED_IMAGE_CONTENT"))).toEqual({
      code: "invalid_multimodal_content",
      message: "image input could not be normalized safely",
    });
  });

  it("does not expose arbitrary error text or credentials", async () => {
    const cause = new Error("private upstream URL https://secret.invalid/?token=private-token");
    const failure = publicFailure(cause);
    expect(failure).toEqual({ code: "upstream_error", message: "Microsoft 365 upstream request failed" });
    const text = await bridgePendingResponsesStream(Promise.reject(cause)).text();
    expect(text).not.toContain("secret.invalid");
    expect(text).not.toContain("private-token");
  });

  it("records a rejected preflight as one semantic error although SSE remains HTTP 200", async () => {
    const { tracker, records } = metricFixture();
    const response = bridgePendingResponsesStream(
      Promise.reject(new MultimodalInputError("invalid_image")), undefined, undefined, tracker,
    );
    const text = await trackStreamingResponse(response, tracker).text();
    await tracker.settled;
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 200, semanticStatus: "error", code: "invalid_image", accountId: null });
  });

  it("records a delayed JSON rejection with its original error code", async () => {
    const { tracker, records } = metricFixture();
    const pending = Promise.resolve(Response.json({
      error: { code: "tool_output_mismatch", message: "function_call_output does not match the pending call_id" },
    }, { status: 400 }));
    const text = await trackStreamingResponse(
      bridgePendingResponsesStream(pending, undefined, undefined, tracker), tracker,
    ).text();
    await tracker.settled;
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 200, semanticStatus: "error", code: "tool_output_mismatch" });
  });

  it("records an inner stream without a terminal frame as an error", async () => {
    const { tracker, records } = metricFixture();
    const inner = new Response("event: response.in_progress\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const text = await trackStreamingResponse(
      bridgePendingResponsesStream(Promise.resolve(inner), undefined, undefined, tracker), tracker,
    ).text();
    await tracker.settled;
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 200, semanticStatus: "error", code: "upstream_disconnected" });
  });

  it("does not emit another failure if the inner stream errors after its failure terminal", async () => {
    const { tracker, records } = metricFixture();
    let pulls = 0;
    const inner = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(
          'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"upstream_timeout"}}}\n\n',
        ));
        else controller.error(new Error("private stream error after terminal"));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const text = await trackStreamingResponse(
      bridgePendingResponsesStream(Promise.resolve(inner), undefined, undefined, tracker), tracker,
    ).text();
    await tracker.settled;
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(text).not.toContain("private stream error");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 200, semanticStatus: "error" });
  });

  it("still emits a failure when alias publication fails before completed reaches the client", async () => {
    const { tracker, records } = metricFixture();
    const delivery = createResponsesTerminalDelivery();
    await delivery.stage({
      generation: "failed-publish",
      expiresAt: Date.now() + 60_000,
      publish: async () => { throw new Error("private publication failure"); },
      revoke: async () => undefined,
    });
    const inner = new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
    attachResponsesTerminalDelivery(inner, delivery);
    const text = await trackStreamingResponse(
      bridgePendingResponsesStream(Promise.resolve(inner), undefined, undefined, tracker), tracker,
    ).text();
    await tracker.settled;
    expect(text.match(/event: response\.failed/gu)).toHaveLength(1);
    expect(text).not.toContain("event: response.completed");
    expect(text).not.toContain("private publication failure");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 200, semanticStatus: "error", code: "upstream_error" });
  });
});
