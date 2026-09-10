import type { Env } from "./types";
import {
  deleteCloudConversation,
  getCloudAccessToken,
  listCloudConversations,
  type CloudChat,
} from "./cloud-api";

export interface AccountCleanupDetail {
  accountId: string;
  email: string;
  deleted: number;
  error?: string;
}

export interface CloudCleanupResult {
  accountsProcessed: number;
  totalDeleted: number;
  details: AccountCleanupDetail[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clean up idle conversations on Microsoft M365 Copilot cloud for all authorized accounts.
 *
 * Sliding window pagination: RefreshNavPane returns a single page of chats.
 * After deleting expired conversations, older ones slide in, so we repeat up to maxRounds.
 */
export async function cleanupAccountCloudConversations(
  token: string,
  maxAgeHours: number,
  keepN: number,
  maxRounds = 20,
): Promise<number> {
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  let deleted = 0;
  let kept = 0;

  for (let round = 0; round < maxRounds; round++) {
    let chats: CloudChat[];
    try {
      chats = await listCloudConversations(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "m365_cloud_list_failed", error: msg }));
      return deleted;
    }

    if (chats.length === 0) break;

    let anyDeleted = false;
    for (const chat of chats) {
      const convId = chat.conversationId || "";
      if (!convId) continue;

      const createTime = chat.createTimeUtc;
      // Protect fresh or timestamp-missing chats from accidental deletion
      if (typeof createTime !== "number" || createTime <= 0) continue;

      const age = now - createTime;
      if (age > maxAgeMs) {
        try {
          await deleteCloudConversation(token, convId);
          deleted++;
          anyDeleted = true;
          await sleep(200); // 200ms throttle between deletions
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(JSON.stringify({ event: "m365_cloud_delete_failed", convId, error: msg }));
        }
      } else {
        if (kept >= keepN) {
          try {
            await deleteCloudConversation(token, convId);
            deleted++;
            anyDeleted = true;
            await sleep(200);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(JSON.stringify({ event: "m365_cloud_delete_failed", convId, error: msg }));
          }
        } else {
          kept++;
        }
      }
    }

    if (!anyDeleted) break;
  }

  return deleted;
}

export async function runCloudCleanup(
  env: Env,
  force = false,
): Promise<CloudCleanupResult> {
  const tenantState = env.TENANTS.getByName(env.TENANT_NAME || "default");
  const settings = await tenantState.getCloudCleanupSettings();

  if (!settings.enabled && !force) {
    return { accountsProcessed: 0, totalDeleted: 0, details: [] };
  }

  const accounts = await tenantState.listAuthorizedAccountTokens();
  const clientId = env.M365_CLIENT_ID || "00000000-0000-4000-8000-000000000001";
  const details: AccountCleanupDetail[] = [];
  let totalDeleted = 0;

  for (const account of accounts) {
    try {
      const token = await getCloudAccessToken(clientId, account.tid, account.refreshToken, account.id);
      const count = await cleanupAccountCloudConversations(token, settings.maxAgeHours, settings.keepN);
      totalDeleted += count;
      details.push({
        accountId: account.id,
        email: account.email,
        deleted: count,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "m365_account_cleanup_failed", accountId: account.id, error: msg }));
      details.push({
        accountId: account.id,
        email: account.email,
        deleted: 0,
        error: msg,
      });
    }
  }

  return {
    accountsProcessed: accounts.length,
    totalDeleted,
    details,
  };
}
