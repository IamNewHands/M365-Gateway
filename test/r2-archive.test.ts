import { describe, expect, it } from "vitest";
import {
  buildDiagnosticArchiveEnvelope,
  buildSessionArchiveEnvelope,
  R2ArchiveQueue,
  R2_ARCHIVE_MAX_ATTEMPTS,
  r2ArchiveObjectKey,
  sanitizeR2ArchiveText,
} from "../src/r2-archive";
import type { Env } from "../src/types";

describe("optional R2 cold archive", () => {
  function alarmContext(options: { nextAttemptAt?: number; currentAlarm?: number | null } = {}): {
    context: DurableObjectState;
    ddlCalls: () => number;
    alarms: () => number[];
  } {
    let ddl = 0;
    const scheduled: number[] = [];
    const nextAttemptAt = options.nextAttemptAt;
    let currentAlarm = options.currentAlarm ?? null;
    const sql = {
      exec: (query: string) => {
        if (query.includes("CREATE TABLE IF NOT EXISTS r2_archive_queue")) ddl += 1;
        if (query.startsWith("SELECT next_attempt_at FROM r2_archive_queue")) {
          return { toArray: () => nextAttemptAt === undefined ? [] : [{ next_attempt_at: nextAttemptAt }] };
        }
        if (query.startsWith("SELECT object_key FROM r2_archive_queue")) {
          return { toArray: () => [] };
        }
        return { toArray: () => [] };
      },
    };
    const storage = {
      sql,
      getAlarm: async () => currentAlarm,
      setAlarm: async (value: number) => { currentAlarm = value; scheduled.push(value); },
      deleteAlarm: async () => { currentAlarm = null; },
    };
    return {
      context: { storage } as unknown as DurableObjectState,
      ddlCalls: () => ddl,
      alarms: () => scheduled,
    };
  }

  it("redacts credential-shaped values before encryption", () => {
    const source = [
      "Authorization: Bearer super-secret-token",
      "api_key=sk-test_1234567890abcdef",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    ].join("\n");
    const sanitized = sanitizeR2ArchiveText(source);
    expect(sanitized).not.toContain("super-secret-token");
    expect(sanitized).not.toContain("sk-test_1234567890abcdef");
    expect(sanitized).not.toContain("BEGIN PRIVATE KEY");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("archives only bounded task/evidence metadata, never raw tool arguments/results", () => {
    const rawArgument = "C:\\secret\\deploy --api-key=do-not-copy";
    const rawResult = "response contained refresh_token=do-not-copy";
    const envelope = buildSessionArchiveEnvelope({
      revision: Date.now(),
      committed: true,
      recordKind: "stable",
      taskAnchors: [{ kind: "windows_path", value: "C:\\work\\gateway" }],
      protocolTail: `continue from ${rawResult}`,
      toolLedgerSnapshot: JSON.stringify([{
        name: "exec_command",
        arguments: rawArgument,
        result: rawResult,
        fingerprint: "fingerprint-1",
        failed: false,
        completedCount: 1,
        actions: ["read"],
      }]),
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(rawArgument);
    expect(serialized).not.toContain("refresh_token=do-not-copy");
    expect(envelope.toolLedger[0]).toMatchObject({ name: "exec_command", failed: false });
    expect(envelope.taskAnchors).toEqual([{ kind: "windows_path", value: "C:\\work\\gateway" }]);
  });

  it("builds stable diagnostic metadata and a non-user-controlled key", () => {
    const envelope = buildDiagnosticArchiveEnvelope({
      revision: 42,
      method: "post",
      path: "/v1/responses?token=ignored",
      status: 503,
      durationMs: 12_345,
      code: "upstream_error",
    });
    expect(envelope).toMatchObject({ kind: "diagnostic", method: "POST", path: "/redacted", status: 503 });
    const key = r2ArchiveObjectKey("../../not-a-user-key", envelope, "fixed nonce");
    expect(key).toMatch(/^m365-gateway\/v1\/diagnostic\/not-a-user-key\/00000000000042-fixednonce\.json\.enc$/u);
  });

  it("uses an idempotent default object key for the same scope/kind/revision", () => {
    const envelope = buildDiagnosticArchiveEnvelope({
      revision: 7,
      method: "GET",
      path: "/api/health",
      status: 503,
      durationMs: 10,
      code: "upstream_error",
    });
    const first = r2ArchiveObjectKey("session-scope", envelope);
    const second = r2ArchiveObjectKey("session-scope", envelope);
    expect(first).toBe(second);
    expect(first).toBe("m365-gateway/v1/diagnostic/session-scope/00000000000007.json.enc");
    expect(r2ArchiveObjectKey("other-scope", envelope)).not.toBe(first);
    expect(r2ArchiveObjectKey("session-scope", { ...envelope, revision: 8 })).not.toBe(first);
    // Explicit nonces remain available for migration/tooling callers that
    // intentionally need a distinct object.
    expect(r2ArchiveObjectKey("session-scope", envelope, "nonce")).not.toBe(first);
  });

  it("is a complete no-op when the optional binding is absent", () => {
    let waited = false;
    const context = {
      waitUntil: () => { waited = true; },
    } as unknown as DurableObjectState;
    const queue = new R2ArchiveQueue(context, {
      DATA_ENCRYPTION_KEY: "",
      R2_ARCHIVE: undefined,
    } as Pick<Env, "R2_ARCHIVE" | "DATA_ENCRYPTION_KEY"> , "scope");
    queue.enqueue("diagnostic", {
      revision: 1,
      method: "GET",
      path: "/api/health",
      status: 200,
      durationMs: 1,
      code: "",
    });
    expect(waited).toBe(false);
  });

  it("merges the R2 retry deadline with the DO state alarm and avoids repeated DDL", async () => {
    const now = Date.now();
    const fake = alarmContext({ nextAttemptAt: now + 5_000 });
    const queue = new R2ArchiveQueue(fake.context, {
      DATA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      R2_ARCHIVE: {} as R2Bucket,
    } as Pick<Env, "R2_ARCHIVE" | "DATA_ENCRYPTION_KEY">, "scope");
    await queue.scheduleAlarmAt(now + 60_000);
    await queue.scheduleAlarmAt(now + 120_000);
    expect(fake.ddlCalls()).toBe(1);
    // The second call resolves to the same earlier archive deadline. A
    // duplicate setAlarm would consume another Durable Object storage write.
    expect(fake.alarms().length).toBe(1);
    expect(fake.alarms().every((deadline) => deadline <= now + 5_000)).toBe(true);
  });

  it("preserves an earlier non-archive alarm when the queue is empty", async () => {
    const now = Date.now();
    const fake = alarmContext({ currentAlarm: now + 2_000 });
    const queue = new R2ArchiveQueue(fake.context, {
      DATA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      R2_ARCHIVE: {} as R2Bucket,
    } as Pick<Env, "R2_ARCHIVE" | "DATA_ENCRYPTION_KEY">, "scope");
    await queue.scheduleAlarmAt(now + 60_000);
    // The existing alarm already is the selected earliest deadline; retaining
    // it avoids an equivalent setAlarm storage write.
    expect(fake.alarms()).toHaveLength(0);
  });

  it("drops a poison row after bounded retries so newer rows are not blocked", async () => {
    let row: Record<string, unknown> | undefined = {
      object_key: "m365-gateway/v1/session/scope/00000000000001.json.enc",
      payload: "ciphertext",
      kind: "session",
      revision: 1,
      attempt_count: R2_ARCHIVE_MAX_ATTEMPTS - 1,
      next_attempt_at: 0,
      created_at: 1,
    };
    let deleted = 0;
    let currentAlarm: number | null = null;
    const sql = {
      exec: (query: string, ...values: unknown[]) => {
        if (query.includes("CREATE TABLE IF NOT EXISTS r2_archive_queue")) return { toArray: () => [] };
        if (query.startsWith("SELECT object_key,payload,kind,revision,attempt_count")) {
          return { toArray: () => row && Number(row.next_attempt_at) <= Date.now() ? [row] : [] };
        }
        if (query.startsWith("SELECT next_attempt_at FROM r2_archive_queue")) {
          return { toArray: () => row ? [{ next_attempt_at: row.next_attempt_at }] : [] };
        }
        if (query.startsWith("DELETE FROM r2_archive_queue WHERE object_key")) {
          if (row?.object_key === values[0]) { row = undefined; deleted += 1; }
          return { toArray: () => [] };
        }
        if (query.startsWith("UPDATE r2_archive_queue SET attempt_count")) {
          if (row) { row.attempt_count = values[0]; row.next_attempt_at = values[1]; }
          return { toArray: () => [] };
        }
        return { toArray: () => [] };
      },
    };
    const storage = {
      sql,
      transactionSync: (callback: () => void) => callback(),
      getAlarm: async () => currentAlarm,
      setAlarm: async (value: number) => { currentAlarm = value; },
      deleteAlarm: async () => { currentAlarm = null; },
    };
    const context = { storage } as unknown as DurableObjectState;
    const bucket = {
      head: async () => { throw new Error("bucket unavailable"); },
      put: async () => { throw new Error("bucket unavailable"); },
    } as unknown as R2Bucket;
    const queue = new R2ArchiveQueue(context, {
      DATA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      R2_ARCHIVE: bucket,
    } as Pick<Env, "R2_ARCHIVE" | "DATA_ENCRYPTION_KEY">, "scope");
    queue.initializeSchema();
    await queue.flush();
    expect(deleted).toBe(1);
    expect(row).toBeUndefined();
  });
});
