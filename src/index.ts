import gateway from "./gateway-handler";
import { runCloudCleanup } from "./cloud-cleanup";
import type { Env } from "./types";

export { ChatSession } from "./chat-session";
export { TenantState } from "./tenant-state";
export { InferenceGateway } from "./inference-gateway";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/v1/") && !(path === "/v1/models" && request.method === "GET")) {
      // No JSON parsing, conversation hashing, SSE decoding or terminal metrics
      // on the 10 ms free-plan ingress. Stream both directions unchanged.
      // One transient object per HTTP request avoids a shared adapter queue;
      // conversation identity and leases remain in the existing CHATS objects.
      return env.INFERENCE.get(env.INFERENCE.newUniqueId()).fetch(request);
    }
    return gateway.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCloudCleanup(env, false));
  },
} satisfies ExportedHandler<Env>;

