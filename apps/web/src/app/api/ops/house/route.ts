import { provisionHouseOrganization } from "@reranker/auth/house";
import { appEnv } from "@reranker/env";
import { AppError, Email, fromZodError, z } from "@reranker/schema";
import { log, requestIdFrom } from "@reranker/telemetry";
import { hasCronBearer } from "../../../../lib/ops-guard";
import { problemResponse } from "../../../../lib/problem";

const Body = z.object({ ownerEmail: Email });

async function readBody(req: Request): Promise<{ ownerEmail: string }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (cause) {
    throw new AppError("invalid_request", { detail: "the body is not JSON", cause });
  }
  const parsed = Body.safeParse(raw);
  if (parsed.success) return parsed.data;
  const { fieldErrors } = fromZodError(parsed.error, "body");
  throw new AppError("invalid_request", {
    detail: "Invalid body",
    ...(fieldErrors === undefined ? {} : { fieldErrors }),
  });
}

/**
 * Provisions the house organization `{ ownerEmail }` in, `{ houseId, created }` out. Production
 * database credentials never leave the deployment, so this is how the house is created there.
 * It writes data, so it answers only to the cron bearer in every environment, and production
 * hides it from everyone else.
 */
export async function POST(req: Request): Promise<Response> {
  if (!hasCronBearer(req)) {
    return new Response(null, { status: appEnv() === "production" ? 404 : 401 });
  }
  try {
    const { ownerEmail } = await readBody(req);
    const { id, created } = await provisionHouseOrganization({ ownerEmail });
    // The owner's address is personal data and stays out of the logs.
    log.info("house provisioned", {
      house_id: id,
      created,
      request_id: requestIdFrom(req.headers),
    });
    return Response.json({ houseId: id, created }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return problemResponse(error, req);
  }
}
