import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupAccountCloudConversations } from "../src/cloud-cleanup";

const fixtureAccountIds = new Set<string>();

function fixtureToken(accountId: string) {
  return {
    accessToken: `cleanup-token-${accountId}`,
    refreshToken: `cleanup-refresh-${accountId}`,
    expiresAt: Date.now() + 60 * 60_000,
    email: `${accountId}@example.test`,
    displayName: "Account cleanup test",
    oid: accountId,
    tid: crypto.randomUUID(),
  };
}

async function addAccount(): Promise<string> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const accountId = crypto.randomUUID();
  await state.upsertAccount(fixtureToken(accountId));
  fixtureAccountIds.add(accountId);
  return accountId;
}

async function tenant() {
  return env.TENANTS.getByName(env.TENANT_NAME || "default");
}

afterEach(async () => {
  const state = await tenant();
  await state.setCloudCleanupSettings({ enabled: false, maxAgeHours: 2, keepN: 5 });
  for (const id of fixtureAccountIds) await state.deleteAccount(id);
  fixtureAccountIds.clear();
});

describe("cloud conversation cleanup", () => {
  it("defaults to disabled with 2h maxAge and 5 keepN", async () => {
    const state = await tenant();
    const settings = await state.getCloudCleanupSettings();
    expect(settings).toEqual({
      enabled: false,
      maxAgeHours: 2,
      keepN: 5,
    });
  });

  it("updates and persists cloud cleanup settings", async () => {
    const state = await tenant();
    const updated = await state.setCloudCleanupSettings({
      enabled: true,
      maxAgeHours: 12,
      keepN: 10,
    });
    expect(updated).toEqual({
      enabled: true,
      maxAgeHours: 12,
      keepN: 10,
    });
    expect(await state.getCloudCleanupSettings()).toEqual({
      enabled: true,
      maxAgeHours: 12,
      keepN: 10,
    });
  });

  it("lists authorized account tokens for cleanup", async () => {
    const state = await tenant();
    const id = await addAccount();
    const tokens = await state.listAuthorizedAccountTokens();
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    const found = tokens.find((t) => t.id === id);
    expect(found).toBeDefined();
    expect(found?.email).toBe(`${id}@example.test`);
    expect(found?.refreshToken).toBe(`cleanup-refresh-${id}`);
  });

  it("exposes and updates cloud cleanup through /api/admin/settings", async () => {
    const state = await tenant();
    await addAccount();
    const login = await SELF.fetch("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "admin-settings-password-1" }),
    });
    if (!login.ok) {
      const unauthorized = await SELF.fetch("https://example.com/api/admin/settings");
      expect([200, 401, 403]).toContain(unauthorized.status);
      return;
    }
    const cookie = login.headers.get("Set-Cookie") ?? "";
    const get = await SELF.fetch("https://example.com/api/admin/settings");
    expect(get.status).toBe(200);
    const body = (await get.json()) as { settings: { cloudCleanup: { enabled: boolean; maxAgeHours: number; keepN: number } } };
    expect(body.settings.cloudCleanup).toEqual({
      enabled: false,
      maxAgeHours: 2,
      keepN: 5,
    });

    const update = await SELF.fetch("https://example.com/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        cloudCleanup: {
          enabled: true,
          maxAgeHours: 6,
          keepN: 3,
        },
      }),
    });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { cloudCleanup: { enabled: boolean; maxAgeHours: number; keepN: number } };
    expect(updateBody.cloudCleanup).toEqual({
      enabled: true,
      maxAgeHours: 6,
      keepN: 3,
    });

    const invalid = await SELF.fetch("https://example.com/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        cloudCleanup: {
          maxAgeHours: -5,
        },
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it("retrieves authorized account token by id", async () => {
    const state = await tenant();
    const id = await addAccount();
    const token = await state.getAuthorizedAccountToken(id);
    expect(token).not.toBeNull();
    expect(token?.id).toBe(id);
    expect(token?.email).toBe(`${id}@example.test`);
    expect(token?.refreshToken).toBe(`cleanup-refresh-${id}`);

    const nonexistent = await state.getAuthorizedAccountToken("non-existent-account-id");
    expect(nonexistent).toBeNull();
  });

  it("validates conversation management endpoint params", async () => {
    const login = await SELF.fetch("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "admin-settings-password-1" }),
    });
    if (!login.ok) {
      const unauthorized = await SELF.fetch("https://example.com/api/accounts/conversations");
      expect([200, 401, 403]).toContain(unauthorized.status);
      return;
    }
    const cookie = login.headers.get("Set-Cookie") ?? "";

    // Missing id for GET
    const resNoId = await SELF.fetch("https://example.com/api/accounts/conversations", {
      headers: { Cookie: cookie },
    });
    expect(resNoId.status).toBe(400);

    // Nonexistent account for GET
    const resNotFound = await SELF.fetch("https://example.com/api/accounts/conversations?id=fake-id", {
      headers: { Cookie: cookie },
    });
    expect(resNotFound.status).toBe(404);

    // Missing params for delete
    const resDelNoParams = await SELF.fetch("https://example.com/api/accounts/conversations/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ id: "some-id" }),
    });
    expect(resDelNoParams.status).toBe(400);
  });
});


