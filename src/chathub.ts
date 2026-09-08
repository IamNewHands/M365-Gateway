import { base64url } from "./crypto";
import { uploadConversationImages } from "./image-upload";
import type { OAuthTokenSet } from "./types";
import {
  extractUpstreamImageURLs,
  normalizeMultimodalContent,
  type NormalizedImageAttachment,
} from "./multimodal";
import { validateToolArguments } from "./tool-schema";

const RS = "\u001e";
// Upgrade via fetch() uses HTTPS. Cloudflare turns the successful 101
// response into a WebSocket; passing a wss:// URL to fetch is rejected before
// any handshake is attempted.
const CHAT_HUB = "https://substrate.office.com/m365Copilot/Chathub";
// Keep all text buffers comfortably below the Worker isolate memory ceiling.
// Each JavaScript string can require two bytes per character and the parser,
// retry wrapper and response renderer may briefly hold several copies.
const MAX_FRAME_CHARACTERS = 1_500_000;
// A binary WebSocket message is decoded as UTF-8 below.  Four bytes is the
// maximum UTF-8 width of one Unicode scalar, so a payload larger than this
// conservative bound cannot possibly fit in the character cap.  Reject it
// before TextDecoder allocates a second large string in the Worker isolate.
const MAX_FRAME_EARLY_REJECT_BYTES = MAX_FRAME_CHARACTERS * 4;
const MAX_OUTPUT_CHARACTERS = 2_000_000;
const MAX_QUEUED_SOCKET_CHARACTERS = 2_000_000;
// SignalR normally carries only a handful of records per WebSocket message.
// A bounded total keeps a malformed stream of tiny records from spending the
// entire request CPU budget on JSON.parse while retaining ample room for a
// legitimate long turn.
const MAX_SIGNALR_RECORDS_PER_REQUEST = 16_384;
// Protocol-drift labels are diagnostics only. Keep a small prefix rather than
// allowing an upstream frame stream with unbounded unique targets/types to
// grow Sets for the entire request.
const MAX_PROTOCOL_DRIFT_LABELS = 32;
const MAX_UPSTREAM_IMAGE_URL_CHARACTERS = 6 * 1_024 * 1_024;
export const CHAT_HUB_PAYLOAD_LIMITS = Object.freeze({
  frameCharacters: MAX_FRAME_CHARACTERS,
  frameRecords: MAX_SIGNALR_RECORDS_PER_REQUEST,
  outputCharacters: MAX_OUTPUT_CHARACTERS,
  queuedSocketCharacters: MAX_QUEUED_SOCKET_CHARACTERS,
  upstreamImageURLCharacters: MAX_UPSTREAM_IMAGE_URL_CHARACTERS,
});

export type BoundedPayloadSubtype =
  | "WS_FRAME_TOO_LARGE"
  | "WS_FRAME_TOO_MANY_RECORDS"
  | "WS_BUFFER_TOO_LARGE"
  | "CHAT_OUTPUT_TOO_LARGE"
  | "CHAT_IMAGE_OUTPUT_TOO_LARGE";

export type BoundedPayloadPhase =
  | "websocket_frame"
  | "websocket_queue"
  | "streamed_text"
  | "update_snapshot"
  | "completion_snapshot"
  | "completion_message"
  | "image_output";

export interface BoundedPayloadMetadata {
  subtype: BoundedPayloadSubtype;
  observed: number;
  limit: number;
  phase: BoundedPayloadPhase;
}

/** A privacy-safe size failure. It intentionally retains only numeric bounds
 * and a closed machine label; payload text, URLs and tool results never enter
 * the error or its diagnostic record. */
export class BoundedPayloadError extends Error implements BoundedPayloadMetadata {
  readonly subtype: BoundedPayloadSubtype;
  readonly observed: number;
  readonly limit: number;
  readonly phase: BoundedPayloadPhase;

  constructor(subtype: BoundedPayloadSubtype, observed: number, limit: number, phase: BoundedPayloadPhase) {
    super(subtype);
    this.name = "BoundedPayloadError";
    this.subtype = subtype;
    this.observed = observed;
    this.limit = limit;
    this.phase = phase;
  }
}

export function assertBoundedPayload(
  subtype: BoundedPayloadSubtype,
  observed: number,
  limit: number,
  phase: BoundedPayloadPhase,
): void {
  if (observed > limit) throw new BoundedPayloadError(subtype, observed, limit, phase);
}
// Microsoft can leave a submitted invocation connected while producing no
// semantic frames.  The request-wide deadline remains ten minutes for long
// turns that keep reporting progress, but a completely idle invocation must
// fail much sooner so Codex can surface/retry it instead of appearing frozen.
const CHAT_PROGRESS_IDLE_TIMEOUT_MS = 90_000;
// Handshake is a transport preflight, not model generation. Keep it short so
// a dead/incorrect ChatHub route is retried or surfaced promptly instead of
// consuming most of the client's idle window before any invocation exists.
const CHAT_HANDSHAKE_TIMEOUT_MS = 15_000;
const VARIANTS = "EnableMcpServerWidgets,feature.EnableMcpServerWidgets,feature.EnableLuForChatCIQ,feature.enableChatCIQPlugin,EnableRequestPlugins,feature.EnableSensitivityLabels,EnableUnsupportedUrlDetector,feature.IsCustomEngineCopilotEnabled,feature.bizchatfluxv3,feature.enablechatpages,feature.enableCodeCanvas,feature.turnOnWorkTabRecommendation,turnOffWorkTabUpsellFromClient,feature.turnOnDARecommendation,feature.IsStreamingModeInChatRequestEnabled,IncludeSourceAttributionsConcise,SkipPublishEmptyMessage,feature.EnableDeduplicatingSourceAttributions,Enable3PActionProgressMessages,feature.enableClientWebRtc,feature.EnableMeetingRecapOfSeriesMeetingWithCiq,feature.EnableReferencesListCompleteSignal,feature.StorageMessageSplitDisabled,feature.EnableCuaTakeControlApi,feature.cwcallowedos,feature.disabledisallowedmsgs,feature.enableCitationsForSynthesisData,feature.enableGenerateGraphicArtOptionsSet,cdximagen,feature.EnableUpdatedUXForConfirmationDialog,feature.EnableClientFileURLSupportForOfficeWebPaidCopilot,feature.EnableDesignEditorImageGrounding,feature.EnableDesignerEditor,feature.OfficeWebToHelix,feature.OfficeDesktopToHelix,feature.M365TeamsHubToHelix,feature.OwaHubToHelix,feature.MonarchHubToHelix,feature.Win32OutlookHubToHelix,feature.MacOutlookHubToHelix,Agt_bizchat_enableGpt5ForHelix";

export interface ChatHubRequest {
  text: string;
  conversationId: string;
  sessionId: string;
  started: boolean;
  tone: string;
  /** Already-normalized image inputs. The ChatHub boundary validates again. */
  attachments?: ReadonlyArray<NormalizedImageAttachment>;
  tools?: unknown[];
  toolChoice?: unknown;
  /** Optional protocol profile. Existing callers remain compatible: requests
   * with client tools, or the hidden router's toolChoice="none", infer the
   * compact profile without inspecting prompt text. */
  messageProfile?: "answer" | "caller_tool" | "router";
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface ChatHubResult {
  text: string;
  conversationId: string;
  sessionId: string;
  requestId: string;
  images?: string[];
  functionCall?: FunctionCall;
  /** Strict decision marker returned by a tool-enabled ChatHub turn. */
  toolDecision?: "answer" | "tool_call" | "invalid";
  throttling?: unknown;
  /** Internal provenance marker; never serialized to an API client. */
  routerGeneratedFunctionCall?: boolean;
  /** The visible answer is a safe local checkpoint rather than a turn that
   * should continue the just-used Microsoft conversation coordinates. */
  checkpointOnly?: boolean;
  /** Privacy-safe diagnostic label for checkpoint metrics and logs. */
  checkpointCode?: string;
}

export interface FunctionCall {
  name: string;
  arguments: string;
}

function safeProtocolLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const label = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(label) ? label : "unknown";
}

function rememberProtocolDriftLabel(labels: Set<string>, value: string): void {
  if (labels.size < MAX_PROTOCOL_DRIFT_LABELS) labels.add(value);
}

/** Extract only an upstream machine label. Human-readable Microsoft messages
 * can contain tenant data, URLs or identifiers and must not enter errors/logs. */
function upstreamErrorLabel(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const candidate of [record.code, record.errorCode, record.error]) {
      if (candidate && typeof candidate === "object") {
        const nested = upstreamErrorLabel(candidate);
        if (nested !== "unknown") return nested;
      } else {
        const label = safeProtocolLabel(candidate);
        if (label !== "unknown") return label;
      }
    }
    if (Object.hasOwn(record, "message")) {
      const label = safeProtocolLabel(record.message);
      return label === "unknown" ? "unknown_error" : label;
    }
    if (Object.hasOwn(record, "error")) return "unknown_error";
  }
  return safeProtocolLabel(value);
}

export interface ChatHubRelay {
  baseURL: string;
  hmacSecret: string;
  origin: string;
}

const textEncoder = new TextEncoder();

function hexadecimal(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function relayBaseURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  return url;
}

function relayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  return url.origin;
}

function relayTargetQuery(sessionId: string, conversationId: string, requestId: string): string {
  const query = new URLSearchParams();
  query.set("chatsessionid", requestId);
  query.set("clientrequestid", requestId);
  query.set("X-SessionId", sessionId);
  query.set("ConversationId", conversationId);
  query.set("variants", VARIANTS);
  query.set("source", '"officeweb"');
  query.set("product", "Office");
  query.set("agentHost", "Bizchat.FullScreen");
  query.set("licenseType", "Starter");
  query.set("agent", "web");
  query.set("scenario", "OfficeWebIncludedCopilot");
  return query.toString();
}

async function relayWebSocketRequest(
  account: OAuthTokenSet,
  sessionId: string,
  conversationId: string,
  requestId: string,
  relay: ChatHubRelay,
): Promise<{ url: string; headers: Headers }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (!uuid.test(account.oid) || !uuid.test(account.tid)
    || textEncoder.encode(relay.hmacSecret).byteLength < 32 || relay.hmacSecret.startsWith("m365_")) {
    throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  }
  const base = relayBaseURL(relay.baseURL);
  const origin = relayOrigin(relay.origin);
  const identity = `${account.oid.toLowerCase()}@${account.tid.toLowerCase()}`;
  const path = `/v1/chathub/${identity}`;
  const url = new URL(path, base);
  const targetQuery = relayTargetQuery(sessionId, conversationId, requestId);
  const tokenBytes = textEncoder.encode(account.accessToken).byteLength;
  const queryBytes = textEncoder.encode(targetQuery).byteLength;
  if (tokenBytes === 0 || tokenBytes > 32 * 1024 || queryBytes > 16 * 1024) {
    throw new Error("ACCOUNT_RELAY_EGRESS_UNAVAILABLE");
  }
  const digestInput = `token:${tokenBytes}:${account.accessToken}\nquery:${queryBytes}:${targetQuery}`;
  const digest = hexadecimal(await crypto.subtle.digest("SHA-256", textEncoder.encode(digestInput)));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const canonical = ["M365-RELAY-V1", timestamp, nonce, "GET", path, origin, digest].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(relay.hmacSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(canonical))));
  return {
    url: url.toString(),
    headers: new Headers({
      Upgrade: "websocket",
      Origin: origin,
      "X-M365-Access-Token": account.accessToken,
      "X-M365-Target-Query": targetQuery,
      "X-Relay-Timestamp": timestamp,
      "X-Relay-Nonce": nonce,
      "X-Relay-Content-SHA256": digest,
      "X-Relay-Signature": signature,
    }),
  };
}

/** Microsoft attaches throttling metadata to successful and failed frames. */
export function quotaExhausted(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const throttling = value as Record<string, unknown>;
  const direct = throttling.CostQuota;
  if (typeof direct === "number") return direct <= 0;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const remaining = (direct as Record<string, unknown>).remainingAllowance;
    if (typeof remaining === "number") return remaining <= 0;
  }
  const metering = throttling.metering;
  if (!metering || typeof metering !== "object" || Array.isArray(metering)) return false;
  const meteredQuota = (metering as Record<string, unknown>).CostQuota;
  if (!meteredQuota || typeof meteredQuota !== "object" || Array.isArray(meteredQuota)) return false;
  const remaining = (meteredQuota as Record<string, unknown>).remainingAllowance;
  return typeof remaining === "number" && remaining <= 0;
}

function encodedArguments(value: unknown): string | null {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value)); } catch { return null; }
  }
  if (value === undefined) return "{}";
  if (value === null || typeof value !== "object") return null;
  return JSON.stringify(value);
}

/** Accept a decoded caller execution request when the client advertises an
 * older schema that omits harmless execution controls. The command itself and
 * the path/shell types remain strict; this is not a general schema bypass. */
function acceptsBoundedExecArguments(name: string, encoded: string, tools: unknown[]): boolean {
  if (name !== "exec_command") return false;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.cmd !== "string") return false;
  if (record.workdir !== undefined && typeof record.workdir !== "string") return false;
  if (record.shell !== undefined && typeof record.shell !== "string") return false;
  if (record.max_output_tokens !== undefined
    && (!Number.isSafeInteger(record.max_output_tokens) || Number(record.max_output_tokens) < 1 || Number(record.max_output_tokens) > 1_000_000_000)) return false;
  if (record.yield_time_ms !== undefined
    && (!Number.isSafeInteger(record.yield_time_ms) || Number(record.yield_time_ms) < 0 || Number(record.yield_time_ms) > 1_000_000_000)) return false;
  // If a declaration is present, retain its required-field guarantees even
  // when it rejects only an optional/unknown property.
  if (tools.length > 0) {
    const declared = tools.find((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const fn = (raw as { function?: { name?: unknown } }).function;
      return (fn?.name ?? (raw as { name?: unknown }).name) === name;
    }) as { function?: { parameters?: unknown }; parameters?: unknown } | undefined;
    const schema = declared?.function?.parameters ?? declared?.parameters;
    if (schema && typeof schema === "object" && !Array.isArray(schema)
      && Array.isArray((schema as Record<string, unknown>).required)) {
      for (const required of (schema as Record<string, unknown>).required as unknown[]) {
        if (typeof required === "string" && !Object.hasOwn(record, required)) return false;
      }
    }
  }
  return true;
}

// M365 can recognize familiar function names as its own hosted capabilities.
// Never send a caller's public function name as a ChatHub plugin identity:
// keep it at the OpenAI boundary, use an opaque deterministic wire alias for
// every caller function, and map the alias back only on receipt.  The fixed
// set below is narrower: those tools remain decodable on Codex continuation
// turns that omit `tools` and retain strict legacy-payload validation.
const INTEGRITY_SENSITIVE_CLIENT_TOOLS = new Set(["exec_command", "write_stdin", "view_image"]);
const CLIENT_TOOL_ALIAS_PREFIX = "m365gw_client_";

const SENSITIVE_CLIENT_TOOL_ARGUMENT_KEYS: Record<string, readonly string[]> = {
  exec_command: [
    "cmd", "justification", "login", "max_output_tokens", "prefix_rule",
    "sandbox_permissions", "shell", "tty", "workdir", "yield_time_ms",
  ],
  write_stdin: ["chars", "max_output_tokens", "session_id", "yield_time_ms"],
  view_image: ["detail", "path"],
};

function boundedInteger(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 1_000_000_000;
}

/** Validate the fixed caller-runtime tools even on Responses continuation
 * turns where Codex legitimately omits the repeated `tools` array.  This is a
 * closed allow-list, not a schema bypass: unknown properties and wrong types
 * are rejected before a decoded call can cross the public API boundary. */
function acceptsFixedSensitiveClientCall(call: FunctionCall): boolean {
  if (!INTEGRITY_SENSITIVE_CLIENT_TOOLS.has(call.name)) return false;
  let value: unknown;
  try { value = JSON.parse(call.arguments); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(SENSITIVE_CLIENT_TOOL_ARGUMENT_KEYS[call.name]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;

  if (call.name === "exec_command") {
    if (typeof record.cmd !== "string") return false;
    if (record.justification !== undefined && typeof record.justification !== "string") return false;
    if (record.login !== undefined && typeof record.login !== "boolean") return false;
    if (record.max_output_tokens !== undefined && !boundedInteger(record.max_output_tokens, 1)) return false;
    if (record.prefix_rule !== undefined
      && (!Array.isArray(record.prefix_rule) || record.prefix_rule.some((item) => typeof item !== "string"))) return false;
    if (record.sandbox_permissions !== undefined
      && !["use_default", "require_escalated"].includes(String(record.sandbox_permissions))) return false;
    if (record.shell !== undefined && typeof record.shell !== "string") return false;
    if (record.tty !== undefined && typeof record.tty !== "boolean") return false;
    if (record.workdir !== undefined && typeof record.workdir !== "string") return false;
    if (record.yield_time_ms !== undefined && !boundedInteger(record.yield_time_ms, 0)) return false;
    return true;
  }
  if (call.name === "write_stdin") {
    if (!boundedInteger(record.session_id, 1)) return false;
    if (record.chars !== undefined && typeof record.chars !== "string") return false;
    if (record.max_output_tokens !== undefined && !boundedInteger(record.max_output_tokens, 1)) return false;
    if (record.yield_time_ms !== undefined && !boundedInteger(record.yield_time_ms, 0)) return false;
    return true;
  }
  if (typeof record.path !== "string" || !record.path.trim()) return false;
  return record.detail === undefined || record.detail === "high" || record.detail === "original";
}

function acceptsDecodedClientCall(call: FunctionCall, tools: unknown[]): boolean {
  return validateToolArguments(call.name, call.arguments, tools)
    || acceptsFixedSensitiveClientCall(call)
    || acceptsBoundedExecArguments(call.name, call.arguments, tools);
}

type SafeTextDecodeResult = { ok: true; value: unknown } | { ok: false };

/** AZHEX leaves only ASCII letters/digits and non-ASCII text literal. Every
 * other ASCII code unit, including whitespace and uppercase Z, is represented
 * as ZHHX. This prevents Markdown from rewriting PowerShell punctuation while
 * avoiding a base64/hex transform of the words the model is composing. */
function decodeAZHEXString(value: string): string | null {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "Z") {
      const hexadecimal = value.slice(index + 1, index + 3);
      if (/^[0-9A-F]{2}$/u.test(hexadecimal) && value[index + 3] === "X") {
        decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
        index += 3;
        continue;
      }
      // M365 sometimes represents a non-ASCII UTF-16 code unit as ZHHHH
      // instead of leaving it literal.  This form is unambiguous with the
      // ASCII ZHHX codec.  Restrict it to non-ASCII code units so malformed
      // or abbreviated ASCII escapes cannot silently become executable text.
      const unicodeHexadecimal = value.slice(index + 1, index + 5);
      if (/^[0-9A-F]{4}$/u.test(unicodeHexadecimal)) {
        const codeUnit = Number.parseInt(unicodeHexadecimal, 16);
        if (codeUnit <= 0x7f) return null;
        decoded += String.fromCharCode(codeUnit);
        index += 4;
        continue;
      }
      // A complete ASCII escape always ends in X. Treat a bare ZHH sequence
      // as malformed instead of guessing: it is indistinguishable from
      // ordinary command/path text that happens to contain Z3D or Z5F.
      return null;
    }
    if (character.codePointAt(0)! <= 0x7f && !/^[A-Ya-z0-9]$/u.test(character)) return null;
    decoded += character;
  }
  return decoded;
}

/** Decode only bounded JSON-compatible values from the integrity-safe textual
 * fallback. Literal transport-sensitive characters are rejected rather than
 * accepted after M365 has had an opportunity to reinterpret them. */
function decodeAZHEXValue(value: unknown, depth = 0, budget = { visited: 0 }): SafeTextDecodeResult {
  budget.visited += 1;
  if (depth > 32 || budget.visited > 50_000) return { ok: false };
  if (typeof value === "string") {
    const decoded = decodeAZHEXString(value);
    return decoded === null ? { ok: false } : { ok: true, value: decoded };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const decoded = decodeAZHEXValue(item, depth + 1, budget);
      if (!decoded.ok) return decoded;
      output.push(decoded.value);
    }
    return { ok: true, value: output };
  }
  if (!value || typeof value !== "object") return { ok: false };
  const entries: Array<[string, unknown]> = [];
  const keys = new Set<string>();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const decodedKey = decodeAZHEXString(key);
    if (decodedKey === null || keys.has(decodedKey)) return { ok: false };
    keys.add(decodedKey);
    const decoded = decodeAZHEXValue(item, depth + 1, budget);
    if (!decoded.ok) return decoded;
    entries.push([decodedKey, decoded.value]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

function containsCompleteAZHEXToken(value: unknown): boolean {
  let serialized: string;
  if (typeof value === "string") serialized = value;
  else {
    try {
      const encoded = JSON.stringify(value);
      if (typeof encoded !== "string") return false;
      serialized = encoded;
    } catch { return false; }
  }
  return /Z[0-9A-F]{2}X/u.test(serialized);
}

/** Exposed for protocol contract tests. Runtime callers still require an
 * object that passes the original client tool's JSON schema. */
export function decodeAZHEXArguments(value: unknown): unknown | null {
  let candidate = value;
  // Native M365 events sometimes serialize the argument object as a JSON
  // string before applying the fallback codec to its nested values.
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { /* it may be a scalar encoded value */ }
  }
  const decoded = decodeAZHEXValue(candidate);
  return decoded.ok ? decoded.value : null;
}

function clientToolParameterKeys(name: string, tools: unknown[]): Set<string> {
  const keys = new Set(SENSITIVE_CLIENT_TOOL_ARGUMENT_KEYS[name] ?? []);
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as {
      function?: { name?: unknown; parameters?: unknown };
      name?: unknown;
      parameters?: unknown;
    };
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    if (fn.name !== name || !fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) continue;
    const properties = (fn.parameters as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
    for (const key of Object.keys(properties as Record<string, unknown>)) keys.add(key);
  }
  return keys;
}

/** M365 occasionally substitutes hyphens for underscores in AZHEX fallback
 * property names even though other keys in the same object remain exact.
 * Canonicalize only against the declared tool schema (plus the fixed caller
 * runtime schemas needed at the last public boundary), and reject collisions
 * rather than guessing which duplicate value should win. */
function normalizeClientArgumentKeys(name: string, value: unknown, tools: unknown[]): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const canonicalKeys = clientToolParameterKeys(name, tools);
  if (canonicalKeys.size === 0) return value;
  const bySignature = new Map<string, string | null>();
  for (const key of canonicalKeys) {
    const signature = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    const previous = bySignature.get(signature);
    bySignature.set(signature, previous === undefined || previous === key ? key : null);
  }
  const output: Record<string, unknown> = {};
  for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
    const signature = rawKey.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    const matched = bySignature.get(signature);
    const key = matched === undefined || matched === null ? rawKey : matched;
    if (Object.prototype.hasOwnProperty.call(output, key)) return null;
    output[key] = item;
  }
  return output;
}


export function clientToolWireName(name: string): string {
  const normalized = name.trim();
  if (!normalized) return normalized;
  const hexadecimalName = Array.from(textEncoder.encode(normalized), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${CLIENT_TOOL_ALIAS_PREFIX}${hexadecimalName}`;
}

interface ClientFunctionDefinition {
  name: string;
  description: string;
  parameters: unknown;
  /** Responses Lite exposes a JavaScript entry point whose description is an
   * executable manual for nested `tools.*` functions.  Those nested names are
   * runtime selectors, not ChatHub plugin identities, and must survive the
   * public-name redaction applied to ordinary client plugins. */
  preservesCallerRuntimeToolSemantics: boolean;
}

/** Accept both Chat Completions' nested function shape and Responses' flat
 * function shape, while excluding provider-hosted built-in tool types. */
function clientFunctionDefinition(raw: unknown): ClientFunctionDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const tool = raw as Record<string, unknown>;
  if (tool.type !== undefined && tool.type !== "function") return null;
  const candidate = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
    ? tool.function as Record<string, unknown>
    : tool;
  if (typeof candidate.name !== "string" || !candidate.name.trim()) return null;
  return {
    name: candidate.name.trim(),
    description: typeof candidate.description === "string" ? candidate.description : "",
    parameters: candidate.parameters && typeof candidate.parameters === "object"
      ? candidate.parameters
      : {},
    preservesCallerRuntimeToolSemantics: candidate.name.trim() === "exec"
      && tool.x_m365_original_responses_tool_type === "custom",
  };
}

function clientFunctionDefinitions(tools: unknown[]): ClientFunctionDefinition[] {
  return tools.map(clientFunctionDefinition).filter((tool): tool is ClientFunctionDefinition => tool !== null);
}

// ChatHub's wire envelope is bounded by serialized size, not tool count:
// fifteen ordinary Claude tools are valid while the default 28-tool manifest
// carries more than 86 KiB of documentation and is rejected before inference.
// Select the compatible encoding from measured contract size so small future
// clients keep the native protocol regardless of how many tools they declare.
const MAX_NATIVE_CLIENT_PLUGIN_CHARACTERS = 64_000;

function clientToolManifestCharacters(tools: unknown[]): number {
  return JSON.stringify(tools).length;
}

function compactHighCardinalityToolSchema(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== "object") {
    return value && typeof value === "object" ? {} : value;
  }
  if (Array.isArray(value)) return value.map((item) => compactHighCardinalityToolSchema(item, depth + 1));
  const schemaKeys = new Set([
    "type", "properties", "required", "items", "enum", "const",
    "anyOf", "oneOf", "allOf", "additionalProperties",
  ]);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!schemaKeys.has(key)) continue;
    if (key === "properties" && item && typeof item === "object" && !Array.isArray(item)) {
      output.properties = Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([property]) => /^[A-Za-z0-9_.-]{1,128}$/u.test(property))
        .map(([property, schema]) => [property, compactHighCardinalityToolSchema(schema, depth + 1)]));
      continue;
    }
    output[key] = compactHighCardinalityToolSchema(item, depth + 1);
  }
  return output;
}

function redactPublicFunctionNames(value: string, names: readonly string[]): string {
  let redacted = value;
  for (const name of [...names].sort((left, right) => right.length - left.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    // Match a complete identifier. Code Mode's public tool is named `exec`,
    // while its documentation legitimately references nested tools such as
    // `exec_command`; substring replacement corrupts those schemas.
    redacted = redacted.replace(new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "giu"), "$1caller function");
  }
  return redacted;
}

/** Code Mode's outer plugin still receives an opaque wire identity, but its
 * documentation is also the executable contract for functions reachable only
 * through the caller's `tools` object.  Disabled local patch selectors are
 * filtered before this function, while the remaining nested runtime API stays
 * intact so the model can choose a direct write or execution route. */
function descriptionRedactionNames(
  definition: ClientFunctionDefinition,
  publicNames: readonly string[],
): readonly string[] {
  return definition.preservesCallerRuntimeToolSemantics
    ? publicNames.filter((name) => name === definition.name)
    : publicNames;
}

/** Preserve executable schema keywords and enum values, but remove public
 * function identities from documentation strings sent to ChatHub. */
function redactSchemaDocumentation(value: unknown, names: readonly string[], depth = 0): unknown {
  if (depth > 64 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSchemaDocumentation(item, names, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (["description", "title", "$comment"].includes(key) && typeof item === "string") {
      return [key, redactPublicFunctionNames(item, names)];
    }
    return [key, redactSchemaDocumentation(item, names, depth + 1)];
  }));
}

export function clientToolChoice(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = { ...input };
  if (typeof input.name === "string") output.name = clientToolWireName(input.name);
  if (input.function && typeof input.function === "object" && !Array.isArray(input.function)) {
    const fn = input.function as Record<string, unknown>;
    output.function = {
      ...fn,
      ...(typeof fn.name === "string" ? { name: clientToolWireName(fn.name) } : {}),
    };
  }
  return output;
}

/** Normalize a client-tool invocation at the final boundary before it can be
 * serialized into an OpenAI/Anthropic response. Map an opaque wire alias back
 * to its public caller name and require the original tool schema to accept
 * ordinary JSON arguments without attempting marker-based rewrites. */
export function normalizeClientFunctionCall(
  call: FunctionCall | null | undefined,
  tools: unknown[] = [],
): FunctionCall | null {
  if (!call || typeof call.name !== "string" || typeof call.arguments !== "string") return null;
  const names = new Map<string, string>();
  // Keep the integrity-sensitive aliases recognizable even if a recovery
  // boundary did not retain the caller's tool array. The alias is deterministic
  // and maps only to this fixed allow-list; schema validation still applies
  // whenever the original tool definitions are available.
  for (const name of INTEGRITY_SENSITIVE_CLIENT_TOOLS) {
    names.set(name, name);
    names.set(clientToolWireName(name), name);
  }
  for (const tool of clientFunctionDefinitions(tools)) {
    names.set(tool.name, tool.name);
    names.set(clientToolWireName(tool.name), tool.name);
  }
  const originalName = names.get(call.name.trim());
  if (!originalName) return null;
  let argumentsJSON: string;
  try {
    const normalizedArguments = normalizeClientArgumentKeys(originalName, JSON.parse(call.arguments), tools);
    if (normalizedArguments === null) return null;
    argumentsJSON = JSON.stringify(normalizedArguments);
  } catch { return null; }
  if (!acceptsDecodedClientCall({ name: originalName, arguments: argumentsJSON }, tools)) return null;
  return { name: originalName, arguments: argumentsJSON };
}

function callFromJSON(
  value: unknown,
  names: Set<string>,
  inferredName?: string,
  wireNames: Map<string, string> = new Map(),
  allowSafePlainText = false,
): FunctionCall | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const call = callFromJSON(item, names, inferredName, wireNames, allowSafePlainText);
      if (call) return call;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.function && typeof record.function === "object") {
    const call = callFromJSON(record.function, names, inferredName, wireNames, allowSafePlainText);
    if (call) return call;
  }
  // Preserve the routing envelopes produced by several M365 model variants
  // and by the original server implementation.
  for (const nested of [record.calls, record.tool_calls, record.function_call]) {
    if (nested === undefined) continue;
    const call = callFromJSON(nested, names, inferredName, wireNames, allowSafePlainText);
    if (call) return call;
  }
  const rawName = [record.name, record.tool_name, typeof record.tool === "string" ? record.tool : undefined]
    .find((candidate): candidate is string => typeof candidate === "string" && (names.has(candidate) || wireNames.has(candidate)));
  if (rawName) {
    const wireOriginalName = wireNames.get(rawName);
    const originalName = wireOriginalName ?? rawName;
    const rawArguments = record.arguments ?? record.args ?? record.parameters ?? record.input;
    // Integrity-sensitive tools may only be selected by their opaque wire
    // alias in textual routing. Decode a complete legacy payload when marked,
    // while accepting ordinary JSON from the structured router unchanged.
    const safeAlias = wireOriginalName !== undefined && INTEGRITY_SENSITIVE_CLIENT_TOOLS.has(originalName);
    // Structured router output is already ordinary JSON. Token-looking user
    // data such as `sshZ3DXhost` must remain byte-for-byte unchanged; only the
    // explicit legacy textual fallback is eligible for AZHEX decoding.
    const legacyPayload = safeAlias && !allowSafePlainText && containsCompleteAZHEXToken(rawArguments);
    const decodedRaw = legacyPayload ? decodeAZHEXArguments(rawArguments) : rawArguments;
    if (legacyPayload && decodedRaw === null) return null;
    const decoded = safeAlias
      ? normalizeClientArgumentKeys(originalName, decodedRaw, [])
      : decodedRaw;
    if (safeAlias && (decoded === null || (!legacyPayload && !allowSafePlainText))) return null;
    const args = encodedArguments(decoded);
    if (args) return { name: originalName, arguments: args };
  }
  for (const name of names) {
    if (!(name in record)) continue;
    const args = encodedArguments(record[name]);
    if (args) return { name, arguments: args };
  }
  const inferredWireName = inferredName ? wireNames.get(inferredName) : undefined;
  if (inferredName && (names.has(inferredName) || inferredWireName)) {
    const safeAlias = inferredWireName !== undefined && INTEGRITY_SENSITIVE_CLIENT_TOOLS.has(inferredWireName);
    const legacyPayload = safeAlias && !allowSafePlainText && containsCompleteAZHEXToken(record);
    const decodedRaw = legacyPayload ? decodeAZHEXArguments(record) : record;
    if (legacyPayload && decodedRaw === null) return null;
    const decoded = safeAlias
      ? normalizeClientArgumentKeys(inferredWireName, decodedRaw, [])
      : decodedRaw;
    if (safeAlias && (decoded === null || (!legacyPayload && !allowSafePlainText))) return null;
    const args = encodedArguments(decoded);
    if (args) return { name: inferredWireName ?? inferredName, arguments: args };
  }
  return null;
}

function strictToolCallDecision(value: unknown): { name: string; arguments: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.decision !== "tool_call" || typeof record.name !== "string") return null;
  if (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments)) return null;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "arguments" || keys[1] !== "decision" || keys[2] !== "name") return null;
  return { name: record.name, arguments: record.arguments as Record<string, unknown> };
}

export function parseToolDecisionAnswer(text: string): string | null {
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "decision" || keys[1] !== "text") return null;
    return record.decision === "answer" && typeof record.text === "string" ? record.text : null;
  } catch {
    return null;
  }
}

/**
 * A tool-enabled ChatHub turn may ignore the requested answer envelope and
 * return ordinary assistant prose. That is still a valid `auto` decision: no
 * caller tool was selected. Accept only text that has no structural trace of
 * a tool protocol so malformed calls remain fail-closed.
 */
export function isOrdinaryToolDecisionAnswer(text: string): boolean {
  const candidate = text.trim();
  if (!candidate) return false;
  if (/<\/?tool_call\b|m365gw_client_/iu.test(candidate)) return false;

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(candidate);
  const payload = fenced ? fenced[1].trim() : candidate;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
    const record = parsed as Record<string, unknown>;
    if (Object.hasOwn(record, "decision") || Object.hasOwn(record, "calls") || Object.hasOwn(record, "function_call")) {
      return false;
    }
    if (Object.hasOwn(record, "name") && Object.hasOwn(record, "arguments")) return false;
    return true;
  } catch {
    // Syntactically broken protocol-shaped JSON must not be downgraded to a
    // harmless answer merely because JSON.parse rejected it.
    return !/["'](?:decision|calls|function_call)["']\s*:/iu.test(payload)
      && !(/["']name["']\s*:/iu.test(payload) && /["']arguments["']\s*:/iu.test(payload));
  }
}

function scrubNarration(text: string): string {
  return text
    .replace(/我将执行[：:][\s\S]*?\n\s*目的[：:][^\n]*\n?\s*预期[：:][^\n]*/gu, "")
    .replace(/我将执行[：:][^\n。]{0,120}。/gu, "")
    .trim();
}

/**
 * ChatHub occasionally wraps an account throttle in a nominally successful
 * `type:2` message (HTTP callers then see `200/completed` with no tool call).
 * Treat only the short, provider-authored capacity placeholders as failures;
 * ordinary user/model prose mentioning rate limits must remain visible.
 */
export function syntheticUpstreamFailureCode(value: unknown): "CHAT_UPSTREAM_RATE_LIMITED" | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 512) return null;
  if (/^(?:we['’]?re|we are) temporarily unable to respond to (?:this|the current) volume of requests(?:[.! ]+please try again later[.!]*)?$/u.test(normalized)) {
    return "CHAT_UPSTREAM_RATE_LIMITED";
  }
  return null;
}

function toolProtocolPrompt(text: string, tools: unknown[] = [], choice: unknown): string {
  if (tools.length === 0 || String(choice ?? "").toLowerCase() === "none") return text;
  const explicit = typeof choice === "object" && choice
    ? ((choice as { function?: { name?: string }; name?: string }).function?.name ?? (choice as { name?: string }).name)
    : undefined;
  const allFunctions = clientFunctionDefinitions(tools);
  const functions = explicit ? allFunctions.filter((fn) => fn.name === explicit) : allFunctions;
  const compactManifest = clientToolManifestCharacters(tools) > MAX_NATIVE_CLIENT_PLUGIN_CHARACTERS && !explicit;
  const publicNames = functions.map((tool) => tool.name);
  const definitions: string[] = [];
  for (const fn of functions) {
    const name = fn.name;
    const wireName = clientToolWireName(name);
    const redactionNames = descriptionRedactionNames(fn, publicNames);
    const redactedDescription = redactPublicFunctionNames(fn.description, redactionNames);
    const description = compactManifest
      ? redactedDescription.replace(/\s+/gu, " ").trim().slice(0, 120)
      : redactedDescription;
    const redactedParameters = redactSchemaDocumentation(fn.parameters, redactionNames);
    const parameters = compactManifest
      ? compactHighCardinalityToolSchema(redactedParameters)
      : redactedParameters;
    definitions.push(`${wireName} — caller-provided function; ${description}\nParameters: ${JSON.stringify(parameters)}`);
  }
  if (definitions.length === 0) return text;
  const mode = explicit ? `named:${clientToolWireName(explicit)}` : String(choice ?? "auto").toLowerCase();
  const codeModeRule = functions.some((fn) => fn.preservesCallerRuntimeToolSemantics)
    ? " For a Code Mode entry point, invoke nested caller-runtime tools exactly as declared; a nested function name is not a shell command or executable."
    : "";
  return `Choose the next response from the user's request, the conversation evidence, and the caller-provided tools below.
Return exactly one JSON object and nothing else.
- Direct answer: {"decision":"answer","text":"your answer"}
- Caller tool action: {"decision":"tool_call","name":"opaque_tool_id","arguments":{}}

MODE auto: choose a tool when external caller state or an action is needed; otherwise answer directly.
MODE required: choose one declared tool.
MODE named: choose exactly the tool named by TOOL_MODE.

The Worker only routes the decision. It has no caller filesystem, desktop, shell, process, or browser state. There is no prescribed workflow, keyword list, first command, or fixed number of steps. Preserve command, path, and text values with ordinary JSON escaping. Never invent tool output or claim an action completed before its structured result is present.${codeModeRule}

TOOL_MODE: ${mode}

<tools>
${definitions.join("\n\n")}
</tools>

User request:
${text}`;
}

// ChatHub's native client-plugin channel uses opaque wire IDs so M365 cannot
// bind familiar public function names to a hosted shell/filesystem. Legacy
// textual responses remain an inbound-only parser concern and are never
// advertised to the model.
export function clientPlugins(tools: unknown[] = []): Array<Record<string, unknown>> {
  const functions = clientFunctionDefinitions(tools);
  const publicNames = functions.map((tool) => tool.name);
  const plugins: Array<Record<string, unknown>> = [];
  for (const fn of functions) {
    const redactionNames = descriptionRedactionNames(fn, publicNames);
    plugins.push({
      Id: clientToolWireName(fn.name),
      Source: "Client",
      Description: redactPublicFunctionNames(fn.description, redactionNames),
      Parameters: redactSchemaDocumentation(fn.parameters, redactionNames),
    });
  }
  return plugins;
}

function runtimeClientPlugins(tools: unknown[] = [], choice: unknown): Array<Record<string, unknown>> {
  if (clientToolManifestCharacters(tools) <= MAX_NATIVE_CLIENT_PLUGIN_CHARACTERS) return clientPlugins(tools);
  const explicit = typeof choice === "object" && choice && !Array.isArray(choice)
    ? ((choice as { function?: { name?: string }; name?: string }).function?.name
      ?? (choice as { name?: string }).name)
    : undefined;
  if (!explicit) return [];
  const selected = tools.filter((raw) => clientFunctionDefinition(raw)?.name === explicit);
  return clientPlugins(selected);
}

export function parseFunctionCall(
  text: string,
  tools: unknown[] = [],
  inferredName?: string,
  allowSafePlainText = false,
): FunctionCall | null {
  const names = new Set<string>();
  const wireNames = new Map<string, string>();
  // Responses continuation requests may omit tool schemas after the first
  // turn. Keep only the three deterministic, strictly validated caller-tool
  // aliases decodable in that case.
  for (const name of INTEGRITY_SENSITIVE_CLIENT_TOOLS) {
    wireNames.set(clientToolWireName(name), name);
  }
  for (const tool of clientFunctionDefinitions(tools)) {
    wireNames.set(clientToolWireName(tool.name), tool.name);
    // Preserve legacy public-name parsing only for ordinary functions. The
    // three execution-sensitive functions remain alias-only in free text.
    if (!INTEGRITY_SENSITIVE_CLIENT_TOOLS.has(tool.name)) names.add(tool.name);
  }
  if (names.size === 0 && wireNames.size === 0) return null;
  const textualInferredName = inferredName && names.has(inferredName) ? inferredName : undefined;
  // A complete router envelope is a structured protocol response, not free
  // assistant prose. Permit an opaque alias to carry ordinary JSON in this
  // envelope; the alias still maps only to the declared caller tool and the
  // decoded arguments pass the bounded checks below. Keep standalone textual
  // alias JSON strict so arbitrary prose cannot request local execution.
  const structuredRouterEnvelope = /^\s*\{\s*["'](?:calls|decision)["']\s*:/u.test(text);
  const permitPlainSafeAlias = allowSafePlainText || structuredRouterEnvelope;

  for (const match of text.matchAll(/```([^\s`]*)\s*\n?([\s\S]*?)```/gu)) {
    const info = match[1].trim();
    try {
      const parsed = JSON.parse(match[2].trim()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "decision" in parsed) {
        const decision = strictToolCallDecision(parsed);
        if (!decision) continue;
        const call = callFromJSON(decision, names, textualInferredName, wireNames, true);
        if (call && acceptsDecodedClientCall(call, tools)) return call;
        continue;
      }
      const wireName = wireNames.get(info);
      if (wireName) {
        if (!INTEGRITY_SENSITIVE_CLIENT_TOOLS.has(wireName)) {
          const args = encodedArguments(parsed);
          if (args && acceptsDecodedClientCall({ name: wireName, arguments: args }, tools)) {
            return { name: wireName, arguments: args };
          }
          continue;
        }
        // Textual execution calls are accepted only as strict legacy input;
        // new model-facing prompts expose the native plugin channel alone.
        const decodedRaw = decodeAZHEXArguments(parsed);
        const decoded = decodedRaw === null ? null : normalizeClientArgumentKeys(wireName, decodedRaw, tools);
        const args = decoded === null ? null : encodedArguments(decoded);
        // Some caller runtimes advertise an older exec_command schema while
        // still sending harmless execution controls such as yield_time_ms.
        // Keep the sensitive fallback bounded to an object with a string cmd
        // (and optional string workdir/shell); do not let schema drift turn a
        // valid call back into leaked fenced text.
        const decodedObject = decoded && typeof decoded === "object" && !Array.isArray(decoded)
          ? decoded as Record<string, unknown>
          : null;
        const boundedExecFallback = wireName === "exec_command"
          && typeof decodedObject?.cmd === "string"
          && (decodedObject.workdir === undefined || typeof decodedObject.workdir === "string")
          && (decodedObject.shell === undefined || typeof decodedObject.shell === "string");
        if (args && (acceptsDecodedClientCall({ name: wireName, arguments: args }, tools) || boundedExecFallback)) {
          return { name: wireName, arguments: args };
        }
        continue;
      }
      if (names.has(info)) {
        const args = encodedArguments(parsed);
        if (args && acceptsDecodedClientCall({ name: info, arguments: args }, tools)) return { name: info, arguments: args };
      }
      const call = callFromJSON(parsed, names, textualInferredName, wireNames, permitPlainSafeAlias);
      if (call && acceptsDecodedClientCall(call, tools)) return call;
    } catch { /* try the next declared representation */ }
  }

  // A free-form answer can legitimately contain JSON examples. Only accept a
  // tagged payload or an envelope that occupies the complete trimmed answer;
  // never mine nested JSON out of surrounding narration.
  const candidates = [
    ...Array.from(text.matchAll(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/giu), (match) => match[1]),
    text.trim(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "decision" in parsed) {
        const decision = strictToolCallDecision(parsed);
        if (!decision) continue;
        const call = callFromJSON(decision, names, textualInferredName, wireNames, true);
        if (call && acceptsDecodedClientCall(call, tools)) return call;
        continue;
      }
      const call = callFromJSON(parsed, names, textualInferredName, wireNames, permitPlainSafeAlias);
      if (call && acceptsDecodedClientCall(call, tools)) return call;
    } catch { /* try the next candidate */ }
  }

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`^\\s*${escaped}\\s*\\(\\s*([\\s\\S]*?)\\s*\\)\\s*$`, "u").exec(text);
    if (!match) continue;
    try {
      const args = encodedArguments(JSON.parse(match[1]));
      if (args && acceptsDecodedClientCall({ name, arguments: args }, tools)) return { name, arguments: args };
    } catch { /* not a valid function call */ }
  }
  return null;
}

// ChatHub can return client-plugin invocations inside nested SignalR update
// messages without rendering a textual fenced call. Walk only the bounded
// upstream event currently being processed and accept an invocation only when
// both its name and argument field are explicit. This deliberately does not
// infer a call from ordinary event data or from the declared plugin schema.
export function parseNativeFunctionCall(value: unknown, tools: unknown[] = []): FunctionCall | null {
  const names = new Map<string, string>();
  for (const name of INTEGRITY_SENSITIVE_CLIENT_TOOLS) {
    names.set(name, name);
    names.set(clientToolWireName(name), name);
  }
  for (const tool of clientFunctionDefinitions(tools)) {
    names.set(tool.name, tool.name);
    names.set(clientToolWireName(tool.name), tool.name);
  }
  if (names.size === 0) return null;

  let visited = 0;
  const walk = (candidate: unknown, depth: number, inheritedInvocationContext = false): FunctionCall | null => {
    if (depth > 32 || visited++ > 50_000 || candidate === null || typeof candidate !== "object") return null;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const call = walk(item, depth + 1, inheritedInvocationContext);
        if (call) return call;
      }
      return null;
    }
    const record = candidate as Record<string, unknown>;
    const invocationContext = inheritedInvocationContext || [record.contentType, record.messageType, record.type, record.kind]
      .some((item) => typeof item === "string" && /(?:tool|function|plugin).*(?:call|invocation)|(?:call|invocation).*(?:tool|function|plugin)/iu.test(item));
    const candidates: Array<{ name: unknown; fields: string[] }> = [
      { name: record.functionName, fields: ["functionArguments", "arguments", "args", "input", ...(invocationContext ? ["parameters"] : [])] },
      { name: record.toolName, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
      { name: record.pluginName, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
      // Generic name/id plus `parameters` is the shape of a plugin definition,
      // not proof of invocation. It is accepted only inside an explicit call
      // event such as contentType=ToolCall.
      { name: record.name, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
      { name: record.id, fields: ["arguments", "args", "input", "functionArguments", ...(invocationContext ? ["parameters"] : [])] },
    ];
    for (const named of candidates) {
      if (typeof named.name !== "string") continue;
      const originalName = names.get(named.name);
      if (!originalName) continue;
      for (const key of named.fields) {
        if (!(key in record)) continue;
        // The native plugin channel carries ordinary JSON. Marker-like text is
        // caller data here (for example an SSH host/token), never an implicit
        // request to transform command arguments.
        const nativeArguments = normalizeClientArgumentKeys(originalName, record[key], tools);
        if (nativeArguments === null) continue;
        const args = encodedArguments(nativeArguments);
        if (args && acceptsDecodedClientCall({ name: originalName, arguments: args }, tools)) return { name: originalName, arguments: args };
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      const childInvocationContext = invocationContext && ["payload", "invocation", "call", "toolCall", "functionCall", "value"].includes(key);
      const call = walk(nested, depth + 1, childInvocationContext);
      if (call) return call;
    }
    return null;
  };
  return walk(value, 0);
}

/** Detect an explicit upstream tool/function invocation envelope even when its
 * name or arguments are malformed.  This carries no argument data outside the
 * parser; it only prevents a bad model decision from being misclassified as an
 * empty transport response (which would incorrectly cool an otherwise healthy
 * Microsoft account and make the bounded repair route unavailable). */
export function hasNativeFunctionCallEnvelope(value: unknown): boolean {
  let visited = 0;
  const walk = (candidate: unknown, depth: number, inherited = false): boolean => {
    if (depth > 32 || visited++ > 50_000 || candidate === null || typeof candidate !== "object") return false;
    if (Array.isArray(candidate)) return candidate.some((item) => walk(item, depth + 1, inherited));
    const record = candidate as Record<string, unknown>;
    const invocation = inherited || [record.contentType, record.messageType, record.type, record.kind]
      .some((item) => typeof item === "string" && /(?:tool|function|plugin).*(?:call|invocation)|(?:call|invocation).*(?:tool|function|plugin)/iu.test(item));
    const named = [record.functionName, record.toolName, record.pluginName, record.name, record.id]
      .some((item) => typeof item === "string" && item.trim().length > 0);
    const argumentsPresent = ["functionArguments", "arguments", "args", "input", "parameters"]
      .some((key) => Object.hasOwn(record, key));
    if (invocation && named && argumentsPresent) return true;
    return Object.entries(record).some(([key, nested]) => walk(
      nested,
      depth + 1,
      invocation && ["payload", "invocation", "call", "toolCall", "functionCall", "value", "item", "result"].includes(key),
    ));
  };
  return walk(value, 0);
}

function webSocketURL(account: OAuthTokenSet, sessionId: string, conversationId: string, requestId: string): string {
  const url = new URL(`${CHAT_HUB}/${encodeURIComponent(account.oid)}@${encodeURIComponent(account.tid)}`);
  url.searchParams.set("chatsessionid", requestId);
  url.searchParams.set("clientrequestid", requestId);
  url.searchParams.set("X-SessionId", sessionId);
  url.searchParams.set("ConversationId", conversationId);
  url.searchParams.set("access_token", account.accessToken);
  url.searchParams.set("variants", VARIANTS);
  url.searchParams.set("source", '"officeweb"');
  url.searchParams.set("product", "Office");
  url.searchParams.set("agentHost", "Bizchat.FullScreen");
  url.searchParams.set("licenseType", "Starter");
  url.searchParams.set("agent", "web");
  url.searchParams.set("scenario", "OfficeWebIncludedCopilot");
  return url.toString();
}

export interface ChatHubImageAttachment {
  type: "image";
  url: string;
  mimeType: string;
}

/**
 * Validate the internal attachment boundary independently of the OpenAI
 * adapter. This must run before dialing ChatHub so a malformed or oversized
 * image can never consume an account connection.
 */
export function chatHubAttachments(value: unknown): ChatHubImageAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("INVALID_CHAT_HUB_ATTACHMENTS");
  const normalized = normalizeMultimodalContent(value);
  // ChatHubRequest.attachments is image-only. Reject runtime callers that try
  // to smuggle text or unsupported content through the internal field.
  if (normalized.text || normalized.attachments.length !== value.length) {
    throw new Error("INVALID_CHAT_HUB_ATTACHMENTS");
  }
  return normalized.attachments.map((attachment) => ({
    type: "image",
    url: attachment.url,
    mimeType: attachment.mimeType,
  }));
}

const ANSWER_MESSAGE_TYPES = Object.freeze([
  "Chat",
  "Suggestion",
  "InternalSearchQuery",
  "Disengaged",
  "InternalLoaderMessage",
  "Progress",
  "RenderCardRequest",
  "SemanticSerp",
  "GenerateContentQuery",
  "SearchQuery",
  "ConfirmationCard",
  "DeveloperLogs",
  "EndOfRequest",
  "ReferencesListComplete",
  "GeneratedCode",
]);

/** Caller-tool and isolated-router turns consume only chat text, progress,
 * tool confirmation, completion and disengagement. Omitting large search,
 * card, developer-log and generated-code envelopes reduces upstream frames
 * before the Worker has to allocate and parse them. */
const COMPACT_MESSAGE_TYPES = Object.freeze([
  "Chat",
  "Disengaged",
  "Progress",
  "ConfirmationCard",
  "EndOfRequest",
  "ReferencesListComplete",
]);

export function chatHubAllowedMessageTypes(
  request: Pick<ChatHubRequest, "tools" | "toolChoice" | "messageProfile">,
): string[] {
  const inferredCompact = (request.tools?.length ?? 0) > 0 || request.toolChoice === "none";
  const compact = request.messageProfile === "caller_tool"
    || request.messageProfile === "router"
    || (request.messageProfile === undefined && inferredCompact);
  return [...(compact ? COMPACT_MESSAGE_TYPES : ANSWER_MESSAGE_TYPES)];
}

function buildChatPayload(request: ChatHubRequest, requestId: string, attachments: ChatHubImageAttachment[]): string {
  const plugins = runtimeClientPlugins(request.tools, request.toolChoice);
  const invocation = {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: crypto.randomUUID(),
      sessionId: request.sessionId,
      optionsSets: [],
      spokenTextMode: "None",
      options: {},
      extraExtensionParameters: {},
      allowedMessageTypes: chatHubAllowedMessageTypes(request),
      sliceIds: [],
      threadLevelGptId: {},
      conversationId: request.conversationId,
      traceId: crypto.randomUUID(),
      isStartOfSession: request.started,
      productThreadType: "Office",
      clientInfo: {
        clientPlatform: "mcmcopilot-web",
        clientAppName: "Office",
        clientEntrypoint: "mcmcopilot-officeweb",
        clientSessionId: request.sessionId,
        clientAppType: "Web",
        deviceOS: "Windows",
        deviceType: "Desktop",
      },
      tone: request.tone,
      streamingMode: "ConciseWithPadding",
      message: {
        author: "user",
        attachments,
        inputMethod: "Keyboard",
        text: toolProtocolPrompt(request.text, request.tools, request.toolChoice),
        requestId,
        locationInfo: { timeZoneOffset: 8, timeZone: "Asia/Shanghai" },
        locale: "en-US",
        messageType: "Chat",
        experienceType: "Default",
        adaptiveCards: [],
        clientPreferences: {},
      },
      plugins,
      // With a high-cardinality manifest the complete strict tool contract is
      // carried once in message.text. Do not reference an omitted native
      // plugin in ChatHub's separate selector field.
      toolChoice: plugins.length > 0 ? clientToolChoice(request.toolChoice) : "none",
      isSbsSupported: true,
      renderReferencesBehindEOS: true,
      disconnectBehavior: "continue",
    }],
    invocationId: "0",
    target: "chat",
    type: 4,
  };
  const metrics = {
    arguments: [{ Timestamps: { ConnectionStart: "", UserInputStart: "", ConnectionEstablished: "", UserInputSubmit: "" } }],
    target: "Metrics",
    type: 1,
  };
  return `${JSON.stringify(invocation)}${RS}${JSON.stringify(metrics)}${RS}`;
}

/** Exposed for protocol contract tests; runtime validation is identical. */
export function chatPayload(request: ChatHubRequest, requestId: string): string {
  return buildChatPayload(request, requestId, chatHubAttachments(request.attachments));
}

/** Merge de-duplicated image outputs while bounding retained URL/data bytes. */
export function appendUpstreamImageURLs(current: readonly string[], event: unknown): string[] {
  const output = current.slice(0, 4);
  const seen = new Set(output);
  let characters = output.reduce((total, value) => total + value.length, 0);
  for (const candidate of extractUpstreamImageURLs(event)) {
    if (output.length >= 4 || seen.has(candidate)) continue;
    assertBoundedPayload(
      "CHAT_IMAGE_OUTPUT_TOO_LARGE",
      characters + candidate.length,
      MAX_UPSTREAM_IMAGE_URL_CHARACTERS,
      "image_output",
    );
    seen.add(candidate);
    output.push(candidate);
    characters += candidate.length;
  }
  return output;
}

function asText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data ?? "");
}

function binaryFrameByteLength(data: unknown): number | null {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface SocketReader {
  next(timeoutMs: number): Promise<string>;
  close(): void;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause ?? "UNKNOWN_CHAT_ERROR");
}

/**
 * A same-account reconnect is safe only while the invocation has not been
 * submitted to ChatHub. Once chatPayload() has been sent, the upstream may
 * already have performed searches or other side effects even if no text delta
 * has reached the client. Replaying that invocation can duplicate work and is
 * a material account-risk signal.
 */
export function mayReconnectChatHubFailure(cause: unknown, invocationSubmitted: boolean): boolean {
  if (invocationSubmitted) return false;
  const message = failureMessage(cause).toUpperCase();
  if (message === "WS_DIAL_ERROR" || message === "WS_READ_TIMEOUT" || message === "WS_ERROR_BEFORE_COMPLETION") return true;
  if (message.startsWith("WS_CLOSED_BEFORE_COMPLETION:")) return true;
  if (message.startsWith("WS_DIAL_FAILED:408") || message.startsWith("WS_DIAL_FAILED:425")) return true;
  return /^WS_DIAL_FAILED:5\d\d(?:\D|$)/u.test(message);
}

/** A reconnect is safe only before the submitted invocation can have produced
 * side effects. Once ChatHub accepted the payload, a clean close is
 * ambiguous: it may have already executed a caller tool even when no text or
 * tool event reached us. Replaying that payload would duplicate the action,
 * so submitted attempts are deliberately not retried. */
export function mayRetryUnseenChatHubFailure(cause: unknown, responseStarted: boolean): boolean {
  if (responseStarted) return false;
  if (cause instanceof ChatHubAttemptError && cause.reconnectSafe) return true;
  // `invocationSubmitted` is intentionally not a retry path. The caller can
  // continue with the preserved response/tool ledger instead of replaying a
  // potentially side-effecting request on a fresh conversation.
  return false;
}

export class ChatHubAttemptError extends Error {
  readonly reconnectSafe: boolean;
  readonly invocationSubmitted: boolean;
  readonly terminalEmptyQuota: boolean;
  readonly boundedPayload: BoundedPayloadMetadata | null;

  constructor(cause: unknown, invocationSubmitted: boolean, terminalEmptyQuota = false) {
    super(failureMessage(cause));
    this.name = "ChatHubAttemptError";
    this.invocationSubmitted = invocationSubmitted;
    this.terminalEmptyQuota = terminalEmptyQuota;
    this.reconnectSafe = mayReconnectChatHubFailure(cause, invocationSubmitted);
    this.boundedPayload = boundedPayloadMetadata(cause);
  }
}

/** Preserve size metadata across ChatHubAttemptError wrapping without
 * retaining the rejected payload or an arbitrary upstream Error object. */
export function boundedPayloadMetadata(cause: unknown): BoundedPayloadMetadata | null {
  const metadata = cause instanceof BoundedPayloadError
    ? cause
    : cause instanceof ChatHubAttemptError
      ? cause.boundedPayload
      : null;
  if (!metadata) return null;
  return {
    subtype: metadata.subtype,
    observed: metadata.observed,
    limit: metadata.limit,
    phase: metadata.phase,
  };
}

export interface BoundedPayloadDiagnostic {
  event: "chathub_bounded_payload_rejected";
  subtype: BoundedPayloadSubtype;
  phase: BoundedPayloadPhase;
  observed_characters: number;
  limit_characters: number;
}

export function boundedPayloadDiagnostic(cause: unknown): BoundedPayloadDiagnostic | null {
  const metadata = boundedPayloadMetadata(cause);
  if (!metadata) return null;
  return {
    event: "chathub_bounded_payload_rejected",
    subtype: metadata.subtype,
    phase: metadata.phase,
    observed_characters: metadata.observed,
    limit_characters: metadata.limit,
  };
}

function logBoundedPayloadFailure(cause: unknown): void {
  const diagnostic = boundedPayloadDiagnostic(cause);
  if (diagnostic) console.error(JSON.stringify(diagnostic));
}

/** Preserve the strongest submission fact across a bounded same-account
 * retry. A second pre-submit failure must not erase that the first attempt was
 * already accepted, otherwise exchange() could replay the logical invocation
 * on another account or reuse polluted upstream coordinates. */
export function preserveChatHubSubmissionHistory(cause: unknown, invocationSubmitted: boolean): unknown {
  if (!invocationSubmitted) return cause;
  if (cause instanceof ChatHubAttemptError && cause.invocationSubmitted) return cause;
  return new ChatHubAttemptError(
    cause,
    true,
    cause instanceof ChatHubAttemptError && cause.terminalEmptyQuota,
  );
}

/**
 * Cross-account failover is another replay of the logical invocation. Keep
 * this decision structured: once ChatHub accepted chatPayload(), neither a
 * timeout nor a close nor a transient 5xx may cause the prompt to be sent to
 * a second account, even when no downstream delta was observed.
 */
export function mayFailOverChatHubFailure(cause: unknown): boolean {
  const message = failureMessage(cause).toUpperCase();
  if (message === "REQUEST_ABORTED" || message === "CHAT_DEADLINE_EXCEEDED" || message === "CHAT_PROGRESS_TIMEOUT") return false;
  return !(cause instanceof ChatHubAttemptError) || !cause.invocationSubmitted;
}

export function chatHubInvocationWasSubmitted(cause: unknown): boolean {
  return cause instanceof ChatHubAttemptError && cause.invocationSubmitted;
}

export function isTerminalEmptyQuotaFailure(cause: unknown): boolean {
  return cause instanceof ChatHubAttemptError && cause.terminalEmptyQuota;
}

/**
 * Wait for the next semantic frame without treating an otherwise healthy,
 * silent WebSocket as dead every 60 seconds. The outer request deadline stays
 * authoritative; the short reads merely let the runtime observe cancellation
 * and keep sending protocol pings while a long model turn is computing.
 */
export async function nextChatHubFrame(
  reader: Pick<SocketReader, "next">,
  deadlineAt: number,
  readSliceMs = 60_000,
): Promise<string> {
  for (;;) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("CHAT_DEADLINE_EXCEEDED");
    try {
      return await reader.next(Math.max(1, Math.min(readSliceMs, remaining)));
    } catch (cause) {
      if (failureMessage(cause) !== "WS_READ_TIMEOUT") throw cause;
      if (Date.now() >= deadlineAt) throw new Error("CHAT_DEADLINE_EXCEEDED");
    }
  }
}

export async function nextProgressBoundedChatHubFrame(
  reader: Pick<SocketReader, "next">,
  requestDeadlineAt: number,
  progressDeadlineAt: number,
): Promise<string> {
  const effectiveDeadline = Math.min(requestDeadlineAt, progressDeadlineAt);
  try {
    return await nextChatHubFrame(reader, effectiveDeadline);
  } catch (cause) {
    if (
      failureMessage(cause) === "CHAT_DEADLINE_EXCEEDED"
      && progressDeadlineAt < requestDeadlineAt
      && Date.now() >= progressDeadlineAt
    ) {
      throw new Error("CHAT_PROGRESS_TIMEOUT");
    }
    throw cause;
  }
}

/** Parse the SignalR handshake without consuming a coalesced first event. */
export function parseSignalRHandshake(frame: string): string {
  let handshakePart = "";
  let remainder = "";
  let foundHandshake = false;
  let records = 0;
  for (const part of signalRFrameParts(frame)) {
    records += 1;
    if (records > MAX_SIGNALR_RECORDS_PER_REQUEST) {
      throw new BoundedPayloadError(
        "WS_FRAME_TOO_MANY_RECORDS",
        records,
        MAX_SIGNALR_RECORDS_PER_REQUEST,
        "websocket_frame",
      );
    }
    if (!foundHandshake) {
      if (!part.trim()) continue;
      handshakePart = part;
      foundHandshake = true;
      continue;
    }
    if (part.trim()) remainder += `${part}${RS}`;
  }
  if (!foundHandshake) throw new Error("WS_HANDSHAKE_EMPTY");
  let handshake: unknown;
  try {
    handshake = JSON.parse(handshakePart) as unknown;
  } catch {
    throw new Error("WS_HANDSHAKE_INVALID");
  }
  if (!handshake || typeof handshake !== "object" || Array.isArray(handshake)) throw new Error("WS_HANDSHAKE_INVALID");
  const record = handshake as Record<string, unknown>;
  if (Object.hasOwn(record, "error")) throw new Error("WS_HANDSHAKE_FAILED");
  if (Object.keys(record).length > 0) throw new Error("WS_HANDSHAKE_UNEXPECTED_FRAME");
  return remainder;
}

/**
 * Iterate SignalR record-separator parts without materializing an array of
 * every part in a potentially 1.5M-character WebSocket frame.  A malformed
 * or adversarial frame can contain hundreds of thousands of tiny records;
 * `String#split` retains all of those substrings until the whole frame has
 * been parsed, which needlessly spikes a 128MiB Worker isolate.  The caller
 * still applies the same whitespace/JSON validation to each yielded part.
 */
function* signalRFrameParts(frame: string): Generator<string> {
  let start = 0;
  while (start <= frame.length) {
    const end = frame.indexOf(RS, start);
    if (end < 0) {
      yield frame.slice(start);
      return;
    }
    yield frame.slice(start, end);
    start = end + RS.length;
  }
}

export function socketReader(socket: WebSocket, maximumQueuedCharacters = MAX_QUEUED_SOCKET_CHARACTERS): SocketReader {
  const queued: string[] = [];
  let queuedCharacters = 0;
  const waiting: Array<{ resolve: (value: string) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let terminal: Error | null = null;
  const settle = (value: string): void => {
    if (terminal) return;
    const waiter = waiting.shift();
    if (!waiter) {
      const observedCharacters = queuedCharacters + value.length;
      if (observedCharacters > maximumQueuedCharacters) {
        fail(new BoundedPayloadError(
          "WS_BUFFER_TOO_LARGE",
          observedCharacters,
          maximumQueuedCharacters,
          "websocket_queue",
        ), true);
        try { socket.close(1009, "buffer too large"); } catch { /* already closed */ }
        return;
      }
      queued.push(value);
      queuedCharacters += value.length;
    }
    else {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  };
  const fail = (reason: Error, discardQueued = false): void => {
    // Preserve the first terminal reason. In particular, a close event caused
    // by our 1009 policy must not overwrite the bounded/protocol error with a
    // generic WS_CLOSED error before the waiting caller observes it.
    if (terminal) return;
    terminal = reason;
    if (discardQueued) {
      queued.length = 0;
      queuedCharacters = 0;
    }
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  };
  socket.addEventListener("message", (event) => {
    const byteLength = binaryFrameByteLength(event.data);
    if (byteLength !== null && byteLength > MAX_FRAME_EARLY_REJECT_BYTES) {
      fail(new BoundedPayloadError(
        "WS_FRAME_TOO_LARGE",
        MAX_FRAME_CHARACTERS + 1,
        MAX_FRAME_CHARACTERS,
        "websocket_frame",
      ), true);
      try { socket.close(1009, "frame too large"); } catch { /* already closed */ }
      return;
    }
    const value = asText(event.data);
    if (value.length > MAX_FRAME_CHARACTERS) {
      fail(new BoundedPayloadError(
        "WS_FRAME_TOO_LARGE",
        value.length,
        MAX_FRAME_CHARACTERS,
        "websocket_frame",
      ), true);
      try { socket.close(1009, "frame too large"); } catch { /* already closed */ }
      return;
    }
    settle(value);
  });
  socket.addEventListener("close", (event) => fail(new Error(`WS_CLOSED_BEFORE_COMPLETION:${event.code}`)));
  socket.addEventListener("error", () => fail(new Error("WS_ERROR_BEFORE_COMPLETION")));
  return {
    next(timeoutMs: number): Promise<string> {
      const value = queued.shift();
      if (value !== undefined) {
        queuedCharacters -= value.length;
        return Promise.resolve(value);
      }
      if (terminal) return Promise.reject(terminal);
      return new Promise((resolve, reject) => {
        const record = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiting.indexOf(record);
            if (index >= 0) waiting.splice(index, 1);
            reject(new Error("WS_READ_TIMEOUT"));
          }, timeoutMs),
        };
        waiting.push(record);
      });
    },
    close(): void {
      fail(new Error("WS_CLOSED"));
      try { socket.close(1000, "complete"); } catch { /* already closed */ }
    },
  };
}

export function appendChatSnapshot(current: string, snapshot: string, emit?: (delta: string) => void): string {
  if (!snapshot) return current;
  if (!current) {
    emit?.(snapshot);
    return snapshot;
  }
  // When no downstream stream is attached, only the accumulated return value
  // matters.  The existing branches return the longer snapshot and otherwise
  // retain the current text regardless of prefix compatibility; skip the
  // O(current.length) prefix scan in this non-streaming path.  Keep the full
  // check below for live streams because it controls suffix emission.
  if (!emit) return snapshot.length > current.length ? snapshot : current;
  if (snapshot.startsWith(current)) {
    const delta = snapshot.slice(current.length);
    if (delta) emit?.(delta);
    return snapshot;
  }
  // ChatHub can interleave a short delta with a later authoritative snapshot
  // whose prefix was not delivered as a delta. Keep the longer snapshot so a
  // final type:2 frame cannot be reduced to a truncated answer. We cannot emit
  // the divergent text here because already-sent bytes cannot be retracted.
  if (snapshot.length > current.length) return snapshot;
  return current;
}

/**
 * Fold a ChatHub `writeAtCursor` value into the accumulated answer.
 *
 * Most tenants send a true delta, but some rollouts resend the whole answer
 * (or repeat the last delta) after a progress/tool frame. Treating every
 * value as a delta duplicates text and can make the public stream diverge
 * from the final answer. This helper keeps the common delta path while being
 * prefix/duplicate safe for cumulative frames.
 */
export function appendChatHubDelta(current: string, chunk: string, emit?: (delta: string) => void): string {
  if (!chunk) return current;
  if (!current) {
    emit?.(chunk);
    return chunk;
  }
  if (chunk === current || current.endsWith(chunk)) return current;
  if (chunk.startsWith(current)) {
    const delta = chunk.slice(current.length);
    if (delta) emit?.(delta);
    return chunk;
  }
  emit?.(chunk);
  return current + chunk;
}

/** Prefer the longest authoritative text when update and completion frames
 * disagree. A short completion snapshot is occasionally emitted before the
 * last update snapshot has been flushed. */
export function chooseChatHubText(streamed: string, final: string): string {
  if (!streamed) return final;
  if (!final) return streamed;
  return final.length >= streamed.length ? final : streamed;
}

export interface ChatHubTextReconciliation {
  text: string;
  divergent: boolean;
  streamedCharacters: number;
  finalCharacters: number;
}

/** Extract only user-visible bot answer text. ChatHub's normal answer snapshot
 * is explicitly tagged `messageType: "Chat"`; treating every non-undefined
 * type as control metadata silently discarded real completions. */
export function chatHubAnswerMessageText(message: Record<string, unknown>): string {
  if (message.author !== "bot" || typeof message.text !== "string" || message.text.length === 0) return "";
  const type = message.messageType;
  return type === undefined || type === "Chat" ? message.text : "";
}

/** A type:2 completion result is the authoritative answer snapshot. Keep the
 * older chooseChatHubText helper for compatibility callers, but runtime
 * completion must never concatenate or prefer an incompatible update stream.
 * Only lengths and the conflict bit are exposed for diagnostics. */
export function reconcileChatHubText(streamed: string, final: string): ChatHubTextReconciliation {
  const divergent = Boolean(
    streamed
    && final
    && !streamed.startsWith(final)
    && !final.startsWith(streamed),
  );
  return {
    text: final || streamed,
    divergent,
    streamedCharacters: streamed.length,
    finalCharacters: final.length,
  };
}

/** Only real user-visible or protocol progress may extend the idle deadline. */
export function chatHubUpdateHasSemanticProgress(update: Record<string, unknown>): boolean {
  if (Object.hasOwn(update, "throttling")) return true;
  if (typeof update.writeAtCursor === "string" && update.writeAtCursor.length > 0) return true;
  const messages = Array.isArray(update.messages) ? update.messages as Array<Record<string, unknown>> : [];
  return messages.some((message) =>
    message.messageType === "Progress"
    || ["SearchResults", "Code", "ToolCall"].includes(String(message.contentType ?? ""))
    || chatHubAnswerMessageText(message).length > 0);
}

async function runChatHub(
  account: OAuthTokenSet,
  request: ChatHubRequest,
  emit?: (delta: string) => void,
  relay?: ChatHubRelay,
  onSemanticProgress?: () => void,
): Promise<ChatHubResult> {
  if (request.signal?.aborted) throw new Error("REQUEST_ABORTED");
  // This is deliberately outside the WebSocket fetch try/catch. A protocol
  // validation failure is a caller error, not a transport failure eligible
  // for reconnect or cross-account failover.
  const attachments = chatHubAttachments(request.attachments);
  const requestId = crypto.randomUUID();
  let invocationSubmitted = false;
  let invalidJSONFrames = 0;
  const unknownFrameTypes = new Set<string>();
  const unknownTargets = new Set<string>();
  let response: Response;
  const connection = relay
    ? await relayWebSocketRequest(account, request.sessionId, request.conversationId, requestId, relay)
    : {
        url: webSocketURL(account, request.sessionId, request.conversationId, requestId),
        headers: new Headers({
          Upgrade: "websocket",
          Origin: "https://m365.cloud.microsoft",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
        }),
      };
  try {
    response = await fetch(connection.url, {
      headers: connection.headers,
      signal: request.signal,
    });
  } catch {
    // Never propagate the fetch error: Cloudflare includes the full URL and
    // therefore the access_token query parameter in that error string.
    if (request.deadlineAt && Date.now() >= request.deadlineAt) {
      throw new ChatHubAttemptError(new Error("CHAT_DEADLINE_EXCEEDED"), false);
    }
    if (request.signal?.aborted) throw new ChatHubAttemptError(new Error("REQUEST_ABORTED"), false);
    if (relay) throw new ChatHubAttemptError(new Error("RELAY_DIAL_ERROR"), false);
    throw new ChatHubAttemptError(new Error("WS_DIAL_ERROR"), false);
  }
  const socket = response.webSocket;
  if (!socket) throw new ChatHubAttemptError(new Error(`${relay ? "RELAY_DIAL_FAILED" : "WS_DIAL_FAILED"}:${response.status}`), false);
  socket.accept();
  const reader = socketReader(socket);
  const abort = (): void => reader.close();
  request.signal?.addEventListener("abort", abort, { once: true });
  let ping: ReturnType<typeof setInterval> | undefined;
  try {
    socket.send(`{"protocol":"json","version":1}${RS}`);
    const deadline = request.deadlineAt ?? Date.now() + 10 * 60_000;
    const handshakeTimeout = Math.max(1, Math.min(CHAT_HANDSHAKE_TIMEOUT_MS, deadline - Date.now()));
    let pendingFrame: string;
    try {
      pendingFrame = parseSignalRHandshake(await reader.next(handshakeTimeout));
    } catch (cause) {
      // Preserve the established transport error label so existing retry and
      // public error classification remains stable; only the timeout budget
      // changes. A submitted invocation is still never replayed.
      if (failureMessage(cause) === "WS_READ_TIMEOUT") throw new Error("WS_HANDSHAKE_TIMEOUT");
      throw cause;
    }
    ping = setInterval(() => {
      try { socket.send(`{"type":6}${RS}`); } catch { /* read side reports closure */ }
    }, 15_000);
    socket.send(buildChatPayload(request, requestId, attachments));
    invocationSubmitted = true;

    let streamed = "";
    let final = "";
    let resultError = "";
    let disengaged = false;
    let syntheticFailureCode: "CHAT_UPSTREAM_RATE_LIMITED" | null = null;
    let throttling: unknown;
    let functionCall: FunctionCall | null = null;
    let malformedFunctionCall = false;
    let images: string[] = [];
    const completeResult = (): ChatHubResult => {
      const reconciliation = reconcileChatHubText(streamed, final);
      if (reconciliation.divergent) {
        console.warn(JSON.stringify({
          event: "chathub_text_divergence",
          authority: "completion_final",
          streamed_characters: reconciliation.streamedCharacters,
          final_characters: reconciliation.finalCharacters,
        }));
      }
      let text = scrubNarration(reconciliation.text);
      let toolDecision: "answer" | "tool_call" | "invalid" | undefined = functionCall ? "tool_call" : undefined;
      const callerTools = request.tools ?? [];
      if (callerTools.length > 0 && String(request.toolChoice ?? "auto").toLowerCase() !== "none" && !functionCall) {
        const explicit = typeof request.toolChoice === "object" && request.toolChoice
          ? ((request.toolChoice as { function?: { name?: string }; name?: string }).function?.name
            ?? (request.toolChoice as { name?: string }).name)
          : undefined;
        const parsedCall = parseFunctionCall(text, callerTools, explicit);
        if (parsedCall) {
          functionCall = parsedCall;
          text = "";
          toolDecision = "tool_call";
        } else {
          const answer = parseToolDecisionAnswer(text);
          if (answer !== null) {
            text = answer;
            toolDecision = "answer";
          } else if (isOrdinaryToolDecisionAnswer(text)) {
            toolDecision = "answer";
          }
        }
      }
      syntheticFailureCode ||= syntheticUpstreamFailureCode(text);
      if (syntheticFailureCode) throw new Error(syntheticFailureCode);
      if (!text && !functionCall && images.length === 0) {
        // A malformed native envelope is a completed Microsoft transport with
        // an invalid semantic decision. Return that closed state to the tool
        // resolver so it can use the same live lease for bounded repair. If we
        // throw here, exchange() correctly assumes a submitted transport may
        // be polluted and tombstones the lease, making any recovered call
        // impossible to commit.
        if (malformedFunctionCall) toolDecision = "invalid";
        else {
        if (disengaged) throw new Error("CHAT_DISENGAGED");
        if (quotaExhausted(throttling)) throw new Error("CHAT_THROTTLED_QUOTA_EXHAUSTED");
        throw new Error("CHAT_RETURNED_NO_CONTENT");
        }
      }
      return {
        text,
        conversationId: request.conversationId,
        sessionId: request.sessionId,
        requestId,
        ...(images.length > 0 ? { images } : {}),
        ...(functionCall ? { functionCall } : {}),
        ...(toolDecision ? { toolDecision } : {}),
        ...(throttling === undefined ? {} : { throttling }),
      };
    };
  let progressDeadline = Math.min(deadline, Date.now() + CHAT_PROGRESS_IDLE_TIMEOUT_MS);
    let signalRRecords = 0;
    while (Date.now() < deadline) {
      const frame = pendingFrame || await nextProgressBoundedChatHubFrame(reader, deadline, progressDeadline);
      pendingFrame = "";
      let semanticProgress = false;
      for (const part of signalRFrameParts(frame)) {
        signalRRecords += 1;
        if (signalRRecords > MAX_SIGNALR_RECORDS_PER_REQUEST) {
          throw new BoundedPayloadError(
            "WS_FRAME_TOO_MANY_RECORDS",
            signalRRecords,
            MAX_SIGNALR_RECORDS_PER_REQUEST,
            "websocket_frame",
          );
        }
        if (!part.trim()) continue;
        let event: Record<string, unknown>;
        try {
          const parsed = JSON.parse(part) as unknown;
          if (!isRecord(parsed)) throw new Error("event_not_object");
          event = parsed;
        } catch {
          invalidJSONFrames += 1;
          continue;
        }
        const priorImageCount = images.length;
        images = appendUpstreamImageURLs(images, event);
        if (images.length > priorImageCount) {
          semanticProgress = true;
          onSemanticProgress?.();
        }
        const parsedFunctionCall = parseNativeFunctionCall(event, request.tools);
        if (!parsedFunctionCall && hasNativeFunctionCallEnvelope(event)) malformedFunctionCall = true;
        if (!functionCall && parsedFunctionCall) {
          semanticProgress = true;
          onSemanticProgress?.();
        }
        functionCall ||= parsedFunctionCall;
        const type = Number(event.type ?? 0);
        if (![1, 2, 3, 6, 7].includes(type)) {
          rememberProtocolDriftLabel(unknownFrameTypes, Number.isSafeInteger(type) ? String(type) : "non_numeric");
        }
        if (type === 6) {
          // A valid SignalR ping proves that the upstream socket is alive.
          // Refresh the bounded semantic-idle window without counting the
          // heartbeat as user-visible progress; the outer ten-minute deadline
          // still prevents an endless heartbeat-only request.
          progressDeadline = Math.min(deadline, Date.now() + CHAT_PROGRESS_IDLE_TIMEOUT_MS);
          socket.send(`{"type":6}${RS}`);
          continue;
        }
        if (type === 1 && event.target === "update") {
          const updates = Array.isArray(event.arguments) ? event.arguments : [];
          if (!Array.isArray(event.arguments) && event.arguments !== undefined) invalidJSONFrames += 1;
          for (const raw of updates) {
            if (!isRecord(raw)) {
              invalidJSONFrames += 1;
              continue;
            }
            const update = raw;
            if (chatHubUpdateHasSemanticProgress(update)) {
              semanticProgress = true;
              onSemanticProgress?.();
            }
            if (Object.hasOwn(update, "throttling")) {
              throttling = update.throttling;
            }
            const messages = (update.messages as Array<Record<string, unknown>> | undefined) ?? [];
            if (messages.some((message) => message.messageType === "Disengaged")) disengaged = true;
            const toolFrame = messages.some((message) => message.messageType === "Progress" || ["SearchResults", "Code", "ToolCall"].includes(String(message.contentType ?? "")));
            if (!toolFrame && typeof update.writeAtCursor === "string" && update.writeAtCursor.length > 0) {
              const placeholder = syntheticUpstreamFailureCode(update.writeAtCursor);
              if (placeholder) syntheticFailureCode ||= placeholder;
              else streamed = appendChatHubDelta(streamed, update.writeAtCursor, emit);
              assertBoundedPayload("CHAT_OUTPUT_TOO_LARGE", streamed.length, MAX_OUTPUT_CHARACTERS, "streamed_text");
            }
            for (const message of messages) {
              const answerText = chatHubAnswerMessageText(message);
              if (answerText) {
                assertBoundedPayload("CHAT_OUTPUT_TOO_LARGE", answerText.length, MAX_OUTPUT_CHARACTERS, "update_snapshot");
                const placeholder = syntheticUpstreamFailureCode(answerText);
                if (placeholder) syntheticFailureCode ||= placeholder;
                else streamed = appendChatSnapshot(streamed, answerText, emit);
              }
            }
          }
          continue;
        }
        if (type === 1) {
          rememberProtocolDriftLabel(unknownTargets, safeProtocolLabel(event.target));
          continue;
        }
        if (type === 2) {
          semanticProgress = true;
          onSemanticProgress?.();
          const item = isRecord(event.item) ? event.item : undefined;
          if (item && Object.hasOwn(item, "throttling")) throttling = item.throttling;
          // The final stream item may carry the authoritative bot snapshot in
          // `item.messages` instead of `item.result.message`. Treat it exactly
          // like an update snapshot before completion is evaluated.
          const finalMessages = Array.isArray(item?.messages)
            ? item.messages as Array<Record<string, unknown>>
            : [];
          if (finalMessages.some((message) => message.messageType === "Disengaged")) disengaged = true;
          for (const message of finalMessages) {
            const answerText = chatHubAnswerMessageText(message);
            if (answerText) {
              assertBoundedPayload("CHAT_OUTPUT_TOO_LARGE", answerText.length, MAX_OUTPUT_CHARACTERS, "completion_snapshot");
              const placeholder = syntheticUpstreamFailureCode(answerText);
              if (placeholder) syntheticFailureCode ||= placeholder;
              else streamed = appendChatSnapshot(streamed, answerText, emit);
            }
          }
          const result = isRecord(item?.result) ? item.result : undefined;
          if (typeof result?.message === "string") {
            assertBoundedPayload("CHAT_OUTPUT_TOO_LARGE", result.message.length, MAX_OUTPUT_CHARACTERS, "completion_message");
            const placeholder = syntheticUpstreamFailureCode(result.message);
            if (placeholder) syntheticFailureCode ||= placeholder;
            else final = result.message;
          }
          if (typeof result?.value === "string" && result.value) {
            try {
              const parsed = JSON.parse(result.value) as unknown;
              resultError = upstreamErrorLabel(parsed);
              if (resultError === "unknown") resultError = "";
            } catch { /* opaque successful value */ }
          }
          continue;
        }
        if (type === 3) {
          if (event.error) throw new Error(`CHAT_COMPLETION_ERROR:${upstreamErrorLabel(event.error)}`);
          if (resultError) throw new Error(`CHAT_UPSTREAM_ERROR:${resultError}`);
          return completeResult();
        }
        if (type === 7) {
          if (event.error) throw new Error(`CHAT_CLOSED_BEFORE_COMPLETION:${upstreamErrorLabel(event.error)}`);
          // Some ChatHub rollouts close cleanly after the final stream item
          // without sending a separate type:3 frame. Accept that only when a
          // final answer/tool/image is already present; a mere partial delta
          // remains a genuine incomplete turn.
          if (final || functionCall || images.length > 0) return completeResult();
          throw new Error("CHAT_CLOSED_BEFORE_COMPLETION:clean_without_final");
        }
      }
      if (semanticProgress) {
        progressDeadline = Math.min(deadline, Date.now() + CHAT_PROGRESS_IDLE_TIMEOUT_MS);
      }
    }
    throw new Error("CHAT_DEADLINE_EXCEEDED");
  } catch (cause) {
    // Log only the closed subtype and numeric bounds. The rejected frame,
    // prompt, tool result and image URL are deliberately unavailable here.
    logBoundedPayloadFailure(cause);
    // Abort is not an account failure and must never trigger either a
    // same-account replay or a switch to another account in exchange().
    if (request.deadlineAt && Date.now() >= request.deadlineAt) {
      throw new ChatHubAttemptError(new Error("CHAT_DEADLINE_EXCEEDED"), invocationSubmitted);
    }
    if (request.signal?.aborted) throw new ChatHubAttemptError(new Error("REQUEST_ABORTED"), invocationSubmitted);
    throw new ChatHubAttemptError(
      cause,
      invocationSubmitted,
      failureMessage(cause).toUpperCase() === "CHAT_THROTTLED_QUOTA_EXHAUSTED",
    );
  } finally {
    if (invalidJSONFrames > 0 || unknownFrameTypes.size > 0 || unknownTargets.size > 0) {
      console.warn(JSON.stringify({
        event: "chathub_protocol_drift",
        invalid_json_frames: invalidJSONFrames,
        unknown_frame_types: [...unknownFrameTypes].slice(0, 16),
        unknown_targets: [...unknownTargets].slice(0, 16),
      }));
    }
    request.signal?.removeEventListener("abort", abort);
    if (ping) clearInterval(ping);
    reader.close();
  }
}

export async function chatHub(
  account: OAuthTokenSet,
  request: ChatHubRequest,
  emit?: (delta: string) => void,
  relay?: ChatHubRelay,
): Promise<ChatHubResult> {
  let last: unknown;
  const deadlineAt = request.deadlineAt ?? Date.now() + 10 * 60_000;
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  const signal = request.signal ? AbortSignal.any([request.signal, deadlineSignal]) : deadlineSignal;
  const boundedRequest = { ...request, deadlineAt, signal };
  // Upload once before transport retries. A failed upload never falls through
  // to a text-only invocation. Nothing changes for requests without images.
  await uploadConversationImages(account, request.conversationId, request.attachments, signal);
  let attemptRequest = request.attachments?.length ? { ...boundedRequest, attachments: [] } : boundedRequest;
  let invocationSubmitted = false;
  // One bounded reconnect is allowed only before any semantic delta. A
  // post-submit disconnect uses fresh conversation coordinates, while a
  // pre-submit dial failure can reuse the original request. All attempts share
  // one deadline, so retry cannot multiply total task duration.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let emitted = false;
    let semanticStarted = false;
    try {
      const deltaEmitter = emit
        ? (delta: string): void => {
            if (delta) emitted = true;
            emit(delta);
          }
        : undefined;
      return await runChatHub(account, attemptRequest, deltaEmitter, relay, () => {
        semanticStarted = true;
      });
    } catch (cause) {
      invocationSubmitted ||= cause instanceof ChatHubAttemptError && cause.invocationSubmitted;
      const historicalCause = preserveChatHubSubmissionHistory(cause, invocationSubmitted);
      if (Date.now() >= deadlineAt) {
        if (historicalCause instanceof ChatHubAttemptError) throw historicalCause;
        throw new ChatHubAttemptError(new Error("CHAT_DEADLINE_EXCEEDED"), invocationSubmitted);
      }
      last = historicalCause;
      if (
        signal.aborted
        || emitted
        || semanticStarted
        || invocationSubmitted
        || attempt === 1
        || Date.now() >= deadlineAt
        || !mayRetryUnseenChatHubFailure(cause, emitted || semanticStarted || invocationSubmitted)
      ) throw historicalCause;
      if (cause instanceof ChatHubAttemptError && cause.invocationSubmitted) {
        attemptRequest = {
          ...boundedRequest,
          conversationId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          started: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw last;
}
