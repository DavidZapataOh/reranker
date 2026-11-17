import { z } from "@reranker/schema";

const Threshold = z.object({
  type: z.enum(["absolute", "percentage"]),
  bounds: z.object({ lower: z.number().nullish(), upper: z.number().nullish() }),
});

const HogQLAlertConfig = z.object({
  type: z.literal("HogQLAlertConfig"),
  column: z.string(),
  evaluation: z.enum(["last_row", "first_row", "any_row"]),
});

const Interval = z.enum(["hourly", "daily", "weekly", "monthly"]);

export const DesiredAlerts = z.array(
  z.object({
    id: z.string(),
    // Read by runbooks:check; PostHog never sees it.
    runbook: z.string().optional(),
    insight: z.object({
      short_id: z.string().optional(),
      name: z.string(),
      query: z.string(),
      date_from: z.string(),
    }),
    alert: z.object({
      name: z.string(),
      calculation_interval: Interval,
      threshold: Threshold,
      config: HogQLAlertConfig,
    }),
  }),
);
export type DesiredAlert = z.output<typeof DesiredAlerts>[number];
type DesiredInsight = DesiredAlert["insight"];

const Query = z
  .object({
    source: z
      .object({
        query: z.string().optional(),
        filters: z
          .object({ dateRange: z.object({ date_from: z.string().nullish() }).nullish() })
          .nullish(),
      })
      .loose()
      .optional(),
  })
  .loose()
  // Legacy insights carry no query at all.
  .nullable()
  .transform((q) => q ?? {});

export const RemoteInsightSchema = z.object({
  id: z.number(),
  short_id: z.string(),
  name: z.string().nullable(),
  query: Query,
});
export type RemoteInsight = z.output<typeof RemoteInsightSchema>;

const UserRef = z.union([z.number(), z.object({ id: z.number() })]);

export const RemoteAlertSchema = z.object({
  id: z.string(),
  name: z.string(),
  insight: z.union([z.number(), z.object({ id: z.number() })]),
  insight_short_id: z.string().optional(),
  enabled: z.boolean(),
  calculation_interval: z.string(),
  threshold: z.object({ configuration: Threshold.nullish() }).nullish(),
  condition: z.object({ type: z.string().optional() }).nullish(),
  config: z.object({ type: z.string().optional() }).loose().nullish(),
  subscribed_users: z.array(UserRef),
});
export type RemoteAlert = z.output<typeof RemoteAlertSchema>;

export type AlertBody = {
  name: string;
  calculation_interval: DesiredAlert["alert"]["calculation_interval"];
  enabled: true;
  threshold: { configuration: DesiredAlert["alert"]["threshold"] };
  condition: { type: "absolute_value" };
  config: DesiredAlert["alert"]["config"];
};

export type Plan = {
  createInsights: { desiredId: string; name: string; query: ReturnType<typeof insightQuery> }[];
  patchInsights: {
    id: number;
    short_id: string;
    name: string;
    query: ReturnType<typeof insightQuery>;
  }[];
  createAlerts: (AlertBody & { desiredId: string; subscribed_users: number[] })[];
  patchAlerts: (AlertBody & { id: string })[];
};

/** A saved SQL insight whose date range comes from the `{filters}` placeholder. */
export function insightQuery(insight: DesiredInsight) {
  return {
    kind: "DataVisualizationNode" as const,
    source: {
      kind: "HogQLQuery" as const,
      query: insight.query,
      filters: { dateRange: { date_from: insight.date_from } },
    },
  };
}

const userId = (u: z.output<typeof UserRef>) => (typeof u === "number" ? u : u.id);
const insightId = (a: RemoteAlert) => (typeof a.insight === "number" ? a.insight : a.insight.id);

export function findInsight(
  desired: DesiredInsight,
  remote: RemoteInsight[],
): RemoteInsight | undefined {
  return remote.find((i) =>
    desired.short_id ? i.short_id === desired.short_id : i.name === desired.name,
  );
}

function findAlert(
  d: DesiredAlert,
  insight: RemoteInsight | undefined,
  remote: RemoteAlert[],
): RemoteAlert | undefined {
  const onInsight = insight && remote.find((a) => insightId(a) === insight.id);
  return onInsight ?? remote.find((a) => a.name === d.alert.name);
}

function insightDrifted(d: DesiredInsight, remote: RemoteInsight): boolean {
  const source = remote.query.source;
  return (
    remote.name !== d.name ||
    source?.query !== d.query ||
    source?.filters?.dateRange?.date_from !== d.date_from
  );
}

function alertDrifted(d: DesiredAlert["alert"], remote: RemoteAlert): boolean {
  const t = remote.threshold?.configuration;
  const c = remote.config;
  return (
    !remote.enabled ||
    remote.name !== d.name ||
    remote.calculation_interval !== d.calculation_interval ||
    remote.condition?.type !== "absolute_value" ||
    t?.type !== d.threshold.type ||
    (t.bounds.lower ?? null) !== (d.threshold.bounds.lower ?? null) ||
    (t.bounds.upper ?? null) !== (d.threshold.bounds.upper ?? null) ||
    c?.type !== d.config.type ||
    c.column !== d.config.column ||
    c.evaluation !== d.config.evaluation
  );
}

function alertBody(d: DesiredAlert["alert"]): AlertBody {
  return {
    name: d.name,
    calculation_interval: d.calculation_interval,
    enabled: true,
    threshold: { configuration: d.threshold },
    condition: { type: "absolute_value" },
    config: d.config,
  };
}

/**
 * Diffs the desired alerts against what PostHog holds. An existing alert on a desired insight is
 * adopted rather than duplicated, and the plan is empty once everything has been applied.
 * `maxAlerts` is the organization's limit on its PostHog plan.
 */
export function planAlerts(
  desired: DesiredAlert[],
  remoteAlerts: RemoteAlert[],
  remoteInsights: RemoteInsight[],
  maxAlerts: number,
): Plan {
  const plan: Plan = { createInsights: [], patchInsights: [], createAlerts: [], patchAlerts: [] };
  const matches = desired.map((d) => {
    const insight = findInsight(d.insight, remoteInsights);
    return { d, insight, alert: findAlert(d, insight, remoteAlerts) };
  });
  // New alerts notify whoever already receives the alerts being adopted.
  const subscribers = [
    ...new Set(
      (matches.find((m) => m.alert)?.alert ?? remoteAlerts[0])?.subscribed_users.map(userId) ?? [],
    ),
  ];

  for (const { d, insight, alert } of matches) {
    const query = insightQuery(d.insight);
    if (!insight) {
      plan.createInsights.push({ desiredId: d.id, name: d.insight.name, query });
    } else if (insightDrifted(d.insight, insight)) {
      plan.patchInsights.push({
        id: insight.id,
        short_id: insight.short_id,
        name: d.insight.name,
        query,
      });
    }
    if (!alert) {
      plan.createAlerts.push({
        ...alertBody(d.alert),
        desiredId: d.id,
        subscribed_users: subscribers,
      });
    } else if (alertDrifted(d.alert, alert)) {
      plan.patchAlerts.push({ ...alertBody(d.alert), id: alert.id });
    }
  }

  const total = remoteAlerts.length + plan.createAlerts.length;
  if (total > maxAlerts) {
    throw new Error(
      `Applying would leave ${total} insight alerts; the PostHog plan allows ${maxAlerts} in total`,
    );
  }
  return plan;
}
