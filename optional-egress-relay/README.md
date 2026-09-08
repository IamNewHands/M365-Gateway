# M365 ChatHub Egress Relay

This directory contains a deliberately small WebSocket egress relay for a
Cloudflare Worker. It is not an HTTP/SOCKS proxy and cannot connect to a
caller-supplied host. The production binary has exactly one upstream base:

```text
wss://substrate.office.com/m365Copilot/Chathub/{oid}@{tid}
```

Its intended deployment model is one relay per trusted server egress IP. The
Cloudflare account record selects one relay, so account-to-IP isolation remains
explicit and deterministic. The relay itself never selects or rotates accounts.

## Security contract

- TLS is mandatory between Cloudflare and Nginx. HMAC authenticates the caller;
  it does not replace encryption.
- The M365 access token is accepted only in `X-M365-Access-Token`. It is never
  accepted in the relay request URL.
- `X-M365-Target-Query` contains only the non-secret ChatHub query string. Its
  keys are allowlisted; `access_token`, arbitrary URLs, duplicate keys, and
  unknown keys are rejected.
- `X-Relay-Content-SHA256` binds the access token and target query.
- `X-Relay-Signature` binds the digest, timestamp, nonce, method, exact relay
  path, and Origin using HMAC-SHA256.
- A valid nonce is accepted once within the clock-skew window. Invalid
  signatures cannot consume nonce-cache capacity.
- Origin, optional direct-peer CIDR, connection count, frame size, handshake,
  idle, write, and total lifetime are bounded.
- Application logs contain only event names, a random request ID, a stable
  error code, and (when available) an upstream HTTP status. They never contain
  access tokens, request headers, target queries, or full upstream URLs.
- The provided Nginx log format uses `$uri`, never `$request_uri`, so URL query
  strings are not written to access logs.

Microsoft ChatHub currently requires the access token in its upstream query.
The relay therefore adds it only after authentication, inside the TLS-protected
outbound connection. Neither the inbound relay URL nor any relay/Nginx log
contains that query.

## Required request

```text
GET /v1/chathub/{oid}@{tid}
Origin: https://the-worker-origin.example
X-M365-Access-Token: <opaque token>
X-M365-Target-Query: chatsessionid=...&clientrequestid=...&X-SessionId=...&ConversationId=...
X-Relay-Timestamp: <Unix seconds>
X-Relay-Nonce: <22-128 chars from A-Z, a-z, 0-9, underscore, and hyphen>
X-Relay-Content-SHA256: <lowercase hex SHA-256>
X-Relay-Signature: <unpadded base64url HMAC-SHA256>
Connection: Upgrade
Upgrade: websocket
```

The digest input is UTF-8:

```text
token:<token byte length>:<token>\nquery:<query byte length>:<query>
```

The signature canonical form is UTF-8, with no trailing newline:

```text
M365-RELAY-V1
<timestamp>
<nonce>
GET
<exact path>
<Origin>
<lowercase digest hex>
```

Generate every nonce with a cryptographically secure random generator. Never
reuse one, including after an HTTP or WebSocket error.

## Cloudflare signing sketch

This is intentionally only the signing boundary. Account storage and selection
remain in the gateway and must not be copied into the relay.

```ts
const enc = new TextEncoder();
const byteLength = (s: string) => enc.encode(s).byteLength;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)]
  .map(x => x.toString(16).padStart(2, "0")).join("");
const base64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = base64url(crypto.getRandomValues(new Uint8Array(24)).buffer);
const digestInput = `token:${byteLength(token)}:${token}\nquery:${byteLength(targetQuery)}:${targetQuery}`;
const digest = hex(await crypto.subtle.digest("SHA-256", enc.encode(digestInput)));
const canonical = ["M365-RELAY-V1", timestamp, nonce, "GET", path, origin, digest].join("\n");
const key = await crypto.subtle.importKey("raw", enc.encode(sharedSecret),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const signature = base64url(await crypto.subtle.sign("HMAC", key, enc.encode(canonical)));
```

Use distinct HMAC secrets for the 5 and 7 relays. Store those secrets as
Cloudflare secrets, never as source-code variables, KV plaintext, or account
fields. Rotate by deploying a second relay endpoint/secret and draining the old
one; this minimal implementation intentionally supports only one active secret.

## Build and test

```bash
go test ./...
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o m365-egress-relay ./cmd/relay
```

The resulting binary is static on the normal Linux Go toolchain. Verify it in
CI with `file m365-egress-relay` and `ldd m365-egress-relay` (the latter should
report that it is not dynamically linked).

## Configuration

Create `/etc/m365-egress-relay/relay.env` owned by root with mode `0600`:

```text
RELAY_LISTEN_ADDR=127.0.0.1:8090
RELAY_HMAC_SECRET=<at-least-32-random-bytes>
RELAY_ALLOWED_ORIGINS=https://api.example.invalid
RELAY_ALLOWED_CIDRS=127.0.0.1/32
RELAY_MAX_CONNECTIONS=64
RELAY_MAX_FRAME_BYTES=8388608
RELAY_HANDSHAKE_TIMEOUT=15s
RELAY_IDLE_TIMEOUT=90s
RELAY_MAX_LIFETIME=15m
RELAY_CLOCK_SKEW=30s
RELAY_NONCE_CAPACITY=10000
```

`RELAY_ALLOWED_CIDRS` checks the process's direct TCP peer. With the supplied
Nginx topology it must allow only loopback; Nginx is the public TLS boundary.
Do not trust `X-Forwarded-For` for authorization. The relay always requires an
exact allowed Origin and a valid HMAC even when the CIDR list is empty.

Deployment examples are under `deploy/`. They contain placeholders only. This
directory does not contain or migrate M365 accounts, OAuth tokens, Cloudflare
keys, proxy credentials, production hostnames, or real server addresses.

## Operational checks

1. `curl --fail http://127.0.0.1:8090/healthz` returns `{"status":"ok"}`.
2. An unsigned WebSocket request is rejected before any upstream dial.
3. A correctly signed request reaches only the fixed ChatHub upstream.
4. Reusing the same nonce returns HTTP 409.
5. Changing the path, Origin, token, or target query without resigning returns
   HTTP 401.
6. Oversized frames close the connection; idle and maximum-lifetime limits
   eventually close abandoned connections.
7. Inspect both application and Nginx logs and confirm test tokens and query
   markers never appear.

No automatic semantic retry is performed. If either side disconnects, the
bridge closes both sockets. The gateway must preserve its existing rule that a
ChatHub invocation which may have been submitted is never replayed.
