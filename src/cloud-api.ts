/**
 * Microsoft 365 Copilot cloud management API client.
 * Calls https://m365.cloud.microsoft/chat for RefreshNavPane / DeleteConversation
 * to list and delete cloud conversation history.
 */

const CLOUD_TOKEN_CACHE = new Map<string, { token: string; expiresAt: number }>();

export async function getCloudAccessToken(
  clientId: string,
  tid: string,
  refreshToken: string,
  accountId = "",
): Promise<string> {
  const cacheKey = accountId || `${tid}:${refreshToken.slice(-16)}`;
  const cached = CLOUD_TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > 2 * 60 * 1000) {
    return cached.token;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: "https://m365.cloud.microsoft/v2/.default",
  });

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tid)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`cloud token exchange HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("cloud token exchange response missing access_token");
  }

  const expiresInMs = (data.expires_in || 3600) * 1000;
  CLOUD_TOKEN_CACHE.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + expiresInMs,
  });

  return data.access_token;
}

export interface CloudChat {
  conversationId?: string;
  createTimeUtc?: number;
  [key: string]: unknown;
}

async function doCloudAPI(
  token: string,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const reqBody = {
    action,
    ...payload,
  };

  const response = await fetch("https://m365.cloud.microsoft/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
      Origin: "https://m365.cloud.microsoft",
      Referer: "https://m365.cloud.microsoft/",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`cloud API HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (contentType && !contentType.includes("application/json")) {
    throw new Error(`unexpected content type from m365 endpoint: ${contentType}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

export async function listCloudConversations(token: string): Promise<CloudChat[]> {
  const result = await doCloudAPI(token, "RefreshNavPane", {});
  const store = result.store as Record<string, unknown> | undefined;
  if (!store) {
    throw new Error("unexpected response format from RefreshNavPane");
  }

  const historyList = store.conversationPageHistoryList as Record<string, unknown> | undefined;
  if (!historyList) {
    return [];
  }

  const chatsRaw = historyList.chats as unknown[] | undefined;
  if (!Array.isArray(chatsRaw)) {
    return [];
  }

  const chats: CloudChat[] = [];
  for (const raw of chatsRaw) {
    if (typeof raw === "string") {
      try {
        const chat = JSON.parse(raw) as CloudChat;
        chats.push(chat);
      } catch {
        // Skip unparseable chat item string
      }
    } else if (typeof raw === "object" && raw !== null) {
      chats.push(raw as CloudChat);
    }
  }

  return chats;
}

export async function deleteCloudConversation(token: string, conversationId: string): Promise<void> {
  await doCloudAPI(token, "DeleteConversation", {
    conversationId,
    state: {
      conversationPageHistoryList: {
        chats: [],
      },
    },
  });
}


