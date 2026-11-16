import { start } from "workflow/api";
import { hasCronBearer } from "../../../../lib/ops-guard";
import { pingWorkflow } from "../../../../workflows/diagnostics/ping";

// Starting runs costs workflow quota, so this answers only to the cron bearer in every environment.
export async function POST(req: Request): Promise<Response> {
  if (!hasCronBearer(req)) return new Response(null, { status: 401 });
  const run = await start(pingWorkflow, [crypto.randomUUID()]);
  return Response.json({ runId: run.runId }, { status: 202 });
}
