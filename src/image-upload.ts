import { normalizeMultimodalContent, type NormalizedImageAttachment } from "./multimodal";
import { readJSONLimited } from "./request-body";
import type { OAuthTokenSet } from "./types";

/** References returned only after UploadFile confirms the same conversation. */
export interface UploadedConversationImage {
  conversationId: string;
  docId: string;
  mimeType: string;
  fileUrl?: string;
}

// UploadFile and the chat turn must select the same image-reference protocol,
// including turns that contain only one image.
export const MULTI_IMAGE_UPLOAD_OPTION = "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch";
const IMAGE_UPLOAD_URL = "https://substrate.office.com/m365Copilot/UploadFile";

/** Keep the optional reference from Microsoft's authenticated upload response
 * in memory only. Microsoft may host the file separately from UploadFile;
 * this URL is passed back to ChatHub, never fetched or logged by the gateway. */
function uploadedImageFileURL(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /[\u0000-\u0020\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const FAILURE_DIAGNOSTIC_BYTES = 8 * 1024;
const FAILURE_DIAGNOSTIC_TIMEOUT_MS = 1_000;
const UPLOAD_ERROR_ENUMS = [
  "AccessDenied", "Forbidden", "Unauthorized", "InvalidAuthenticationToken", "InvalidToken", "TokenExpired",
  "InvalidAudience", "InsufficientPermissions", "InsufficientPrivileges", "Authorization_RequestDenied",
  "AuthenticationError", "InvalidRequest", "BadRequest", "AuthorizationFailed", "RequestBlocked", "PolicyDenied",
  "TooManyRequests", "RateLimitExceeded", "ServiceUnavailable", "InternalServerError",
  "invalid_token", "insufficient_scope", "access_denied", "invalid_request", "invalid_client", "invalid_grant",
  "invalid_scope", "interaction_required", "consent_required",
] as const;
const UPLOAD_RESULT_ENUMS = ["Success", "Error", "Failure", "Throttled", "InternalError", ...UPLOAD_ERROR_ENUMS];
const DIAGNOSTIC_JSON_FIELDS = [
  "error", "error.code", "error.message", "error.innerError", "error.innerError.code", "error.innerError.requestId",
  "error.innererror", "error.innererror.code", "error_description", "error_codes", "code", "message", "status",
  "statusCode", "title", "detail", "type", "result", "result.code", "result.value", "result.message",
  "requestId", "correlationId", "traceId", "conversationId", "docId", "fileName", "fileType", "fileSize", "fileSanitizer",
] as const;
const UPLOAD_SUCCESS_DIAGNOSTIC_FIELDS = [
  "result.value", "conversationId", "docId", "fileUrl", "fileName", "fileType",
  "fileSize", "fileSanitizer", "url", "downloadUrl", "webUrl", "contentUrl",
] as const;

function diagnosticEnum(value: unknown, allowed: readonly string[]): string {
  if (value === undefined || value === null) return "absent";
  // Return a literal from our list, never a substring of upstream content.
  return typeof value === "string" ? allowed.find(entry => entry.toLowerCase() === value.toLowerCase()) ?? "other" : "other";
}

function diagnosticField(value: unknown, field: string): unknown {
  for (const key of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** A denial must remain diagnosable without logging Microsoft bodies, identifiers,
 * credentials or arbitrary property names. Diagnostic collection is best effort
 * and bounded independently of the upstream timeout; it cannot delay a known
 * HTTP error indefinitely or change the original failure code.
 */
async function logUploadHTTPFailure(response: Response, signal: AbortSignal): Promise<void> {
  const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  const contentType = !mediaType ? "missing" : ["application/json", "application/problem+json", "text/html", "text/plain"].includes(mediaType) ? mediaType : "other";
  const challenge = response.headers.get("WWW-Authenticate")?.slice(0, 4096) ?? "";
  const scheme = /^\s*(bearer|basic|negotiate|ntlm)\b/iu.exec(challenge)?.[1].toLowerCase() ?? (challenge ? "other" : "absent");
  const challengeError = /\berror\s*=\s*(?:"([^"\r\n]{0,128})"|([^,\s]{1,128}))/iu.exec(challenge);
  const diagnostic: Record<string, unknown> = {
    event: "image_upload_failure", status: response.status, content_type: contentType,
    auth_challenge: {
      scheme, error: diagnosticEnum(challengeError?.[1] ?? challengeError?.[2], ["invalid_token", "insufficient_scope", "invalid_request"]),
      claims: /\bclaims\s*=/iu.test(challenge),
    },
    body_kind: "empty", body_bytes: 0,
  };
  if (response.body) {
    const reader = response.body.getReader();
    const bytes = new Uint8Array(FAILURE_DIAGNOSTIC_BYTES);
    let length = 0;
    let done = false;
    let stopReason = "unreadable";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = (): void => undefined;
    const stop = new Promise<never>((_resolve, reject) => {
      abort = (): void => { stopReason = "cancelled"; reject(new Error("UPLOAD_DIAGNOSTIC_CANCELLED")); };
      timer = setTimeout(() => { stopReason = "timeout"; reject(new Error("UPLOAD_DIAGNOSTIC_TIMEOUT")); }, FAILURE_DIAGNOSTIC_TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      while (length < bytes.length) {
        const chunk = await Promise.race([reader.read(), stop]);
        if (chunk.done) { done = true; break; }
        const take = Math.min(chunk.value.byteLength, bytes.length - length);
        bytes.set(chunk.value.subarray(0, take), length);
        length += take;
      }
      diagnostic.body_bytes = length;
      if (!done) diagnostic.body_kind = "truncated";
      else if (length > 0) {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length));
        if (contentType === "application/json" || contentType === "application/problem+json" || /^\s*[{[]/u.test(text)) {
          try {
            const parsed: unknown = JSON.parse(text);
            diagnostic.body_kind = "json";
            diagnostic.json_fields = DIAGNOSTIC_JSON_FIELDS.flatMap(field => {
              const value = diagnosticField(parsed, field);
              return value === undefined ? [] : [{ field, type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value }];
            });
            diagnostic.error_code = diagnosticEnum(diagnosticField(parsed, "error.code") ?? diagnosticField(parsed, "code") ?? diagnosticField(parsed, "result.code") ?? diagnosticField(parsed, "error"), UPLOAD_ERROR_ENUMS);
            diagnostic.result_value = diagnosticEnum(diagnosticField(parsed, "result.value"), UPLOAD_RESULT_ENUMS);
          } catch { diagnostic.body_kind = "invalid_json"; }
        } else diagnostic.body_kind = contentType === "text/html" || /^\s*(?:<!doctype\s+html|<html\b)/iu.test(text) ? "html" : "text";
      }
    } catch {
      diagnostic.body_kind = stopReason;
      diagnostic.body_bytes = length;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (!done) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  console.warn(JSON.stringify(diagnostic));
}

/** Upload before chat: Microsoft binds images to the authenticated conversation,
 * rather than consuming OpenAI-like message.attachments in the SignalR frame.
 * No URLs, tokens or response bodies may be included in errors.
 */
export async function uploadConversationImages(
  account: OAuthTokenSet,
  conversationId: string,
  images: ReadonlyArray<NormalizedImageAttachment> | undefined,
  signal: AbortSignal,
): Promise<UploadedConversationImage[]> {
  if (!images?.length) return [];
  const normalized = normalizeMultimodalContent(images);
  // Do not fetch arbitrary caller URLs with Microsoft credentials or silently
  // omit them. Inline images are the verified upload representation.
  if (normalized.attachments.some(image => !image.url.startsWith("data:"))) {
    throw new Error("IMAGE_UPLOAD_INLINE_REQUIRED");
  }
  const uploaded: UploadedConversationImage[] = [];
  for (const image of normalized.attachments) {
    if (signal.aborted) throw new Error("REQUEST_ABORTED");
    const body = new FormData();
    body.set("scenario", "UploadImage");
    body.set("conversationId", conversationId);
    body.set("FileBase64", image.url);
    for (const option of ["cwcgptvsan", MULTI_IMAGE_UPLOAD_OPTION, "gptvnorm2048"]) body.append("optionsSets", option);
    let response: Response;
    try {
      // Match the official AAD UploadFile client (module 399052): mailbox
      // routing and image support are separate from Bearer authentication.
      // Use the identity already returned by the existing OAuth exchange;
      // never invent another account or copy browser credentials. Let fetch
      // supply Content-Type and the boundary for this exact FormData body.
      const headers = new Headers({
        Authorization: `Bearer ${account.accessToken}`,
        Origin: "https://m365.cloud.microsoft",
        "X-Scenario": "officeweb",
        "X-Variants": "feature.EnableImageSupportInUploadFile",
      });
      if (account.oid && account.tid) headers.set("X-AnchorMailbox", `Oid:${account.oid}@${account.tid}`);
      response = await fetch(IMAGE_UPLOAD_URL, {
        method: "POST", redirect: "manual", body,
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new Error(signal.aborted ? "REQUEST_ABORTED" : "IMAGE_UPLOAD_UNAVAILABLE");
    }
    if (!response.ok) {
      // Diagnostics must never replace the known HTTP status, even if logging
      // or the denied response's stream is itself broken.
      try { await logUploadHTTPFailure(response, signal); } catch { /* diagnostic only */ }
      throw new Error(`IMAGE_UPLOAD_HTTP_${response.status}`);
    }
    let result: { result?: { value?: unknown }; conversationId?: unknown; docId?: unknown; fileUrl?: unknown };
    try {
      // The response is bounded before JSON parsing, including chunked replies.
      result = await readJSONLimited(new Request("https://upload-response.invalid", { method: "POST", body: response.body }), 64 * 1024);
    } catch { throw new Error("IMAGE_UPLOAD_INVALID_RESPONSE"); }
    if (result?.result?.value !== "Success" || typeof result.docId !== "string" || !result.docId
      || result.conversationId !== conversationId) throw new Error("IMAGE_UPLOAD_NOT_BOUND");
    const fileUrl = uploadedImageFileURL(result.fileUrl);
    // Success can still produce an unusable ChatHub reference. Record only a
    // fixed allow-list of field names and value types so production probes can
    // distinguish a missing URL from a wire-shape bug without retaining any
    // identifier, URL, filename, response body, token, or arbitrary property.
    console.info(JSON.stringify({
      event: "image_upload_success_shape",
      fields: UPLOAD_SUCCESS_DIAGNOSTIC_FIELDS.flatMap(field => {
        const value = diagnosticField(result, field);
        return value === undefined ? [] : [{
          field, type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        }];
      }),
      usable_file_url: fileUrl !== undefined,
    }));
    uploaded.push({ conversationId, docId: result.docId, mimeType: image.mimeType, ...(fileUrl ? { fileUrl } : {}) });
  }
  return uploaded;
}
