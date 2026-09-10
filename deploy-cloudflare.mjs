#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const wranglerEntry = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const args = parseArgs(process.argv.slice(2));
let rl;
let temporaryDirectory = "";

function parseArgs(values) {
  const result = { yes: false, update: false, dryRun: false, help: false, syncApiKey: false, resetAdminPassword: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--yes" || value === "-y") result.yes = true;
    else if (value === "--update") result.update = true;
    else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--sync-api-key") result.syncApiKey = true;
    else if (value === "--reset-admin-password") result.resetAdminPassword = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (["--name", "--client-id", "--domain", "--kv-id", "--account-id", "--canonical-bundle", "--archive-bucket"].includes(value)) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} 缺少参数值`);
      result[value.slice(2).replaceAll("-", "_")] = next.trim();
      index += 1;
    } else throw new Error(`未知参数：${value}`);
  }
  return result;
}

function showHelp() {
  console.log(`
M365 Gateway Cloudflare 一键部署器

新建部署：
  node deploy-cloudflare.mjs

无人值守新建（仍会打开 Cloudflare 登录）：
  node deploy-cloudflare.mjs --yes --account-id <Cloudflare账号ID> --name my-m365-gateway --client-id <Entra应用ID>

更新已有 Worker（必须复用原 KV）：
  node deploy-cloudflare.mjs --update --account-id <Cloudflare账号ID> --name my-m365-gateway --client-id <Entra应用ID> --kv-id <原KV_ID>

部署参数（正式部署必填，dry-run 可省略）：
  --account-id <32位ID>        明确锁定 Cloudflare 账号，防止 OAuth 与部署目标串号
  --domain <api.example.com>  同时绑定 Cloudflare 自定义域名
  --sync-api-key             从 M365_GATEWAY_API_KEY 安全同步统一客户端 Key
  --reset-admin-password     从 M365_ADMIN_PASSWORD 安全重置管理员密码（仅更新模式）
  --canonical-bundle <file>  直接部署已核验的线上 Worker 模块，不重新打包
  --archive-bucket <name>    可选：绑定已经创建的 R2 冷归档桶（仅用 info --json 校验，不创建/切换桶）
  --dry-run                   只验证构建，不登录、不创建资源、不部署
  -h, --help                  显示本说明
`);
}

function run(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    // A stuck Wrangler child must fail the deployment task instead of leaving
    // Codex waiting forever with no evidence. Real deployments are bounded by
    // the same limit; rerun after inspecting the emitted command/error.
    timeout: timeoutMs,
    stdio: options.capture ? [options.input ? "pipe" : "ignore", "pipe", "pipe"] : [options.input ? "pipe" : "inherit", "inherit", "inherit"],
    input: options.input,
    env: process.env,
  });
  if (options.capture && !options.quiet) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) {
    const message = result.error.code === "ETIMEDOUT"
      ? `${command} ${commandArgs.join(" ")} 超过 ${Math.ceil(timeoutMs / 1_000)} 秒仍未退出，已终止`
      : result.error.message;
    const failure = new Error(message, { cause: result.error });
    Object.defineProperties(failure, {
      stdout: { value: String(result.stdout ?? ""), enumerable: false },
      stderr: { value: String(result.stderr ?? ""), enumerable: false },
      exitCode: { value: result.status, enumerable: false },
    });
    throw failure;
  }
  if (result.status !== 0) {
    const failure = new Error(`${command} ${commandArgs.join(" ")} 执行失败（退出码 ${result.status ?? "unknown"}）`);
    Object.defineProperties(failure, {
      stdout: { value: String(result.stdout ?? ""), enumerable: false },
      stderr: { value: String(result.stderr ?? ""), enumerable: false },
      exitCode: { value: result.status, enumerable: false },
    });
    throw failure;
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runNpm(commandArgs) {
  if (process.platform !== "win32") return run(npm, commandArgs);
  const commandLine = [npm, ...commandArgs].map((value) => /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value).join(" ");
  return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine]);
}

function runWrangler(commandArgs, options = {}) {
  if (!existsSync(wranglerEntry)) throw new Error("Wrangler 未安装，请先运行 npm ci");
  // Never let a repository-local `.wrangler/cache/wrangler-account.json`
  // override the explicitly selected OAuth profile/account. All resource and
  // deployment commands run from the isolated temporary deployment directory.
  return run(process.execPath, [wranglerEntry, ...commandArgs], {
    ...options,
    cwd: options.cwd ?? (temporaryDirectory || root),
  });
}

function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function parseWranglerJSON(output) {
  const firstArray = output.indexOf("[");
  const lastArray = output.lastIndexOf("]");
  const firstObject = output.indexOf("{");
  const lastObject = output.lastIndexOf("}");
  const candidates = [];
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(output.slice(firstArray, lastArray + 1));
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(output.slice(firstObject, lastObject + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try next bounded JSON value */ }
  }
  throw new Error("Wrangler 返回了无法解析的 JSON");
}

/** Return normalized names from a legacy R2 bucket-list JSON response.
 * Kept exported for compatibility with local deployment-helper fixtures; the
 * deploy path below intentionally uses the single-bucket `info --json` API. */
export function r2BucketNames(output) {
  const parsed = parseWranglerJSON(output);
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.buckets) ? parsed.buckets : [];
  return new Set(entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const name = String(entry.name ?? entry.bucket_name ?? "").trim().toLowerCase();
    return name ? [name] : [];
  }));
}

/** Build the exact Wrangler command used for the R2 existence check. */
export function r2BucketInfoArgs(bucketName) {
  const normalized = String(bucketName ?? "").trim().toLowerCase();
  assertR2BucketName(normalized);
  return ["r2", "bucket", "info", normalized, "--json"];
}

/** Extract the canonical bucket name from `wrangler r2 bucket info --json`. */
export function r2BucketInfoName(output) {
  const parsed = parseWranglerJSON(String(output ?? ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("R2_INFO_INVALID_RESPONSE");
  }
  const name = String(parsed.name ?? parsed.bucket_name ?? "").trim().toLowerCase();
  if (!name) throw new Error("R2_INFO_INVALID_RESPONSE");
  return name;
}

/** Classify bounded Wrangler output without exposing it in user-facing errors. */
export function classifyR2BucketFailure(output) {
  const text = String(output ?? "").slice(0, 20_000);
  if (/(?:unknown|unrecognized|unrecognised|unsupported|invalid)\s+(?:argument|option|flag)[^\n]*\b(?:json|--json)\b|(?:unknown|unsupported)\s+.*\b--json\b/iu.test(text)) {
    return "R2_CLI_UNSUPPORTED";
  }
  if (/\b10042\b|\b(?:r2|object\s+storage)\b[^\n]{0,120}\b(?:not\s+enabled|disabled|enable\s+r2)\b|\b(?:not\s+enabled|disabled)\b[^\n]{0,120}\b(?:r2|object\s+storage)\b/iu.test(text)) {
    return "R2_NOT_ENABLED";
  }
  if (/\b10006\b|\b(?:r2\s+)?bucket\b[^\n]{0,120}\b(?:not\s+found|does\s+not\s+exist|doesn't\s+exist|not\s+exist|no\s+such)\b|\b(?:not\s+found|does\s+not\s+exist|doesn't\s+exist|no\s+such)\b[^\n]{0,120}\b(?:r2\s+)?bucket\b/iu.test(text)) {
    return "R2_BUCKET_NOT_FOUND";
  }
  if (/\b(?:403|10007|10013)\b|\b(?:forbidden|permission|not\s+authorized|unauthorized|access\s+denied)\b/iu.test(text)) {
    return "R2_PERMISSION_DENIED";
  }
  return "R2_CHECK_FAILED";
}

function r2CheckError(accountId, bucketName, code, cause) {
  const descriptions = {
    R2_CLI_UNSUPPORTED: "当前 Wrangler 不支持 `r2 bucket info --json`，请升级到支持该命令的 Wrangler 版本后重试",
    R2_NOT_ENABLED: "当前 Cloudflare 账号尚未启用 R2，未绑定归档桶；请先启用 R2 或省略 --archive-bucket",
    R2_BUCKET_NOT_FOUND: `同一账号中不存在指定 R2 桶 ${bucketName}；请先创建该桶，或省略 --archive-bucket`,
    R2_PERMISSION_DENIED: "当前 OAuth/API 权限无法读取指定 R2 桶；请重新授权包含 R2 读取权限的账号",
    R2_INFO_INVALID_RESPONSE: "Wrangler 返回的 R2 桶信息不是有效的 JSON 对象；已停止部署以避免绑定未知资源",
    R2_INFO_MISMATCH: "Wrangler 返回的桶名称与请求不一致；已停止部署以避免绑定未知资源",
    R2_CHECK_FAILED: "R2 桶存在性检查失败，未能安全判定原因；已停止部署，请检查 Wrangler 输出后重试",
  };
  const failure = new Error(`${code}: Cloudflare 账号尾号 ${accountId.slice(-4)}：${descriptions[code] ?? descriptions.R2_CHECK_FAILED}`, { cause });
  failure.code = code;
  return failure;
}

/** Fail closed when an optional archive bucket is missing from the explicitly
 * authorized account. The deployer never creates or switches R2 buckets. */
function ensureR2Bucket(accountId, bucketName) {
  const expected = String(bucketName).trim().toLowerCase();
  const commandArgs = r2BucketInfoArgs(expected);
  let output;
  try {
    output = runWrangler(commandArgs, { capture: true, quiet: true, timeoutMs: 60_000 });
  } catch (cause) {
    const diagnostic = [cause?.stdout, cause?.stderr, cause?.message].filter(Boolean).join("\n");
    throw r2CheckError(accountId, expected, classifyR2BucketFailure(diagnostic), cause);
  }
  let actual;
  try {
    actual = r2BucketInfoName(output);
  } catch (cause) {
    throw r2CheckError(accountId, expected, "R2_INFO_INVALID_RESPONSE", cause);
  }
  if (actual !== expected) {
    throw r2CheckError(accountId, expected, "R2_INFO_MISMATCH", new Error(`Wrangler returned ${actual}`));
  }
}

export function deployedVersionId(output) {
  const parsed = parseWranglerJSON(output);
  const deployments = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.deployments) ? parsed.deployments : [];
  const latest = deployments.reduce((selected, candidate) => {
    if (!selected) return candidate;
    const selectedAt = Date.parse(String(selected?.created_on ?? ""));
    const candidateAt = Date.parse(String(candidate?.created_on ?? ""));
    if (Number.isFinite(candidateAt) && (!Number.isFinite(selectedAt) || candidateAt > selectedAt)) return candidate;
    // Wrangler currently emits oldest-to-newest. If timestamps are absent or
    // invalid, prefer the later array entry rather than the oldest deployment.
    if (!Number.isFinite(candidateAt) && !Number.isFinite(selectedAt)) return candidate;
    return selected;
  }, null);
  const versions = Array.isArray(latest?.versions) ? latest.versions : [];
  const activeVersion = versions.reduce((selected, candidate) => {
    if (typeof candidate?.version_id !== "string") return selected;
    return !selected || Number(candidate.percentage ?? 0) > Number(selected.percentage ?? 0) ? candidate : selected;
  }, null);
  const versionId = activeVersion?.version_id
    ?? (typeof latest?.version_id === "string" ? latest.version_id : "");
  if (!/^[0-9a-f-]{32,36}$/iu.test(versionId)) throw new Error("无法从 Wrangler deployment 清单确认当前生产 version ID");
  return versionId;
}

export function deployedBaseURL(output, domain) {
  if (domain) return `https://${domain}`;
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/giu) ?? [];
  const url = urls.at(-1) ?? "";
  if (!url) throw new Error("Wrangler 未返回 workers.dev 地址，无法执行部署后健康检查");
  return url.replace(/\/$/u, "");
}

export async function verifyDeployment(baseURL, options = {}) {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const delayMs = options.delayMs ?? 2_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const expectedVersionId = String(options.expectedVersionId ?? "").trim();
  let last = "";
  let definitiveFailure = "";
  // A brand-new workers.dev hostname can lag behind the successful version
  // upload for several seconds. Give DNS/edge propagation a bounded window so
  // a valid first deployment is not reported as failed immediately.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const probeURL = `${baseURL}/api/health?deployment_probe=${Date.now()}-${attempt}`;
      const response = await fetchImpl(probeURL, {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache, no-store",
          Pragma: "no-cache",
          "User-Agent": "m365-gateway-deploy-smoke/1",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (response.ok) {
        let value;
        try { value = JSON.parse(body); } catch { /* validated below */ }
        if (value && typeof value === "object") {
          const reportedVersion = String(value.version ?? response.headers.get("X-M365-Worker-Version") ?? "").trim();
          if (!expectedVersionId || reportedVersion === expectedVersionId) {
            return { verified: true, reason: "", ...(reportedVersion ? { versionId: reportedVersion } : {}) };
          }
          definitiveFailure = `健康接口版本不匹配（期望 ${expectedVersionId}，实际 ${reportedVersion || "missing"}）`;
        } else definitiveFailure = "健康接口没有返回 JSON";
      } else definitiveFailure = `健康接口返回 HTTP ${response.status}`;
      last = definitiveFailure;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  // A DNS/VPN/firewall failure says nothing about the deployed Worker. Only a
  // real HTTP response with invalid status/body is evidence for rollback.
  if (!definitiveFailure) return { verified: false, reason: last || "network unavailable" };
  throw new Error(`部署后健康检查失败：${definitiveFailure}`);
}

function configuredSecretNames(configPath) {
  const output = runWrangler(["secret", "list", "--config", configPath, "--format", "json"], { capture: true });
  const parsed = parseWranglerJSON(output);
  if (!Array.isArray(parsed)) throw new Error("Wrangler Secret 清单格式无效");
  return new Set(parsed.flatMap((item) => item && typeof item === "object" && typeof item.name === "string" ? [item.name] : []));
}

async function ask(question, fallback = "") {
  if (args.yes) return fallback;
  if (!rl) throw new Error("部署器交互终端尚未初始化");
  const suffix = fallback ? ` [${fallback}]` : "";
  return (await rl.question(`${question}${suffix}: `)).trim() || fallback;
}

function assertWorkerName(value) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    throw new Error("Worker 名称只能使用小写字母、数字和连字符，长度 1–63，首尾不能是连字符");
  }
}

function assertClientId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("M365 Client ID 必须是 Microsoft Entra Application (client) ID 的 GUID 格式");
  }
}

function assertKvId(value) {
  if (!/^[0-9a-f]{32}$/iu.test(value) || /^0{32}$/u.test(value)) {
    throw new Error("已有部署必须提供原 SENSITIVE_KV 的 32 位十六进制 ID，不能使用全零占位符");
  }
}

function assertAccountId(value) {
  if (!/^[0-9a-f]{32}$/iu.test(value)) {
    throw new Error("Cloudflare Account ID 必须是 32 位十六进制字符串");
  }
}

function assertR2BucketName(value) {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(value)) {
    throw new Error("R2 归档桶名称必须是 3–63 位小写字母、数字或连字符，首尾不能是连字符");
  }
}

function normalizeDomain(value) {
  if (!value) return "";
  const normalized = value.toLowerCase().replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  if (normalized.includes("/") || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(normalized)) {
    throw new Error("自定义域名格式无效，请只填写类似 api.example.com 的主机名");
  }
  return normalized;
}

export function configFor({ workerName, clientId, kvId, domain, accountId = "", canonicalBundle = "", archiveBucket = "" }) {
  const config = {
    name: workerName,
    main: canonicalBundle || path.join(root, "src", "index.ts"),
    ...(canonicalBundle ? { no_bundle: true } : {}),
    compatibility_date: "2026-08-22",
    compatibility_flags: ["enable_request_signal"],
    placement: { mode: "smart" },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    workers_dev: true,
    preview_urls: true,
    assets: {
      directory: path.join(root, "web"),
      binding: "ASSETS",
      // Only protected pages and API routes need Worker-first processing.
      // Other files can be served by the free, globally cached Assets path;
      // routing every asset through the Worker wastes CPU and adds latency.
      run_worker_first: ["/", "/index.html", "/login", "/login.html", "/api/*", "/v1/*"],
      html_handling: "none",
      not_found_handling: "none",
    },
    kv_namespaces: [{ binding: "SENSITIVE_KV", ...(kvId ? { id: kvId } : {}) }],
    durable_objects: {
      bindings: [
        { name: "TENANTS", class_name: "TenantState" },
        { name: "CHATS", class_name: "ChatSession" },
        { name: "INFERENCE", class_name: "InferenceGateway" },
      ],
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["TenantState", "ChatSession"] },
      { tag: "v2", new_sqlite_classes: ["InferenceGateway"] },
    ],
    vars: {
      ENVIRONMENT: "production",
      TENANT_NAME: "default",
      MAX_ACCOUNTS: "40",
      MIGRATION_ENABLED: "false",
      MIGRATION_CANDIDATE_TAG: "account-migration-candidate",
      DIRECT_NATIVE_TOOL_MODE: "true",
      M365_CLIENT_ID: clientId,
      M365_AUTHORITY: "https://login.microsoftonline.com/common",
      M365_REDIRECT_URI: "https://login.microsoftonline.com/common/oauth2/nativeclient",
      M365_SCOPE: "openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite",
    },
    secrets: { required: ["DATA_ENCRYPTION_KEY", "BOOTSTRAP_ADMIN_PASSWORD"] },
    observability: { enabled: true, head_sampling_rate: 1 },
    triggers: { crons: ["0 */2 * * *"] },
  };
  if (accountId) config.account_id = accountId;
  if (domain) config.routes = [{ pattern: domain, custom_domain: true }];
  if (archiveBucket) {
    assertR2BucketName(archiveBucket);
    config.r2_buckets = [{ binding: "R2_ARCHIVE", bucket_name: archiveBucket }];
  }
  return config;
}

async function ensureDependencies() {
  if (existsSync(wranglerEntry)) return;
  console.log("\n[1/7] 安装锁定版本依赖…");
  runNpm(["ci"]);
}

export function assertAuthorizedCloudflareAccount(identity, accountId) {
  const expected = accountId.toLowerCase();
  const accountIds = Array.isArray(identity?.accounts)
    ? identity.accounts.map((entry) => String(entry?.id ?? "").toLowerCase())
    : [];
  if (!accountIds.includes(expected)) {
    throw new Error(`当前 OAuth 未授权目标 Cloudflare 账号（尾号 ${accountId.slice(-4)}），已停止部署以防串号`);
  }
}

function cloudflareIdentityProbe() {
  const probe = spawnSync(process.execPath, [wranglerEntry, "whoami", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 180_000,
  });
  if (probe.error?.code === "ETIMEDOUT") throw new Error("Cloudflare 登录探测超过 180 秒，已终止；请检查网络后重试");
  if (probe.error) throw probe.error;
  return probe;
}

async function ensureCloudflareLogin(accountId) {
  console.log("\n[2/7] 检查 Cloudflare 登录…");
  let probe = cloudflareIdentityProbe();
  if (probe.status !== 0) {
    console.log("尚未登录，将打开 Cloudflare 官方授权页面。");
    runWrangler(["login"]);
    probe = cloudflareIdentityProbe();
  }
  if (probe.status !== 0) throw new Error("Cloudflare 登录验证失败");
  let identity;
  try { identity = JSON.parse(probe.stdout); } catch { throw new Error("Cloudflare 登录探测未返回有效 JSON，已停止部署"); }
  assertAuthorizedCloudflareAccount(identity, accountId);
  console.log(`Cloudflare 账号已锁定：尾号 ${accountId.slice(-4)}`);
}

async function main() {
  rl = createInterface({ input: process.stdin, output: process.stdout });
  if (args.help) {
    showHelp();
    return;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) throw new Error(`需要 Node.js 20 或更高版本，当前为 ${process.version}`);
  for (const required of ["package.json", "wrangler.jsonc", "src", "web"]) {
    if (!existsSync(path.join(root, required))) throw new Error(`项目文件不完整：缺少 ${required}`);
  }

  const workerName = args.name ?? await ask("Worker 名称", "m365-gateway-cf");
  const clientId = args.client_id ?? await ask("Microsoft Entra Application (client) ID", args.dryRun ? "00000000-0000-4000-8000-000000000001" : "");
  const accountId = (args.account_id ?? (args.dryRun ? "" : await ask("Cloudflare Account ID", ""))).toLowerCase();
  const domain = normalizeDomain(args.domain ?? await ask("自定义域名（可留空）", ""));
  const archiveBucket = String(args.archive_bucket ?? process.env.M365_R2_ARCHIVE_BUCKET ?? "").trim().toLowerCase();
  const canonicalBundle = args.canonical_bundle ? path.resolve(args.canonical_bundle) : "";
  assertWorkerName(workerName);
  assertClientId(clientId);
  if (!args.dryRun || accountId) assertAccountId(accountId);
  if (archiveBucket) assertR2BucketName(archiveBucket);
  if (canonicalBundle && !existsSync(canonicalBundle)) throw new Error(`指定的线上基准模块不存在：${canonicalBundle}`);

  if (args.yes && !args.dryRun && !args.client_id) throw new Error("--yes 模式必须同时提供 --client-id");
  if (args.yes && !args.dryRun && !args.account_id) throw new Error("--yes 模式必须同时提供 --account-id，禁止从旧配置猜测部署账号");
  if (args.update && args.yes && !args.kv_id) throw new Error("无人值守更新必须同时提供 --kv-id，禁止生成新 KV 覆盖旧绑定");

  // Wrangler also consults cached account metadata outside the generated
  // config. Pin every child process to the requested account so a valid OAuth
  // token from another profile cannot silently target the wrong account.
  if (accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  await ensureDependencies();
  if (!args.dryRun) await ensureCloudflareLogin(accountId);

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "m365-gateway-cf-"));
  const configPath = path.join(temporaryDirectory, "wrangler.deploy.json");
  const secretPath = path.join(temporaryDirectory, "secrets.json");
  let kvId = args.kv_id ?? "";
  let bootstrapPassword = "";
  let secretsForDeploy = {};
  let previousVersionId = "";

  if (archiveBucket && !args.dryRun) {
    console.log("检查 R2 归档桶是否属于已锁定的 Cloudflare 账号…");
    ensureR2Bucket(accountId, archiveBucket);
    console.log("R2 归档桶校验通过。");
  }

  if (args.update) {
    if (!kvId || /^0{32}$/u.test(kvId)) kvId = await ask("粘贴现有 SENSITIVE_KV namespace ID", "");
    assertKvId(kvId);
  }

  if (args.syncApiKey) {
    const gatewayAPIKey = String(process.env.M365_GATEWAY_API_KEY ?? "").trim();
    if (!/^m365_[A-Za-z0-9_-]{24,128}$/u.test(gatewayAPIKey)) {
      throw new Error("--sync-api-key 要求 M365_GATEWAY_API_KEY 存在且格式有效");
    }
    secretsForDeploy.BOOTSTRAP_GATEWAY_API_KEY = gatewayAPIKey;
    console.log("统一客户端 API Key 已加入临时 Secret 清单；命令输出和项目文件均不写入明文。");
  }

  if (args.resetAdminPassword) {
    if (!args.update) throw new Error("--reset-admin-password 只能用于更新现有 Worker");
    const adminPassword = String(process.env.M365_ADMIN_PASSWORD ?? "").trim();
    if (adminPassword.length < 8 || adminPassword.length > 128) {
      throw new Error("--reset-admin-password 要求 M365_ADMIN_PASSWORD 为 8–128 个字符");
    }
    secretsForDeploy.BOOTSTRAP_ADMIN_PASSWORD = adminPassword;
    secretsForDeploy.ADMIN_PASSWORD_RESET_VERSION = randomSecret(24);
    console.log("管理员密码恢复 Secret 已加入临时部署清单；不会写入命令参数、项目文件或部署日志。");
  }

  await writeFile(configPath, `${JSON.stringify(configFor({ workerName, clientId, kvId, domain, accountId, canonicalBundle, archiveBucket }), null, 2)}\n`, { mode: 0o600 });

  if (archiveBucket) {
    console.log(`已启用可选 R2 冷归档绑定：${archiveBucket}（必须是当前账号中已存在的桶；不会把归档放入请求热路径）。`);
  }

  if (args.dryRun) {
    console.log("\n[DRY RUN] 只验证 Worker 构建，不访问 Cloudflare 资源。");
    runWrangler(["deploy", "--config", configPath, "--dry-run"]);
    return;
  }

  if (!args.update) {
    if (kvId) {
      assertKvId(kvId);
      console.log("\n[3/7] 复用已存在但尚未绑定部署的 SENSITIVE_KV。");
    } else {
      console.log("\n[3/7] 创建独立的 SENSITIVE_KV…");
      runWrangler(["kv", "namespace", "create", `${workerName}-sensitive`, "--binding", "SENSITIVE_KV", "--update-config", "--config", configPath]);
      const updated = JSON.parse(await readFile(configPath, "utf8"));
      kvId = updated?.kv_namespaces?.find((entry) => entry.binding === "SENSITIVE_KV")?.id ?? "";
      assertKvId(kvId);
      console.log("KV 已创建并仅写入临时部署配置。");
    }

    console.log("\n[4/7] 生成 DATA_ENCRYPTION_KEY…");
    bootstrapPassword = randomSecret(24);
    secretsForDeploy = {
      ...secretsForDeploy,
      DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
    };
    console.log("加密密钥和随机初始管理员密码已生成；不会写入项目目录。");
  } else {
    console.log("\n[3/7] 更新模式：检查并复用现有 KV 与 Secret。");
    previousVersionId = deployedVersionId(runWrangler(["deployments", "list", "--config", configPath, "--json"], { capture: true }));
    console.log(`已记录当前生产版本：${previousVersionId}`);
    const secretNames = configuredSecretNames(configPath);
    if (!secretNames.has("DATA_ENCRYPTION_KEY")) {
      throw new Error("现有 Worker 缺少 DATA_ENCRYPTION_KEY；为避免破坏已有 OAuth 密文，已停止更新");
    }
    if (!secretNames.has("BOOTSTRAP_ADMIN_PASSWORD")) {
      bootstrapPassword = randomSecret(24);
      secretsForDeploy = { ...secretsForDeploy, BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword };
      console.log("现有 Worker 缺少新的引导密码 Secret；已生成随机值。已有管理员密码不会被覆盖。");
    }
  }

  if (Object.keys(secretsForDeploy).length > 0) {
    await writeFile(secretPath, `${JSON.stringify(secretsForDeploy)}\n`, { mode: 0o600 });
  }

  console.log("\n[5/7] 执行 TypeScript、后台契约、Worker 回归测试和部署 dry-run…");
  if (canonicalBundle) {
    run(process.execPath, ["--check", canonicalBundle]);
    console.log("线上基准模块语法检查通过；跳过与该预构建模块无关的本地源码重编译。");
  } else {
    runNpm(["run", "check:no-docs"]);
    runNpm(["run", "typecheck"]);
    runNpm(["run", "check:ui"]);
    runNpm(["test"]);
  }
  runWrangler(["deploy", "--config", configPath, "--dry-run"]);

  console.log("\n[6/7] 部署 Cloudflare Worker…");
  const deployArgs = ["deploy", "--config", configPath, "--keep-vars", "--message", "one-click Cloudflare deployment"];
  if (Object.keys(secretsForDeploy).length > 0) deployArgs.push("--secrets-file", secretPath);
  const deployOutput = runWrangler(deployArgs, { capture: true });

  const deployedVersion = deployedVersionId(runWrangler(["deployments", "list", "--config", configPath, "--json"], { capture: true }));
  if (args.update && previousVersionId && deployedVersion === previousVersionId) {
    throw new Error("部署命令返回成功，但 Cloudflare 生产版本未发生变化；已停止后续成功声明");
  }
  console.log(`Cloudflare 新生产版本：${deployedVersion}`);

  const baseURL = deployedBaseURL(deployOutput, domain);
  console.log(`正在验证：${baseURL}/api/health`);
  let healthVerified = false;
  let healthTransportIssue = "";
  try {
    // Custom-domain and Smart Placement propagation can legitimately take
    // longer than the upload command. Wait up to roughly forty seconds before
    // deciding that a version mismatch is a real failed release.
    const health = await verifyDeployment(baseURL, { attempts: 20, expectedVersionId: deployedVersion });
    healthVerified = health.verified;
    healthTransportIssue = health.reason;
  } catch (error) {
    if (args.update && previousVersionId) {
      console.error("新版本健康检查失败，正在回滚到部署前版本…");
      runWrangler(["rollback", previousVersionId, "--config", configPath, "--yes", "--message", "automatic rollback after failed health check"]);
      throw new Error(`${error instanceof Error ? error.message : String(error)}；已回滚到 ${previousVersionId}`);
    }
    // The upload already succeeded before this health check. Never discard the
    // only copy of a fresh deployment's bootstrap password merely because the
    // new workers.dev hostname has not propagated yet.
    if (bootstrapPassword) {
      console.error(`Worker 已上传，但健康检查尚未通过。请立即保存初始管理员密码（仅显示一次）：${bootstrapPassword}`);
    }
    throw error;
  }

  console.log("\n[7/7] 部署完成");
  console.log(`Worker：${workerName}`);
  console.log(`版本：${deployedVersion}`);
  if (healthVerified) console.log(`健康检查：${baseURL}/api/health（通过）`);
  else console.warn(`健康检查：本机网络无法访问 workers.dev（${healthTransportIssue}）；版本已发布，需从其他网络验证 ${baseURL}/api/health`);
  if (domain) console.log(`管理后台：https://${domain}/`);
  else console.log("管理后台地址请使用上方 Wrangler 输出的 workers.dev URL。");
  if (bootstrapPassword) console.log(`本次生成的初始管理员密码（仅显示一次）：${bootstrapPassword}`);
  else console.log("管理员密码沿用现有 Durable Object 状态。");
  console.log("首次登录后必须立即修改管理员密码，然后添加 Microsoft 365 账号并创建 API Key。");
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  try {
    await main();
  } catch (error) {
    console.error(`\n部署失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    rl?.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
