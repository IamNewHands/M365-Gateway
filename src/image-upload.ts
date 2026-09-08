import { normalizeMultimodalContent, type NormalizedImageAttachment } from "./multimodal";
import { readJSONLimited } from "./request-body";
import type { OAuthTokenSet } from "./types";

/** Upload before chat: Microsoft binds images to the authenticated conversation,
 * rather than consuming OpenAI-like message.attachments in the SignalR frame.
 * No URLs, tokens or response bodies may be included in errors.
 */
export async function uploadConversationImages(
  account: OAuthTokenSet,
  conversationId: string,
  images: ReadonlyArray<NormalizedImageAttachment> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!images?.length) return;
  const normalized = normalizeMultimodalContent(images);
  // Do not fetch arbitrary caller URLs with Microsoft credentials or silently
  // omit them. Inline images are the verified upload representation.
  if (normalized.attachments.some(image => !image.url.startsWith("data:"))) {
    throw new Error("IMAGE_UPLOAD_INLINE_REQUIRED");
  }
  for (const image of normalized.attachments) {
    if (signal.aborted) throw new Error("REQUEST_ABORTED");
    const body = new FormData();
    body.set("scenario", "UploadImage");
    body.set("conversationId", conversationId);
    body.set("FileBase64", image.url);
    for (const option of ["cwcgptvsan", "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch", "gptvnorm2048"]) body.append("optionsSets", option);
    let response: Response;
    try {
      response = await fetch("https://substrate.office.com/m365Copilot/UploadFile", {
        method: "POST", redirect: "manual", body,
        headers: { Authorization: `Bearer ${account.accessToken}`, Origin: "https://m365.cloud.microsoft" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new Error(signal.aborted ? "REQUEST_ABORTED" : "IMAGE_UPLOAD_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`IMAGE_UPLOAD_HTTP_${response.status}`);
    }
    let result: { result?: { value?: unknown }; conversationId?: unknown; docId?: unknown };
    try {
      // The response is bounded before JSON parsing, including chunked replies.
      result = await readJSONLimited(new Request("https://upload-response.invalid", { method: "POST", body: response.body }), 64 * 1024);
    } catch { throw new Error("IMAGE_UPLOAD_INVALID_RESPONSE"); }
    if (result?.result?.value !== "Success" || typeof result.docId !== "string" || !result.docId
      || result.conversationId !== conversationId) throw new Error("IMAGE_UPLOAD_NOT_BOUND");
  }
}
