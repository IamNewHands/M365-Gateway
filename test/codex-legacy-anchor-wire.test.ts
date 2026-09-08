import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientToolWireName } from "../src/chathub";

const RS = "\u001e";
const accounts = new Set<string>();
const keys = new Set<string>();

function encoded(value: string): string {
  return Array.from(value, (character) => /[A-Ya-z0-9\u0080-\uFFFF]/u.test(character)
    ? character : `Z${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}X`).join("");
}

afterEach(async () => {
  vi.restoreAllMocks();
  const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
  for (const id of accounts) await state.deleteAccount(id);
  for (const id of keys) await state.revokeAPIKey(id);
  accounts.clear(); keys.clear();
});

describe("Legacy command provenance stays internal on public protocols", () => {
  it.each([
    ["responses", false], ["responses", true],
    ["chat/completions", false], ["chat/completions", true],
    ["messages", false], ["messages", true],
  ] as const)("retains legacy path repair without exposing parser metadata (%s, stream=%s)", async (protocol, stream) => {
    const state = env.TENANTS.getByName(env.TENANT_NAME || "default");
    const id = crypto.randomUUID();
    await state.upsertAccount({ accessToken: "offline-fixture-token", refreshToken: "offline-fixture-refresh", expiresAt: Date.now() + 3600000, email: `${id}@example.test`, displayName: "Offline legacy wire test", oid: id, tid: crypto.randomUUID() });
    accounts.add(id);
    const created = await state.createAPIKey(`legacy-wire-${id}`, 1);
    keys.add(created.record.id);
    const legacy = `\`\`\`${clientToolWireName("exec_command")}\n${JSON.stringify({ cmd: encoded("Get-Item -LiteralPath 'C:/fixtures/服务X器X'") })}\n\`\`\``;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input));
      if (url.hostname !== "substrate.office.com") throw new Error("unexpected outbound request blocked by offline test");
      const pair = new WebSocketPair();
      const server = pair[1]; server.accept();
      let handshaken = false;
      server.addEventListener("message", () => {
        if (!handshaken) { handshaken = true; server.send(`{}${RS}`); return; }
        server.send(`${JSON.stringify({ type: 2, item: { result: { message: legacy } } })}${RS}${JSON.stringify({ type: 3 })}${RS}`);
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
    const parameters = { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false };
    const prompt = "Inspect the local directory C:/fixtures/服务器 using the declared caller tool.";
    const body = protocol === "responses"
      ? { input: prompt, tools: [{ type: "function", name: "exec_command", parameters }], tool_choice: "required" }
      : protocol === "chat/completions"
        ? { messages: [{ role: "user", content: prompt }], tools: [{ type: "function", function: { name: "exec_command", parameters } }], tool_choice: "required" }
        : { messages: [{ role: "user", content: prompt }], max_tokens: 1000, tools: [{ name: "exec_command", input_schema: parameters }], tool_choice: { type: "tool", name: "exec_command" } };
    const response = await SELF.fetch(`https://example.com/v1/${protocol}`, { method: "POST", headers: {
      Authorization: `Bearer ${created.key}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": created.key,
    }, body: JSON.stringify({ model: "gpt-5.6-sol", stream, ...body }) });
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain("Get-Item");
    expect(wire).toContain("C:/fixtures/服务器");
    expect(wire).not.toContain("服务X器X");
    expect(wire).not.toContain("argumentEncoding");
    expect(wire).not.toContain("legacy_azhex");
  });
});
