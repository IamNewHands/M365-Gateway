import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { MAX_RESPONSES_REQUEST_BYTES } from "../src/request-body";
import type { Env } from "../src/types";

describe("CPU-safe inference dispatch", () => {
  it("passes the original request and response through without parsing or rewriting", async () => {
    const request = new Request("https://example.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer opaque", "Content-Type": "application/json" },
      body: JSON.stringify({ input: "原样 $x [Math]::Min(1,2) \\server\n".repeat(25_000) }),
    });
    const text = vi.spyOn(request, "text");
    const json = vi.spyOn(request, "json");
    const response = new Response("data: {\"type\":\"response.completed\"}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const fetch = vi.fn().mockResolvedValue(response);
    const id = env.INFERENCE.newUniqueId();
    const get = vi.fn().mockReturnValue({ fetch });
    const bindings = { INFERENCE: { newUniqueId: () => id, get } } as unknown as Env;
    const result = await worker.fetch(request, bindings, {} as ExecutionContext);
    expect(get).toHaveBeenCalledWith(id);
    expect(fetch).toHaveBeenCalledWith(request);
    expect(result).toBe(response);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(result.bodyUsed).toBe(false);
  });

  it.each(["responses", "responses/compact", "chat/completions", "messages"])(
    "keeps authentication inside the durable %s adapter", async (path) => {
      const response = await SELF.fetch(`https://example.com/v1/${path}`, {
        method: "POST", body: "{}", headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("X-M365-Execution")).toBe("durable-object");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await response.text();
    },
  );

  it("keeps request size enforcement after the handoff", async () => {
    const response = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer m365_test_deployment_key_1234567890", "Content-Type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(MAX_RESPONSES_REQUEST_BYTES) }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("X-M365-Execution")).toBe("durable-object");
    await response.text();
  });

  it("leaves successful discovery and health on the lightweight edge path", async () => {
    for (const path of ["/api/health", "/v1/models"]) {
      const response = await SELF.fetch(`https://example.com${path}`, {
        headers: { Authorization: "Bearer m365_test_deployment_key_1234567890" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.has("X-M365-Execution")).toBe(false);
      await response.text();
    }
  });
});
