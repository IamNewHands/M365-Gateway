import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RESPONSE_ALIAS_REGISTRY_NAME, type DurableChatHubRequest } from "../src/chat-session";
import { decryptJSON, encryptJSON } from "../src/crypto";
import { MAX_RESPONSES_REQUEST_BYTES } from "../src/request-body";
import type { OAuthTokenSet } from "../src/types";

function cookie(response: Response): string {
  return response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
}

describe("Worker HTTP contract", () => {
  it("installs the deployment-synced API key without exposing plaintext state", async () => {
    const response = await SELF.fetch("https://example.com/v1/models", {
      headers: { Authorization: "Bearer m365_test_deployment_key_1234567890" },
    });
    expect(response.status).toBe(200);
  });

  it("restricts health to GET and attaches a stable error code", async () => {
    expect((await SELF.fetch("https://example.com/api/health")).status).toBe(200);
    const invalid = await SELF.fetch("https://example.com/api/health", { method: "POST" });
    expect(invalid.status).toBe(405);
    expect(invalid.headers.get("X-M365-Error-Code")).toBe("method_not_allowed");
  });

  it("requires a one-time password change and enforces method contracts", async () => {
    const first = await SELF.fetch("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-bootstrap-password-2026" }),
    });
    expect(first.status).toBe(200);
    expect((await first.clone().json<{ must_change_password: boolean }>()).must_change_password).toBe(true);
    const firstCookie = cookie(first);

    const tooShort = await SELF.fetch("https://example.com/api/admin/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: firstCookie },
      body: JSON.stringify({ current_password: "test-bootstrap-password-2026", new_password: "1234567" }),
    });
    expect(tooShort.status).toBe(400);
    await expect(tooShort.json()).resolves.toMatchObject({ error: { code: "password_too_short" } });

    const changed = await SELF.fetch("https://example.com/api/admin/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: firstCookie },
      body: JSON.stringify({ current_password: "test-bootstrap-password-2026", new_password: "changed-password-2026" }),
    });
    expect(changed.status).toBe(200);

    const login = await SELF.fetch("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "changed-password-2026" }),
    });
    const sessionCookie = cookie(login);
    const created = await SELF.fetch("https://example.com/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ name: "test", days: 1 }),
    });
    expect(created.status).toBe(201);
    const apiKey = (await created.json<{ key: string }>()).key;

    const wrongMethod = await SELF.fetch("https://example.com/v1/models", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("X-M365-Error-Code")).toBe("method_not_allowed");

    const anthropicWrongMethod = await SELF.fetch("https://example.com/v1/messages", {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });
    expect(anthropicWrongMethod.status).toBe(405);
    expect(anthropicWrongMethod.headers.get("X-M365-Error-Code")).toBe("method_not_allowed");

    const settings = await SELF.fetch("https://example.com/api/admin/settings", {
      headers: { Cookie: sessionCookie },
    });
    await expect(settings.json()).resolves.toMatchObject({
      settings: { adminSessionTTL: "24 hours", chatSessionTTL: "30 days" },
    });

    const compact = await SELF.fetch("https://example.com/v1/responses/compact", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        prompt_cache_key: "worker-compact-contract",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [{
              type: "namespace",
              name: "functions",
              tools: [{
                type: "custom",
                name: "exec",
                description: "Run caller-local JavaScript through tools.exec_command or tools.write_stdin.",
                format: { type: "text" },
              }],
            }],
          },
          { type: "message", role: "developer", content: [{ type: "input_text", text: "retain policy" }] },
          { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" },
          { type: "function_call_output", call_id: "call_1", output: "large historical tool result" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "retain current task" }] },
        ],
      }),
    });
    expect(compact.status).toBe(200);
    const compactBody = await compact.json<{
      object: string;
      output: Array<Record<string, unknown>>;
    }>();
    expect(compactBody).toMatchObject({
      object: "response.compaction",
      output: [
        { type: "additional_tools", role: "developer" },
        { type: "message", role: "developer" },
        { type: "message", role: "user" },
        { type: "compaction", encrypted_content: expect.any(String) },
      ],
    });
    const firstCompactItem = compactBody.output.at(-1) as { encrypted_content: string };
    const firstCapsule = await decryptJSON<{
      version: number;
      sessionKey: string;
      credentialHash: string;
      issuedAt: number;
      expiresAt: number;
      checkpoint: { toolLedgerSnapshot: string; portableProtocolTail: string; callerToolsSnapshot?: string };
    }>(
      firstCompactItem.encrypted_content,
      env.DATA_ENCRYPTION_KEY,
    );
    expect(firstCapsule.version).toBe(3);
    expect(JSON.parse(firstCapsule.checkpoint.toolLedgerSnapshot)).toEqual([
      expect.objectContaining({ name: "exec_command", failed: false }),
    ]);
    expect(firstCapsule.checkpoint.portableProtocolTail).toContain("INTERNAL COMPLETED TOOL EVIDENCE");
    expect(JSON.parse(firstCapsule.checkpoint.callerToolsSnapshot ?? "[]")).toEqual([
      expect.objectContaining({ type: "function", name: "exec" }),
    ]);

    // The opaque capsule, not a best-effort prompt-cache key, is authoritative
    // after Codex compacts a long thread.
    const restoredCompact = await SELF.fetch("https://example.com/v1/responses/compact", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        prompt_cache_key: "changed-after-compaction",
        input: [firstCompactItem],
      }),
    });
    expect(restoredCompact.status).toBe(200);
    const restoredBody = await restoredCompact.json<{ output: Array<{ encrypted_content?: string }> }>();
    const restoredCapsule = await decryptJSON<{
      sessionKey: string;
      checkpoint: { toolLedgerSnapshot: string; portableProtocolTail: string; callerToolsSnapshot?: string };
    }>(
      String(restoredBody.output.at(-1)?.encrypted_content ?? ""),
      env.DATA_ENCRYPTION_KEY,
    );
    expect(restoredCapsule.sessionKey).toBe(firstCapsule.sessionKey);
    expect(restoredCapsule.checkpoint.toolLedgerSnapshot).toBe(firstCapsule.checkpoint.toolLedgerSnapshot);
    expect(restoredCapsule.checkpoint.portableProtocolTail).toBe(firstCapsule.checkpoint.portableProtocolTail);
    expect(restoredCapsule.checkpoint.callerToolsSnapshot).toBe(firstCapsule.checkpoint.callerToolsSnapshot);

    // Existing v2 capsules remain accepted and are upgraded on the next
    // compaction instead of invalidating an already-running Codex task.
    const legacyItem = {
      type: "compaction",
      encrypted_content: await encryptJSON({
        version: 2,
        sessionKey: firstCapsule.sessionKey,
        credentialHash: firstCapsule.credentialHash,
        issuedAt: firstCapsule.issuedAt,
        expiresAt: firstCapsule.expiresAt,
      }, env.DATA_ENCRYPTION_KEY),
    };
    const upgradedLegacy = await SELF.fetch("https://example.com/v1/responses/compact", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [legacyItem] }),
    });
    expect(upgradedLegacy.status).toBe(200);
    const upgradedLegacyBody = await upgradedLegacy.json<{ output: Array<{ encrypted_content?: string }> }>();
    const upgradedLegacyCapsule = await decryptJSON<{ version: number; sessionKey: string }>(
      String(upgradedLegacyBody.output.at(-1)?.encrypted_content ?? ""),
      env.DATA_ENCRYPTION_KEY,
    );
    expect(upgradedLegacyCapsule).toMatchObject({ version: 3, sessionKey: firstCapsule.sessionKey });

    const otherKeyResponse = await SELF.fetch("https://example.com/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ name: "compact-cross-credential", days: 1 }),
    });
    expect(otherKeyResponse.status).toBe(201);
    const otherApiKey = (await otherKeyResponse.json<{ key: string }>()).key;
    const crossCredential = await SELF.fetch("https://example.com/v1/responses/compact", {
      method: "POST",
      headers: { Authorization: `Bearer ${otherApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [firstCompactItem] }),
    });
    expect(crossCredential.status).toBe(400);
    expect(crossCredential.headers.get("X-M365-Error-Code")).toBe("invalid_compaction");

    const compactStream = await SELF.fetch("https://example.com/v1/responses/compact", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, prompt_cache_key: "worker-compact-stream", input: [] }),
    });
    expect(compactStream.status).toBe(200);
    expect(compactStream.headers.get("Content-Type")).toContain("text/event-stream");
    const compactEvents = await compactStream.text();
    expect(compactEvents).toContain('"type":"compaction"');
    expect(compactEvents).toContain("event: response.completed");
    expect(compactEvents).toContain("data: [DONE]");

    const oversized = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: "x".repeat(MAX_RESPONSES_REQUEST_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("X-M365-Error-Code")).toBe("request_too_large");
    await expect(oversized.json()).resolves.toMatchObject({ error: { message: "request body exceeds the 8 MiB limit" } });
    let sent = 0;
    const oversizedChunked = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > MAX_RESPONSES_REQUEST_BYTES) { controller.close(); return; }
          const chunk = new Uint8Array(65_536);
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        },
      }),
    });
    expect(oversizedChunked.status).toBe(413);
    expect(oversizedChunked.headers.get("X-M365-Error-Code")).toBe("request_too_large");
  });

  it("recovers the administrator password once when the deployment reset version changes", async () => {
    const mutableEnv = env as Env & { ADMIN_PASSWORD_RESET_VERSION?: string };
    mutableEnv.ADMIN_PASSWORD_RESET_VERSION = "test-reset-version-1";
    try {
      const initialRecovery = await SELF.fetch("https://example.com/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "test-bootstrap-password-2026" }),
      });
      expect(initialRecovery.status).toBe(200);
      await expect(initialRecovery.clone().json()).resolves.toMatchObject({ must_change_password: false });

      const changed = await SELF.fetch("https://example.com/api/admin/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(initialRecovery) },
        body: JSON.stringify({
          current_password: "test-bootstrap-password-2026",
          new_password: "old-admin-password-2026",
        }),
      });
      expect(changed.status).toBe(200);

      mutableEnv.ADMIN_PASSWORD_RESET_VERSION = "test-reset-version-2";
      const recovered = await SELF.fetch("https://example.com/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "test-bootstrap-password-2026" }),
      });
      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toMatchObject({ must_change_password: false });

      const stale = await SELF.fetch("https://example.com/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "old-admin-password-2026" }),
      });
      expect(stale.status).toBe(401);
    } finally {
      delete mutableEnv.ADMIN_PASSWORD_RESET_VERSION;
    }
  });
});

describe("Tenant upstream route fence", () => {
  it("returns structured missing/stale results and rejects an ABA route epoch", async () => {
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const token = (id: string): OAuthTokenSet => ({
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60 * 60_000,
      email: `${id}@example.test`,
      displayName: "Route fence test",
      oid: id,
      tid: crypto.randomUUID(),
    });
    await state.upsertAccount(token(firstId));
    await state.upsertAccount(token(secondId));
    const initial = await state.selectAccount();
    expect(initial?.accountId).toBe(firstId);
    expect(await state.acquireUpstream(crypto.randomUUID(), "missing-route", initial?.routeEpoch)).toMatchObject({
      ok: false,
      code: "ACCOUNT_MISSING",
    });

    await state.reportAccountFailure(firstId, "transient", initial?.routeEpoch);
    const second = await state.selectAccount();
    expect(second?.accountId).toBe(secondId);
    await state.upsertAccount(token(firstId));
    await state.reportAccountFailure(secondId, "transient", second?.routeEpoch);
    const rebound = await state.selectAccount();
    expect(rebound?.accountId).toBe(firstId);
    expect(rebound?.routeEpoch).not.toBe(initial?.routeEpoch);

    expect(await state.acquireUpstream(firstId, "stale-route", initial?.routeEpoch)).toMatchObject({
      ok: false,
      code: "ACCOUNT_NOT_ACTIVE",
    });
    const current = await state.acquireUpstream(firstId, "current-route", rebound?.routeEpoch);
    expect(current.ok).toBe(true);
    if (current.ok) await state.releaseUpstream(firstId, current.leaseId);
  });
});

describe("Durable ChatHub cancellation fence", () => {
  it("cancels a run before any outbound Microsoft request starts", async () => {
    const runner = env.CHATS.getByName("cancel-test");
    const runId = crypto.randomUUID();
    expect(await runner.cancelChatHub(runId)).toBe("queued");
    const account: OAuthTokenSet = {
      accessToken: "unused",
      refreshToken: "unused",
      expiresAt: Date.now() + 60_000,
      email: "",
      displayName: "",
      oid: "oid",
      tid: "tid",
    };
    const request: DurableChatHubRequest = {
      runId,
      text: "must not reach upstream",
      conversationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      started: true,
      tone: "Gpt_5_6_Chat",
      deadlineAt: Date.now() + 5_000,
    };
    const result = await runner.runChatHub(account, request);
    expect(result).toMatchObject({ ok: false, failure: { message: "REQUEST_ABORTED", invocationSubmitted: false } });
  });

  it("releases a conversation lease so the next turn continues in place", async () => {
    const session = env.CHATS.getByName("lease-release-test");
    const first = await session.acquire();
    await session.release(first.leaseId);
    const continued = await session.acquire();
    expect(continued.leaseId).not.toBe(first.leaseId);
    await session.release(continued.leaseId);
  });

  it("does not create durable state for an unknown Responses alias", async () => {
    const session = env.CHATS.getByName(`missing-alias-${crypto.randomUUID()}`);
    expect(await session.checkoutResponseAlias()).toBeNull();
    // A later legitimate publication at the same key must not collide with a
    // stable tombstone left behind by the failed lookup.
    await session.seed(
      crypto.randomUUID(),
      crypto.randomUUID(),
      "account-late-publication",
      "",
      "",
      "",
      "[]",
      [],
      "published later",
    );
    expect((await session.checkoutResponseAlias())?.portableProtocolTail).toBe("published later");
  });

  it("checks out an uncommitted checkpoint alias into fresh working coordinates", async () => {
    const session = env.CHATS.getByName(`checkpoint-alias-${crypto.randomUUID()}`);
    const sourceConversationId = crypto.randomUUID();
    const sourceSessionId = crypto.randomUUID();
    await session.seed(
      sourceConversationId,
      sourceSessionId,
      "account-checkpoint",
      "",
      "",
      "",
      "[]",
      [],
      "portable checkpoint context",
      false,
    );
    const snapshot = await session.checkoutResponseAlias();
    expect(snapshot?.portableProtocolTail).toBe("portable checkpoint context");
    const working = env.CHATS.getByName(`checkpoint-work-${crypto.randomUUID()}`);
    const resumed = await working.startResponseBranch(snapshot!);
    expect(resumed.started).toBe(false);
    expect(resumed.conversationId).not.toBe(sourceConversationId);
    expect(resumed.sessionId).not.toBe(sourceSessionId);
    expect(resumed.portableProtocolTail).toBe("portable checkpoint context");
    await working.release(resumed.leaseId);
    expect((await session.checkoutResponseAlias())?.portableProtocolTail).toBe("portable checkpoint context");
  });

  it("keeps repeated Responses branches independent and leaves their source alias immutable", async () => {
    const source = env.CHATS.getByName(`branch-source-${crypto.randomUUID()}`);
    await source.seed(
      crypto.randomUUID(),
      crypto.randomUUID(),
      "account-branch-source",
      "pending-source",
      "read_file",
      '{"path":"C:/source.txt"}',
      "[]",
      [],
      "immutable source tail",
    );
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      source.checkoutResponseAlias(),
      source.checkoutResponseAlias(),
    ]);
    expect(leftSnapshot).toEqual(rightSnapshot);

    const leftSession = env.CHATS.getByName(`branch-left-${crypto.randomUUID()}`);
    const rightSession = env.CHATS.getByName(`branch-right-${crypto.randomUUID()}`);
    const [leftInitial, rightInitial] = await Promise.all([
      leftSession.startResponseBranch(leftSnapshot!),
      rightSession.startResponseBranch(rightSnapshot!),
    ]);
    expect(leftInitial.conversationId).not.toBe(rightInitial.conversationId);
    expect(leftInitial.sessionId).not.toBe(rightInitial.sessionId);

    const left = await leftSession.bindAccount(leftInitial.leaseId, "account-left");
    const right = await rightSession.bindAccount(rightInitial.leaseId, "account-right");
    await leftSession.completeFinal(left, left.conversationId, left.sessionId, { protocolTail: "left child" });
    await rightSession.completeFinal(right, right.conversationId, right.sessionId, { protocolTail: "right child" });
    expect(await source.checkoutResponseAlias()).toEqual(leftSnapshot);
    expect(await leftSession.discardResponseBranch(left.leaseId)).toBe(true);
    expect(await rightSession.discardResponseBranch(right.leaseId)).toBe(true);
  });

  it("keeps a registry-rejected alias invisible and removes its pending row", async () => {
    const aliasName = `rejected-alias-${crypto.randomUUID()}`;
    const aliasId = env.CHATS.idFromName(aliasName).toString();
    const registry = env.CHATS.getByName(RESPONSE_ALIAS_REGISTRY_NAME);
    const conflictingGeneration = crypto.randomUUID();
    expect(await registry.registerResponseAlias({
      aliasId,
      generation: conflictingGeneration,
      groupId: `conflict-${crypto.randomUUID()}`,
      expiresAt: Date.now() + 60_000,
    })).toEqual({ ok: true });
    const alias = env.CHATS.getByName(aliasName);
    try {
      const rejected = await alias.seed(
        crypto.randomUUID(),
        crypto.randomUUID(),
        "account-rejected",
        "",
        "",
        "",
        "[]",
        [],
        "must never become visible",
      );
      expect(rejected).toEqual({ ok: false, code: "ALIAS_REGISTRY_GENERATION_CONFLICT" });
      expect(await alias.checkoutResponseAlias()).toBeNull();
      // A failed pending admission must not leave a key-collision tombstone.
      const normal = await alias.acquire();
      await alias.release(normal.leaseId);
    } finally {
      await registry.unregisterResponseAlias(aliasId, conflictingGeneration);
    }
  });

  it("publishes and revokes a staged Responses alias with a generation fence", async () => {
    const alias = env.CHATS.getByName(`staged-alias-${crypto.randomUUID()}`);
    const staged = await alias.seed(
      crypto.randomUUID(),
      crypto.randomUUID(),
      "account-staged",
      "",
      "",
      "",
      "[]",
      [],
      "staged portable tail",
      true,
      "",
      true,
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error(staged.code);
    expect(await alias.tryCheckoutResponseAlias()).toEqual({ ok: false, code: "CONVERSATION_BUSY" });
    expect(await alias.publishResponseAlias(crypto.randomUUID(), staged.expiresAt)).toBe(false);
    expect(await alias.tryCheckoutResponseAlias()).toEqual({ ok: false, code: "CONVERSATION_BUSY" });
    expect(await alias.publishResponseAlias(staged.generation, staged.expiresAt)).toBe(true);
    expect((await alias.checkoutResponseAlias())?.portableProtocolTail).toBe("staged portable tail");
    expect(await alias.revokeResponseAlias(crypto.randomUUID())).toBe("generation_mismatch");
    expect(await alias.checkoutResponseAlias()).not.toBeNull();
    expect(await alias.revokeResponseAlias(staged.generation)).toBe("revoked");
    expect(await alias.checkoutResponseAlias()).toBeNull();
  });

  it("fences upstream runner identity to the lease account", async () => {
    const session = env.CHATS.getByName(`runner-account-fence-${crypto.randomUUID()}`);
    const acquired = await session.acquire();
    const lease = await session.bindAccount(acquired.leaseId, "account-correct");
    expect(await session.markUpstreamRun(
      lease.leaseId,
      "account-wrong",
      crypto.randomUUID(),
      crypto.randomUUID(),
    )).toBe(false);
    await session.release(lease.leaseId);
  });

  it("keeps the legacy rollback behavior for a buffered terminal failure", async () => {
    const session = env.CHATS.getByName("disconnect-checkpoint-test");
    const acquired = await session.acquire();
    const lease = await session.bindAccount(acquired.leaseId, "account-1");
    const checkpoint = {
      pendingCallId: lease.pendingCallId,
      pendingToolName: lease.pendingToolName,
      pendingToolArguments: lease.pendingToolArguments,
      toolLedgerSnapshot: lease.toolLedgerSnapshot,
      portableProtocolTail: "safe task context before interrupted turn",
    };
    await session.completeFinal(lease, lease.conversationId, lease.sessionId, {
      protocolTail: "new result that may not have reached the client",
    });
    await session.abandon(lease.leaseId, checkpoint);
    const resumed = await session.acquire();
    expect(resumed.portableProtocolTail).toBe(checkpoint.portableProtocolTail);
    expect(resumed.started).toBe(false);
    expect(resumed.toolLedgerSnapshot).toBe(checkpoint.toolLedgerSnapshot);
    await session.release(resumed.leaseId);
  });

  it("keeps a durable terminal result behind the streaming cancellation fence", async () => {
    const session = env.CHATS.getByName(`stream-commit-fence-${crypto.randomUUID()}`);
    const acquired = await session.acquire();
    const lease = await session.bindAccount(acquired.leaseId, "account-stream");
    const checkpoint = {
      pendingCallId: "old-call",
      pendingToolName: "exec_command",
      pendingToolArguments: JSON.stringify({ cmd: "Get-Item -LiteralPath C:\\safe" }),
      toolLedgerSnapshot: "[]",
      portableProtocolTail: "safe task context before interrupted turn",
    };
    await session.completeFinal(lease, lease.conversationId, lease.sessionId, {
      protocolTail: "new streamed result",
    });
    await session.abandonIfActive(lease.leaseId, checkpoint);
    const resumed = await session.acquire();
    expect(resumed.portableProtocolTail).toBe("new streamed result");
    expect(resumed.started).toBe(true);
    await session.release(resumed.leaseId);
  });

  it("restores the prior checkpoint when streaming cancellation wins before commit", async () => {
    const session = env.CHATS.getByName(`precommit-disconnect-${crypto.randomUUID()}`);
    const acquired = await session.acquire();
    const lease = await session.bindAccount(acquired.leaseId, "account-precommit");
    const checkpoint = {
      pendingCallId: "pending-safe",
      pendingToolName: "exec_command",
      pendingToolArguments: JSON.stringify({ cmd: "Get-Item -LiteralPath C:\\safe" }),
      toolLedgerSnapshot: "[]",
      portableProtocolTail: "safe task context before interrupted turn",
    };
    await session.abandonIfActive(lease.leaseId, checkpoint);
    const resumed = await session.acquire();
    expect(resumed.portableProtocolTail).toBe(checkpoint.portableProtocolTail);
    expect(resumed.pendingCallId).toBe(checkpoint.pendingCallId);
    expect(resumed.started).toBe(false);
    await session.release(resumed.leaseId);
  });

  it("tombstones a submitted upstream turn while preserving its pre-submit checkpoint", async () => {
    const session = env.CHATS.getByName(`submitted-failure-checkpoint-${crypto.randomUUID()}`);
    const acquired = await session.acquire();
    const lease = await session.bindAccount(acquired.leaseId, "account-submitted");
    const anchors = [{ kind: "windows_path" as const, value: "C:\\safe\\project" }];
    await session.mergeTaskAnchors(lease.leaseId, anchors);
    const gateLeaseId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    expect(await session.markUpstreamRun(lease.leaseId, lease.accountId, gateLeaseId, runId)).toBe(true);

    const checkpoint = {
      pendingCallId: "call-safe",
      pendingToolName: "exec_command",
      pendingToolArguments: JSON.stringify({ cmd: "Get-Item -LiteralPath C:\\safe\\project" }),
      toolLedgerSnapshot: JSON.stringify([{
        name: "exec_command",
        fingerprint: "opaque-safe-fingerprint",
        failed: false,
        completedCount: 1,
      }]),
      portableProtocolTail: "[USER]\ncontinue the safe task\n\n[ASSISTANT]\nprior visible result",
    };
    await session.abandonFailedUpstream(lease.leaseId, checkpoint);

    expect(await session.markUpstreamRun(
      lease.leaseId,
      lease.accountId,
      crypto.randomUUID(),
      crypto.randomUUID(),
    )).toBe(false);
    const resumed = await session.acquire();
    expect(resumed).toMatchObject({
      accountId: lease.accountId,
      accountLocked: true,
      started: false,
      pendingCallId: checkpoint.pendingCallId,
      pendingToolName: checkpoint.pendingToolName,
      pendingToolArguments: checkpoint.pendingToolArguments,
      toolLedgerSnapshot: checkpoint.toolLedgerSnapshot,
      portableProtocolTail: checkpoint.portableProtocolTail,
      taskAnchors: anchors,
    });
    expect(resumed.conversationId).not.toBe(lease.conversationId);
    expect(resumed.sessionId).not.toBe(lease.sessionId);
    const rebound = await session.rebindCommittedAccount(
      resumed.leaseId,
      lease.accountId,
      "account-successor",
    );
    expect(rebound).toMatchObject({
      accountId: "account-successor",
      accountLocked: false,
      started: false,
      pendingCallId: checkpoint.pendingCallId,
      pendingToolName: checkpoint.pendingToolName,
      pendingToolArguments: checkpoint.pendingToolArguments,
      toolLedgerSnapshot: checkpoint.toolLedgerSnapshot,
      portableProtocolTail: checkpoint.portableProtocolTail,
      taskAnchors: anchors,
    });
    expect(rebound.conversationId).not.toBe(resumed.conversationId);
    expect(rebound.sessionId).not.toBe(resumed.sessionId);
    const superseded = await session.supersedeActive();
    expect(superseded?.upstream).toBeNull();
    expect(superseded?.lease.accountId).toBe("");
    expect(superseded?.lease.portableProtocolTail).toBe(checkpoint.portableProtocolTail);
    if (superseded) await session.release(superseded.lease.leaseId);
  });

  it("rebinds a portable checkpoint to a healthy account without reusing upstream coordinates", async () => {
    const session = env.CHATS.getByName(`checkpoint-account-rebind-${crypto.randomUUID()}`);
    const acquired = await session.acquire();
    const bound = await session.bindAccount(acquired.leaseId, "account-checkpoint-old");
    await session.completeCheckpoint(bound, {
      protocolTail: "[USER]\ninspect the workspace\n\n[ASSISTANT]\ncheckpoint preserved",
      taskAnchors: [],
    }, "[]");

    const checkpoint = await session.acquire();
    expect(checkpoint).toMatchObject({
      accountId: "account-checkpoint-old",
      accountLocked: true,
      started: false,
      portableProtocolTail: expect.stringContaining("checkpoint preserved"),
    });
    const rebound = await session.rebindCommittedAccount(
      checkpoint.leaseId,
      "account-checkpoint-old",
      "account-checkpoint-new",
    );
    expect(rebound).toMatchObject({
      accountId: "account-checkpoint-new",
      accountLocked: false,
      started: false,
      portableProtocolTail: checkpoint.portableProtocolTail,
      toolLedgerSnapshot: checkpoint.toolLedgerSnapshot,
    });
    expect(rebound.conversationId).not.toBe(checkpoint.conversationId);
    expect(rebound.sessionId).not.toBe(checkpoint.sessionId);
    await session.release(rebound.leaseId);
  });

  it("preserves an empty legacy portable state without manufacturing recovery context", async () => {
    const session = env.CHATS.getByName(`empty-portable-rebind-${crypto.randomUUID()}`);
    const acquired = await session.acquire();
    const bound = await session.bindAccount(acquired.leaseId, "account-legacy-old");
    await session.completeFinal(bound, bound.conversationId, bound.sessionId, { protocolTail: "" });

    const legacy = await session.acquire();
    expect(legacy).toMatchObject({
      accountId: "account-legacy-old",
      accountLocked: true,
      started: true,
      portableProtocolTail: "",
    });
    await session.release(legacy.leaseId);
  });

  it("atomically supersedes a disconnected turn and exposes only its exact upstream identities", async () => {
    const session = env.CHATS.getByName("disconnect-supersession-test");
    const acquired = await session.acquire();
    const active = await session.bindAccount(acquired.leaseId, "account-disconnected");
    const runId = crypto.randomUUID();
    const gateLeaseId = crypto.randomUUID();
    await session.markUpstreamRun(active.leaseId, active.accountId, gateLeaseId, runId);

    const superseded = await session.supersedeActive();
    expect(superseded).not.toBeNull();
    expect(superseded?.upstream).toEqual({
      accountId: "account-disconnected",
      gateLeaseId,
      runId,
    });
    expect(superseded?.lease.leaseId).not.toBe(active.leaseId);
    expect(superseded?.lease.conversationId).not.toBe(active.conversationId);
    expect(superseded?.lease.sessionId).not.toBe(active.sessionId);

    // A late cleanup from the displaced request must not clear the new lease.
    await session.clearUpstreamRun(active.leaseId, runId);
    await session.release(superseded!.lease.leaseId);
  });
});
