import { spendDay, startOnce } from "@reranker/jobs";
import { start } from "workflow/api";
import { hasCronBearer } from "../../../../lib/ops-guard";
import { dailyMaintenanceWorkflow } from "../../../../workflows/maintenance/daily";

/**
 * Vercel Cron calls this once a day with `Authorization: Bearer $CRON_SECRET`. A delivery can be
 * repeated, so the run is claimed per Bogota date; anything without the bearer is turned away
 * before the database is touched. Reading the request headers keeps it out of prerendering.
 */
export async function GET(req: Request): Promise<Response> {
  if (!hasCronBearer(req)) return new Response(null, { status: 401 });
  const date = spendDay();
  const { runId, created } = await startOnce("daily", date, async () => {
    const run = await start(dailyMaintenanceWorkflow, [date]);
    return { runId: run.runId };
  });
  return Response.json({ runId, created });
}
