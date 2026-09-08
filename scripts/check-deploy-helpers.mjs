import assert from "node:assert/strict";
import {
  assertAuthorizedCloudflareAccount,
  classifyR2BucketFailure,
  configFor,
  deployedBaseURL,
  deployedVersionId,
  r2BucketInfoArgs,
  r2BucketInfoName,
  r2BucketNames,
  verifyDeployment,
} from "../deploy-cloudflare.mjs";

const deployments = JSON.stringify([
  {
    created_on: "2026-08-27T00:01:00Z",
    versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
  },
  {
    created_on: "2026-08-27T07:18:00Z",
    versions: [
      { version_id: "33333333-3333-4333-8333-333333333333", percentage: 10 },
      { version_id: "22222222-2222-4222-8222-222222222222", percentage: 90 },
    ],
  },
]);

assert.equal(deployedVersionId(deployments), "22222222-2222-4222-8222-222222222222");
assert.equal(
  deployedBaseURL("Uploaded https://example-worker.example.workers.dev\n", ""),
  "https://example-worker.example.workers.dev",
);
assert.equal(deployedBaseURL("no public URL required", "api.example.com"), "https://api.example.com");

const generatedConfig = configFor({
  workerName: "example-worker",
  clientId: "00000000-0000-4000-8000-000000000001",
  kvId: "11111111111111111111111111111111",
  accountId: "22222222222222222222222222222222",
  domain: "api.example.com",
});
assert.deepEqual(generatedConfig.compatibility_flags, ["enable_request_signal"]);
assert.deepEqual(generatedConfig.placement, { mode: "smart" });
assert.ok(generatedConfig.durable_objects.bindings.some((binding) =>
  binding.name === "INFERENCE" && binding.class_name === "InferenceGateway"));
assert.deepEqual(generatedConfig.migrations, [
  { tag: "v1", new_sqlite_classes: ["TenantState", "ChatSession"] },
  { tag: "v2", new_sqlite_classes: ["InferenceGateway"] },
]);
assert.equal(generatedConfig.account_id, "22222222222222222222222222222222");
assert.deepEqual(generatedConfig.assets.run_worker_first, [
  "/", "/index.html", "/login", "/login.html", "/api/*", "/v1/*",
]);
const canonicalConfig = configFor({
  workerName: "example-worker",
  clientId: "00000000-0000-4000-8000-000000000001",
  kvId: "11111111111111111111111111111111",
  domain: "api.example.com",
  canonicalBundle: "C:/verified/index.js",
});
assert.equal(canonicalConfig.main, "C:/verified/index.js");
assert.equal(canonicalConfig.no_bundle, true);
const archiveConfig = configFor({
  workerName: "example-worker",
  clientId: "00000000-0000-4000-8000-000000000001",
  kvId: "11111111111111111111111111111111",
  archiveBucket: "m365-gateway-cf2-archive",
});
assert.deepEqual(archiveConfig.r2_buckets, [{ binding: "R2_ARCHIVE", bucket_name: "m365-gateway-cf2-archive" }]);
assert.deepEqual(
  [...r2BucketNames("info\n[{\"name\":\"M365-Gateway-CF2-Archive\"},{\"bucket_name\":\"other\"}]")].sort(),
  ["m365-gateway-cf2-archive", "other"],
);
// Keep the deployment guard tied to Wrangler's supported single-bucket
// command. This exact argv assertion prevents a regression to the removed
// `r2 bucket list --json` form (Wrangler 4.125 rejects that flag).
assert.deepEqual(
  r2BucketInfoArgs("M365-Gateway-CF2-Archive"),
  ["r2", "bucket", "info", "m365-gateway-cf2-archive", "--json"],
);
assert.equal(
  r2BucketInfoName('{"name":"M365-Gateway-CF2-Archive","location":"WNAM"}'),
  "m365-gateway-cf2-archive",
);
assert.equal(classifyR2BucketFailure("Unknown argument: json"), "R2_CLI_UNSUPPORTED");
assert.equal(classifyR2BucketFailure("APIError: code 10042 R2 is not enabled for this account"), "R2_NOT_ENABLED");
assert.equal(classifyR2BucketFailure("The R2 bucket [missing] doesn't exist (code 10006)"), "R2_BUCKET_NOT_FOUND");
assert.equal(classifyR2BucketFailure("HTTP 403 Forbidden: permission denied"), "R2_PERMISSION_DENIED");
assert.equal(classifyR2BucketFailure("unexpected transport failure"), "R2_CHECK_FAILED");
assert.throws(() => r2BucketInfoArgs("Not A Valid Bucket"), /R2/u);
assert.throws(
  () => configFor({
    workerName: "example-worker",
    clientId: "00000000-0000-4000-8000-000000000001",
    kvId: "11111111111111111111111111111111",
    archiveBucket: "Not A Valid Bucket",
  }),
  /R2/u,
);
assert.doesNotThrow(() => assertAuthorizedCloudflareAccount({ accounts: [{ id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }] }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
assert.throws(
  () => assertAuthorizedCloudflareAccount({ accounts: [{ id: "11111111111111111111111111111111" }] }, "22222222222222222222222222222222"),
  /未授权目标 Cloudflare 账号/u,
);

assert.deepEqual(
  await verifyDeployment("https://example.invalid", {
    attempts: 2,
    delayMs: 0,
    fetchImpl: async () => { throw new Error("local DNS unavailable"); },
    sleep: async () => {},
  }),
  { verified: false, reason: "local DNS unavailable" },
);
await assert.rejects(
  () => verifyDeployment("https://example.invalid", {
    attempts: 1,
    fetchImpl: async () => new Response("bad", { status: 503 }),
  }),
  /HTTP 503/u,
);
assert.deepEqual(
  await verifyDeployment("https://example.invalid", {
    attempts: 1,
    expectedVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    fetchImpl: async () => Response.json({
      ok: true,
      version: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
  }),
  { verified: true, reason: "", versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
);
{
  const seen = [];
  const result = await verifyDeployment("https://example.invalid", {
    attempts: 2,
    delayMs: 0,
    expectedVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), cacheControl: init?.headers?.["Cache-Control"] });
      return Response.json({
        ok: true,
        version: seen.length === 1
          ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });
    },
  });
  assert.equal(result.verified, true);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].url, seen[1].url);
  assert.match(seen[0].url, /deployment_probe=/u);
  assert.equal(seen[0].cacheControl, "no-cache, no-store");
}
await assert.rejects(
  () => verifyDeployment("https://example.invalid", {
    attempts: 1,
    expectedVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    fetchImpl: async () => Response.json({
      ok: true,
      version: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
  }),
  /版本不匹配/u,
);

console.log("deployment helper checks passed");
