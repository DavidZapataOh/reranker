import { z } from "@reranker/schema";
import {
  type DesiredAlert,
  findInsight,
  planAlerts,
  RemoteAlertSchema,
  RemoteInsightSchema,
} from "./alerts-plan";
import type { createPostHogRest } from "./posthog-rest";

const Created = z.object({ id: z.number() });

/**
 * Reconciles PostHog with the definitions. Insights go first because alerts point at their ids.
 * Needs a personal API key with `insight:read`, `insight:write`, `alert:read` and `alert:write`.
 */
export async function applyAlerts(
  rest: ReturnType<typeof createPostHogRest>,
  desired: DesiredAlert[],
  options: { dryRun: boolean; maxAlerts: number; log: (line: string) => void },
): Promise<void> {
  const [alerts, insights] = await Promise.all([
    rest.list("alerts/", RemoteAlertSchema),
    rest.list("insights/?saved=true", RemoteInsightSchema),
  ]);
  const plan = planAlerts(desired, alerts, insights, options.maxAlerts);
  const { log } = options;

  for (const i of plan.createInsights) log(`create insight "${i.name}"`);
  for (const i of plan.patchInsights) log(`patch insight ${i.short_id} "${i.name}"`);
  for (const a of plan.createAlerts) log(`create alert "${a.name}"`);
  for (const a of plan.patchAlerts) log(`patch alert "${a.name}" (${a.id})`);
  const changes =
    plan.createInsights.length +
    plan.patchInsights.length +
    plan.createAlerts.length +
    plan.patchAlerts.length;
  if (changes === 0) log("nothing to do");
  if (options.dryRun || changes === 0) return;

  const insightIds = new Map<string, number>();
  for (const i of plan.createInsights) {
    const body = { name: i.name, query: i.query };
    insightIds.set(i.desiredId, Created.parse(await rest.send("insights/", "POST", body)).id);
  }
  for (const i of plan.patchInsights) {
    await rest.send(`insights/${i.id}/`, "PATCH", { name: i.name, query: i.query });
  }
  for (const { desiredId, ...body } of plan.createAlerts) {
    const d = desired.find((x) => x.id === desiredId);
    const insight = insightIds.get(desiredId) ?? (d && findInsight(d.insight, insights)?.id);
    if (insight === undefined) throw new Error(`No insight for alert ${desiredId}`);
    await rest.send("alerts/", "POST", { ...body, insight });
  }
  for (const { id, ...body } of plan.patchAlerts) {
    await rest.send(`alerts/${id}/`, "PATCH", body);
  }
  log(`applied ${changes} change(s)`);
}
