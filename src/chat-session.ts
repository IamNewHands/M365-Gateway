import { DurableObject } from "cloudflare:workers";
import {
  chatHub,
  chatHubInvocationWasSubmitted,
  isTerminalEmptyQuotaFailure,
  type ChatHubRelay,
  type ChatHubRequest,
  type ChatHubResult,
} from "./chathub";
import { decodeTaskAnchors, encodeTaskAnchors, mergeTaskAnchors, type TaskAnchor } from "./task-anchors";
import { R2ArchiveQueue, R2_ARCHIVE_MIN_SESSION_SIGNAL_BYTES } from "./r2-archive";
import type { Env, OAuthTokenSet } from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
// A response branch is an internal, per-request working copy. It is normally
// deleted as soon as its child response alias has been admitted; this short
// fallback TTL bounds storage if the Worker disappears mid-turn.
const RESPONSE_BRANCH_TTL_MS = 60 * 60_000;
// A newly written alias is deliberately invisible while its cross-object
// registry admission is pending. If the caller disappears during that RPC,
// the pending row expires quickly instead of becoming uncounted seven-day
// state.
const RESPONSE_ALIAS_PENDING_TTL_MS = 15 * 60_000;
// Increment only when an upstream prompt/tool protocol must not inherit an
// older Microsoft ChatHub conversation.  Existing Durable Object rows are
// rolled onto fresh upstream coordinates once while portable caller context,
// pending results and the replay ledger remain intact.
const CURRENT_UPSTREAM_PROTOCOL_GENERATION = "native-tools-v3-disconnect-supersession";
/**
 * A response id is a branch point, not a durable user thread. Keep a useful
 * continuation window without allowing an agent loop to create objects for a
 * month. The effective retention window is the newest 64 aliases in one
 * upstream conversation, for at most seven days.
 */
export const RESPONSE_ALIAS_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_RESPONSE_ALIASES_PER_UPSTREAM = 64;
export const MAX_RESPONSE_ALIASES_TOTAL = 512;
export const MAX_CHAT_SESSION_STATE_BYTES = 192 * 1_024;
export const MAX_RESPONSE_ALIAS_STATE_BYTES_TOTAL = MAX_RESPONSE_ALIASES_TOTAL * MAX_CHAT_SESSION_STATE_BYTES;
export const MAX_PORTABLE_SESSION_BYTES = 64 * 1_024;
const MAX_TOOL_LEDGER_SNAPSHOT_BYTES = 64 * 1_024;
const MAX_PENDING_TOOL_ARGUMENT_BYTES = 96 * 1_024;
const MAX_UPSTREAM_ID_BYTES = 4 * 1_024;
const MAX_ACCOUNT_ID_BYTES = 1 * 1_024;
const MAX_TOOL_ID_BYTES = 4 * 1_024;
const MAX_TOOL_NAME_BYTES = 1 * 1_024;
// Caller tool schemas are non-secret capability metadata. Retain a bounded
// copy in the session DO so an account rebind/compaction can restore the
// caller runtime instead of making the model claim local tools are absent.
export const MAX_CALLER_TOOLS_SNAPSHOT_BYTES = 64 * 1_024;
// A completed result can contain up to the full bounded ChatHub output. Two
// entries are enough for duplicate delivery/idempotency while avoiding the
// previous multi-copy memory spike that could terminate the isolate (1102).
const MAX_COMPLETED_CHAT_RUNS_IN_MEMORY = 2;
// Lease ids, row-kind markers, integer columns and serialization framing are
// covered by this reserve so the 192 KiB cap is not merely the sum of user
// supplied text columns.
const PERSISTED_STATE_METADATA_RESERVE_BYTES = 1 * 1_024;
export const RESPONSE_ALIAS_REGISTRY_NAME = "__m365_internal_response_alias_registry_v1__";
const CHAT_HUB_RUNNER_PREFIX = "__m365_internal_chathub_runner_v1__:";
// The lease starts before an account gate can queue for up to two minutes and
// before a ChatHub exchange can run for up to ten minutes. Keep a safety margin
// so a legitimate long first turn can never be stolen by a second request.
const CHAT_LEASE_MS = 15 * 60_000;

export function validateToolLedgerSnapshot(toolLedgerSnapshot: string): string {
  if (utf8Bytes(toolLedgerSnapshot) > MAX_TOOL_LEDGER_SNAPSHOT_BYTES) throw new Error("TOOL_LEDGER_SNAPSHOT_TOO_LARGE");
  try {
    if (!Array.isArray(JSON.parse(toolLedgerSnapshot))) throw new Error("invalid snapshot");
  } catch {
    throw new Error("INVALID_TOOL_LEDGER_SNAPSHOT");
  }
  return toolLedgerSnapshot;
}

export interface PortableSessionState {
  taskAnchors: TaskAnchor[];
  /**
   * Opaque, client-protocol context retained from the most recent turns. It is
   * deliberately a bounded suffix of complete framed turns: when the budget
   * is exhausted, the newest call/result/user items survive and stale history
   * falls off the front without cutting a turn in the middle.
   */
  protocolTail: string;
}

export interface PortableSessionUpdate {
  taskAnchors?: TaskAnchor[];
  protocolTail?: string;
  /** Optional sanitized tool evidence. It is persisted only by terminal
   * commits; provisional/split-phase completions keep the existing snapshot. */
  toolLedgerSnapshot?: string;
}

export interface FinalPortableSessionUpdate extends PortableSessionUpdate {
  protocolTail: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
// Keep this framing token in the storage layer as well as the prompt renderer
// so the persisted byte cap cannot cut through the newest logical turn.
const PORTABLE_TURN_SEPARATOR = "\n\u001eM365_PORTABLE_TURN_V1\u001f\n";

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function boundedField(value: string, maximumBytes: number, code: string): string {
  if (utf8Bytes(value) > maximumBytes) throw new Error(code);
  return value;
}

interface PersistedSessionFields {
  conversationId: string;
  sessionId: string;
  accountId: string;
  pendingCallId: string;
  pendingToolName: string;
  pendingToolArguments: string;
  toolLedgerSnapshot: string;
  aliasGeneration?: string;
  aliasGroupId?: string;
}

function validatePersistedFields(fields: PersistedSessionFields): PersistedSessionFields {
  boundedField(fields.conversationId, MAX_UPSTREAM_ID_BYTES, "CONVERSATION_ID_TOO_LARGE");
  boundedField(fields.sessionId, MAX_UPSTREAM_ID_BYTES, "SESSION_ID_TOO_LARGE");
  boundedField(fields.accountId, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
  boundedField(fields.pendingCallId, MAX_TOOL_ID_BYTES, "PENDING_CALL_ID_TOO_LARGE");
  boundedField(fields.pendingToolName, MAX_TOOL_NAME_BYTES, "PENDING_TOOL_NAME_TOO_LARGE");
  boundedField(fields.pendingToolArguments, MAX_PENDING_TOOL_ARGUMENT_BYTES, "PENDING_TOOL_ARGUMENTS_TOO_LARGE");
  validateToolLedgerSnapshot(fields.toolLedgerSnapshot);
  if (fields.aliasGeneration) boundedField(fields.aliasGeneration, 128, "ALIAS_GENERATION_TOO_LARGE");
  if (fields.aliasGroupId) boundedField(fields.aliasGroupId, 128, "ALIAS_GROUP_TOO_LARGE");
  return fields;
}

function persistedFieldBytes(fields: PersistedSessionFields): number {
  return utf8Bytes(fields.conversationId)
    + utf8Bytes(fields.sessionId)
    + utf8Bytes(fields.accountId)
    + utf8Bytes(fields.pendingCallId)
    + utf8Bytes(fields.pendingToolName)
    + utf8Bytes(fields.pendingToolArguments)
    + utf8Bytes(fields.toolLedgerSnapshot)
    + utf8Bytes(fields.aliasGeneration ?? "")
    + utf8Bytes(fields.aliasGroupId ?? "");
}

/** Apply both the portable-state cap and the aggregate persisted-row cap. */
function boundPortableForPersistedFields(
  fields: PersistedSessionFields,
  taskAnchors: ReadonlyArray<TaskAnchor> | undefined,
  protocolTail: string | null | undefined,
): PortableSessionState {
  validatePersistedFields(fields);
  const anchors = decodeTaskAnchors(encodeTaskAnchors(taskAnchors));
  const encodedAnchors = encodeTaskAnchors(anchors);
  const anchorBytes = utf8Bytes(encodedAnchors);
  const nonPortableBytes = persistedFieldBytes(fields);
  const portableBudget = Math.min(
    MAX_PORTABLE_SESSION_BYTES,
    MAX_CHAT_SESSION_STATE_BYTES - PERSISTED_STATE_METADATA_RESERVE_BYTES - nonPortableBytes,
  );
  if (portableBudget < anchorBytes) throw new Error("CHAT_SESSION_STATE_TOO_LARGE");
  return {
    taskAnchors: anchors,
    protocolTail: boundedPortableProtocolSuffix(
      typeof protocolTail === "string" ? protocolTail : "",
      portableBudget - anchorBytes,
    ),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8Encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function responseAliasGroup(accountId: string, conversationId: string): Promise<string> {
  return `upstream_${await sha256(`${accountId}\u0000${conversationId}`)}`;
}

interface ResponseAliasRegistration {
  aliasId: string;
  generation: string;
  groupId: string;
  expiresAt: number;
}

type ResponseAliasRegistryAdmissionResult =
  | { ok: true }
  | { ok: false; code: string };

export type ResponseAliasAdmissionResult =
  | { ok: true; generation: string; expiresAt: number }
  | { ok: false; code: string };

interface RegisteredAliasRow {
  [key: string]: SqlStorageValue;
  alias_id: string;
  generation: string;
  group_id: string;
  sequence: number;
  expires_at: number;
}

/** Keep the newest UTF-8 suffix without ever beginning inside a code point. */
export function boundedUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1;
  return start < encoded.byteLength ? utf8Decoder.decode(encoded.subarray(start)) : "";
}

/** Keep a UTF-8 prefix without ending inside a code point. */
function boundedUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = Math.min(encoded.byteLength, Math.trunc(maxBytes));
  // A bounded prefix can end after a multi-byte lead byte. Back up until the
  // fatal decoder accepts a complete sequence; this handles both a one-byte
  // ASCII boundary and every UTF-8 width without manufacturing U+FFFD.
  while (end > 0) {
    try {
      return utf8Decoder.decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function portableTurnIsComplete(value: string): boolean {
  const turn = value.trim();
  if (!turn || !turn.startsWith("[")) return false;
  return /(?:^|\n)\[ASSISTANT(?: TOOL CALL[^\]]*)?\]/u.test(turn)
    && /(?:^|\n)\[(?:USER|TURN|SYSTEM|DEVELOPER|INTERNAL TASK REFERENCES)\]/u.test(turn);
}

const OVERSIZED_PORTABLE_TURN_MARKER = "[OVERSIZED PORTABLE TURN CONTENT OMITTED]";

/**
 * Keep a structurally complete representation when one newest turn is larger
 * than the entire portable budget. The request prefix normally contains the
 * task/path anchor; only the oversized body is replaced.
 */
function compactOversizedPortableTurn(turn: string, maxBytes: number): string {
  const value = turn.trim();
  const requestMatch = /(?:^|\n)\[(?:USER|TURN|SYSTEM|DEVELOPER|INTERNAL TASK REFERENCES)\]/u.exec(value);
  const assistantMatch = /(?:^|\n)\[ASSISTANT(?: TOOL CALL[^\]]*)?\]/u.exec(value);
  if (!requestMatch || !assistantMatch || assistantMatch.index <= requestMatch.index) return "";
  const requestStart = requestMatch.index + (requestMatch[0].startsWith("\n") ? 1 : 0);
  const assistantHeader = assistantMatch[0].trimStart();
  const request = value.slice(requestStart, assistantMatch.index).trimEnd();
  const suffix = `\n\n${assistantHeader}\n${OVERSIZED_PORTABLE_TURN_MARKER}`;
  const available = maxBytes - utf8Bytes(suffix);
  if (available <= 0) return "";
  const prefix = boundedUtf8Prefix(request, available).trimEnd();
  const compacted = `${prefix}${suffix}`;
  return utf8Bytes(compacted) <= maxBytes ? compacted : "";
}

/**
 * Bound portable history by whole framed turns. A raw UTF-8 suffix can begin
 * halfway through the newest `[USER]` or `[ASSISTANT]` section; restoration
 * then discards that newest task and a long-running agent appears to forget
 * what it was doing. Unframed legacy text keeps the code-point-safe behavior.
 */
export function boundedPortableProtocolSuffix(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  const rawTurns = value.includes(PORTABLE_TURN_SEPARATOR)
    ? value.split(PORTABLE_TURN_SEPARATOR)
    : [value];
  const hasFramedTurn = rawTurns.some((turn) => portableTurnIsComplete(turn));
  if (!hasFramedTurn) return boundedUtf8Suffix(value, maxBytes);

  const selected: string[] = [];
  let selectedBytes = 0;
  for (let index = rawTurns.length - 1; index >= 0; index -= 1) {
    const turn = rawTurns[index].trim();
    if (!portableTurnIsComplete(turn)) continue;
    const separatorBytes = selected.length > 0 ? utf8Bytes(PORTABLE_TURN_SEPARATOR) : 0;
    const turnBytes = utf8Bytes(turn);
    if (turnBytes + separatorBytes + selectedBytes <= maxBytes) {
      selected.unshift(turn);
      selectedBytes += turnBytes + separatorBytes;
      continue;
    }
    // If the newest complete turn alone is too large, retain a compact,
    // structurally valid checkpoint for that turn rather than stale history.
    if (selected.length === 0) return compactOversizedPortableTurn(turn, maxBytes);
    break;
  }
  return selected.join(PORTABLE_TURN_SEPARATOR);
}

/**
 * Task anchors have their own strict count/value bounds. They are budgeted
 * first, then the remaining bytes retain the newest protocol history. The
 * persisted representation therefore never exceeds 64 KiB in aggregate.
 */
export function boundPortableSessionState(
  taskAnchors: ReadonlyArray<TaskAnchor> | undefined,
  protocolTail: string | null | undefined,
): PortableSessionState {
  const anchors = decodeTaskAnchors(encodeTaskAnchors(taskAnchors));
  const encodedAnchors = encodeTaskAnchors(anchors);
  const anchorBytes = utf8Bytes(encodedAnchors);
  if (anchorBytes > MAX_PORTABLE_SESSION_BYTES) throw new Error("PORTABLE_TASK_ANCHORS_TOO_LARGE");
  return {
    taskAnchors: anchors,
    protocolTail: boundedPortableProtocolSuffix(
      typeof protocolTail === "string" ? protocolTail : "",
      MAX_PORTABLE_SESSION_BYTES - anchorBytes,
    ),
  };
}

export function portableSessionByteLength(state: PortableSessionState): number {
  return utf8Bytes(encodeTaskAnchors(state.taskAnchors)) + utf8Bytes(state.protocolTail);
}

export interface ChatLease {
  leaseId: string;
  conversationId: string;
  sessionId: string;
  accountId: string;
  accountLocked: boolean;
  started: boolean;
  pendingCallId: string;
  pendingToolName: string;
  pendingToolArguments: string;
  toolLedgerSnapshot: string;
  taskAnchors: TaskAnchor[];
  portableProtocolTail: string;
  /** Last sanitized caller-tool manifest, used only to recover a client
   * runtime declaration when a continuation omits `tools`. */
  callerToolsSnapshot?: string;
  /** Registry lineage inherited by a Responses branch. Child aliases retain
   * this group so fresh upstream coordinates cannot bypass the per-lineage
   * alias cap. */
  responseAliasGroupId?: string;
}

export type ChatLeaseAcquisitionResult =
  | { ok: true; lease: ChatLease }
  | { ok: false; code: string };

export type ResponseAliasCheckoutResult =
  | { ok: true; snapshot: ResponseAliasSnapshot | null }
  | { ok: false; code: string };

/** Immutable portable state checked out from a ready Responses alias. Upstream
 * conversation/session coordinates are intentionally absent: every branch
 * starts on fresh coordinates and restores only caller-visible protocol state. */
export interface ResponseAliasSnapshot {
  pendingCallId: string;
  pendingToolName: string;
  pendingToolArguments: string;
  toolLedgerSnapshot: string;
  taskAnchors: TaskAnchor[];
  portableProtocolTail: string;
  responseAliasGroupId: string;
}

export interface ChatTurnCheckpoint {
  pendingCallId: string;
  pendingToolName: string;
  pendingToolArguments: string;
  toolLedgerSnapshot: string;
  portableProtocolTail: string;
}

/** Self-contained, caller-visible state embedded in an encrypted Responses
 * compaction capsule. It deliberately excludes Microsoft conversation ids,
 * account ids and access tokens: a recovered task starts on fresh upstream
 * coordinates while retaining only its local-tool ledger and bounded task
 * context. */
export interface ChatCompactionCheckpoint extends ChatTurnCheckpoint {
  taskAnchors: TaskAnchor[];
  callerToolsSnapshot?: string;
}

export interface SupersededUpstreamRun {
  accountId: string;
  gateLeaseId: string;
  runId: string;
}

export interface SupersededChatLease {
  lease: ChatLease;
  upstream: SupersededUpstreamRun | null;
}

export type DurableChatHubRequest = Omit<ChatHubRequest, "signal"> & { runId: string };

export type DurableChatHubOutcome =
  | { ok: true; result: ChatHubResult }
  | {
      ok: false;
      failure: {
        message: string;
        invocationSubmitted: boolean;
        terminalEmptyQuota: boolean;
      };
    };

export class ChatSession extends DurableObject<Env> {
  private readonly r2Archive: R2ArchiveQueue;
  private readonly activeChatRuns = new Map<string, {
    controller: AbortController;
    outcome: Promise<DurableChatHubOutcome>;
    settled: Promise<void>;
  }>();
  private readonly completedChatRuns = new Map<string, DurableChatHubOutcome>();
  private readonly cancelledChatRuns = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.r2Archive = new R2ArchiveQueue(ctx, env, ctx.id.toString());
    ctx.blockConcurrencyWhile(async () => {
      this.initializeStateSchema();
      this.r2Archive.initializeSchema();
    });
  }

  private initializeStateSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(state)").toArray().map((column) => column.name));
    if (!columns.has("pending_call_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN pending_call_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("pending_tool_name")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN pending_tool_name TEXT NOT NULL DEFAULT ''");
    if (!columns.has("pending_tool_arguments")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN pending_tool_arguments TEXT NOT NULL DEFAULT ''");
    if (!columns.has("tool_ledger_snapshot")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN tool_ledger_snapshot TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("committed")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN committed INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("completed_lease_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN completed_lease_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("account_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("account_locked")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN account_locked INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("task_anchors")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN task_anchors TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("portable_protocol_tail")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN portable_protocol_tail TEXT NOT NULL DEFAULT ''");
    if (!columns.has("record_kind")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'stable'");
    if (!columns.has("alias_generation")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN alias_generation TEXT NOT NULL DEFAULT ''");
    if (!columns.has("alias_group_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN alias_group_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("alias_expires_at")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN alias_expires_at INTEGER NOT NULL DEFAULT 0");
    // Fail closed for rows created by an interrupted legacy seed. The client
    // protocol generation is bumped alongside this migration, so old aliases
    // are not made reachable merely because they predate admission fencing.
    if (!columns.has("alias_admitted")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN alias_admitted INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("upstream_protocol_generation")) {
      this.ctx.storage.sql.exec(`ALTER TABLE state ADD COLUMN upstream_protocol_generation TEXT NOT NULL DEFAULT '${CURRENT_UPSTREAM_PROTOCOL_GENERATION}'`);
      // Rows that existed before this column were created may still point at
      // a ChatHub conversation taught the retired textual command codec.
      this.ctx.storage.sql.exec("UPDATE state SET upstream_protocol_generation='legacy-text-tool-codec' WHERE singleton=1");
    }
    if (!columns.has("active_upstream_run_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN active_upstream_run_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("active_upstream_gate_lease_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN active_upstream_gate_lease_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("active_upstream_account_id")) this.ctx.storage.sql.exec("ALTER TABLE state ADD COLUMN active_upstream_account_id TEXT NOT NULL DEFAULT ''");
    // Only the well-known registry object inserts the singleton meta row or
    // alias rows. Creating the empty schema everywhere keeps migrations simple
    // while stable sessions remain completely absent from alias eviction.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS alias_registry_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        next_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alias_registry (
        alias_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL,
        group_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alias_registry_group_sequence
      ON alias_registry(group_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS alias_registry_expiry
      ON alias_registry(expires_at);
    `);
  }

  async rememberCallerTools(leaseId: string, toolsSnapshot: string): Promise<void> {
    boundedField(leaseId, MAX_UPSTREAM_ID_BYTES, "LEASE_ID_TOO_LARGE");
    boundedField(toolsSnapshot, MAX_CALLER_TOOLS_SNAPSHOT_BYTES, "CALLER_TOOLS_SNAPSHOT_TOO_LARGE");
    try {
      if (!Array.isArray(JSON.parse(toolsSnapshot))) throw new Error("invalid snapshot");
    } catch {
      throw new Error("INVALID_CALLER_TOOLS_SNAPSHOT");
    }
    const row = this.ctx.storage.sql.exec<{ lease_id: string }>(
      "SELECT lease_id FROM state WHERE singleton=1",
    ).toArray()[0];
    if (!row || row.lease_id !== leaseId) throw new Error("STALE_CONVERSATION_LEASE");
    await this.ctx.storage.put("caller_tools_snapshot", toolsSnapshot);
  }

  /**
   * Queue a privacy-filtered cold copy only after a hot SQLite mutation has
   * succeeded. The archive is never consulted by request routing; it is an
   * optional recovery/diagnostic aid when an R2 binding is configured.
   */
  private queueCurrentR2Archive(reason: string): void {
    if (!this.env.R2_ARCHIVE) return;
    try {
      const row = this.ctx.storage.sql.exec<{
        updated_at: number;
        committed: number;
        record_kind: string;
        task_anchors: string;
        portable_protocol_tail: string;
        tool_ledger_snapshot: string;
      }>(
        `SELECT updated_at,committed,record_kind,task_anchors,
         portable_protocol_tail,tool_ledger_snapshot FROM state WHERE singleton=1`,
      ).toArray()[0];
      if (!row) return;
      const signalBytes = new TextEncoder().encode(
        `${row.task_anchors}\n${row.portable_protocol_tail}\n${row.tool_ledger_snapshot}`,
      ).byteLength;
      // Normal short completions do not need a cold object. Keep checkpoints
      // and upstream failures even when their payload is small, because those
      // are the states operators may need to recover after a disconnect.
      const exceptional = /checkpoint|failure|abandon/iu.test(reason);
      if (signalBytes < R2_ARCHIVE_MIN_SESSION_SIGNAL_BYTES && !exceptional) return;
      this.r2Archive.enqueue("session", {
        revision: row.updated_at,
        committed: Boolean(row.committed),
        recordKind: row.record_kind,
        taskAnchors: decodeTaskAnchors(row.task_anchors),
        protocolTail: row.portable_protocol_tail,
        toolLedgerSnapshot: row.tool_ledger_snapshot,
        reason,
      });
    } catch {
      // Cold archival is strictly best-effort; a malformed/temporarily
      // unavailable archive read must not turn a committed hot transition
      // into a user-visible request failure.
      console.error(JSON.stringify({ event: "r2_archive_snapshot_unavailable" }));
    }
  }

  /**
   * Run the CPU-heavy Microsoft WebSocket protocol inside a Durable Object.
   * The public Worker remains a thin compatibility/SSE adapter and therefore
   * no longer accumulates ChatHub frame parsing against the Free-plan Worker
   * request CPU allowance. Callers use one named runner per account so the
   * existing account gate and the DO execution order agree.
   */
  async runChatHub(
    account: OAuthTokenSet,
    request: DurableChatHubRequest,
    relay?: ChatHubRelay,
  ): Promise<DurableChatHubOutcome> {
    const { runId, ...chatRequest } = request;
    if (!/^[0-9a-f-]{36}$/iu.test(runId)) {
      return { ok: false, failure: { message: "INVALID_CHAT_RUN_ID", invocationSubmitted: false, terminalEmptyQuota: false } };
    }
    const completed = this.completedChatRuns.get(runId);
    if (completed) return completed;
    if (this.cancelledChatRuns.delete(runId)) {
      return { ok: false, failure: { message: "REQUEST_ABORTED", invocationSubmitted: false, terminalEmptyQuota: false } };
    }
    const existing = this.activeChatRuns.get(runId);
    if (existing) return existing.outcome;
    const controller = new AbortController();
    // Publish the in-flight promise before ChatHub starts. Durable Object RPC
    // delivery can be retried with the same runId; a duplicate must join the
    // original result rather than return CHAT_RUN_ALREADY_ACTIVE or submit a
    // second Microsoft invocation.
    const outcome = Promise.resolve().then(async (): Promise<DurableChatHubOutcome> => {
      try {
        return { ok: true, result: await chatHub(account, { ...chatRequest, signal: controller.signal }, undefined, relay) };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "UNKNOWN_CHAT_ERROR";
        return {
          ok: false,
          failure: {
            message: message.slice(0, 2_048),
            invocationSubmitted: chatHubInvocationWasSubmitted(cause),
            terminalEmptyQuota: isTerminalEmptyQuotaFailure(cause),
          },
        };
      }
    });
    const settled = outcome.then(() => undefined, () => undefined);
    this.activeChatRuns.set(runId, { controller, outcome, settled });
    try {
      const completedOutcome = await outcome;
      this.completedChatRuns.set(runId, completedOutcome);
      while (this.completedChatRuns.size > MAX_COMPLETED_CHAT_RUNS_IN_MEMORY) {
        const oldest = this.completedChatRuns.keys().next().value as string | undefined;
        if (!oldest) break;
        this.completedChatRuns.delete(oldest);
      }
      return completedOutcome;
    } finally {
      if (this.activeChatRuns.get(runId)?.outcome === outcome) this.activeChatRuns.delete(runId);
    }
  }

  /** Cancel an outbound ChatHub WebSocket without waiting for its hard deadline. */
  async cancelChatHub(runId: string): Promise<"cancelled" | "queued" | "invalid"> {
    if (!/^[0-9a-f-]{36}$/iu.test(runId)) return "invalid";
    const active = this.activeChatRuns.get(runId);
    if (active) {
      active.controller.abort();
      await active.settled;
      return "cancelled";
    }
    // The exact run already settled. Treat cancellation as confirmed so its
    // caller may release the matching account gate without installing a
    // pre-cancel marker that would overwrite an idempotent late RPC replay.
    if (this.completedChatRuns.has(runId)) return "cancelled";
    // RPCs sent through the same stub are ordered, but retain a small bounded
    // pre-cancel fence for runtimes that deliver cancellation before startup.
    this.cancelledChatRuns.add(runId);
    while (this.cancelledChatRuns.size > 128) {
      const oldest = this.cancelledChatRuns.values().next().value as string | undefined;
      if (!oldest) break;
      this.cancelledChatRuns.delete(oldest);
    }
    return "queued";
  }

  async isChatHubRunActive(runId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/iu.test(runId)) return false;
    return this.activeChatRuns.has(runId);
  }

  private responseAliasRegistry(): DurableObjectStub<ChatSession> {
    return this.env.CHATS.getByName(RESPONSE_ALIAS_REGISTRY_NAME);
  }

  private async armRegistryAlarm(now: number): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ expires_at: number }>(
      "SELECT MIN(expires_at) AS expires_at FROM alias_registry",
    ).toArray()[0]?.expires_at;
    if (Number.isFinite(next)) await this.setAlarmAt(Math.max(now + 60_000, next));
    else await this.deleteAlarmIfNoPendingArchive();
  }

  private unregisterRegistryRow(aliasId: string, generation: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM alias_registry WHERE alias_id=? AND generation=?",
      aliasId,
      generation,
    );
  }

  /**
   * Strongly ordered alias admission. All response-alias objects rendezvous at
   * one internal ChatSession instance, so concurrent Workers cannot race a KV
   * read/modify/write and admit more than the configured bounds.
  */
  async registerResponseAlias(registration: ResponseAliasRegistration): Promise<ResponseAliasRegistryAdmissionResult> {
    // An exception escaping blockConcurrencyWhile breaks and resets the
    // registry object's input gate. Capture the admission failure inside the
    // gate, then reject the individual RPC normally after serialization ends.
    let failure: unknown;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.registerResponseAliasLocked(registration);
      } catch (cause) {
        failure = cause;
      }
    });
    if (failure !== undefined) {
      return {
        ok: false,
        code: failure instanceof Error ? failure.message : "RESPONSE_ALIAS_REGISTRY_FAILURE",
      };
    }
    return { ok: true };
  }

  private async registerResponseAliasLocked(registration: ResponseAliasRegistration): Promise<void> {
    const now = Date.now();
    boundedField(registration.aliasId, 256, "ALIAS_ID_TOO_LARGE");
    boundedField(registration.generation, 128, "ALIAS_GENERATION_TOO_LARGE");
    boundedField(registration.groupId, 128, "ALIAS_GROUP_TOO_LARGE");
    if (!registration.aliasId || !registration.generation || !registration.groupId || registration.expiresAt <= now) {
      throw new Error("INVALID_ALIAS_REGISTRATION");
    }

    const existing = this.ctx.storage.sql.exec<RegisteredAliasRow>(
      "SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry WHERE alias_id=?",
      registration.aliasId,
    ).toArray()[0];
    if (existing && existing.expires_at > now) {
      if (existing.generation !== registration.generation || existing.group_id !== registration.groupId) {
        throw new Error("ALIAS_REGISTRY_GENERATION_CONFLICT");
      }
      // An RPC response can be lost after admission committed. Retrying the
      // same generation must not allocate a new sequence, rerun eviction or
      // make a later rollback delete the already-admitted row.
      await this.armRegistryAlarm(now);
      return;
    }
    if (existing) this.unregisterRegistryRow(existing.alias_id, existing.generation);

    const meta = this.ctx.storage.sql.exec<{ next_sequence: number }>(
      "SELECT next_sequence FROM alias_registry_meta WHERE singleton=1",
    ).toArray()[0];
    const sequence = (meta?.next_sequence ?? 0) + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO alias_registry_meta(singleton,next_sequence) VALUES(1,?)
       ON CONFLICT(singleton) DO UPDATE SET next_sequence=excluded.next_sequence`,
      sequence,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO alias_registry(alias_id,generation,group_id,sequence,expires_at)
       VALUES(?,?,?,?,?)`,
      registration.aliasId,
      registration.generation,
      registration.groupId,
      sequence,
      registration.expiresAt,
    );

    const victims = new Map<string, RegisteredAliasRow>();
    const addVictims = (rows: RegisteredAliasRow[]): void => {
      for (const row of rows) victims.set(`${row.alias_id}\u0000${row.generation}`, row);
    };
    addVictims(this.ctx.storage.sql.exec<RegisteredAliasRow>(
      "SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry WHERE expires_at<=?",
      now,
    ).toArray());
    addVictims(this.ctx.storage.sql.exec<RegisteredAliasRow>(
      `SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry
       WHERE group_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?`,
      registration.groupId,
      MAX_RESPONSE_ALIASES_PER_UPSTREAM,
    ).toArray());
    addVictims(this.ctx.storage.sql.exec<RegisteredAliasRow>(
      `SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry
       ORDER BY sequence DESC LIMIT -1 OFFSET ?`,
      MAX_RESPONSE_ALIASES_TOTAL,
    ).toArray());

    try {
      for (const victim of victims.values()) {
        if (victim.alias_id === registration.aliasId && victim.generation === registration.generation) {
          throw new Error("ALIAS_REGISTRY_CAPACITY_EXCEEDED");
        }
        const target = this.env.CHATS.get(this.env.CHATS.idFromString(victim.alias_id));
        const result = await target.evictResponseAlias(victim.generation);
        if (result === "busy") throw new Error("ALIAS_REGISTRY_VICTIM_BUSY");
        this.unregisterRegistryRow(victim.alias_id, victim.generation);
      }
      await this.armRegistryAlarm(now);
    } catch (cause) {
      // Admission is fail-closed. If an active old alias cannot be evicted, the
      // just-created alias is removed by seed() and is not returned to clients.
      this.unregisterRegistryRow(registration.aliasId, registration.generation);
      await this.armRegistryAlarm(now);
      throw cause;
    }
  }

  async unregisterResponseAlias(aliasId: string, generation: string): Promise<void> {
    this.unregisterRegistryRow(aliasId, generation);
    await this.armRegistryAlarm(Date.now());
  }

  async responseAliasRegistryStats(): Promise<{
    aliases: number;
    groups: number;
    maximumAliases: number;
    maximumAliasesPerUpstream: number;
    maximumPayloadBytes: number;
  }> {
    const row = this.ctx.storage.sql.exec<{ aliases: number; groups: number }>(
      "SELECT COUNT(*) AS aliases,COUNT(DISTINCT group_id) AS groups FROM alias_registry",
    ).toArray()[0] ?? { aliases: 0, groups: 0 };
    return {
      aliases: row.aliases,
      groups: row.groups,
      maximumAliases: MAX_RESPONSE_ALIASES_TOTAL,
      maximumAliasesPerUpstream: MAX_RESPONSE_ALIASES_PER_UPSTREAM,
      maximumPayloadBytes: MAX_RESPONSE_ALIAS_STATE_BYTES_TOTAL,
    };
  }

  async responseAliasGroupCount(accountId: string, conversationId: string): Promise<number> {
    boundedField(accountId, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    boundedField(conversationId, MAX_UPSTREAM_ID_BYTES, "CONVERSATION_ID_TOO_LARGE");
    const groupId = await responseAliasGroup(accountId, conversationId);
    return this.ctx.storage.sql.exec<{ aliases: number }>(
      "SELECT COUNT(*) AS aliases FROM alias_registry WHERE group_id=?",
      groupId,
    ).toArray()[0]?.aliases ?? 0;
  }

  /** Registry-only, generation-fenced eviction. */
  async evictResponseAlias(generation: string): Promise<"evicted" | "absent" | "generation_mismatch" | "busy"> {
    const row = this.ctx.storage.sql.exec<{ record_kind: string; alias_generation: string; lease_until: number }>(
      "SELECT record_kind,alias_generation,lease_until FROM state WHERE singleton=1",
    ).toArray()[0];
    if (!row) return "absent";
    if (row.record_kind !== "alias" || row.alias_generation !== generation) return "generation_mismatch";
    if (row.lease_until > Date.now()) return "busy";
    this.ctx.storage.sql.exec(
      "DELETE FROM state WHERE singleton=1 AND record_kind='alias' AND alias_generation=?",
      generation,
    );
    await this.clearStateStorage();
    return "evicted";
  }

  private stateExpiry(row: { record_kind?: string; alias_expires_at?: number; updated_at: number }): number {
    if (row.record_kind === "alias" && Number(row.alias_expires_at) > 0) return Number(row.alias_expires_at);
    if (row.record_kind === "response_work") return row.updated_at + RESPONSE_BRANCH_TTL_MS;
    return row.updated_at + SESSION_TTL_MS;
  }

  private stateAlarmAt(row: { record_kind?: string; alias_expires_at?: number } | undefined, now: number): number {
    if (row?.record_kind === "alias" && Number(row.alias_expires_at) > 0) return Number(row.alias_expires_at);
    return now + (row?.record_kind === "response_work" ? RESPONSE_BRANCH_TTL_MS : SESSION_TTL_MS);
  }

  /**
   * ChatSession and the optional R2 outbox share one Durable Object alarm.
   * Delegate scheduling so the earliest future deadline (TTL or archive
   * retry) always wins. With no R2 binding this is the same direct setAlarm
   * operation used before the cold-archive feature existed.
   */
  private async setAlarmAt(deadline: number): Promise<void> {
    await this.r2Archive.scheduleAlarmAt(deadline);
  }

  private async deleteAlarmIfNoPendingArchive(): Promise<void> {
    await this.r2Archive.deleteAlarmIfNoPendingArchive();
  }

  /**
   * `deleteAll()` is intentionally delayed while an encrypted cold copy is
   * waiting in the outbox: SQLite hot state may be gone, but the archive row
   * still needs its alarm/retry metadata. If the queue is empty, clear the
   * whole DO as before and recreate both schemas for this still-live object.
   */
  private async clearStateStorage(): Promise<void> {
    // A waitUntil archive may still be between encryption and its SQLite
    // outbox insert. Drain that tiny window before deciding whether deleteAll
    // is safe; otherwise deleteAll could remove the queue table underneath it.
    await this.r2Archive.drainPendingWrites();
    if (await this.r2Archive.hasPendingArchive()) {
      this.initializeStateSchema();
      await this.r2Archive.scheduleAlarmAt(null);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.initializeStateSchema();
    this.r2Archive.onStorageCleared();
  }

  private async deleteCurrentState(row: { record_kind?: string; alias_generation?: string }): Promise<void> {
    const aliasId = this.ctx.id.toString();
    const generation = row.record_kind === "alias" ? row.alias_generation ?? "" : "";
    this.ctx.storage.sql.exec("DELETE FROM state WHERE singleton=1");
    await this.clearStateStorage();
    if (generation) {
      try {
        await this.responseAliasRegistry().unregisterResponseAlias(aliasId, generation);
      } catch {
        // The registry's own expiry sweep is authoritative and will remove a
        // stale row even if this best-effort reverse notification is lost.
      }
    }
  }

  async acquire(): Promise<ChatLease> {
    const lease = await this.acquireInternal(false);
    if (!lease) throw new Error("CONVERSATION_STATE_UNAVAILABLE");
    return lease;
  }

  /** Expected contention must not escape a Durable Object RPC as an uncaught
   * exception: Cloudflare records that as a red runtime error even when the
   * Worker catches it and successfully supersedes the older request. */
  async tryAcquire(): Promise<ChatLeaseAcquisitionResult> {
    try {
      const lease = await this.acquireInternal(false);
      return lease ? { ok: true, lease } : { ok: false, code: "CONVERSATION_STATE_UNAVAILABLE" };
    } catch (cause) {
      return {
        ok: false,
        code: cause instanceof Error ? cause.message : "CONVERSATION_ACQUIRE_FAILED",
      };
    }
  }

  /** Return an immutable, portable snapshot of an admitted response alias.
   * This method never installs a lease, refreshes TTL, or exposes upstream
   * coordinates. Multiple callers can therefore branch from the same response
   * concurrently without superseding or mutating one another. */
  async checkoutResponseAlias(): Promise<ResponseAliasSnapshot | null> {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string; session_id: string; account_id: string;
      lease_until: number; pending_call_id: string; pending_tool_name: string;
      pending_tool_arguments: string; tool_ledger_snapshot: string;
      task_anchors: string; portable_protocol_tail: string; record_kind: string;
      alias_generation: string; alias_group_id: string; alias_expires_at: number;
      alias_admitted: number; updated_at: number;
    }>(
      `SELECT conversation_id,session_id,account_id,lease_until,pending_call_id,
       pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,
       portable_protocol_tail,record_kind,alias_generation,alias_group_id,
       alias_expires_at,alias_admitted,updated_at FROM state WHERE singleton=1`,
    ).toArray()[0];
    if (!row || row.record_kind !== "alias") return null;
    if (row.lease_until > now) throw new Error("CONVERSATION_BUSY");
    if (this.stateExpiry(row) <= now || !row.alias_group_id) return null;
    // A function terminal frame may reach the client just before the outer SSE
    // delivery boundary publishes this staged alias. Treat that short window as
    // contention so continuation waits for publish/revoke instead of returning
    // a false 404 for an ID the client has already observed.
    if (!row.alias_admitted) throw new Error("CONVERSATION_BUSY");
    boundedField(row.alias_group_id, 128, "ALIAS_GROUP_TOO_LARGE");
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: row.account_id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    return {
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
      responseAliasGroupId: row.alias_group_id,
    };
  }

  /** Read the latest durable task checkpoint without acquiring a lease or
   * extending its lifetime. /responses/compact uses this to make its opaque
   * capsule self-contained instead of assuming this Durable Object will be
   * the only surviving copy of long-task progress. */
  async compactionCheckpoint(): Promise<ChatCompactionCheckpoint | null> {
    const storedCallerTools = await this.ctx.storage.get<string>("caller_tools_snapshot");
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string; session_id: string; account_id: string;
      pending_call_id: string; pending_tool_name: string;
      pending_tool_arguments: string; tool_ledger_snapshot: string;
      task_anchors: string; portable_protocol_tail: string;
      alias_generation: string; alias_group_id: string;
    }>(
      `SELECT conversation_id,session_id,account_id,pending_call_id,
       pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,
       task_anchors,portable_protocol_tail,alias_generation,alias_group_id
       FROM state WHERE singleton=1`,
    ).toArray()[0];
    if (!row) return null;
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: row.account_id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    return {
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
      callerToolsSnapshot: typeof storedCallerTools === "string" ? storedCallerTools : undefined,
    };
  }

  async tryCheckoutResponseAlias(): Promise<ResponseAliasCheckoutResult> {
    try {
      return { ok: true, snapshot: await this.checkoutResponseAlias() };
    } catch (cause) {
      return {
        ok: false,
        code: cause instanceof Error ? cause.message : "RESPONSE_ALIAS_CHECKOUT_FAILED",
      };
    }
  }

  private async acquireInternal(existingAliasOnly: boolean): Promise<ChatLease | null> {
    const now = Date.now();
    const storedCallerTools = await this.ctx.storage.get<string>("caller_tools_snapshot");
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string;
      session_id: string;
      lease_id: string;
      lease_until: number;
      pending_call_id: string;
      pending_tool_name: string;
      pending_tool_arguments: string;
      tool_ledger_snapshot: string;
      committed: number;
      account_id: string;
      account_locked: number;
      task_anchors: string;
      portable_protocol_tail: string;
      record_kind: string;
      alias_generation: string;
      alias_group_id: string;
      alias_expires_at: number;
      alias_admitted: number;
      upstream_protocol_generation: string;
      updated_at: number;
    }>("SELECT conversation_id,session_id,lease_id,lease_until,pending_call_id,pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,committed,account_id,account_locked,task_anchors,portable_protocol_tail,record_kind,alias_generation,alias_group_id,alias_expires_at,alias_admitted,upstream_protocol_generation,updated_at FROM state WHERE singleton=1").toArray()[0];
    // An active alias remains owned by its lease even if its nominal seven-day
    // expiry is crossed during that turn. Never delete active state (and its
    // upstream runner/gate identity) before applying the busy fence.
    if (row && row.lease_until > now) {
      throw new Error("CONVERSATION_BUSY");
    }
    if (row?.record_kind === "alias") throw new Error("RESPONSE_ALIAS_REQUIRES_CHECKOUT");
    if (row && this.stateExpiry(row) <= now) {
      await this.deleteCurrentState(row);
      return this.acquireInternal(false);
    }
    if (row && row.upstream_protocol_generation !== CURRENT_UPSTREAM_PROTOCOL_GENERATION) {
      const rollover = this.ctx.storage.sql.exec(
        `UPDATE state SET conversation_id=?,session_id=?,committed=0,
         completed_lease_id='',lease_id='',lease_until=0,
         active_upstream_run_id='',active_upstream_gate_lease_id='',
         active_upstream_account_id='',
         upstream_protocol_generation=?,updated_at=?
         WHERE singleton=1`,
        crypto.randomUUID(),
        crypto.randomUUID(),
        CURRENT_UPSTREAM_PROTOCOL_GENERATION,
        now,
      );
      if (rollover.rowsWritten !== 1) throw new Error("UPSTREAM_PROTOCOL_ROLLOVER_CONFLICT");
      return this.acquireInternal(existingAliasOnly);
    }
    const continueCommitted = Boolean(row?.committed);
    const portable = boundPortableForPersistedFields({
      conversationId: row?.conversation_id ?? "",
      sessionId: row?.session_id ?? "",
      accountId: row?.account_id ?? "",
      pendingCallId: row?.pending_call_id ?? "",
      pendingToolName: row?.pending_tool_name ?? "",
      pendingToolArguments: row?.pending_tool_arguments ?? "",
      toolLedgerSnapshot: row?.tool_ledger_snapshot ?? "[]",
      aliasGeneration: row?.alias_generation ?? "",
      aliasGroupId: row?.alias_group_id ?? "",
    },
      decodeTaskAnchors(row?.task_anchors),
      row?.portable_protocol_tail,
    );
    // Repair an oversized or pre-normalization row in place. New writes are
    // already bounded; this prevents legacy/corrupt state from escaping the
    // same memory budget merely because it was read rather than overwritten.
    if (row && (
      row.task_anchors !== encodeTaskAnchors(portable.taskAnchors)
      || row.portable_protocol_tail !== portable.protocolTail
    )) {
      this.ctx.storage.sql.exec(
        "UPDATE state SET task_anchors=?,portable_protocol_tail=? WHERE singleton=1",
        encodeTaskAnchors(portable.taskAnchors),
        portable.protocolTail,
      );
    }
    const lease: ChatLease = {
      leaseId: crypto.randomUUID(),
      conversationId: continueCommitted ? row.conversation_id : crypto.randomUUID(),
      sessionId: continueCommitted ? row.session_id : crypto.randomUUID(),
      accountId: continueCommitted || Boolean(row?.account_locked) ? row.account_id : "",
      accountLocked: Boolean(row?.account_locked),
      started: continueCommitted,
      // An account rebind intentionally makes the upstream coordinates
      // uncommitted while retaining a pending call and its replay ledger. An
      // ordinary abandonment clears those fields explicitly below.
      pendingCallId: row?.pending_call_id ?? "",
      pendingToolName: row?.pending_tool_name ?? "",
      pendingToolArguments: row?.pending_tool_arguments ?? "",
      toolLedgerSnapshot: row?.tool_ledger_snapshot ?? "[]",
      // Task references are safe, bounded user identifiers rather than
      // upstream conversation state. Preserve them across an abandoned turn
      // so a retry can still remember the original project target.
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
      callerToolsSnapshot: typeof storedCallerTools === "string" ? storedCallerTools : undefined,
      responseAliasGroupId: row?.alias_group_id || undefined,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO state(singleton,conversation_id,session_id,account_id,account_locked,lease_id,lease_until,updated_at)
       VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
       conversation_id=excluded.conversation_id,session_id=excluded.session_id,
       account_id=excluded.account_id,account_locked=excluded.account_locked,
       lease_id=excluded.lease_id,lease_until=excluded.lease_until,
       completed_lease_id='',active_upstream_run_id='',
       active_upstream_gate_lease_id='',active_upstream_account_id='',
       updated_at=excluded.updated_at`,
      lease.conversationId,
      lease.sessionId,
      lease.accountId,
      lease.accountLocked ? 1 : 0,
      lease.leaseId,
      now + CHAT_LEASE_MS,
      now,
    );
    await this.setAlarmAt(this.stateAlarmAt(row, now));
    return lease;
  }

  /** Materialize one private working session from an immutable response alias.
   * Fresh upstream coordinates make parallel branches independent; only the
   * bounded caller-visible protocol state and replay ledger cross the branch
   * boundary. */
  async startResponseBranch(snapshot: ResponseAliasSnapshot): Promise<ChatLease> {
    const now = Date.now();
    const existing = this.ctx.storage.sql.exec<{
      record_kind: string; lease_until: number; alias_expires_at: number; updated_at: number;
    }>(
      "SELECT record_kind,lease_until,alias_expires_at,updated_at FROM state WHERE singleton=1",
    ).toArray()[0];
    if (existing) {
      if (existing.lease_until > now || this.stateExpiry(existing) > now) {
        throw new Error("RESPONSE_BRANCH_COLLISION");
      }
      await this.deleteCurrentState(existing);
    }

    boundedField(snapshot.responseAliasGroupId, 128, "ALIAS_GROUP_TOO_LARGE");
    if (!snapshot.responseAliasGroupId) throw new Error("RESPONSE_ALIAS_GROUP_REQUIRED");
    const conversationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const leaseId = crypto.randomUUID();
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: "",
      pendingCallId: snapshot.pendingCallId,
      pendingToolName: snapshot.pendingToolName,
      pendingToolArguments: snapshot.pendingToolArguments,
      toolLedgerSnapshot: snapshot.toolLedgerSnapshot,
      aliasGroupId: snapshot.responseAliasGroupId,
    }, snapshot.taskAnchors, snapshot.portableProtocolTail);
    this.ctx.storage.sql.exec(
      `INSERT INTO state(singleton,conversation_id,session_id,account_id,account_locked,
       lease_id,lease_until,updated_at,pending_call_id,pending_tool_name,
       pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,
       committed,record_kind,alias_generation,alias_group_id,alias_expires_at,
       alias_admitted,upstream_protocol_generation)
       VALUES(1,?,?,'',0,?,?,?,?,?,?,?,?,?,0,'response_work','',?,0,0,?)`,
      conversationId,
      sessionId,
      leaseId,
      now + CHAT_LEASE_MS,
      now,
      snapshot.pendingCallId,
      snapshot.pendingToolName,
      snapshot.pendingToolArguments,
      snapshot.toolLedgerSnapshot,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      snapshot.responseAliasGroupId,
      CURRENT_UPSTREAM_PROTOCOL_GENERATION,
    );
    await this.setAlarmAt(now + RESPONSE_BRANCH_TTL_MS);
    return {
      leaseId,
      conversationId,
      sessionId,
      accountId: "",
      accountLocked: false,
      started: false,
      pendingCallId: snapshot.pendingCallId,
      pendingToolName: snapshot.pendingToolName,
      pendingToolArguments: snapshot.pendingToolArguments,
      toolLedgerSnapshot: snapshot.toolLedgerSnapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
      responseAliasGroupId: snapshot.responseAliasGroupId,
    };
  }

  /** Delete a successfully completed private branch after its child alias is
   * admitted. The completed lease id is the fence against deleting unrelated
   * or still-active state if a key collision ever occurs. */
  async discardResponseBranch(completedLeaseId: string): Promise<boolean> {
    boundedField(completedLeaseId, MAX_UPSTREAM_ID_BYTES, "LEASE_ID_TOO_LARGE");
    const result = this.ctx.storage.sql.exec(
      `DELETE FROM state WHERE singleton=1 AND record_kind='response_work'
       AND lease_id='' AND completed_lease_id=?`,
      completedLeaseId,
    );
    if (result.rowsWritten !== 1) return false;
    await this.clearStateStorage();
    return true;
  }

  /** Persist the exact runner and account-gate identities owned by this turn.
   * A later request can then cancel only this abandoned run after a client
   * disconnect, instead of waiting for the 15-minute safety lease or clearing
   * an unrelated account gate. */
  async markUpstreamRun(
    leaseId: string,
    accountId: string,
    gateLeaseId: string,
    runId: string,
  ): Promise<boolean> {
    boundedField(leaseId, MAX_UPSTREAM_ID_BYTES, "LEASE_ID_TOO_LARGE");
    boundedField(accountId, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    boundedField(gateLeaseId, MAX_UPSTREAM_ID_BYTES, "UPSTREAM_GATE_LEASE_ID_TOO_LARGE");
    boundedField(runId, MAX_UPSTREAM_ID_BYTES, "CHAT_RUN_ID_TOO_LARGE");
    if (!leaseId || !accountId || !gateLeaseId || !runId) throw new Error("UPSTREAM_RUN_IDENTITY_REQUIRED");
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET active_upstream_run_id=?,active_upstream_gate_lease_id=?,
       active_upstream_account_id=?,updated_at=? WHERE singleton=1 AND lease_id=? AND account_id=?`,
      runId,
      gateLeaseId,
      accountId,
      Date.now(),
      leaseId,
      accountId,
    );
    return result.rowsWritten === 1;
  }

  async clearUpstreamRun(leaseId: string, runId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE state SET active_upstream_run_id='',active_upstream_gate_lease_id='',
       active_upstream_account_id='',updated_at=?
       WHERE singleton=1 AND lease_id=? AND active_upstream_run_id=?`,
      Date.now(),
      leaseId,
      runId,
    );
  }

  /** Replace an active lease after the short contention grace period. Callers
   * handling ordinary client retries must pass false: once Microsoft is
   * running a turn, cancelling it makes retrying SDKs repeatedly displace one
   * another and turns healthy work into an abort/502 loop. */
  async supersedeActive(allowRunningUpstream = true): Promise<SupersededChatLease | null> {
    const now = Date.now();
    const storedCallerTools = await this.ctx.storage.get<string>("caller_tools_snapshot");
    const row = this.ctx.storage.sql.exec<{
      lease_id: string;
      lease_until: number;
      account_id: string;
      account_locked: number;
      pending_call_id: string;
      pending_tool_name: string;
      pending_tool_arguments: string;
      tool_ledger_snapshot: string;
      task_anchors: string;
      portable_protocol_tail: string;
      record_kind: string;
      alias_generation: string;
      alias_group_id: string;
      alias_expires_at: number;
      active_upstream_run_id: string;
      active_upstream_gate_lease_id: string;
      active_upstream_account_id: string;
    }>(
      `SELECT lease_id,lease_until,account_id,account_locked,pending_call_id,
       pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,
       portable_protocol_tail,record_kind,alias_generation,alias_group_id,
       alias_expires_at,active_upstream_run_id,active_upstream_gate_lease_id,
       active_upstream_account_id FROM state
       WHERE singleton=1 AND lease_id<>'' AND lease_until>?`,
      now,
    ).toArray()[0];
    if (!row) return null;
    let hasRunningUpstream = Boolean(
      row.active_upstream_run_id
      && row.active_upstream_gate_lease_id
      && row.active_upstream_account_id,
    );
    if (hasRunningUpstream && !allowRunningUpstream) {
      const runner = this.env.CHATS.getByName(`${CHAT_HUB_RUNNER_PREFIX}${row.active_upstream_account_id}`);
      try {
        hasRunningUpstream = await runner.isChatHubRunActive(row.active_upstream_run_id);
      } catch {
        // Preserve the busy fence when runner state cannot be verified.
        return null;
      }
    }
    if (hasRunningUpstream && !allowRunningUpstream) return null;
    const portable = boundPortableForPersistedFields({
      conversationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      accountId: row.account_locked ? row.account_id : "",
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    const lease: ChatLease = {
      leaseId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      accountId: row.account_locked ? row.account_id : "",
      accountLocked: Boolean(row.account_locked),
      started: false,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
      callerToolsSnapshot: typeof storedCallerTools === "string" ? storedCallerTools : undefined,
    };
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET conversation_id=?,session_id=?,account_id=?,
       lease_id=?,lease_until=?,completed_lease_id='',committed=0,
       active_upstream_run_id='',active_upstream_gate_lease_id='',
       active_upstream_account_id='',upstream_protocol_generation=?,updated_at=?
       WHERE singleton=1 AND lease_id=? AND lease_until>?`,
      lease.conversationId,
      lease.sessionId,
      lease.accountId,
      lease.leaseId,
      now + CHAT_LEASE_MS,
      CURRENT_UPSTREAM_PROTOCOL_GENERATION,
      now,
      row.lease_id,
      now,
    );
    if (result.rowsWritten !== 1) return null;
    await this.setAlarmAt(this.stateAlarmAt(row, now));
    const upstream = hasRunningUpstream
      ? {
          runId: row.active_upstream_run_id,
          gateLeaseId: row.active_upstream_gate_lease_id,
          accountId: row.active_upstream_account_id,
        }
      : null;
    return { lease, upstream };
  }

  async bindAccount(leaseId: string, accountId: string): Promise<ChatLease> {
    const id = accountId.trim();
    if (!id) throw new Error("ACCOUNT_ID_REQUIRED");
    boundedField(id, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string;
      session_id: string;
      account_id: string;
      account_locked: number;
      committed: number;
      pending_call_id: string;
      pending_tool_name: string;
      pending_tool_arguments: string;
      tool_ledger_snapshot: string;
      task_anchors: string;
      portable_protocol_tail: string;
      alias_generation: string;
      alias_group_id: string;
    }>(
      "SELECT conversation_id,session_id,account_id,account_locked,committed,pending_call_id,pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,alias_generation,alias_group_id FROM state WHERE singleton=1 AND lease_id=?",
      leaseId,
    ).toArray()[0];
    if (!row) throw new Error("STALE_CONVERSATION_LEASE");
    if (row.account_id && row.account_id !== id) throw new Error("SESSION_ACCOUNT_MISMATCH");
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    this.ctx.storage.sql.exec(
      "UPDATE state SET account_id=?,task_anchors=?,portable_protocol_tail=?,updated_at=? WHERE singleton=1 AND lease_id=?",
      id,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
    );
    return {
      leaseId,
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: id,
      accountLocked: Boolean(row.account_locked),
      started: Boolean(row.committed),
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
    };
  }

  async switchUncommittedAccount(leaseId: string, expectedAccountId: string, nextAccountId: string): Promise<ChatLease> {
    const next = nextAccountId.trim();
    if (!next) throw new Error("ACCOUNT_ID_REQUIRED");
    boundedField(next, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    const row = this.ctx.storage.sql.exec<{ pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string; tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string; alias_generation: string; alias_group_id: string }>(
      "SELECT pending_call_id,pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,alias_generation,alias_group_id FROM state WHERE singleton=1 AND lease_id=? AND account_id=? AND committed=0 AND account_locked=0",
      leaseId,
      expectedAccountId,
    ).toArray()[0];
    if (!row) throw new Error("SESSION_ACCOUNT_LOCKED");
    const conversationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: next,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    this.ctx.storage.sql.exec(
      "UPDATE state SET conversation_id=?,session_id=?,account_id=?,task_anchors=?,portable_protocol_tail=?,updated_at=? WHERE singleton=1 AND lease_id=? AND account_id=? AND committed=0 AND account_locked=0",
      conversationId,
      sessionId,
      next,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
      expectedAccountId,
    );
    return {
      leaseId,
      conversationId,
      sessionId,
      accountId: next,
      accountLocked: false,
      started: false,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
    };
  }

  /**
   * Atomically detach a portable logical session from an inactive account.
   * Microsoft conversation/session coordinates are account-specific and are
   * therefore always regenerated. Credential-scoped portable context,
   * pending-call state and the non-replay ledger survive. The conditional
   * update is also the stale-epoch fence: after it succeeds, a lease still
   * carrying expectedOldAccountId cannot commit or bind that account again.
   * Every account migration requires a non-empty portable tail. This includes
   * committed legacy rows: upstream coordinates alone are account-bound and
   * cannot reconstruct client-visible context after a route change.
   */
  async rebindCommittedAccount(
    leaseId: string,
    expectedOldAccountId: string,
    newActiveAccountId: string,
  ): Promise<ChatLease> {
    const expectedOld = expectedOldAccountId.trim();
    const next = newActiveAccountId.trim();
    if (!expectedOld || !next) throw new Error("ACCOUNT_ID_REQUIRED");
    if (expectedOld === next) throw new Error("ACCOUNT_REBIND_TARGET_UNCHANGED");
    boundedField(expectedOld, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    boundedField(next, MAX_ACCOUNT_ID_BYTES, "ACCOUNT_ID_TOO_LARGE");
    const row = this.ctx.storage.sql.exec<{
      pending_call_id: string;
      pending_tool_name: string;
      pending_tool_arguments: string;
      tool_ledger_snapshot: string;
      task_anchors: string;
      portable_protocol_tail: string;
      alias_generation: string;
      alias_group_id: string;
    }>(
      `SELECT pending_call_id,pending_tool_name,pending_tool_arguments,
       tool_ledger_snapshot,task_anchors,portable_protocol_tail,alias_generation,alias_group_id
       FROM state WHERE singleton=1 AND lease_id=? AND account_id=?
       AND account_locked=1 AND portable_protocol_tail<>''`,
      leaseId,
      expectedOld,
    ).toArray()[0];
    if (!row) throw new Error("SESSION_ACCOUNT_REBIND_MISMATCH");

    const conversationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: next,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), row.portable_protocol_tail);
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET conversation_id=?,session_id=?,account_id=?,
       committed=0,account_locked=0,completed_lease_id='',task_anchors=?,portable_protocol_tail=?,updated_at=?
       WHERE singleton=1 AND lease_id=? AND account_id=?
        AND account_locked=1 AND portable_protocol_tail<>''`,
      conversationId,
      sessionId,
      next,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
      expectedOld,
    );
    if (result.rowsWritten !== 1) throw new Error("SESSION_ACCOUNT_REBIND_MISMATCH");
    return {
      leaseId,
      conversationId,
      sessionId,
      accountId: next,
      accountLocked: false,
      started: false,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      taskAnchors: portable.taskAnchors,
      portableProtocolTail: portable.protocolTail,
    };
  }

  async mergeTaskAnchors(leaseId: string, anchors: TaskAnchor[]): Promise<TaskAnchor[]> {
    const row = this.ctx.storage.sql.exec<{
      conversation_id: string; session_id: string; account_id: string;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string;
      alias_generation: string; alias_group_id: string;
    }>(
      `SELECT conversation_id,session_id,account_id,pending_call_id,pending_tool_name,
       pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,
       alias_generation,alias_group_id FROM state WHERE singleton=1 AND lease_id=?`,
      leaseId,
    ).toArray()[0];
    if (!row) throw new Error("STALE_CONVERSATION_LEASE");
    const merged = mergeTaskAnchors(decodeTaskAnchors(row.task_anchors), anchors);
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: row.account_id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, merged, row.portable_protocol_tail);
    this.ctx.storage.sql.exec(
      "UPDATE state SET task_anchors=?,portable_protocol_tail=?,updated_at=? WHERE singleton=1 AND lease_id=?",
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      Date.now(),
      leaseId,
    );
    return portable.taskAnchors;
  }

  async markAccountLocked(leaseId: string, accountId: string): Promise<void> {
    const result = this.ctx.storage.sql.exec(
      "UPDATE state SET account_locked=1,updated_at=? WHERE singleton=1 AND lease_id=? AND account_id=?",
      Date.now(),
      leaseId,
      accountId,
    );
    if (result.rowsWritten !== 1) throw new Error("STALE_CONVERSATION_LEASE");
  }

  async complete(
    lease: ChatLease,
    conversationId: string,
    sessionId: string,
    portableUpdate?: PortableSessionUpdate,
  ): Promise<void> {
    await this.commitCompleted(lease, conversationId, sessionId, portableUpdate, false);
  }

  /**
   * Atomically commit upstream coordinates and the exact post-guard protocol
   * tail, then release the lease. Callers doing terminal-commit buffering must
   * use this method only after tool parsing/evidence validation succeeds; until
   * this single conditional UPDATE runs, acquire() continues to return busy.
   */
  async completeFinal(
    lease: ChatLease,
    conversationId: string,
    sessionId: string,
    portableUpdate: FinalPortableSessionUpdate,
  ): Promise<void> {
    await this.commitCompleted(lease, conversationId, sessionId, portableUpdate, true);
  }

  /**
   * Commit a downstream-visible answer while deliberately refusing to reuse
   * the Microsoft conversation that produced an invalid tool/refusal turn.
   * The caller can continue from the portable task/evidence state, but the
   * next upstream exchange starts on fresh coordinates. This is one atomic
   * state transition, so no contending request can observe polluted committed
   * coordinates between a normal completion and a later abandonment.
   */
  async completeCheckpoint(
    lease: ChatLease,
    portableUpdate: FinalPortableSessionUpdate,
    toolLedgerSnapshot: string,
  ): Promise<void> {
    validateToolLedgerSnapshot(toolLedgerSnapshot);
    const current = this.ctx.storage.sql.exec<{
      lease_id: string; account_id: string; task_anchors: string;
      record_kind: string; alias_generation: string; alias_group_id: string;
      alias_expires_at: number;
    }>(
      `SELECT lease_id,account_id,task_anchors,record_kind,alias_generation,
       alias_group_id,alias_expires_at FROM state WHERE singleton=1`,
    ).toArray()[0];
    if (!current || current.lease_id !== lease.leaseId) throw new Error("STALE_CONVERSATION_LEASE");
    if (!lease.accountId || current.account_id !== lease.accountId) throw new Error("SESSION_ACCOUNT_MISMATCH");
    if (typeof portableUpdate.protocolTail !== "string") throw new Error("FINAL_PROTOCOL_TAIL_REQUIRED");

    const conversationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const anchors = mergeTaskAnchors(decodeTaskAnchors(current.task_anchors), portableUpdate.taskAnchors);
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: current.account_id,
      pendingCallId: "",
      pendingToolName: "",
      pendingToolArguments: "",
      toolLedgerSnapshot,
      aliasGeneration: current.alias_generation,
      aliasGroupId: current.alias_group_id,
    }, anchors, portableUpdate.protocolTail);
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET conversation_id=?,session_id=?,lease_id='',lease_until=0,
       completed_lease_id=?,pending_call_id='',pending_tool_name='',pending_tool_arguments='',
       tool_ledger_snapshot=?,active_upstream_run_id='',active_upstream_gate_lease_id='',
       active_upstream_account_id='',task_anchors=?,portable_protocol_tail=?,
       committed=0,account_locked=1,updated_at=?
       WHERE singleton=1 AND lease_id=? AND account_id=?`,
      conversationId,
      sessionId,
      lease.leaseId,
      toolLedgerSnapshot,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      now,
      lease.leaseId,
      lease.accountId,
    );
    if (result.rowsWritten !== 1) throw new Error("STALE_CONVERSATION_LEASE");
    await this.setAlarmAt(this.stateAlarmAt(current, now));
    this.queueCurrentR2Archive("checkpoint_commit");
  }

  private async commitCompleted(
    lease: ChatLease,
    conversationId: string,
    sessionId: string,
    portableUpdate: PortableSessionUpdate | undefined,
    persistFinalTail: boolean,
  ): Promise<void> {
    const current = this.ctx.storage.sql.exec<{
      lease_id: string; account_id: string; pending_call_id: string; pending_tool_name: string;
      pending_tool_arguments: string; tool_ledger_snapshot: string; task_anchors: string;
      portable_protocol_tail: string; record_kind: string; alias_generation: string;
      alias_group_id: string; alias_expires_at: number;
    }>(
      `SELECT lease_id,account_id,pending_call_id,pending_tool_name,pending_tool_arguments,
       tool_ledger_snapshot,task_anchors,portable_protocol_tail,record_kind,
       alias_generation,alias_group_id,alias_expires_at FROM state WHERE singleton=1`,
    ).toArray()[0];
    if (!current || current.lease_id !== lease.leaseId) throw new Error("STALE_CONVERSATION_LEASE");
    if (!lease.accountId || current.account_id !== lease.accountId) throw new Error("SESSION_ACCOUNT_MISMATCH");
    boundedField(conversationId, MAX_UPSTREAM_ID_BYTES, "CONVERSATION_ID_TOO_LARGE");
    boundedField(sessionId, MAX_UPSTREAM_ID_BYTES, "SESSION_ID_TOO_LARGE");
    const anchors = portableUpdate?.taskAnchors === undefined
      ? decodeTaskAnchors(current.task_anchors)
      : mergeTaskAnchors(decodeTaskAnchors(current.task_anchors), portableUpdate.taskAnchors);
    if (persistFinalTail && typeof portableUpdate?.protocolTail !== "string") {
      throw new Error("FINAL_PROTOCOL_TAIL_REQUIRED");
    }
    const nextToolLedgerSnapshot = persistFinalTail && portableUpdate?.toolLedgerSnapshot !== undefined
      ? validateToolLedgerSnapshot(portableUpdate.toolLedgerSnapshot)
      : current.tool_ledger_snapshot;
    const portable = boundPortableForPersistedFields({
      conversationId,
      sessionId,
      accountId: current.account_id,
      pendingCallId: "",
      pendingToolName: "",
      pendingToolArguments: "",
      toolLedgerSnapshot: nextToolLedgerSnapshot,
      aliasGeneration: current.alias_generation,
      aliasGroupId: current.alias_group_id,
    },
      anchors,
      persistFinalTail
        ? portableUpdate!.protocolTail
        // Legacy split-phase callers complete before function-call parsing and
        // completion-evidence guards know the downstream output. Never persist
        // their provisional text; the CAS method can promote a guarded tail.
        : current.portable_protocol_tail,
    );
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET conversation_id=?,session_id=?,lease_id='',lease_until=0,
       completed_lease_id=?,pending_call_id='',pending_tool_name='',pending_tool_arguments='',
       tool_ledger_snapshot=?,active_upstream_run_id='',active_upstream_gate_lease_id='',active_upstream_account_id='',
       task_anchors=?,portable_protocol_tail=?,committed=1,account_locked=1,updated_at=?
       WHERE singleton=1 AND lease_id=? AND account_id=?`,
      conversationId,
      sessionId,
      lease.leaseId,
      nextToolLedgerSnapshot,
      encodeTaskAnchors(portable.taskAnchors),
      portable.protocolTail,
      now,
      lease.leaseId,
      lease.accountId,
    );
    if (result.rowsWritten !== 1) throw new Error("STALE_CONVERSATION_LEASE");
    await this.setAlarmAt(this.stateAlarmAt(current, now));
    this.queueCurrentR2Archive(persistFinalTail ? "terminal_commit" : "split_phase_commit");
  }

  /**
   * Promote the exact downstream-visible, post-tool-guard output for legacy
   * split-phase callers. complete() deliberately retained the previous safe
   * tail. All four expected values form a CAS fence: a later acquire clears
   * completed_lease_id, while account rotation or a different upstream
   * completion changes the other coordinates and cannot be overwritten by a
   * late resolver. New terminal-commit callers should prefer completeFinal().
   */
  async replaceCompletedPortableProtocolTail(
    completedLeaseId: string,
    expectedAccountId: string,
    expectedConversationId: string,
    expectedSessionId: string,
    portableProtocolTail: string,
  ): Promise<void> {
    const row = this.ctx.storage.sql.exec<{
      account_id: string; conversation_id: string; session_id: string;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; record_kind: string;
      alias_generation: string; alias_group_id: string; alias_expires_at: number;
    }>(
      `SELECT account_id,conversation_id,session_id,pending_call_id,pending_tool_name,
       pending_tool_arguments,tool_ledger_snapshot,task_anchors,record_kind,
       alias_generation,alias_group_id,alias_expires_at FROM state
       WHERE singleton=1 AND completed_lease_id=? AND account_id=?
       AND conversation_id=? AND session_id=? AND committed=1 AND lease_id=''`,
      completedLeaseId,
      expectedAccountId,
      expectedConversationId,
      expectedSessionId,
    ).toArray()[0];
    if (!row) throw new Error("STALE_COMPLETED_CONVERSATION");
    const portable = boundPortableForPersistedFields({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      accountId: row.account_id,
      pendingCallId: row.pending_call_id,
      pendingToolName: row.pending_tool_name,
      pendingToolArguments: row.pending_tool_arguments,
      toolLedgerSnapshot: row.tool_ledger_snapshot,
      aliasGeneration: row.alias_generation,
      aliasGroupId: row.alias_group_id,
    }, decodeTaskAnchors(row.task_anchors), portableProtocolTail);
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET portable_protocol_tail=?,updated_at=?
       WHERE singleton=1 AND completed_lease_id=? AND account_id=?
       AND conversation_id=? AND session_id=? AND committed=1 AND lease_id=''`,
      portable.protocolTail,
      now,
      completedLeaseId,
      expectedAccountId,
      expectedConversationId,
      expectedSessionId,
    );
    if (result.rowsWritten !== 1) throw new Error("STALE_COMPLETED_CONVERSATION");
    await this.setAlarmAt(this.stateAlarmAt(row, now));
    this.queueCurrentR2Archive("portable_tail_promotion");
  }

  async release(leaseId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ record_kind: string; alias_expires_at: number }>(
      "SELECT record_kind,alias_expires_at FROM state WHERE singleton=1 AND lease_id=?",
      leaseId,
    ).toArray()[0];
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE state SET lease_id='',lease_until=0,active_upstream_run_id='',
       active_upstream_gate_lease_id='',active_upstream_account_id='',updated_at=?
       WHERE singleton=1 AND lease_id=?`,
      now,
      leaseId,
    );
    if (!row || result.rowsWritten !== 1) return;
    if (row.record_kind === "response_work") {
      await this.deleteCurrentState(row);
      return;
    }
    await this.setAlarmAt(this.stateAlarmAt(row, now));
  }

  /**
   * Roll back a turn when its terminal result was not safely delivered. This
   * legacy method intentionally also handles a completed_lease_id: buffered
   * callers that fail before returning a response must be allowed to retry
   * from their prior checkpoint. Streaming cancellation uses
   * abandonIfActive(), which has a stricter commit fence.
   */
  async abandon(leaseId: string, checkpoint?: ChatTurnCheckpoint): Promise<void> {
    await this.abandonTurn(leaseId, false, checkpoint);
  }

  /**
   * Cancellation fence for streaming callers. Only an active lease may be
   * rolled back; once completeFinal()/completeCheckpoint() has cleared
   * lease_id, a late transport disconnect must not erase the durable result
   * that the client can resume through its response alias.
   */
  async abandonIfActive(leaseId: string, checkpoint: ChatTurnCheckpoint): Promise<void> {
    await this.abandonTurn(leaseId, false, checkpoint, false, true);
  }

  /**
   * Abandon a turn after ChatHub accepted the invocation but failed before its
   * result could be committed safely. Never replay that invocation here. The
   * exact pre-submit checkpoint remains bound to the old account as a locked,
   * portable continuation; accountForLease may rebind that checkpoint on the
   * next client request if the active route has advanced. Fresh upstream
   * coordinates ensure the abandoned half-turn can never be continued.
   */
  async abandonFailedUpstream(leaseId: string, checkpoint: ChatTurnCheckpoint): Promise<void> {
    await this.abandonTurn(leaseId, false, checkpoint, true);
  }

  private async abandonTurn(
    leaseId: string,
    detachAccount: boolean,
    checkpoint?: ChatTurnCheckpoint,
    tombstoneUpstream = false,
    activeOnly = false,
  ): Promise<void> {
    const now = Date.now();
    const rowQuery = activeOnly
      ? `SELECT lease_id,completed_lease_id,record_kind,alias_expires_at,
       conversation_id,session_id,account_id,account_locked,task_anchors,
       alias_generation,alias_group_id FROM state
       WHERE singleton=1 AND lease_id=?`
      : `SELECT lease_id,completed_lease_id,record_kind,alias_expires_at,
       conversation_id,session_id,account_id,account_locked,task_anchors,
       alias_generation,alias_group_id FROM state
       WHERE singleton=1 AND (lease_id=? OR (lease_id='' AND completed_lease_id=?))`;
    const rowBindings = activeOnly ? [leaseId] : [leaseId, leaseId];
    const row = this.ctx.storage.sql.exec<{
      lease_id: string;
      completed_lease_id: string;
      record_kind: string;
      alias_expires_at: number;
      conversation_id: string;
      session_id: string;
      account_id: string;
      account_locked: number;
      task_anchors: string;
      alias_generation: string;
      alias_group_id: string;
    }>(rowQuery, ...rowBindings).toArray()[0];
    if (!row) return;

    const activeLease = row.lease_id === leaseId;
    const conversationId = tombstoneUpstream ? crypto.randomUUID() : row.conversation_id;
    const sessionId = tombstoneUpstream ? crypto.randomUUID() : row.session_id;
    const accountId = detachAccount ? "" : row.account_id;
    const accountLocked = detachAccount ? 0 : tombstoneUpstream ? 1 : row.account_locked;
    const restored = checkpoint
      ? boundPortableForPersistedFields({
          conversationId,
          sessionId,
          accountId,
          pendingCallId: checkpoint.pendingCallId,
          pendingToolName: checkpoint.pendingToolName,
          pendingToolArguments: checkpoint.pendingToolArguments,
          toolLedgerSnapshot: checkpoint.toolLedgerSnapshot,
          aliasGeneration: row.alias_generation,
          aliasGroupId: row.alias_group_id,
        }, decodeTaskAnchors(row.task_anchors), checkpoint.portableProtocolTail)
      : undefined;
    const pendingCallId = restored ? checkpoint!.pendingCallId : "";
    const pendingToolName = restored ? checkpoint!.pendingToolName : "";
    const pendingToolArguments = restored ? checkpoint!.pendingToolArguments : "";
    const toolLedgerSnapshot = restored ? checkpoint!.toolLedgerSnapshot : "[]";
    const portableProtocolTail = restored ? restored.protocolTail : "";
    const taskAnchors = restored ? encodeTaskAnchors(restored.taskAnchors) : row.task_anchors;
    const result = activeLease
      ? this.ctx.storage.sql.exec(
          `UPDATE state SET conversation_id=?,session_id=?,account_id=?,account_locked=?,
           lease_id='',lease_until=0,completed_lease_id='',committed=0,
           active_upstream_run_id='',active_upstream_gate_lease_id='',active_upstream_account_id='',
           pending_call_id=?,pending_tool_name=?,pending_tool_arguments=?,
           tool_ledger_snapshot=?,task_anchors=?,portable_protocol_tail=?,updated_at=?
           WHERE singleton=1 AND lease_id=?`,
          conversationId,
          sessionId,
          accountId,
          accountLocked,
          pendingCallId,
          pendingToolName,
          pendingToolArguments,
          toolLedgerSnapshot,
          taskAnchors,
          portableProtocolTail,
          now,
          leaseId,
        )
      : this.ctx.storage.sql.exec(
          `UPDATE state SET conversation_id=?,session_id=?,account_id=?,account_locked=?,
           lease_id='',lease_until=0,completed_lease_id='',committed=0,
           active_upstream_run_id='',active_upstream_gate_lease_id='',active_upstream_account_id='',
           pending_call_id=?,pending_tool_name=?,pending_tool_arguments=?,
           tool_ledger_snapshot=?,task_anchors=?,portable_protocol_tail=?,updated_at=?
           WHERE singleton=1 AND lease_id='' AND completed_lease_id=?`,
          conversationId,
          sessionId,
          accountId,
          accountLocked,
          pendingCallId,
          pendingToolName,
          pendingToolArguments,
          toolLedgerSnapshot,
          taskAnchors,
          portableProtocolTail,
          now,
          leaseId,
        );
    if (result.rowsWritten !== 1) return;
    if (row.record_kind === "response_work") {
      await this.deleteCurrentState(row);
      return;
    }
    await this.setAlarmAt(this.stateAlarmAt(row, now));
    this.queueCurrentR2Archive(tombstoneUpstream ? "upstream_failure_checkpoint" : "turn_abandoned");
  }

  async seed(conversationId: string, sessionId: string, accountId: string, pendingCallId = "", pendingToolName = "", pendingToolArguments = "", toolLedgerSnapshot = "[]", taskAnchors: TaskAnchor[] = [], portableProtocolTail = "", committed = true, inheritedGroupId = "", deferVisibility = false): Promise<ResponseAliasAdmissionResult> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) throw new Error("ACCOUNT_ID_REQUIRED");
    const inheritedGroup = inheritedGroupId.trim();
    if (inheritedGroup) boundedField(inheritedGroup, 128, "ALIAS_GROUP_TOO_LARGE");
    const generation = crypto.randomUUID();
    const groupId = inheritedGroup || await responseAliasGroup(normalizedAccountId, conversationId);
    const fields: PersistedSessionFields = {
      conversationId,
      sessionId,
      accountId: normalizedAccountId,
      pendingCallId,
      pendingToolName,
      pendingToolArguments,
      toolLedgerSnapshot,
      aliasGeneration: generation,
      aliasGroupId: groupId,
    };
    const portable = boundPortableForPersistedFields(fields, taskAnchors, portableProtocolTail);
    const encodedAnchors = encodeTaskAnchors(portable.taskAnchors);
    const now = Date.now();
    const expiresAt = now + RESPONSE_ALIAS_TTL_MS;
    const pendingExpiresAt = now + RESPONSE_ALIAS_PENDING_TTL_MS;

    let existing: {
      conversation_id: string; session_id: string; account_id: string; lease_until: number;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string;
      record_kind: string; alias_generation: string; alias_group_id: string;
      alias_expires_at: number; alias_admitted: number; updated_at: number; committed: number;
    } | undefined = this.ctx.storage.sql.exec<{
      conversation_id: string; session_id: string; account_id: string; lease_until: number;
      pending_call_id: string; pending_tool_name: string; pending_tool_arguments: string;
      tool_ledger_snapshot: string; task_anchors: string; portable_protocol_tail: string;
      record_kind: string; alias_generation: string; alias_group_id: string;
      alias_expires_at: number; alias_admitted: number; updated_at: number; committed: number;
    }>(
      `SELECT conversation_id,session_id,account_id,lease_until,pending_call_id,
       pending_tool_name,pending_tool_arguments,tool_ledger_snapshot,task_anchors,
       portable_protocol_tail,record_kind,alias_generation,alias_group_id,
       alias_expires_at,alias_admitted,updated_at,committed FROM state WHERE singleton=1`,
    ).toArray()[0];
    // A leased alias cannot be expired out from under an in-flight turn.
    if (existing && existing.lease_until > now) throw new Error("RESPONSE_ALIAS_BUSY");
    if (existing && this.stateExpiry(existing) <= now) {
      await this.deleteCurrentState(existing);
      existing = undefined;
    }
    if (existing) {
      if (existing.record_kind !== "alias") throw new Error("RESPONSE_ALIAS_KEY_COLLISION");
      const idempotent = existing.conversation_id === conversationId
        && existing.session_id === sessionId
        && existing.account_id === normalizedAccountId
        && existing.pending_call_id === pendingCallId
        && existing.pending_tool_name === pendingToolName
        && existing.pending_tool_arguments === pendingToolArguments
        && existing.tool_ledger_snapshot === toolLedgerSnapshot
        && existing.task_anchors === encodedAnchors
        && existing.portable_protocol_tail === portable.protocolTail
        && existing.alias_group_id === groupId
        && Boolean(existing.committed) === committed;
      if (!idempotent) throw new Error("RESPONSE_ALIAS_IMMUTABLE");
      const admissionExpiresAt = existing.alias_admitted ? existing.alias_expires_at : expiresAt;
      const registration = await this.responseAliasRegistry().registerResponseAlias({
          aliasId: this.ctx.id.toString(),
          generation: existing.alias_generation,
          groupId: existing.alias_group_id,
          expiresAt: admissionExpiresAt,
        });
      if (!registration.ok) {
        if (!existing.alias_admitted) await this.evictResponseAlias(existing.alias_generation);
        return registration;
      }
      if (!existing.alias_admitted && !deferVisibility) {
        const admitted = this.ctx.storage.sql.exec(
          `UPDATE state SET alias_admitted=1,alias_expires_at=?,updated_at=?
           WHERE singleton=1 AND record_kind='alias' AND alias_generation=?
           AND alias_admitted=0 AND lease_id=''`,
          admissionExpiresAt,
          Date.now(),
          existing.alias_generation,
        );
        if (admitted.rowsWritten !== 1) {
          await this.responseAliasRegistry().unregisterResponseAlias(this.ctx.id.toString(), existing.alias_generation);
          await this.evictResponseAlias(existing.alias_generation);
          return { ok: false, code: "RESPONSE_ALIAS_ADMISSION_CONFLICT" };
        }
      }
      await this.setAlarmAt(existing.alias_admitted || !deferVisibility ? admissionExpiresAt : existing.alias_expires_at);
      return {
        ok: true,
        generation: existing.alias_generation,
        expiresAt: admissionExpiresAt,
      };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO state(singleton,conversation_id,session_id,account_id,account_locked,
       lease_id,lease_until,updated_at,pending_call_id,pending_tool_name,
       pending_tool_arguments,tool_ledger_snapshot,task_anchors,portable_protocol_tail,
       committed,record_kind,alias_generation,alias_group_id,alias_expires_at,
       alias_admitted)
       VALUES(1,?,?,?,1,'',0,?,?,?,?,?,?,?,?, 'alias',?,?,?,0)`,
      conversationId,
      sessionId,
      normalizedAccountId,
      now,
      pendingCallId,
      pendingToolName,
      pendingToolArguments,
      toolLedgerSnapshot,
      encodedAnchors,
      portable.protocolTail,
      committed ? 1 : 0,
      generation,
      groupId,
      pendingExpiresAt,
    );
    await this.setAlarmAt(pendingExpiresAt);
    let registered = false;
    let staged = false;
    try {
      const registration = await this.responseAliasRegistry().registerResponseAlias({
        aliasId: this.ctx.id.toString(),
        generation,
        groupId,
        expiresAt,
      });
      if (!registration.ok) return registration;
      registered = true;
      if (deferVisibility) {
        staged = true;
        return { ok: true, generation, expiresAt };
      }
      const admitted = this.ctx.storage.sql.exec(
        `UPDATE state SET alias_admitted=1,alias_expires_at=?,updated_at=?
         WHERE singleton=1 AND record_kind='alias' AND alias_generation=?
         AND alias_admitted=0 AND lease_id=''`,
        expiresAt,
        Date.now(),
        generation,
      );
      if (admitted.rowsWritten !== 1) return { ok: false, code: "RESPONSE_ALIAS_ADMISSION_CONFLICT" };
      await this.setAlarmAt(expiresAt);
      return { ok: true, generation, expiresAt };
    } catch (cause) {
      if (registered) {
        try {
          await this.responseAliasRegistry().unregisterResponseAlias(this.ctx.id.toString(), generation);
        } catch { /* local generation fence still keeps the alias invisible */ }
      }
      await this.evictResponseAlias(generation);
      return {
        ok: false,
        code: cause instanceof Error ? cause.message : "RESPONSE_ALIAS_ADMISSION_FAILURE",
      };
    } finally {
      // A structured failure returned from inside the try must still remove
      // the invisible pending row and any registry entry it admitted.
      const current = this.ctx.storage.sql.exec<{ alias_generation: string; alias_admitted: number }>(
        "SELECT alias_generation,alias_admitted FROM state WHERE singleton=1 AND record_kind='alias'",
      ).toArray()[0];
      if (!staged && current?.alias_generation === generation && !current.alias_admitted) {
        if (registered) {
          try {
            await this.responseAliasRegistry().unregisterResponseAlias(this.ctx.id.toString(), generation);
          } catch { /* generation fence keeps unrelated aliases safe */ }
        }
        await this.evictResponseAlias(generation);
      }
    }
  }

  /** Make one registered staged alias visible. Both coordinates are supplied
   * by seed(), so a delayed publisher cannot expose a replacement generation. */
  async publishResponseAlias(generation: string, expiresAt: number): Promise<boolean> {
    boundedField(generation, 128, "ALIAS_GENERATION_TOO_LARGE");
    const now = Date.now();
    if (!generation || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
    const current = this.ctx.storage.sql.exec<{
      alias_generation: string; alias_admitted: number; alias_expires_at: number; lease_until: number;
    }>(
      `SELECT alias_generation,alias_admitted,alias_expires_at,lease_until FROM state
       WHERE singleton=1 AND record_kind='alias'`,
    ).toArray()[0];
    if (!current || current.alias_generation !== generation || current.lease_until > now) return false;
    if (current.alias_admitted) return true;
    const published = this.ctx.storage.sql.exec(
      `UPDATE state SET alias_admitted=1,alias_expires_at=?,updated_at=?
       WHERE singleton=1 AND record_kind='alias' AND alias_generation=?
       AND alias_admitted=0 AND lease_id=''`,
      expiresAt,
      now,
      generation,
    );
    if (published.rowsWritten !== 1) return false;
    await this.setAlarmAt(expiresAt);
    return true;
  }

  /** Roll back a staged or just-published alias without touching a newer value
   * stored under the same responseSessionKey. */
  async revokeResponseAlias(generation: string): Promise<"revoked" | "absent" | "generation_mismatch" | "busy"> {
    boundedField(generation, 128, "ALIAS_GENERATION_TOO_LARGE");
    const result = await this.evictResponseAlias(generation);
    try {
      await this.responseAliasRegistry().unregisterResponseAlias(this.ctx.id.toString(), generation);
    } catch {
      // Local generation-fenced eviction is the visibility boundary. A stale
      // registry row remains bounded and is removed by its normal expiry sweep.
    }
    return result === "evicted" ? "revoked" : result;
  }

  async alarm(): Promise<void> {
    // Flush the optional cold outbox before normal TTL handling. The flush is
    // serialized and failure-tolerant; it never changes the hot session state.
    await this.r2Archive.flush();
    const registry = this.ctx.storage.sql.exec<{ singleton: number }>(
      "SELECT singleton FROM alias_registry_meta WHERE singleton=1",
    ).toArray()[0];
    if (registry) {
      await this.ctx.blockConcurrencyWhile(() => this.expireRegisteredAliases(Date.now()));
      return;
    }
    await this.expireIfIdle(Date.now());
  }

  private async expireRegisteredAliases(now: number): Promise<void> {
    const expired = this.ctx.storage.sql.exec<RegisteredAliasRow>(
      "SELECT alias_id,generation,group_id,sequence,expires_at FROM alias_registry WHERE expires_at<=? ORDER BY sequence",
      now,
    ).toArray();
    for (const row of expired) {
      try {
        const target = this.env.CHATS.get(this.env.CHATS.idFromString(row.alias_id));
        const result = await target.evictResponseAlias(row.generation);
        if (result !== "busy") this.unregisterRegistryRow(row.alias_id, row.generation);
      } catch {
        // Keep the registry row and retry. Dropping it before the target is
        // confirmed gone would make the global hard bound an accounting lie.
      }
    }
    await this.armRegistryAlarm(now);
  }

  async expireIfIdle(now = Date.now()): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<{
      updated_at: number; lease_until: number; record_kind: string;
      alias_generation: string; alias_expires_at: number;
    }>(
      "SELECT updated_at,lease_until,record_kind,alias_generation,alias_expires_at FROM state WHERE singleton=1",
    ).toArray()[0];
    if (!row) {
      await this.clearStateStorage();
      return true;
    }
    const expiresAt = this.stateExpiry(row);
    if (row.lease_until > now) {
      await this.setAlarmAt(Math.max(row.lease_until, expiresAt));
      return false;
    }
    if (expiresAt > now) {
      // An older alarm can race a recently refreshed alias. Re-arm from the
      // persisted timestamp so that stale alarms never evict live context and
      // never accidentally consume the only future cleanup alarm.
      await this.setAlarmAt(expiresAt);
      return false;
    }
    await this.deleteCurrentState(row);
    return true;
  }
}
