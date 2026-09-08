import type { Env, OAuthTokenSet } from "./types";

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

function tokenFailure(response: Response, payload: MicrosoftTokenResponse): string {
  const code = (payload.error ?? "").toLowerCase();
  if (response.status === 429 || code === "temporarily_throttled") return "MICROSOFT_TOKEN_RATE_LIMITED";
  if (code === "invalid_grant" || code === "interaction_required" || code === "consent_required") {
    return "MICROSOFT_REFRESH_TOKEN_REJECTED";
  }
  if (response.status >= 500 || code === "temporarily_unavailable" || code === "server_error") {
    return "MICROSOFT_TOKEN_SERVICE_UNAVAILABLE";
  }
  return "MICROSOFT_TOKEN_EXCHANGE_FAILED";
}

function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const normalized = part.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function claim(claims: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) if (typeof claims[name] === "string" && claims[name]) return claims[name] as string;
  return "";
}

async function tokenRequest(env: Env, form: URLSearchParams): Promise<OAuthTokenSet> {
  let response: Response;
  try {
    response = await fetch(`${env.M365_AUTHORITY.replace(/\/$/u, "")}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Fetch errors can contain the authority URL or request internals. Keep
    // those out of both the API response and the durable account diagnostics.
    throw new Error("MICROSOFT_TOKEN_SERVICE_UNAVAILABLE");
  }
  let payload: MicrosoftTokenResponse;
  try {
    const parsed = await response.json<unknown>();
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as MicrosoftTokenResponse
      : {};
  } catch {
    payload = {};
  }
  if (!response.ok || payload.error || !payload.access_token) {
    console.error(JSON.stringify({ event: "oauth_token_failed", status: response.status, code: payload.error ?? "empty_token" }));
    throw new Error(tokenFailure(response, payload));
  }
  const accessClaims = jwtClaims(payload.access_token);
  const idClaims = payload.id_token ? jwtClaims(payload.id_token) : {};
  const email = claim(accessClaims, "unique_name", "upn", "preferred_username", "email") || claim(idClaims, "preferred_username", "email", "upn");
  const oid = claim(accessClaims, "oid", "sub") || claim(idClaims, "oid", "sub");
  const tid = claim(accessClaims, "tid", "tenant_id") || claim(idClaims, "tid", "tenant_id");
  if (!oid || !tid) throw new Error("MICROSOFT_TOKEN_IDENTITY_MISSING");
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? "",
    expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000,
    email,
    displayName: claim(accessClaims, "name") || claim(idClaims, "name") || email,
    oid,
    tid,
  };
}

export function authorizationURL(env: Env, state: string, challenge: string): string {
  const url = new URL(`${env.M365_AUTHORITY.replace(/\/$/u, "")}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: env.M365_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.M365_REDIRECT_URI,
    response_mode: "query",
    scope: env.M365_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export function exchangeCode(env: Env, code: string, verifier: string): Promise<OAuthTokenSet> {
  return tokenRequest(env, new URLSearchParams({
    client_id: env.M365_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: env.M365_REDIRECT_URI,
    code_verifier: verifier,
    scope: env.M365_SCOPE,
  }));
}

export function refreshToken(env: Env, token: OAuthTokenSet): Promise<OAuthTokenSet> {
  if (!token.refreshToken) throw new Error("MICROSOFT_REFRESH_TOKEN_MISSING");
  return tokenRequest(env, new URLSearchParams({
    client_id: env.M365_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    scope: env.M365_SCOPE,
  })).then((fresh) => ({ ...fresh, refreshToken: fresh.refreshToken || token.refreshToken }));
}
