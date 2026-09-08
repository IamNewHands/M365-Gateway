import { DurableObject } from "cloudflare:workers";
import gateway from "./gateway-handler";
import type { Env } from "./types";

/** Request-scoped compute only: no credentials, leases or conversation storage. */
export class InferenceGateway extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/v1/")) {
      return new Response("Not found", { status: 404 });
    }
    // Auth, bounded body parsing, native tool schemas and all stream processing
    // execute here under the DO CPU budget. Never trust a caller-supplied
    // internal/auth header. Cancellation travels with the original request.
    const response = await gateway.fetch(request, this.env, this.ctx);
    response.headers.set("X-M365-Execution", "durable-object");
    return response;
  }
}
