import { readFileSync } from "node:fs";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { applyAlerts } from "./alerts-apply";
import { DesiredAlerts, insightQuery } from "./alerts-plan";
import { createPostHogRest } from "./posthog-rest";

const BASE = "https://us.posthog.com/api/projects/711803";
const desired = DesiredAlerts.parse(
  JSON.parse(readFileSync(new URL("../posthog-alerts.json", import.meta.url), "utf8")),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const existingAlert = {
  id: "0190aaaa-0000-7000-8000-000000000001",
  name: "Error en reranker.co",
  insight: { id: 41 },
  insight_short_id: "Q1Prz3Se",
  enabled: true,
  calculation_interval: "hourly",
  threshold: { configuration: { type: "absolute", bounds: { upper: 5 } } },
  condition: { type: "absolute_value" },
  config: null,
  subscribed_users: [{ id: 7 }],
};
const existingInsight = { id: 41, short_id: "Q1Prz3Se", name: "Error", query: null };

function stubRemote() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const record = async (method: string, request: Request) => {
    calls.push({
      method,
      path: new URL(request.url).pathname.replace("/api/projects/711803", ""),
      body: await request.json(),
    });
  };
  server.use(
    http.get(`${BASE}/alerts/`, () => HttpResponse.json({ next: null, results: [existingAlert] })),
    http.get(`${BASE}/insights/`, () =>
      HttpResponse.json({ next: null, results: [existingInsight] }),
    ),
    http.post(`${BASE}/insights/`, async ({ request }) => {
      await record("POST", request.clone());
      return HttpResponse.json({ id: 50 + calls.length }, { status: 201 });
    }),
    http.patch(`${BASE}/insights/41/`, async ({ request }) => {
      await record("PATCH", request.clone());
      return HttpResponse.json({ id: 41 });
    }),
    http.post(`${BASE}/alerts/`, async ({ request }) => {
      await record("POST", request.clone());
      return HttpResponse.json({ id: "new" }, { status: 201 });
    }),
    http.patch(`${BASE}/alerts/${existingAlert.id}/`, async ({ request }) => {
      await record("PATCH", request.clone());
      return HttpResponse.json({ id: existingAlert.id });
    }),
  );
  return calls;
}

test("reports nothing to do when PostHog already matches", async () => {
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
    enabled: true,
    calculation_interval: d.alert.calculation_interval,
    threshold: { configuration: d.alert.threshold },
    condition: { type: "absolute_value" },
    config: d.alert.config,
    subscribed_users: [],
  }));
  server.use(
    http.get(`${BASE}/alerts/`, () => HttpResponse.json({ next: null, results: alerts })),
    http.get(`${BASE}/insights/`, () => HttpResponse.json({ next: null, results: insights })),
  );
  const lines: string[] = [];
  await applyAlerts(createPostHogRest("phx_test"), desired, {
    dryRun: false,
    maxAlerts: 5,
    log: (l) => lines.push(l),
  });
  expect(lines).toEqual(["nothing to do"]);
});

test("dry run prints the plan and writes nothing", async () => {
  const calls = stubRemote();
  const lines: string[] = [];
  await applyAlerts(createPostHogRest("phx_test"), desired, {
    dryRun: true,
    maxAlerts: 5,
    log: (l) => lines.push(l),
  });
  expect(calls).toEqual([]);
  expect(lines.join("\n")).toMatch(/create insight.*Alertas de operación/);
  expect(lines.join("\n")).toMatch(/patch alert.*Error en reranker\.co/);
});

test("creates insights first, then alerts pointing at the new insight ids", async () => {
  const calls = stubRemote();
  await applyAlerts(createPostHogRest("phx_test"), desired, {
    dryRun: false,
    maxAlerts: 5,
    log: () => {},
  });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "POST /insights/",
    "POST /insights/",
    "PATCH /insights/41/",
    "POST /alerts/",
    "POST /alerts/",
    `PATCH /alerts/${existingAlert.id}/`,
  ]);
  const created = calls
    .filter((c) => c.path === "/alerts/")
    .map((c) => c.body as { insight: number });
  expect(created.map((c) => c.insight)).toEqual([51, 52]);
  expect(calls[3]?.body).toMatchObject({
    subscribed_users: [7],
    calculation_interval: "hourly",
    threshold: { configuration: { type: "absolute", bounds: { upper: 0 } } },
    condition: { type: "absolute_value" },
  });
});
