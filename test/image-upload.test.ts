import { afterEach, describe, expect, it, vi } from "vitest";
import { MULTI_IMAGE_UPLOAD_OPTION, uploadConversationImages } from "../src/image-upload";
import { chatHub } from "../src/chathub";
import { publicFailure } from "../src/openai";
import type { OAuthTokenSet } from "../src/types";
const account = { accessToken: "test-private-token", oid: "11111111-2222-4333-8444-555555555555", tid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } as OAuthTokenSet;
const image = { type: "image" as const, url: "data:image/png;base64,AAAA", mimeType: "image/png", detail: "high" as const };
async function uploadForm(init: RequestInit | undefined): Promise<FormData> {
  if (init?.body instanceof FormData) return init.body;
  return new Response(init?.body, { headers: init?.headers }).formData();
}
afterEach(() => vi.restoreAllMocks());
describe("Microsoft conversation image upload", () => {
  it("logs only an allow-listed success shape without identifiers or URLs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const privateId = "private-doc-identifier";
    const privateUrl = "https://files.microsoft.example/private.png?token=secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      result: { value: "Success" }, conversationId: "conversation", docId: privateId,
      fileUrl: privateUrl, privateField: "private-value",
    }));
    await uploadConversationImages(account, "conversation", [image], new AbortController().signal);
    expect(info).toHaveBeenCalledOnce();
    const record = JSON.parse(String(info.mock.calls[0][0]));
    expect(record).toEqual({
      event: "image_upload_success_shape",
      fields: [
        { field: "result.value", type: "string" },
        { field: "conversationId", type: "string" },
        { field: "docId", type: "string" },
        { field: "fileUrl", type: "string" },
      ],
      usable_file_url: true,
    });
    expect(JSON.stringify(record)).not.toMatch(/private-doc|files\.microsoft|token=secret|privateField|private-value/u);
  });

  it("does nothing for text/tools without images", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await uploadConversationImages(account, "conversation", undefined, new AbortController().signal);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the official AAD UploadFile routing and native multipart encoding", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-AnchorMailbox")).toBe(`Oid:${account.oid}@${account.tid}`);
      expect(headers.get("X-Variants")).toBe("feature.EnableImageSupportInUploadFile");
      expect(headers.get("X-Scenario")).toBe("officeweb");
      expect(headers.get("Content-Type")).toBeNull();
      expect(headers.get("Authorization")).toBe(`Bearer ${account.accessToken}`);
      expect(init?.body).toBeInstanceOf(FormData);
      expect((await uploadForm(init)).get("FileBase64")).toBe(image.url);
      return Response.json({ result: { value: "Success" }, conversationId: "conversation", docId: "image-id" });
    });
    await uploadConversationImages(account, "conversation", [image], new AbortController().signal);
  });
  it("uploads serially with exact bytes, authenticated conversation and no redirect following", async () => {
    const bodies: FormData[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(url).toBe("https://substrate.office.com/m365Copilot/UploadFile");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-private-token");
      bodies.push(await uploadForm(init));
      return Response.json({ result: { value: "Success" }, conversationId: "conversation", docId: "image-id" });
    });
    await uploadConversationImages(account, "conversation", [image, image], new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0].get("FileBase64")).toBe(image.url);
    expect(bodies[0].get("conversationId")).toBe("conversation");
    expect(bodies[0].get("scenario")).toBe("UploadImage");
    expect(bodies[0].getAll("optionsSets")).toHaveLength(3);
    expect(bodies[0].getAll("optionsSets")).toContain(MULTI_IMAGE_UPLOAD_OPTION);
  });
  it("keeps a large inline image intact in native multipart data", async () => {
    const largeImage = { ...image, url: `data:image/png;base64,${"A".repeat(160_000)}` };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const form = await uploadForm(init);
      expect(init?.body).toBeInstanceOf(FormData);
      expect(form.get("FileBase64")).toBe(largeImage.url);
      expect(form.getAll("optionsSets")).toEqual(["cwcgptvsan", MULTI_IMAGE_UPLOAD_OPTION, "gptvnorm2048"]);
      return Response.json({ result: { value: "Success" }, conversationId: "conversation", docId: "image-id" });
    });
    await uploadConversationImages(account, "conversation", [largeImage], new AbortController().signal);
  });
  it.each([
    "https://substrate.office.com/images/file-1?signature=test",
    "https://files.microsoft.example/image.png?signature=test",
  ])("preserves an optional HTTPS upload reference without fetching it: %s", async fileUrl => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      result: { value: "Success" }, conversationId: "conversation", docId: "image-id", fileUrl,
    }));
    const result = await uploadConversationImages(account, "conversation", [image], new AbortController().signal);
    expect(result).toEqual([{ conversationId: "conversation", docId: "image-id", mimeType: "image/png", fileUrl }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, "", "not a URL", "http://files.example/a", "https://user:pass@files.example/a", "https://files.example/a\n", "data:image/png;base64,AAAA"])("ignores an unusable optional URL without discarding a verified docId: %s", async fileUrl => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      result: { value: "Success" }, conversationId: "conversation", docId: "image-id", fileUrl,
    }));
    expect(await uploadConversationImages(account, "conversation", [image], new AbortController().signal))
      .toEqual([{ conversationId: "conversation", docId: "image-id", mimeType: "image/png" }]);
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

describe("uploaded image references on the actual ChatHub wire", () => {
  const RS = "\u001e";
  function upstream(options: { firstDialFails?: boolean; disconnectAfterSubmit?: boolean; secondUploadFails?: boolean; fileUrl?: string; type2Only?: boolean } = {}) {
    const uploads: Array<{ conversationId: string; docId: string; bytes: string; optionsSets: FormDataEntryValue[] }> = [];
    const invocations: Array<{ conversationId: string; optionsSets: string[]; message: Record<string, unknown> }> = [];
    const urls: URL[] = [];
    let dials = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input));
      if (url.hostname !== "substrate.office.com") throw new Error("unexpected outbound request in offline image test");
      if (url.pathname === "/m365Copilot/UploadFile") {
        const form = await uploadForm(init);
        const conversationId = String(form.get("conversationId"));
        const docId = `verified-image-${uploads.length + 1}`;
        uploads.push({ conversationId, docId, bytes: String(form.get("FileBase64")), optionsSets: form.getAll("optionsSets") });
        if (options.secondUploadFails && uploads.length === 2) return Response.json({ result: { value: "Failure" }, conversationId });
        return Response.json({ result: { value: "Success" }, conversationId, docId, fileUrl: options.fileUrl });
      }
      dials += 1;
      urls.push(url);
      if (options.firstDialFails && dials === 1) return new Response(null, { status: 503 });
      const pair = new WebSocketPair();
      const server = pair[1]; server.accept();
      let handshaken = false;
      server.addEventListener("message", event => {
        if (!handshaken) { handshaken = true; server.send(`{}${RS}`); return; }
        for (const frame of String(event.data).split(RS).filter(Boolean)) {
          const payload = JSON.parse(frame);
          if (payload.target !== "chat") continue;
          invocations.push(payload.arguments[0]);
          if (options.disconnectAfterSubmit) { server.close(1000, "offline disconnect fixture"); return; }
          server.send(`${JSON.stringify({ type: 2, item: { result: { message: "offline answer fixture" } } })}${RS}${options.type2Only ? "" : `${JSON.stringify({ type: 3 })}${RS}`}`);
        }
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
    return { uploads, invocations, urls, dials: () => dials };
  }
  const request = { text: "Read this image.", conversationId: "conversation", sessionId: "session", started: true, tone: "Chat" };

  it("sends each verified upload as an ImageFile annotation on the routed ChatHub connection", async () => {
    const fileUrl = "https://files.microsoft.example/uploaded.png?signature=fixture";
    const wire = upstream({ fileUrl });
    await chatHub(account, { ...request, attachments: [image] });
    expect(wire.invocations).toHaveLength(1);
    const invocation = wire.invocations[0];
    expect(invocation.message.imageUrl).toBeUndefined();
    expect(invocation.queryAnnotations).toBeUndefined();
    expect(invocation.message.attachments).toBeUndefined();
    expect(invocation.message.messageAnnotations).toEqual([{
      id: wire.uploads[0].docId,
      messageAnnotationMetadata: {
        "@type": "File",
        annotationType: "File",
        fileType: "png",
        fileName: "image.png",
      },
      messageAnnotationType: "ImageFile",
    }]);
    expect(invocation.message.queryAnnotations).toBeUndefined();
    expect(invocation.message.entityAnnotationTypes).toEqual(["People", "File", "Event", "Email", "TeamsMessage"]);
    expect(invocation.optionsSets).toContain("cwcfluxgptv");
    expect(invocation.optionsSets).not.toContain("cwcgptv");
    expect(invocation.optionsSets).toContain("cwc_flux_v3");
    expect(invocation.optionsSets).toContain("flux_v3_references");
    expect(invocation.optionsSets).toContain("flux_v3_progress_messages");
    expect(invocation.optionsSets).toContain("cwc_fileupload_odb");
    expect(invocation.optionsSets).toContain("flux_v3_references_entities");
    expect(invocation.optionsSets).toContain("rich_responses");
    expect(new Set(invocation.optionsSets).size).toBe(invocation.optionsSets.length);
    expect(invocation.optionsSets).toContain(MULTI_IMAGE_UPLOAD_OPTION);
    expect(wire.uploads[0].optionsSets).toContain(MULTI_IMAGE_UPLOAD_OPTION);
    expect(wire.urls[0].searchParams.has("variants")).toBe(true);
    expect(wire.urls[0].searchParams.has("X-variants")).toBe(false);
    expect(JSON.stringify(invocation)).not.toContain("data:image/");
    expect(invocation.conversationId).toBe(wire.uploads[0].conversationId);
    expect(invocation.message.text).toBe(request.text);
    expect(wire.urls[0].searchParams.get("XRoutingParameterSessionKey")).toBe(wire.urls[0].searchParams.get("chatsessionid"));
    expect(wire.urls[0].searchParams.get("clientrequestid")).toBe(wire.urls[0].searchParams.get("chatsessionid"));
  });

  it("completes from Microsoft's final type:2 item when type:3 is omitted", async () => {
    upstream({ type2Only: true });
    const result = await chatHub(account, { ...request, attachments: [image] });
    expect(result.text).toBe("offline answer fixture");
  });

  it("binds every verified image without replaying client bytes or metadata", async () => {
    const wire = upstream();
    await chatHub(account, { ...request, attachments: [image, image] });
    const invocation = wire.invocations[0];
    expect(invocation.message.imageUrl).toBeUndefined();
    expect(invocation.queryAnnotations).toBeUndefined();
    expect(invocation.message.attachments).toBeUndefined();
    expect(invocation.message.messageAnnotations).toEqual(wire.uploads.map(upload => ({
      id: upload.docId,
      messageAnnotationMetadata: {
        "@type": "File",
        annotationType: "File",
        fileType: "png",
        fileName: "image.png",
      },
      messageAnnotationType: "ImageFile",
    })));
    expect(invocation.message.queryAnnotations).toBeUndefined();
    expect(invocation.optionsSets).toContain("flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch");
    expect(JSON.stringify(invocation)).not.toContain("data:image/");
  });

  it("does not add image options or fields to ordinary text requests", async () => {
    const wire = upstream();
    await chatHub(account, request);
    expect(wire.uploads).toEqual([]);
    expect(wire.invocations[0].optionsSets).toEqual([]);
    expect(wire.invocations[0].message.imageUrl).toBeUndefined();
    expect(wire.invocations[0].queryAnnotations).toBeUndefined();
    expect(wire.invocations[0].message.queryAnnotations).toBeUndefined();
    expect(wire.invocations[0].message.attachments).toBeUndefined();
    expect(wire.invocations[0].message.messageAnnotations).toBeUndefined();
    expect(wire.invocations[0].message.entityAnnotationTypes).toBeUndefined();
    expect(wire.invocations[0].message.text).toBe(request.text);
    expect(wire.urls[0].searchParams.get("variants")?.split(",")).not.toContain("cdxodimgupload");
    expect(wire.urls[0].searchParams.get("variants")?.split(",")).not.toContain("agt_module_enableImageUploadFromOD");
    expect(wire.urls[0].searchParams.has("X-variants")).toBe(false);
    expect(wire.urls[0].searchParams.get("XRoutingParameterSessionKey")).toBe(wire.urls[0].searchParams.get("chatsessionid"));
  });

  it("reuses the same verified binding after a pre-submit dial failure without uploading twice", async () => {
    const wire = upstream({ firstDialFails: true });
    await chatHub(account, { ...request, attachments: [image] });
    expect(wire.uploads).toHaveLength(1);
    expect(wire.dials()).toBe(2);
    expect(wire.invocations).toHaveLength(1);
    expect(wire.invocations[0].conversationId).toBe(wire.uploads[0].conversationId);
    expect(wire.invocations[0].message.imageUrl).toBeUndefined();
    expect(wire.invocations[0].message.attachments).toBeUndefined();
    expect(wire.invocations[0].message.messageAnnotations).toMatchObject([{ id: wire.uploads[0].docId }]);
    expect(wire.invocations[0].message.queryAnnotations).toBeUndefined();
    expect(wire.urls[1].searchParams.get("XRoutingParameterSessionKey")).toBe(wire.urls[1].searchParams.get("chatsessionid"));
  });

  it("uploads each new image with exact bytes in consecutive turns of the same conversation", async () => {
    const wire = upstream();
    const second = { ...image, url: "data:image/png;base64,AQID" };
    await chatHub(account, { ...request, attachments: [image] });
    await chatHub(account, { ...request, started: false, attachments: [second] });
    expect(wire.uploads.map(upload => upload.bytes)).toEqual([image.url, second.url]);
    expect(wire.invocations).toHaveLength(2);
    expect(wire.uploads[0].docId).not.toBe(wire.uploads[1].docId);
    for (const [index, invocation] of wire.invocations.entries()) {
      expect(invocation.conversationId).toBe(request.conversationId);
      expect(invocation.message.attachments).toBeUndefined();
      expect(invocation.message.messageAnnotations).toMatchObject([{ id: wire.uploads[index].docId }]);
      expect(invocation.message.queryAnnotations).toBeUndefined();
      expect(invocation.optionsSets).toContain(MULTI_IMAGE_UPLOAD_OPTION);
    }
  });

  it("never replays submitted image references onto a fresh conversation after disconnect", async () => {
    const wire = upstream({ disconnectAfterSubmit: true });
    await expect(chatHub(account, { ...request, attachments: [image] })).rejects.toMatchObject({ invocationSubmitted: true });
    expect(wire.uploads).toHaveLength(1);
    expect(wire.dials()).toBe(1);
    expect(wire.invocations).toHaveLength(1);
  });

  it("does not submit a partial image set when the second binding is unconfirmed", async () => {
    const wire = upstream({ secondUploadFails: true });
    await expect(chatHub(account, { ...request, attachments: [image, image] })).rejects.toThrow("IMAGE_UPLOAD_NOT_BOUND");
    expect(wire.uploads).toHaveLength(2);
    expect(wire.dials()).toBe(0);
    expect(wire.invocations).toEqual([]);
  });
});

describe("bounded upload failure diagnostics", () => {
  function diagnostic() {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return () => {
      expect(warn).toHaveBeenCalledTimes(1);
      return JSON.parse(String(warn.mock.calls[0][0])) as Record<string, unknown>;
    };
  }

  it("reports only known error enums, JSON field types and auth challenge categories", async () => {
    const record = diagnostic();
    const privateText = "private-body-token https://private.example/?token=secret user@example.test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { code: "AccessDenied", message: privateText, innerError: { requestId: privateText } },
      result: { value: "InvalidRequest", message: privateText },
      [privateText]: privateText,
    }, { status: 403, headers: {
      "WWW-Authenticate": `Bearer realm="${privateText}", error="insufficient_scope", claims="${privateText}"`,
    } }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    const logged = record();
    expect(logged).toMatchObject({
      event: "image_upload_failure", status: 403, content_type: "application/json", body_kind: "json",
      error_code: "AccessDenied", result_value: "InvalidRequest",
      auth_challenge: { scheme: "bearer", error: "insufficient_scope", claims: true },
    });
    expect(logged.json_fields).toContainEqual({ field: "error.code", type: "string" });
    expect(logged.json_fields).toContainEqual({ field: "error.message", type: "string" });
    expect(JSON.stringify(logged)).not.toMatch(/private-body-token|private\.example|user@example|test-private-token|conversation"/u);
  });

  it("classifies HTML denial without retaining its contents or content-type parameters", async () => {
    const record = diagnostic();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>private-waf-body-token</html>", {
      status: 403, headers: { "Content-Type": "text/html; private=header-secret" },
    }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    const logged = record();
    expect(logged).toMatchObject({ content_type: "text/html", body_kind: "html" });
    expect(JSON.stringify(logged)).not.toMatch(/private-waf-body-token|header-secret/u);
  });

  it("does not disclose unknown error values, JSON property names or auth parameters", async () => {
    const record = diagnostic();
    const secret = "unique-secret-fixture";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { code: secret, [secret]: secret }, result: { value: secret }, [secret]: { token: secret },
    }, { status: 403, headers: { "WWW-Authenticate": `Bearer error="${secret}", authorization_uri="https://${secret}.invalid"` } }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    const logged = record();
    expect(logged).toMatchObject({ error_code: "other", result_value: "other", auth_challenge: { scheme: "bearer", error: "other", claims: false } });
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("caps a chunked denial at 8 KiB and cancels the remaining body", async () => {
    const record = diagnostic();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4096).fill(65)); }, cancel,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 403, headers: { "Content-Type": "application/json" } }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    expect(record()).toMatchObject({ body_kind: "truncated", body_bytes: 8192 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps the original HTTP error if diagnostic JSON is malformed", async () => {
    const record = diagnostic();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"private":', { status: 403, headers: { "Content-Type": "application/json" } }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    expect(record()).toMatchObject({ body_kind: "invalid_json" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not replace an HTTP denial when its diagnostic stream fails", async () => {
    const record = diagnostic();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private-reader-failure")); } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 403 }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    const logged = record();
    expect(logged).toMatchObject({ body_kind: "unreadable" });
    expect(JSON.stringify(logged)).not.toContain("private-reader-failure");
  });

  it("bounds a stalled diagnostic body instead of delaying the original error indefinitely", async () => {
    const record = diagnostic();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); }, cancel });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 403 }));
    await expect(uploadConversationImages(account, "conversation", [image], new AbortController().signal)).rejects.toThrow("IMAGE_UPLOAD_HTTP_403");
    expect(record()).toMatchObject({ body_kind: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  }, 3_000);

  it.each([401, 403, 429, 500])("retains the compatible public code and identifies HTTP %s", status => {
    const failure = publicFailure(new Error(`IMAGE_UPLOAD_HTTP_${status}`));
    expect(failure.code).toBe("image_upload_failed");
    expect(failure.message).toContain(`HTTP ${status}`);
    expect(failure.message).toContain("no image question was sent");
  });

  it("distinguishes transport, malformed response and binding failures without reflecting arbitrary input", () => {
    const failures = ["UNAVAILABLE", "INVALID_RESPONSE", "NOT_BOUND"].map(code => publicFailure(new Error(`IMAGE_UPLOAD_${code}`)));
    expect(failures.every(failure => failure.code === "image_upload_failed")).toBe(true);
    expect(new Set(failures.map(failure => failure.message)).size).toBe(3);
    expect(failures[0].message).toContain("could not be reached or timed out");
    expect(failures[1].message).toContain("invalid or oversized response");
    expect(failures[2].message).toContain("conversation binding");
    expect(publicFailure(new Error("IMAGE_UPLOAD_HTTP_403 private-token https://private.invalid"))).toEqual({
      code: "upstream_error", message: "Microsoft 365 upstream request failed",
    });
  });
});
