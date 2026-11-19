import { handleAuthRequest } from "@reranker/auth/server";
import { captureServerEvent } from "@reranker/telemetry";
import { toNextJsHandler } from "better-auth/next-js";

const handler = toNextJsHandler(handleAuthRequest);

export const { GET } = handler;

// The rate limiter answers before any Better Auth hook runs, so only the response shows a refusal.
export async function POST(request: Request): Promise<Response> {
  const response = await handler.POST(request);
  if (response.status === 429) {
    captureServerEvent(
      { name: "auth_rate_limited", props: { route: new URL(request.url).pathname } },
      { headers: request.headers, subject: { system: true } },
    );
  }
  return response;
}
