import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("asset routing smoke", () => {
  it("protects management shell paths", async () => {
    for (const path of ["/", "/index.html", "/login", "/login.html"]) {
      const response = await SELF.fetch(`https://example.com${path}`, { redirect: "manual" });
      if (path === "/login") {
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("text/html");
      } else {
        expect(response.status).toBe(307);
        expect(response.headers.get("Location")).toBe("https://example.com/login");
      }
    }
  });

  it("serves the legacy debug asset directly", async () => {
    const response = await SELF.fetch("https://example.com/debug.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    await expect(response.text()).resolves.toContain("诊断记录已合并到管理后台");
  });
});
