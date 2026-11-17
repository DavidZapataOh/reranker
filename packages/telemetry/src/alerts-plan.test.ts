import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  type DesiredAlert,
  DesiredAlerts,
  insightQuery,
  planAlerts,
  type RemoteAlert,
  type RemoteInsight,
} from "./alerts-plan";
import { postHogLimits } from "./posthog-plan";

const desired: DesiredAlert[] = DesiredAlerts.parse(
  JSON.parse(readFileSync(new URL("../posthog-alerts.json", import.meta.url), "utf8")),
);
const EMPTY_PLAN = { createInsights: [], patchInsights: [], createAlerts: [], patchAlerts: [] };

const q1Prz3Se: RemoteInsight = {
  id: 41,
  short_id: "Q1Prz3Se",
  name: "Error en reranker.co",
  query: {
    kind: "DataVisualizationNode",
    source: { kind: "HogQLQuery", query: "SELECT count() FROM events" },
  },
};

const existingQ1Prz3SeAlert: RemoteAlert = {
  id: "0190aaaa-0000-7000-8000-000000000001",
  name: "Error en reranker.co",
  insight: 41,
  insight_short_id: "Q1Prz3Se",
  enabled: true,
  calculation_interval: "hourly",
  threshold: { configuration: { type: "absolute", bounds: { upper: 5 } } },
  condition: { type: "absolute_value" },
  config: null,
  subscribed_users: [{ id: 7 }],
};

// What PostHog would hold after one successful apply.
function applied(): { alerts: RemoteAlert[]; insights: RemoteInsight[] } {
  const insights = desired.map((d, i) => ({
    id: 100 + i,
    short_id: d.insight.short_id ?? `short${i}`,
    name: d.insight.name,
    query: insightQuery(d.insight),
  }));
  const alerts = desired.map((d, i) => ({
    id: `0190bbbb-0000-7000-8000-00000000000${i}`,
    name: d.alert.name,
    insight: 100 + i,
    insight_short_id: insights[i]?.short_id,
    enabled: true,
    calculation_interval: d.alert.calculation_interval,
    threshold: { configuration: d.alert.threshold },
    condition: { type: "absolute_value" as const },
    config: { ...d.alert.config, label_column: null },
    subscribed_users: [{ id: 7 }],
  }));
  return { alerts, insights };
}

test("adopts the existing exceptions alert instead of creating a sixth", () => {
  const p = planAlerts(desired, [existingQ1Prz3SeAlert], [q1Prz3Se], 5);
  expect(p.createAlerts.map((a) => a.name)).toEqual(["Alertas de operación", "LCP p75 alto"]);
  expect(p.patchInsights[0]?.short_id).toBe("Q1Prz3Se");
  expect(p.patchAlerts).toHaveLength(1);
  expect(p.patchAlerts[0]).toMatchObject({
    id: existingQ1Prz3SeAlert.id,
    threshold: { configuration: { type: "absolute", bounds: { upper: 0 } } },
    config: { type: "HogQLAlertConfig", evaluation: "first_row" },
  });
  expect(p.createInsights.map((i) => i.name)).toHaveLength(2);
});

test("new alerts notify the people already subscribed to the adopted one", () => {
  const p = planAlerts(desired, [existingQ1Prz3SeAlert], [q1Prz3Se], 5);
  expect(p.createAlerts.every((a) => a.subscribed_users.join() === "7")).toBe(true);
});

test("second run is a no-op", () => {
  const { alerts, insights } = applied();
  expect(planAlerts(desired, alerts, insights, 5)).toEqual(EMPTY_PLAN);
});

test("patches an alert that was disabled or retuned by hand", () => {
  const { alerts, insights } = applied();
  const drifted = alerts.map((a, i) =>
    i === 2 ? { ...a, enabled: false, calculation_interval: "hourly" as const } : a,
  );
  const p = planAlerts(desired, drifted, insights, 5);
  expect(p.patchAlerts.map((a) => a.name)).toEqual(["LCP p75 alto"]);
  expect(p.createAlerts).toEqual([]);
});

test("patches an insight whose query drifted", () => {
  const { alerts, insights } = applied();
  const drifted = insights.map((i, n) =>
    n === 1 ? { ...i, query: { ...i.query, source: { ...i.query.source, query: "SELECT 1" } } } : i,
  );
  const p = planAlerts(desired, alerts, drifted, 5);
  expect(p.patchInsights.map((i) => i.name)).toEqual([desired[1]?.insight.name]);
});

test("refuses to exceed 5 alerts", () => {
  const others: RemoteAlert[] = Array.from({ length: 5 }, (_, i) => ({
    ...existingQ1Prz3SeAlert,
    id: `0190cccc-0000-7000-8000-00000000000${i}`,
    name: `other ${i}`,
    insight: 900 + i,
    insight_short_id: `other${i}`,
  }));
  expect(() => planAlerts(desired, others, [], 5)).toThrow(/5/);
});

test("allows exactly 5 alerts when the others are already there", () => {
  const { alerts, insights } = applied();
  const two: RemoteAlert[] = [0, 1].map((i) => ({
    ...existingQ1Prz3SeAlert,
    id: `0190dddd-0000-7000-8000-00000000000${i}`,
    name: `other ${i}`,
    insight: 800 + i,
    insight_short_id: `other${i}`,
  }));
  expect(planAlerts(desired, [...alerts, ...two], insights, 5)).toEqual(EMPTY_PLAN);
});

test("the definitions file holds three alerts on production events with filters", () => {
  expect(desired.map((d) => d.id)).toEqual(["exceptions-in-production", "ops-alerts", "lcp-p75"]);
  expect(desired[0]?.insight.short_id).toBe("Q1Prz3Se");
  for (const d of desired) {
    expect(d.insight.query).toContain("{filters}");
    expect(d.insight.query).toContain("properties.app_env = 'production'");
  }
});

test("adopts an alert by name when its insight is not saved yet and reads plain user ids", () => {
  const byName: RemoteAlert = {
    ...existingQ1Prz3SeAlert,
    insight: { id: 999 },
    insight_short_id: undefined,
    name: "LCP p75 alto",
    subscribed_users: [7, 7, 9],
  };
  const p = planAlerts(desired, [byName], [], 5);
  expect(p.createAlerts.map((a) => a.name)).toEqual([
    "Error en reranker.co",
    "Alertas de operación",
  ]);
  expect(p.patchAlerts.map((a) => a.id)).toEqual([byName.id]);
  expect(p.createAlerts[0]?.subscribed_users).toEqual([7, 9]);
});

test("rewrites an insight without a query and an alert with percentage bounds", () => {
  const { alerts, insights } = applied();
  const legacy = insights.map((i, n) => (n === 0 ? { ...i, query: {} } : i));
  const retuned = alerts.map((a, n) =>
    n === 0
      ? {
          ...a,
          threshold: { configuration: { type: "percentage" as const, bounds: { lower: 1 } } },
        }
      : a,
  );
  const p = planAlerts(desired, retuned, legacy, 5);
  expect(p.patchInsights).toHaveLength(1);
  expect(p.patchAlerts.map((a) => a.name)).toEqual(["Error en reranker.co"]);
});

test("starts new alerts without subscribers when none exist anywhere", () => {
  const p = planAlerts(desired, [], [], 5);
  expect(p.createAlerts.every((a) => a.subscribed_users.length === 0)).toBe(true);
});

test("on pay-as-you-go the organization holds as many alerts as it needs", () => {
  const others: RemoteAlert[] = Array.from({ length: 9 }, (_, i) => ({
    ...existingQ1Prz3SeAlert,
    id: `0190eeee-0000-7000-8000-00000000000${i}`,
    name: `other ${i}`,
    insight: 700 + i,
    insight_short_id: `other${i}`,
  }));
  const limit = postHogLimits("pay-as-you-go").alerts;
  expect(planAlerts(desired, others, [], limit).createAlerts).toHaveLength(desired.length);
  expect(postHogLimits("free").alerts).toBe(5);
});
