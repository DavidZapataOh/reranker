import { startOnce } from "@reranker/jobs";
import { start } from "workflow/api";
import { hasCronBearer } from "../../../../lib/ops-guard";
import { hourlyEvidenceWorkflow } from "../../../../workflows/evidence/hourly";

/**
 * Vercel Cron calls this at the top of every hour with `Authorization: Bearer $CRON_SECRET`. A
 * delivery can be repeated, so the run is claimed per UTC hour; anything without the bearer is
 * turned away before the database is touched.
 */
export async function GET(req: Request): Promise<Response> {
  if (!hasCronBearer(req)) return new Response(null, { status: 401 });
  const hourKey = new Date().toISOString().slice(0, 13);
  const { runId, created } = await startOnce("evidence-hourly", hourKey, async () => {
    const run = await start(hourlyEvidenceWorkflow, [hourKey]);
    return { runId: run.runId };
  });
  return Response.json({ runId, created });
}
