import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const excludedDirectories = new Set(["node_modules", ".wrangler", "reports", "coverage", ".git"]);
const textExtensions = new Set([
  ".cjs", ".css", ".go", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ps1", ".sql", ".ts", ".tsx", ".txt", ".yml", ".yaml",
]);

const patterns = [
  { category: "private_key", expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u },
  { category: "known_token_prefix", expression: /\b(?:sk|pk|ghp|github_pat|xoxb|xoxp|cfp|cft)_[A-Za-z0-9_-]{20,}\b/u },
  { category: "jwt", expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { category: "bearer_literal", expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/iu },
  { category: "credential_literal", expression: /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*["'`]([A-Za-z0-9_./+=:-]{24,})["'`]/iu },
];

// Deployment identifiers (domains, IPs, UUIDs) are useful to audit before a
// public release, but they are not credentials.  Keep that noisy check
// opt-in so the normal secret scan can be used in CI without flagging package
// registry URLs and test fixtures.
const identifierPatterns = [
  { category: "email", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu },
  { category: "ipv4", expression: /\b(?:\d{1,3}\.){3}\d{1,3}\b/u },
  { category: "custom_domain", expression: /\b(?:[A-Z0-9-]+\.)+(?:cc|cd)\b/iu },
  { category: "worker_domain", expression: /\b[A-Z0-9-]+\.workers\.dev\b/iu },
  { category: "uuid", expression: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu },
  { category: "cloudflare_account_id", expression: /\b[0-9a-f]{32}\b/iu },
];

const publicOrPlaceholder = [
  "example.com", "example.org", "example.net", "localhost", "127.0.0.1", "0.0.0.0", "255.255.255.255",
  "login.microsoftonline.com", "substrate.office.com", "00000000-0000-4000-8000-000000000001",
  "your-api-key", "your-token", "replace-me", "placeholder", "cf2-account-id", "your-worker",
];

const identifierMode = process.argv.includes("--identifiers");
const sourceFilesOnly = process.argv.includes("--source-only");

function isPlaceholder(line, category) {
  const normalized = line.toLowerCase();
  if (publicOrPlaceholder.some((value) => normalized.includes(value))) return true;
  if (category === "ipv4") return /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./u.test(normalized);
  if (category === "uuid" && /(?:client[_ -]?id|request[_ -]?id|response[_ -]?id|uuid)/iu.test(normalized)) {
    return normalized.includes("00000000-0000-4000-8000-000000000001");
  }
  if (category === "public_domain" && /(?:microsoftonline\.com|office\.com|cloudflare\.com|workers\.dev)/iu.test(normalized)) return true;
  if (category === "credential_literal" && /(?:process\.env|env\.|getenv|example|placeholder)/iu.test(normalized)) return true;
  return false;
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) result.push(...await walk(resolve(directory, entry.name)));
      continue;
    }
    if (entry.name === "package-lock.json" || entry.name === "worker-configuration.d.ts") continue;
    if (textExtensions.has(extname(entry.name).toLowerCase())) result.push(resolve(directory, entry.name));
  }
  return result;
}

const files = await walk(root);
const findings = [];
for (const file of files) {
  const relativeFile = relative(root, file).replaceAll("\\", "/");
  const isTestFixture = /^(?:test|testdata)\//u.test(relativeFile) || /(?:^|\/)vitest\.config\./u.test(relativeFile);
  const isDocumentation = /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|SECURITY)\.md$/iu.test(relativeFile);
  if (sourceFilesOnly && (isTestFixture || isDocumentation)) continue;
  let lines;
  try {
    lines = (await readFile(file, "utf8")).split(/\r?\n/u);
  } catch {
    continue;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const activePatterns = identifierMode ? [...patterns, ...identifierPatterns] : patterns;
    for (const pattern of activePatterns) {
      if (isTestFixture && ["private_key", "bearer_literal", "known_token_prefix", "jwt", "credential_literal"].includes(pattern.category)) continue;
      if (pattern.expression.test(lines[index]) && !isPlaceholder(lines[index], pattern.category)) {
        findings.push({ file: relativeFile, line: index + 1, category: pattern.category });
      }
    }
  }
}

console.log(JSON.stringify({ filesScanned: files.length, mode: identifierMode ? "secrets+identifiers" : "secrets", findings }, null, 2));
if (findings.length > 0) process.exitCode = 1;
