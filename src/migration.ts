import { base64url, sha256 } from "./crypto";
import { readTextLimited } from "./request-body";
import type { AccountEgress, Env, OAuthTokenSet } from "./types";

export const ACCOUNT_MIGRATION_PATH = "/api/internal/migrations/accounts";
export const MAX_MIGRATION_ACCOUNTS = 40;
export const MAX_MIGRATION_BODY_BYTES = 1024 * 1024;
const SIGNATURE_WINDOW_SECONDS = 5 * 60;
const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface MigratedAccountInput {
  token: OAuthTokenSet;
  egress: AccountEgress;
}

export interface AccountMigrationInput {
  migrationId: string;
  activeSequence: number;
  accounts: MigratedAccountInput[];
}

export interface VerifiedAccountMigration {
  input: AccountMigrationInput;
  bodyHash: string;
  nonceHash: string;
}

export class MigrationRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function tokenSet(value: unknown): value is OAuthTokenSet {
  if (!object(value) || !exactKeys(value, ["accessToken", "refreshToken", "expiresAt", "email", "displayName", "oid", "tid"])) return false;
  return boundedString(value.accessToken, 16, 32_768)
    && boundedString(value.refreshToken, 16, 32_768)
    && Number.isSafeInteger(value.expiresAt)
    && Number(value.expiresAt) > 0
    && boundedString(value.email, 3, 320)
    && /^\S+@\S+$/u.test(value.email)
    && boundedString(value.displayName, 1, 200)
    && boundedString(value.oid, 1, 128)
    && boundedString(value.tid, 1, 128);
}

function parseMigration(text: string, configuredMaximum: number): AccountMigrationInput {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new MigrationRequestError(400, "invalid_migration_json"); }
  if (!object(raw) || !exactKeys(raw, ["migrationId", "activeSequence", "accounts"])) {
    throw new MigrationRequestError(400, "invalid_migration_payload");
  }
  if (!boundedString(raw.migrationId, 12, 128) || !/^[A-Za-z0-9_.:-]+$/u.test(raw.migrationId)) {
    throw new MigrationRequestError(400, "invalid_migration_id");
  }
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0
    || raw.accounts.length > Math.min(MAX_MIGRATION_ACCOUNTS, configuredMaximum)) {
    throw new MigrationRequestError(400, "invalid_migration_account_count");
  }
  if (!Number.isInteger(raw.activeSequence) || Number(raw.activeSequence) < 1 || Number(raw.activeSequence) > raw.accounts.length) {
    throw new MigrationRequestError(400, "invalid_active_sequence");
  }
  const accounts: MigratedAccountInput[] = [];
  const objectIds = new Set<string>();
  const emails = new Set<string>();
  for (const item of raw.accounts) {
    if (!object(item) || !exactKeys(item, ["token", "egress"]) || !tokenSet(item.token)
      || !["direct", "relay5", "relay7"].includes(String(item.egress))
      || (item.egress !== "direct" && (!UUID.test(item.token.oid) || !UUID.test(item.token.tid)))) {
      throw new MigrationRequestError(400, "invalid_migration_account");
    }
    const objectId = item.token.oid.toLowerCase();
    const email = item.token.email.toLowerCase();
    if (objectIds.has(objectId) || emails.has(email)) throw new MigrationRequestError(409, "duplicate_migration_account");
    objectIds.add(objectId);
    emails.add(email);
    accounts.push({ token: item.token, egress: item.egress as AccountEgress });
  }
  return { migrationId: raw.migrationId, activeSequence: Number(raw.activeSequence), accounts };
}

function versionOverrideTargets(request: Request, versionId: string): boolean {
  const override = request.headers.get("Cloudflare-Workers-Version-Overrides") ?? "";
  // Cloudflare's override grammar includes the version UUID in quotes. Avoid
  // depending on the Worker name, which can change between test candidates.
  return override.split(",").some((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0 && entry.slice(separator + 1).trim() === `\"${versionId}\"`;
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

/**
 * Authenticate a migration without accepting an administrator cookie or a
 * normal gateway API key. The candidate version ID and the actual Version
 * Override header are signed, so copying the request to production fails.
 */
export async function verifyAccountMigration(request: Request, env: Env): Promise<VerifiedAccountMigration> {
  if (request.method !== "POST") throw new MigrationRequestError(405, "migration_method_not_allowed");
  const currentVersion = env.CF_VERSION_METADATA?.id?.trim() ?? "";
  const currentTag = env.CF_VERSION_METADATA?.tag?.trim() ?? "";
  const candidateTag = env.MIGRATION_CANDIDATE_TAG?.trim() ?? "";
  if (env.MIGRATION_ENABLED !== "true" || !currentVersion || !candidateTag || currentTag !== candidateTag
    || request.headers.get("X-M365-Migration-Version") !== currentVersion
    || !versionOverrideTargets(request, currentVersion)) {
    throw new MigrationRequestError(404, "migration_not_available");
  }
  const secret = env.MIGRATION_SIGNING_KEY ?? "";
  if (secret.length < 32 || secret.startsWith("m365_")) throw new MigrationRequestError(503, "migration_not_configured");
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new MigrationRequestError(415, "migration_content_type_required");
  }
  const timestampRaw = request.headers.get("X-M365-Migration-Timestamp")?.trim() ?? "";
  const timestamp = Number(timestampRaw);
  if (!/^\d{10}$/u.test(timestampRaw) || !Number.isSafeInteger(timestamp)
    || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > SIGNATURE_WINDOW_SECONDS) {
    throw new MigrationRequestError(401, "migration_signature_expired");
  }
  const nonce = request.headers.get("X-M365-Migration-Nonce")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)) throw new MigrationRequestError(401, "invalid_migration_nonce");
  const supplied = request.headers.get("X-M365-Migration-Signature")?.trim() ?? "";
  if (!supplied.startsWith("v1=")) throw new MigrationRequestError(401, "invalid_migration_signature");

  const text = await readTextLimited(request, MAX_MIGRATION_BODY_BYTES);
  const bodyHash = await sha256(text);
  const canonical = ["v1", timestampRaw, nonce, request.method, ACCOUNT_MIGRATION_PATH, bodyHash, currentVersion].join("\n");
  const expected = `v1=${await hmac(secret, canonical)}`;
  if (!timingSafeEqual(supplied, expected)) throw new MigrationRequestError(401, "invalid_migration_signature");
  const configuredMaximum = Math.max(1, Number.parseInt(env.MAX_ACCOUNTS || "1", 10) || 1);
  return { input: parseMigration(text, configuredMaximum), bodyHash, nonceHash: await sha256(nonce) };
}
