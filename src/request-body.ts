export class RequestBodyError extends Error {
  constructor(readonly code: "REQUEST_TOO_LARGE" | "INVALID_JSON") {
    super(code);
  }
}

// A Worker isolate has a 128 MiB memory ceiling. JSON input exists
// simultaneously as UTF-16 text, parsed objects, the flattened prompt and a
// SignalR payload; accepting 32 MiB could therefore exceed that ceiling before
// any upstream request is made. Prefer remote image URLs for larger media.
export const MAX_AI_REQUEST_BYTES = 8 * 1024 * 1024;

// Responses also carries base64 input_image parts, not just text/tool history.
// Its former 2 MiB limit rejected otherwise valid images before multimodal
// validation. Use the same bounded wire budget as Chat and Messages, including
// /responses/compact continuations. Parsing runs in the inference DO. Per-image
// and aggregate decoded-image limits still apply independently; oversized tool
// outputs are still compacted after parsing. Do not remove the streaming cap.
export const MAX_RESPONSES_REQUEST_BYTES = MAX_AI_REQUEST_BYTES;

function declaredLength(request: Request): number | null {
  const raw = request.headers.get("Content-Length")?.trim();
  if (!raw) return null;
  if (!/^\d+$/u.test(raw)) throw new RequestBodyError("INVALID_JSON");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new RequestBodyError("INVALID_JSON");
  return value;
}

/**
 * Read a request body without ever buffering more than maxBytes. Cloudflare
 * Workers may receive chunked requests without Content-Length, so checking the
 * header after request.text() is not a memory bound.
 */
export async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
  const declared = declaredLength(request);
  if (declared !== null && declared > maxBytes) throw new RequestBodyError("REQUEST_TOO_LARGE");
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let total = 0;
  let text = "";
  let fragments: string[] = [];
  let fragmentBytes = 0;
  const flushFragments = (): void => {
    if (fragments.length === 0) return;
    text += fragments.join("");
    fragments = [];
    fragmentBytes = 0;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        // Do not wait for the sender to finish an oversized upload.
        await reader.cancel("request body exceeds configured limit").catch(() => undefined);
        throw new RequestBodyError("REQUEST_TOO_LARGE");
      }
      total += value.byteLength;
      // Decode incrementally so the Worker never retains both every raw chunk
      // and a second combined byte buffer. This matters under the 128 MiB
      // isolate limit, especially for chunked requests without a length header.
      const fragment = decoder.decode(value, { stream: true });
      if (fragment) fragments.push(fragment);
      fragmentBytes += value.byteLength;
      // Bound per-chunk object overhead for adversarially fragmented bodies,
      // while avoiding a quadratic concatenation for normal uploads.
      if (fragmentBytes >= 64 * 1024 || fragments.length >= 4_096) flushFragments();
    }
    const finalFragment = decoder.decode();
    if (finalFragment) fragments.push(finalFragment);
    flushFragments();
  } finally {
    reader.releaseLock();
  }
  return text;
}

export async function readJSONLimited<T>(request: Request, maxBytes: number): Promise<T> {
  let text: string;
  try {
    text = await readTextLimited(request, maxBytes);
    return JSON.parse(text || "{}") as T;
  } catch (cause) {
    if (cause instanceof RequestBodyError) throw cause;
    throw new RequestBodyError("INVALID_JSON");
  }
}
