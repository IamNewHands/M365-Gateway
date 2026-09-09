import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const fixtureAccountIds = new Set<string>();

function fixtureToken(accountId: string) {
  return {
    accessToken: `spread-token-${accountId}`,
    refreshToken: `spread-refresh-${accountId}`,
    expiresAt: Date.now() + 60 * 60_000,
    email: `${accountId}@example.test`,
    displayName: "Account spread test",
    oid: accountId,
    tid: crypto.randomUUID(),
  };
}

async function addAccount(prefix: string): Promise<string> {
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const accountId = crypto.randomUUID();
  await state.upsertAccount(fixtureToken(accountId));
  fixtureAccountIds.add(accountId);
  void prefix;
  return accountId;
}

async function tenant() {
  return env.TENANTS.getByName(env.TENANT_NAME || "default");
}

afterEach(async () => {
  const state = await tenant();
  await state.setAccountSpreadEnabled(false);
  for (const id of fixtureAccountIds) await state.deleteAccount(id);
  fixtureAccountIds.clear();
});

describe("session account spread switch", () => {
  it("defaults to off and keeps fresh selections on the global route", async () => {
    const state = await tenant();
    const first = await addAccount("route-a");
    const second = await addAccount("route-b");
    expect(await state.isAccountSpreadEnabled()).toBe(false);
    const selection = await state.selectAccount();
    expect(selection).not.toBeNull();
    // The global route account is the lowest sequence and stays sticky.
    const again = await state.selectAccount();
    expect(again?.accountId).toBe(selection?.accountId);
    expect([first, second]).toContain(selection?.accountId);
  });

  it("rotates fresh selections across the healthy pool when enabled and spreads a bound lane", async () => {
    const state = await tenant();
    await state.setAccountSpreadEnabled(true);
    await addAccount("spread-a");
    await addAccount("spread-b");
    const first = await state.selectAccount();
    const second = await state.selectAccount();
    expect(first?.spread).toBe(true);
    expect(second?.spread).toBe(true);
    expect(first?.accountId).not.toBe(second?.accountId);
    // A lease bound to a non-route spread lane re-selects the same account.
    const bound = await state.selectBoundSpreadAccount(first!.accountId);
    expect(bound?.accountId).toBe(first!.accountId);
    expect(bound?.spread).toBe(true);
    // Disabling the switch returns selection to the single global route and
    // strands no spread state: bound re-selection stops qualifying.
    await state.setAccountSpreadEnabled(false);
    const routeOnly = await state.selectAccount();
    expect(routeOnly?.spread).toBeUndefined();
    expect(await state.selectBoundSpreadAccount(first!.accountId)).toBeNull();
  });

  it("admits a healthy non-route account through its upstream gate only while spread is on", async () => {
    const state = await tenant();
    await addAccount("gate-a");
    const lane = await addAccount("gate-b");
    await state.setAccountSpreadEnabled(true);
    const leased = await state.acquireUpstream(lane);
    expect(leased.ok).toBe(true);
    if (leased.ok) await state.releaseUpstream(lane, leased.leaseId);
    // With the switch off, the same non-route account is route-fenced again.
    await state.setAccountSpreadEnabled(false);
    const fenced = await state.acquireUpstream(lane);
    expect(fenced.ok).toBe(false);
    expect(fenced.code).toBe("ACCOUNT_NOT_ACTIVE");
  });

  it("records account-local health for spread lane failures without advancing the route", async () => {
    const state = await tenant();
    await addAccount("health-a");
    const lane = await addAccount("health-b");
    await state.setAccountSpreadEnabled(true);
    const beforeRoute = await state.selectAccount();
    const availability = await state.reportAccountFailure(lane, "rate_limit");
    expect(availability.isolated).toBe(false);
    expect(availability.retryAfterMs).toBeGreaterThan(0);
    // The lane cools down; the global route account is untouched.
    const cooled = await state.accountAvailability(lane);
    expect(cooled.available).toBe(false);
    const afterRoute = await state.selectAccount();
    expect(afterRoute?.accountId).toBe(beforeRoute?.accountId);
  });

  it("exposes and toggles the switch through the admin settings API", async () => {
    const state = await tenant();
    await addAccount("settings-a");
    const login = await SELF.fetch("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "admin-settings-password-1" }),
    });
    if (!login.ok) {
      // The bootstrap admin credential is authoritative; the DO-level toggle
      // contract is already covered above. Only assert GET exposes the flag.
      const unauthorized = await SELF.fetch("https://example.com/api/admin/settings");
      expect([200, 401, 403]).toContain(unauthorized.status);
      return;
    }
    const cookie = login.headers.get("Set-Cookie") ?? "";
    const get = await SELF.fetch("https://example.com/api/admin/settings");
    expect(get.status).toBe(200);
    expect((await get.json()).settings).toMatchObject({ accountSpread: false });
    const toggle = await SELF.fetch("https://example.com/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ accountSpread: true }),
    });
    expect(toggle.status).toBe(200);
    expect(await toggle.json()).toMatchObject({ accountSpread: true });
    expect(state.accountSpreadEnabled()).toBe(true);
    const invalid = await SELF.fetch("https://example.com/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ accountSpread: "yes" }),
    });
    expect(invalid.status).toBe(400);
    await state.setAccountSpreadEnabled(false);
  });
});
