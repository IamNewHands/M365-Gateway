import { decryptJSON, encryptJSON } from "./crypto";
import type { TaskAnchor } from "./task-anchors";
import type { Env } from "./types";

/**
 * R2 is deliberately a cold copy, never the source of truth for a request.
 * Durable Object SQLite commits the hot state first; this module only queues
 * an encrypted, bounded copy after that commit and retries it from an alarm.
 * A missing binding is a supported configuration (and is a complete no-op).
 */

export const R2_ARCHIVE_SCHEMA_VERSION = 1;
export const R2_ARCHIVE_MAX_QUEUE = 32;
export const R2_ARCHIVE_MAX_PAYLOAD_BYTES = 256 * 1_024;
export const R2_ARCHIVE_RETRY_MIN_MS = 1_000;
export const R2_ARCHIVE_RETRY_MAX_MS = 6 * 60 * 60_000;
export const R2_ARCHIVE_FLUSH_BATCH_SIZE = 2;
/**
 * Do not let one unavailable/malformed archive row block newer rows forever.
 * The SQLite hot state remains authoritative when a row is dropped.
 */
export const R2_ARCHIVE_MAX_ATTEMPTS = 8;
/** Durable Objects count setAlarm() as a storage write. Small clock drift does
 * not justify replacing an equivalent deadline and consuming another write.
 */
const R2_ARCHIVE_ALARM_TOLERANCE_MS = 500;
/** Avoid an R2 Class-A write for every tiny successful request. */
export const R2_ARCHIVE_MIN_SESSION_SIGNAL_BYTES = 4 * 1_024;

const MAX_PROTOCOL_TAIL_CHARACTERS = 96 * 1_024;
const MAX_ARCHIVE_REASON_CHARACTERS = 96;
const MAX_DIAGNOSTIC_CODE_CHARACTERS = 128;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export type R2ArchiveKind = "session" | "diagnostic" | "compaction";

export interface R2SessionArchiveInput {
  revision: number;
  committed: boolean;
  recordKind: string;
  taskAnchors: ReadonlyArray<TaskAnchor>;
  protocolTail: string;
  toolLedgerSnapshot: string;
  reason?: string;
}

export interface R2DiagnosticArchiveInput {
  revision: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  code: string;
  reason?: string;
}

export interface R2CompactionArchiveInput {
  revision: number;
  /** The already encrypted Responses compaction capsule. */
  encryptedContent: string;
  reason?: string;
}

export interface R2SessionArchiveEnvelope {
  version: typeof R2_ARCHIVE_SCHEMA_VERSION;
  kind: "session";
  recordedAt: string;
  revision: number;
  committed: boolean;
  recordKind: string;
  taskAnchors: TaskAnchor[];
  protocolTail: string;
  /** Metadata-only ledger; raw tool arguments/results are intentionally absent. */
  toolLedger: Array<{
    name: string;
    fingerprint: string;
    failed: boolean;
    completedCount: number;
    repeatedFailure: boolean;
    actions: string[];
  }>;
  reason: string;
}

export interface R2DiagnosticArchiveEnvelope {
  version: typeof R2_ARCHIVE_SCHEMA_VERSION;
  kind: "diagnostic";
  recordedAt: string;
  revision: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  code: string;
  reason: string;
}

export interface R2CompactionArchiveEnvelope {
  version: typeof R2_ARCHIVE_SCHEMA_VERSION;
  kind: "compaction";
  recordedAt: string;
  revision: number;
  /** Kept opaque; this value is encrypted and credential-bound by the API. */
  encryptedContent: string;
  reason: string;
}

export type R2ArchiveEnvelope = R2SessionArchiveEnvelope | R2DiagnosticArchiveEnvelope | R2CompactionArchiveEnvelope;

export interface R2ArchiveLatest {
  key: string;
  envelope: R2ArchiveEnvelope;
}

interface R2ArchiveQueueRow {
  [key: string]: SqlStorageValue;
  object_key: string;
  payload: string;
  kind: string;
  revision: number;
  attempt_count: number;
  next_attempt_at: number;
  created_at: number;
}

interface R2ArchiveManifestRow {
  [key: string]: SqlStorageValue;
  latest_key: string;
  latest_revision: number;
}

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

/** Keep a suffix without cutting through a UTF-8 code point. */
function boundedUtf8Suffix(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return "";
  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1;
  return start < encoded.byteLength ? utf8Decoder.decode(encoded.subarray(start)) : "";
}

function boundedText(value: unknown, maxCharacters: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, maxCharacters);
}

/**
 * Redact common credential forms before data is encrypted and sent to R2.
 * This is defense in depth: the hot state already has its own bounded storage
 * policy, and the archive intentionally excludes raw tool arguments/results.
 */
export function sanitizeR2ArchiveText(value: unknown, maxCharacters = MAX_PROTOCOL_TAIL_CHARACTERS): string {
  let text = boundedText(value, maxCharacters);
  if (!text) return "";
  text = text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(\bbearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|pwd|secret|private[_-]?key)\s*[:=]\s*)[^\s,;)}\]]+/giu, "$1[REDACTED]")
    .replace(/\b(?:sk|sk-ant|ghp|github_pat|m365|cfk)[_-][A-Za-z0-9_-]{12,}\b/giu, "[REDACTED]")
    .replace(/-----BEGIN [^\r\n-]{0,80}PRIVATE KEY-----[\s\S]*?-----END [^\r\n-]{0,80}PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]");
  return boundedUtf8Suffix(text, utf8ByteLength(text) > MAX_PROTOCOL_TAIL_CHARACTERS * 2 ? MAX_PROTOCOL_TAIL_CHARACTERS * 2 : Number.MAX_SAFE_INTEGER);
}

function safeIdentifier(value: unknown, fallback = "unknown", maximum = 160): string {
  const candidate = boundedText(value, maximum).trim();
  return /^[A-Za-z0-9_.:/@-]+$/u.test(candidate) ? candidate : fallback;
}

function safeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(9_999_999_999_999, Math.trunc(value)));
}

function safeStatus(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(999, Math.trunc(value)));
}

function safeDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(60 * 60_000, Math.trunc(value)));
}

function safeEncryptedContent(value: unknown): string {
  const candidate = boundedText(value, 192 * 1_024).trim();
  // `encryptJSON` emits base64url. Reject anything else instead of copying a
  // caller-controlled protocol fragment into the cold archive.
  return /^[A-Za-z0-9_-]+$/u.test(candidate) ? candidate : "";
}

function safeAnchors(value: ReadonlyArray<TaskAnchor>): TaskAnchor[] {
  const result: TaskAnchor[] = [];
  for (const anchor of value ?? []) {
    if (!anchor || !["windows_path", "unc_path", "unix_path", "url", "server"].includes(anchor.kind)) continue;
    const cleaned = sanitizeR2ArchiveText(anchor.value, 1_024);
    if (!cleaned) continue;
    // Query/fragment values are frequent credential carriers. Keep only the
    // stable URL origin/path in the cold copy.
    if (anchor.kind === "url") {
      try {
        const url = new URL(cleaned);
        if (!/^https?:$/u.test(url.protocol) || url.username || url.password) continue;
        url.search = "";
        url.hash = "";
        result.push({ kind: "url", value: url.toString().slice(0, 1_024) });
      } catch {
        continue;
      }
    } else {
      result.push({ kind: anchor.kind, value: cleaned.slice(0, 1_024) });
    }
    if (result.length >= 4) break;
  }
  return result;
}

function safeLedger(value: string): R2SessionArchiveEnvelope["toolLedger"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-128).flatMap((entry): R2SessionArchiveEnvelope["toolLedger"] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as Record<string, unknown>;
      const actions = Array.isArray(item.actions)
        ? item.actions.filter((action): action is string => typeof action === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(action)).slice(0, 16)
        : [];
      return [{
        name: safeIdentifier(item.name, "unknown-tool", 96),
        fingerprint: safeIdentifier(item.fingerprint, "unknown", 160),
        failed: item.failed === true,
        completedCount: typeof item.completedCount === "number" && Number.isFinite(item.completedCount)
          ? Math.max(0, Math.min(512, Math.trunc(item.completedCount)))
          : 0,
        repeatedFailure: item.repeatedFailure === true,
        actions,
      }];
    });
  } catch {
    return [];
  }
}

export function buildSessionArchiveEnvelope(input: R2SessionArchiveInput): R2SessionArchiveEnvelope {
  return {
    version: R2_ARCHIVE_SCHEMA_VERSION,
    kind: "session",
    recordedAt: new Date().toISOString(),
    revision: safeRevision(input.revision),
    committed: input.committed === true,
    recordKind: safeIdentifier(input.recordKind, "stable", 48),
    taskAnchors: safeAnchors(input.taskAnchors),
    protocolTail: sanitizeR2ArchiveText(input.protocolTail),
    toolLedger: safeLedger(input.toolLedgerSnapshot),
    reason: boundedText(input.reason, MAX_ARCHIVE_REASON_CHARACTERS) || "terminal_state",
  };
}

export function buildDiagnosticArchiveEnvelope(input: R2DiagnosticArchiveInput): R2DiagnosticArchiveEnvelope {
  return {
    version: R2_ARCHIVE_SCHEMA_VERSION,
    kind: "diagnostic",
    recordedAt: new Date().toISOString(),
    revision: safeRevision(input.revision),
    method: safeIdentifier(input.method, "OTHER", 16).toUpperCase(),
    path: /^\/[A-Za-z0-9_./:{}-]*$/u.test(input.path) ? input.path.slice(0, 160) : "/redacted",
    status: safeStatus(input.status),
    durationMs: safeDuration(input.durationMs),
    code: safeIdentifier(input.code, "redacted", MAX_DIAGNOSTIC_CODE_CHARACTERS),
    reason: boundedText(input.reason, MAX_ARCHIVE_REASON_CHARACTERS) || "diagnostic",
  };
}

export function buildCompactionArchiveEnvelope(input: R2CompactionArchiveInput): R2CompactionArchiveEnvelope {
  return {
    version: R2_ARCHIVE_SCHEMA_VERSION,
    kind: "compaction",
    recordedAt: new Date().toISOString(),
    revision: safeRevision(input.revision),
    encryptedContent: safeEncryptedContent(input.encryptedContent),
    reason: boundedText(input.reason, MAX_ARCHIVE_REASON_CHARACTERS) || "compaction",
  };
}

function safeScope(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 96);
  return normalized || "unknown";
}

export function r2ArchiveObjectKey(scope: string, envelope: R2ArchiveEnvelope, nonce?: string): string {
  const revision = String(safeRevision(envelope.revision)).padStart(14, "0");
  const kind = envelope.kind;
  // A stable key makes retries and repeated terminal callbacks idempotent for
  // the same DO scope/kind/revision.  Keep the optional nonce only for callers
  // that explicitly need a distinct object (and for backwards-compatible
  // tooling); the hot path never supplies one.
  const safeNonce = typeof nonce === "string"
    ? nonce.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 64)
    : "";
  return `m365-gateway/v${R2_ARCHIVE_SCHEMA_VERSION}/${kind}/${safeScope(scope)}/${revision}${safeNonce ? `-${safeNonce}` : ""}.json.enc`;
}

function retryDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(20, Math.trunc(attempt)));
  return Math.min(R2_ARCHIVE_RETRY_MAX_MS, R2_ARCHIVE_RETRY_MIN_MS * (2 ** exponent));
}

function hasBucket(env: Pick<Env, "R2_ARCHIVE">): env is Pick<Env, "R2_ARCHIVE"> & { R2_ARCHIVE: R2Bucket } {
  return Boolean(env.R2_ARCHIVE);
}

/**
 * Bounded, serialized R2 outbox for a Durable Object. No method in this class
 * is called before the caller's SQLite mutation has committed. Upload errors
 * are retained as retry metadata and never escape into the user response.
 */
export class R2ArchiveQueue {
  private flushInFlight: Promise<void> | null = null;
  private schemaInitialized = false;
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Pick<Env, "R2_ARCHIVE" | "DATA_ENCRYPTION_KEY">,
    private readonly scope: string,
  ) {}

  initializeSchema(): void {
    if (!hasBucket(this.env)) return;
    if (this.schemaInitialized) return;
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS r2_archive_queue (
          object_key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          kind TEXT NOT NULL,
          revision INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_r2_archive_queue_retry
        ON r2_archive_queue(next_attempt_at,revision,created_at);
        CREATE TABLE IF NOT EXISTS r2_archive_manifest (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          latest_key TEXT NOT NULL DEFAULT '',
          latest_revision INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.schemaInitialized = true;
    } catch {
      // R2 is optional. A migration/schema problem must never make a Worker
      // request fail when the SQLite hot state is otherwise healthy.
      console.error(JSON.stringify({ event: "r2_archive_schema_unavailable" }));
    }
  }

  /** Recreate the optional queue schema after a caller clears DO storage. */
  onStorageCleared(): void {
    this.schemaInitialized = false;
    this.initializeSchema();
  }

  /** Queue encryption and upload outside the current request's critical path. */
  enqueue(kind: R2ArchiveKind, input: R2SessionArchiveInput | R2DiagnosticArchiveInput | R2CompactionArchiveInput): void {
    if (!hasBucket(this.env) || !this.env.DATA_ENCRYPTION_KEY) return;
    let envelope: R2ArchiveEnvelope;
    try {
      envelope = kind === "session"
        ? buildSessionArchiveEnvelope(input as R2SessionArchiveInput)
        : kind === "diagnostic"
          ? buildDiagnosticArchiveEnvelope(input as R2DiagnosticArchiveInput)
          : buildCompactionArchiveEnvelope(input as R2CompactionArchiveInput);
    } catch {
      // Malformed optional metadata must never escape into a hot request.
      console.error(JSON.stringify({ event: "r2_archive_input_invalid" }));
      return;
    }
    if (kind === "compaction" && !(envelope.kind === "compaction" && envelope.encryptedContent)) return;
    // `waitUntil` is intentionally the only async boundary here. If the
    // Worker is terminated before it runs, SQLite hot state remains complete;
    // a later terminal mutation can enqueue another cold copy.
    try {
      const work = this.prepareAndFlush(envelope).catch(() => {
        // Archive failure is non-fatal and must not disclose encryption/R2
        // details in the runtime log.
        console.error(JSON.stringify({ event: "r2_archive_write_failed" }));
      });
      this.pendingWrites.add(work);
      // Keep the set bounded to promises that have not settled, without
      // creating an unhandled rejection from the bookkeeping continuation.
      void work.then(
        () => this.pendingWrites.delete(work),
        () => this.pendingWrites.delete(work),
      );
      this.ctx.waitUntil(work);
    } catch {
      // Test doubles and legacy runtimes may not expose waitUntil on a DO
      // state. The no-op fallback still preserves the SQLite source of truth.
    }
  }

  /** Wait for in-flight encryption/queue insertion before a caller clears DO storage. */
  async drainPendingWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
  }

  private async prepareAndFlush(envelope: R2ArchiveEnvelope): Promise<void> {
    this.initializeSchema();
    const encrypted = await encryptJSON(envelope, this.env.DATA_ENCRYPTION_KEY);
    if (utf8ByteLength(encrypted) > R2_ARCHIVE_MAX_PAYLOAD_BYTES) return;
    const objectKey = r2ArchiveObjectKey(this.scope, envelope);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO r2_archive_queue(object_key,payload,kind,revision,attempt_count,next_attempt_at,created_at)
         VALUES(?,?,?,?,0,?,?)`,
        objectKey,
        encrypted,
        envelope.kind,
        safeRevision(envelope.revision),
        now,
        now,
      );
      // Keep the outbox bounded. This is optional cold history; dropping an
      // old pending copy can never remove the authoritative SQLite state.
      this.ctx.storage.sql.exec(
        `DELETE FROM r2_archive_queue WHERE object_key IN
         (SELECT object_key FROM r2_archive_queue ORDER BY revision DESC,created_at DESC LIMIT -1 OFFSET ?)`,
        R2_ARCHIVE_MAX_QUEUE,
      );
    });
    await this.armRetryAlarm();
    await this.flush();
  }

  private async armRetryAlarm(): Promise<void> {
    await this.scheduleAlarmAt(null);
  }

  /**
   * Durable Objects expose one alarm timeline for all concerns.  Keep the
   * archive retry deadline and a caller-provided state/TTL deadline on that
   * same timeline, always retaining the earliest future deadline.  A null
   * candidate means "archive queue only" and is used by the outbox itself.
   * Missing R2 remains a direct setAlarm path, so deployments without the
   * optional binding pay no extra SQL/read overhead.
   */
  async scheduleAlarmAt(candidate: number | null): Promise<void> {
    const now = Date.now();
    const requested = candidate === null
      ? null
      : Number.isFinite(candidate) ? Math.max(now + 1, Math.trunc(candidate)) : now + 1;
    if (!hasBucket(this.env)) {
      if (requested !== null) {
        try {
          const current = await this.ctx.storage.getAlarm();
          if (current === null || !Number.isFinite(current) || current <= now
            || Math.abs(current - requested) > R2_ARCHIVE_ALARM_TOLERANCE_MS) {
            await this.ctx.storage.setAlarm(requested);
          }
        } catch {
          // Legacy test doubles/runtimes may not expose getAlarm(). Preserve
          // the original best-effort scheduling behavior in that case.
          await this.ctx.storage.setAlarm(requested);
        }
      }
      return;
    }
    try {
      this.initializeSchema();
      const row = this.ctx.storage.sql.exec<{ next_attempt_at: number }>(
        "SELECT next_attempt_at FROM r2_archive_queue ORDER BY next_attempt_at,revision,created_at LIMIT 1",
      ).toArray()[0];
      const archiveDue = row && Number.isFinite(Number(row.next_attempt_at))
        ? Math.max(now + 1, Number(row.next_attempt_at))
        : null;
      const current = await this.ctx.storage.getAlarm();
      const currentFuture = current !== null && Number.isFinite(current) && current > now ? current : null;
      const deadlines = [requested, archiveDue, currentFuture].filter((value): value is number => value !== null);
      const desired = deadlines.length > 0 ? Math.min(...deadlines) : null;
      if (desired !== null) {
        // Keep an existing equivalent deadline. Apart from avoiding needless
        // wakeups this matters on the Free plan, where each setAlarm is a DO
        // row write and contributes to the daily write budget.
        if (current === null || !Number.isFinite(current) || current <= now
          || Math.abs(current - desired) > R2_ARCHIVE_ALARM_TOLERANCE_MS) {
          await this.ctx.storage.setAlarm(desired);
        }
      } else if (current !== null) {
        await this.ctx.storage.deleteAlarm();
      }
    } catch {
      // Alarm scheduling is a retry optimization; losing it cannot invalidate
      // the hot state or the already-enqueued archive row.
      if (requested !== null) {
        try {
          // If the optional schema is unavailable, preserve the caller's hot
          // state/TTL alarm rather than allowing the archive helper to make
          // that alarm disappear.
          await this.ctx.storage.setAlarm(requested);
        } catch {
          // The storage runtime itself may be unavailable during shutdown.
        }
      }
    }
  }

  /** Delete the shared alarm only when this DO has no pending archive row. */
  async deleteAlarmIfNoPendingArchive(): Promise<void> {
    if (!hasBucket(this.env)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    try {
      this.initializeSchema();
      const row = this.ctx.storage.sql.exec<{ next_attempt_at: number }>(
        "SELECT next_attempt_at FROM r2_archive_queue ORDER BY next_attempt_at,revision,created_at LIMIT 1",
      ).toArray()[0];
      if (row) {
        await this.scheduleAlarmAt(null);
      } else {
        // Do not erase a future alarm owned by another ChatSession concern.
        // The registry caller may legitimately have no rows while a state/TTL
        // alarm was scheduled by a preceding operation on this object.
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current <= Date.now()) await this.ctx.storage.deleteAlarm();
      }
    } catch {
      // Keep an existing alarm if the optional archive schema is unavailable.
    }
  }

  /**
   * `DurableObjectStorage.deleteAll()` also removes SQLite tables and alarms.
   * Callers that are deleting hot session state use this guard to avoid
   * deleting an archive row which is waiting for a transient R2 retry.
   * A schema/read failure is treated conservatively as pending work.
   */
  async hasPendingArchive(): Promise<boolean> {
    if (!hasBucket(this.env)) return false;
    try {
      this.initializeSchema();
      const row = this.ctx.storage.sql.exec<{ object_key: string }>(
        "SELECT object_key FROM r2_archive_queue LIMIT 1",
      ).toArray()[0];
      return Boolean(row?.object_key);
    } catch {
      return true;
    }
  }

  async flush(): Promise<void> {
    if (!hasBucket(this.env)) return;
    if (this.flushInFlight) return this.flushInFlight;
    const work = this.flushInternal().catch(() => {
      // Keep alarm callbacks non-failing even if an older DO has no archive
      // table or the storage runtime rejects a best-effort cold write.
      console.error(JSON.stringify({ event: "r2_archive_flush_failed" }));
    }).finally(() => {
      this.flushInFlight = null;
    });
    this.flushInFlight = work;
    return work;
  }

  private async flushInternal(): Promise<void> {
    if (!hasBucket(this.env)) return;
    for (let index = 0; index < R2_ARCHIVE_FLUSH_BATCH_SIZE; index += 1) {
      const row = this.ctx.storage.sql.exec<R2ArchiveQueueRow>(
        `SELECT object_key,payload,kind,revision,attempt_count,next_attempt_at,created_at
         FROM r2_archive_queue WHERE next_attempt_at<=? ORDER BY revision,created_at LIMIT 1`,
        Date.now(),
      ).toArray()[0];
      if (!row) break;
      try {
        // A deterministic object key lets us safely recover from a crash
        // after R2.put() and before the queue-row delete. A HEAD turns that
        // recovery into a cheap Class-B read instead of a duplicate Class-A
        // overwrite; R2 egress is free and the read quota is much larger.
        const existing = await this.env.R2_ARCHIVE.head(row.object_key);
        if (!existing) {
          await this.env.R2_ARCHIVE.put(row.object_key, row.payload, {
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: {
              schema: String(R2_ARCHIVE_SCHEMA_VERSION),
              kind: safeIdentifier(row.kind, "unknown", 24),
              revision: String(safeRevision(row.revision)),
            },
          });
        }
        this.markUploaded(row);
      } catch {
        const attempts = Math.min(31, Math.max(0, Math.trunc(Number(row.attempt_count) || 0)) + 1);
        if (attempts >= R2_ARCHIVE_MAX_ATTEMPTS) {
          // A poison row must not hold the head of the queue indefinitely.
          // Dropping only this cold copy is fail-open: the committed DO state
          // remains intact and a later terminal mutation may archive again.
          this.ctx.storage.sql.exec("DELETE FROM r2_archive_queue WHERE object_key=?", row.object_key);
          console.warn(JSON.stringify({
            event: "r2_archive_row_dropped",
            kind: safeIdentifier(row.kind, "unknown", 24),
            revision: safeRevision(row.revision),
            attempts,
          }));
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE r2_archive_queue SET attempt_count=?,next_attempt_at=? WHERE object_key=?",
            attempts,
            Date.now() + retryDelay(attempts),
            row.object_key,
          );
        }
        break;
      }
    }
    await this.armRetryAlarm();
  }

  private markUploaded(row: R2ArchiveQueueRow): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM r2_archive_queue WHERE object_key=?", row.object_key);
      this.ctx.storage.sql.exec(
        `INSERT INTO r2_archive_manifest(singleton,latest_key,latest_revision,updated_at)
         VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
           latest_key=excluded.latest_key,latest_revision=excluded.latest_revision,updated_at=excluded.updated_at
         WHERE excluded.latest_revision>r2_archive_manifest.latest_revision
            OR (excluded.latest_revision=r2_archive_manifest.latest_revision AND excluded.latest_key>r2_archive_manifest.latest_key)`,
        row.object_key,
        safeRevision(row.revision),
        Date.now(),
      );
    });
  }

  /** Explicit cold-copy read for diagnostics/recovery; never used as hot authority. */
  async latest(): Promise<R2ArchiveLatest | null> {
    if (!hasBucket(this.env)) return null;
    try {
      this.initializeSchema();
      const row = this.ctx.storage.sql.exec<R2ArchiveManifestRow>(
        "SELECT latest_key,latest_revision FROM r2_archive_manifest WHERE singleton=1",
      ).toArray()[0];
      if (!row?.latest_key) return null;
      const object = await this.env.R2_ARCHIVE.get(row.latest_key);
      if (!object) return null;
      const envelope = await decryptJSON<R2ArchiveEnvelope>(await object.text(), this.env.DATA_ENCRYPTION_KEY);
      if (!envelope || envelope.version !== R2_ARCHIVE_SCHEMA_VERSION || !["session", "diagnostic", "compaction"].includes(envelope.kind)) return null;
      return { key: row.latest_key, envelope };
    } catch {
      return null;
    }
  }
}
