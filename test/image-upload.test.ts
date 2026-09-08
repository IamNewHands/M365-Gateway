import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadConversationImages } from "../src/image-upload";
import { chatHub } from "../src/chathub";
import { publicFailure } from "../src/openai";
import type { OAuthTokenSet } from "../src/types";
const account = { accessToken: "test-private-token" } as OAuthTokenSet;
const image = { type: "image" as const, url: "data:image/png;base64,AAAA", mimeType: "image/png", detail: "high" as const };
afterEach(() => vi.restoreAllMocks());
describe("Microsoft conversation image upload", () => {
  it("does nothing for text/tools without images", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await uploadConversationImages(account, "conversation", undefined, new AbortController().signal);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uploads serially with exact bytes, authenticated conversation and no redirect following", async () => {
    const bodies: FormData[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(url).toBe("https://substrate.office.com/m365Copilot/UploadFile");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-private-token");
      bodies.push(init?.body as FormData);
      return Response.json({ result: { value: "Success" }, conversationId: "conversation", docId: "image-id" });
    });
    await uploadConversationImages(account, "conversation", [image, image], new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0].get("FileBase64")).toBe(image.url);
    expect(bodies[0].get("conversationId")).toBe("conversation");
    expect(bodies[0].get("scenario")).toBe("UploadImage");
    expect(bodies[0].getAll("optionsSets")).toHaveLength(3);
  });
  it.each([
    { result: { value: "InvalidRequest" }, conversationId: "conversation", docId: "id" },
    { result: { value: "Success" }, conversationId: "wrong", docId: "id" },
    { result: { value: "Success" }, conversationId: "conversation" },
  ])("rejects unconfirmed binding and never sends chat: %j", async result => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(result));
    await expect(chatHub(account, { text: "read", conversationId: "conversation", sessionId: "session", started: false, tone: "Chat", attachments: [image] })).rejects.toThrow("IMAGE_UPLOAD_NOT_BOUND");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("fails closed on authorization or redirects, with no body/secret leak", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret response", { status: 403 }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    expect(publicFailure(new Error("IMAGE_UPLOAD_HTTP_403")).code).toBe("image_upload_failed");
  });
  it("bounds upstream replies before parsing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(65_537)));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_INVALID_RESPONSE");
  });
  it("does not fetch unverified remote URLs with Microsoft credentials", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(uploadConversationImages(account, "conversation", [{ ...image, url: "https://example.com/image.png" }], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_INLINE_REQUIRED");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors cancellation before upload", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(uploadConversationImages(account, "conversation", [image], controller.signal)).rejects.toThrow("REQUEST_ABORTED");
    expect(fetch).not.toHaveBeenCalled();
  });
});
