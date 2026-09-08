import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { shouldRetainRequestObservation } from "../src/request-metrics";

/**
 * These writes used to be dispatched as two independent RPCs from the Worker
 * for every terminal request.  Keep a small concurrent burst here as a
 * regression guard: all logical terminal records must survive without
 * turning the tenant Durable Object into a fan-out of simultaneous storage
 * operations (a common precursor to Cloudflare overload/1101-1102 errors).
 */
describe("resource-safe tenant terminal writes", () => {
  it("retains all failures and slow requests while sampling ordinary successes", () => {
    const sampled = "00000000-0000-4000-8000-000000000000";
    const ordinary = "00000000-0000-4000-8000-000000000001";
    expect(shouldRetainRequestObservation(sampled, {
      status: 200,
      semanticStatus: "complete",
      durationMs: 10,
    })).toBe(true);
    expect(shouldRetainRequestObservation(ordinary, {
      status: 200,
      semanticStatus: "complete",
      durationMs: 10,
    })).toBe(false);
    expect(shouldRetainRequestObservation(ordinary, {
      status: 200,
      semanticStatus: "error",
      durationMs: 10,
    })).toBe(true);
    expect(shouldRetainRequestObservation(ordinary, {
      status: 200,
      semanticStatus: "complete",
      durationMs: 45_000,
    })).toBe(true);
  });

  it("does not turn successful read-only probes into terminal writes", async () => {
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const before = await state.statsSnapshot();
    const model = await SELF.fetch("https://example.com/v1/models", {
      headers: { Authorization: "Bearer m365_test_deployment_key_1234567890" },
    });
    expect(model.status).toBe(200);
    const health = await SELF.fetch("https://example.com/api/health");
    expect(health.status).toBe(200);
    // The next DO RPC is also a synchronization point for waitUntil writes.
    const after = await state.statsSnapshot();
    expect(after).toEqual(before);
    const ids = [model, health].map((response) => response.headers.get("X-Request-Id")).filter(Boolean);
    const diagnostics = await state.listDiagnostics(200);
    expect(diagnostics.filter((entry) => ids.includes(entry.id))).toHaveLength(0);
  });

  it("reads the dashboard account view through one TenantState RPC", async () => {
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const snapshot = await state.accountsSnapshot();
    expect(Array.isArray(snapshot.accounts)).toBe(true);
    expect(snapshot.totals).toMatchObject({
      totalRequestCount: expect.any(Number),
      totalErrorCount: expect.any(Number),
      totalTokenIn: expect.any(Number),
      totalTokenOut: expect.any(Number),
    });
  });

  it("commits concurrent request metrics and diagnostics through one RPC", async () => {
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const prefix = `resource-regression-${crypto.randomUUID()}`;
    const writes = Array.from({ length: 8 }, (_, index) => {
      const requestId = `${prefix}-${index}`;
      return state.recordRequestWithDiagnostic(
        {
          requestId,
          status: 200,
          semanticStatus: "complete",
          durationMs: index,
          tokenIn: 1,
          tokenOut: 1,
        },
        {
          requestId,
          method: "POST",
          path: "/v1/chat/completions",
          status: 200,
          durationMs: index,
          code: "terminal_complete",
        },
      );
    });

    await Promise.all(writes);
    const diagnostics = await state.listDiagnostics(200);
    expect(diagnostics.filter((entry) => entry.id.startsWith(prefix))).toHaveLength(writes.length);
  });

  it("deduplicates the diagnostic together with its metric request id", async () => {
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const requestId = `resource-idempotent-${crypto.randomUUID()}`;
    const metric = {
      requestId,
      status: 503,
      semanticStatus: "error" as const,
      durationMs: 50,
      tokenIn: 1,
      tokenOut: 0,
    };
    const diagnostic = {
      requestId,
      method: "POST",
      path: "/v1/responses",
      status: 503,
      durationMs: 50,
      code: "terminal_error_upstream_error",
    };
    await state.recordRequestWithDiagnostic(metric, diagnostic);
    await state.recordRequestWithDiagnostic(metric, diagnostic);
    const diagnostics = await state.listDiagnostics(200);
    expect(diagnostics.filter((entry) => entry.id === requestId)).toHaveLength(1);
  });
});
