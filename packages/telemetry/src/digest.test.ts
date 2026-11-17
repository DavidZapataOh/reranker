import { EnvValidationError, resetAppEnv } from "@reranker/env";
import { cost } from "@reranker/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DigestInput } from "./digest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));
vi.mock("./logger", () => ({ log: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));

const {
  buildDailyDigest,
  DIGEST_THRESHOLDS,
  digestEmailConfigured,
  fetchWithin,
  sendDailyDigest,
  SourceError,
} = await import("./digest");

const usd = (major: number) => cost(Math.round(major * 1_000_000), "USD");
const ok = <T>(value: T) => ({ ok: true as const, value });
const GIB = 1_073_741_824;

const fullInput: DigestInput = {
  date: "2026-11-17",
  day: "2026-11-16",
  spend: ok([
    { scope: "global", day: usd(12.5), cap: usd(75), month: usd(80) },
    { scope: "provider:dataforseo", day: usd(10), cap: usd(36), month: usd(70) },
    { scope: "provider:openai", day: usd(2.5), cap: usd(14), month: usd(10) },
    { scope: "purpose:benchmark", day: usd(20), cap: usd(20), month: usd(20) },
  ]),
  dataforseo: ok({ balanceUsd: 42.1 }),
  neon: ok([
    { name: "reranker-prod", computeHours: 10, storageBytes: GIB / 2 },
    { name: "reranker-nonprod", computeHours: 5, storageBytes: GIB / 4 },
  ]),
  github: ok({ minutesUsed: 1234, includedUsedUsd: 1.2, includedUsd: 12, billedUsd: 0 }),
  posthog: ok({ events: 120_000, exceptions: 300 }),
  resend: ok({ sent: 12, limit: 100 }),
  workflows: ok({ estimatedEvents: 4_500, ratio: 0.09 }),
  switches: ok({ "capture-provider-dataforseo": true, "capture-channel-api": false }),
};

// Neon spend at the published Launch rates for a given share of the monthly budget.
function neonAt(percent: number): DigestInput["neon"] {
  const hours = (DIGEST_THRESHOLDS.neonMonthlyUsd * percent) / 100 / 0.106;
  return ok([{ name: "reranker-prod", computeHours: hours, storageBytes: 0 }]);
}

describe("buildDailyDigest", () => {
  test("lists spend per provider, DataForSEO balance, Neon (both projects), Actions, PostHog, Resend and switches", () => {
    const { text } = buildDailyDigest(fullInput);
    for (const s of [
      "dataforseo",
      "DataForSEO",
      "reranker-prod",
      "reranker-nonprod",
      "Actions",
      "PostHog",
      "Resend",
      "Workflows",
      "capture-provider-dataforseo",
    ]) {
      expect(text).toContain(s);
    }
    expect(text.split("\n")[0]).toBe("Resumen diario · 2026-11-17");
  });

  test("shows each provider's spend against its cap and the month so far", () => {
    const { text } = buildDailyDigest(fullInput);
    expect(text).toMatch(/dataforseo: USD\s10,00 de USD\s36,00 · mes: USD\s70,00/);
    expect(text).toMatch(/Total: USD\s12,50 de USD\s75,00/);
  });

  test("names the caps reached that day without raising a spend alert", () => {
    const { text, alerts } = buildDailyDigest(fullInput);
    expect(text).toContain("Topes alcanzados el 2026-11-16: purpose:benchmark");
    expect(alerts.map((a) => a.payload.source)).not.toContain("spend");
    expect(alerts.every((a) => a.kind === "free-tier-quota" || a.kind === "neon-quota")).toBe(true);
  });

  test("a day without caps reached says so", () => {
    const { text } = buildDailyDigest({
      ...fullInput,
      spend: ok([{ scope: "global", day: usd(0), cap: usd(0), month: usd(0) }]),
    });
    expect(text).toContain("Topes alcanzados el 2026-11-16: ninguno");
  });

  test.each([
    [49, null],
    [50, "warning"],
    [80, "warning"],
    [95, "critical"],
  ])("neon spend at %i%% of the monthly budget → %s", (percent, severity) => {
    const { alerts } = buildDailyDigest({ ...fullInput, neon: neonAt(percent) });
    const neon = alerts.filter((a) => a.kind === "neon-quota");
    if (severity === null) {
      expect(neon).toEqual([]);
    } else {
      expect(neon).toHaveLength(1);
      expect(neon[0]?.payload).toMatchObject({ severity, percent, threshold: percent });
    }
  });

  test("neon spend counts storage at the Launch rate per GiB-month", () => {
    const { text } = buildDailyDigest({
      ...fullInput,
      neon: ok([{ name: "reranker-prod", computeHours: 0, storageBytes: 10 * GIB }]),
    });
    expect(text).toMatch(/gasto estimado del mes USD\s3,50 de USD\s20,00 \(18\s%\)/);
  });

  test("workflows usage appears in the text and never as an alert", () => {
    const { text, alerts } = buildDailyDigest({
      ...fullInput,
      workflows: ok({ estimatedEvents: 45_000, ratio: 0.9 }),
    });
    expect(text).toMatch(/Workflows \(estimado\): 45\.000 eventos \(90\s%/);
    expect(alerts).toEqual([]);
  });

  test("resend above 70% daily → free-tier-quota warning", () => {
    const below = buildDailyDigest({ ...fullInput, resend: ok({ sent: 70, limit: 100 }) });
    expect(below.alerts).toEqual([]);
    const { alerts } = buildDailyDigest({ ...fullInput, resend: ok({ sent: 71, limit: 100 }) });
    expect(alerts).toEqual([
      {
        kind: "free-tier-quota",
        payload: expect.objectContaining({
          source: "resend",
          severity: "warning",
          percent: 71,
          day: "2026-11-16",
        }),
      },
    ]);
  });

  test("resend near its daily quota is critical", () => {
    const { alerts } = buildDailyDigest({ ...fullInput, resend: ok({ sent: 96, limit: 100 }) });
    expect(alerts[0]?.payload).toMatchObject({ source: "resend", severity: "critical" });
  });

  test("actions and posthog thresholds raise free-tier-quota with their source", () => {
    const { alerts } = buildDailyDigest({
      ...fullInput,
      github: ok({ minutesUsed: 2000, includedUsedUsd: 11.5, includedUsd: 12, billedUsd: 0 }),
      posthog: ok({ events: 820_000, exceptions: 50_000 }),
    });
    expect(alerts.map((a) => [a.kind, a.payload.source, a.payload.severity])).toEqual([
      ["free-tier-quota", "github-actions", "critical"],
      ["free-tier-quota", "posthog-events", "warning"],
      ["free-tier-quota", "posthog-exceptions", "warning"],
    ]);
  });

  test("a failed source is marked 'sin dato' and the digest still builds", () => {
    const { text } = buildDailyDigest({ ...fullInput, github: { ok: false, reason: "sin dato" } });
    expect(text).toMatch(/Actions: sin dato/);
  });

  test("every source can be missing at once, each with its reason", () => {
    const missing = { ok: false as const, reason: "sin dato" as const, detail: "falta X" };
    const { text, alerts } = buildDailyDigest({
      ...fullInput,
      spend: missing,
      dataforseo: missing,
      neon: missing,
      github: missing,
      posthog: missing,
      resend: missing,
      workflows: missing,
      switches: missing,
    });
    expect(alerts).toEqual([]);
    expect(text.match(/sin dato \(falta X\)/g)).toHaveLength(8);
  });

  test("threshold 0% in preview fires neon-quota", () => {
    const { alerts } = buildDailyDigest({
      ...fullInput,
      neon: neonAt(1),
      thresholds: { warning: [0] },
    });
    expect(alerts.some((a) => a.kind === "neon-quota")).toBe(true);
  });

  test("switches read as on or off", () => {
    const { text } = buildDailyDigest(fullInput);
    expect(text).toContain("capture-provider-dataforseo: encendido");
    expect(text).toContain("capture-channel-api: apagado");
  });
});

describe("fetchWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns the value of a source that answers", async () => {
    expect(await fetchWithin(async () => 3)).toEqual({ ok: true, value: 3 });
  });

  test("a source that never answers is 'sin dato' after the bound and is aborted", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = fetchWithin((s) => {
      signal = s;
      return new Promise<number>(() => {});
    }, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({
      ok: false,
      reason: "sin dato",
      detail: "sin respuesta en 10 s",
    });
    expect(signal?.aborted).toBe(true);
  });

  test("a failure becomes 'sin dato' with a reason that holds no provider text", async () => {
    expect(await fetchWithin(() => Promise.reject(new SourceError("falta TOKEN")))).toEqual({
      ok: false,
      reason: "sin dato",
      detail: "falta TOKEN",
    });
    expect(
      await fetchWithin(() => Promise.reject(new TypeError("fetch failed for a@b.co"))),
    ).toEqual({ ok: false, reason: "sin dato", detail: "error inesperado (TypeError)" });
    expect(
      await fetchWithin(() => {
        throw new EnvValidationError([{ name: "NEON_API_KEY", problem: "invalid" }]);
      }),
    ).toEqual({ ok: false, reason: "sin dato", detail: "variable inválida: NEON_API_KEY" });
    expect(await fetchWithin(() => Promise.reject("boom"))).toEqual({
      ok: false,
      reason: "sin dato",
      detail: "error inesperado",
    });
  });
});

describe("sendDailyDigest", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("OPS_ALERT_EMAIL", "alertas@reranker.co");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    mocks.send.mockResolvedValue({
      data: { id: "email-1" },
      error: null,
      headers: { "x-resend-daily-quota": "12", "x-resend-monthly-quota": "140" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    resetAppEnv();
  });

  test("is configured only with both the inbox and the key", () => {
    expect(digestEmailConfigured()).toBe(true);
    vi.stubEnv("OPS_ALERT_EMAIL", "");
    expect(digestEmailConfigured()).toBe(false);
  });

  test("sends plain text from the alerts sender, once per date", async () => {
    expect(await sendDailyDigest("2026-11-17", "hola")).toBe(true);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      {
        from: "Reranker alertas <alertas@reranker.co>",
        to: "alertas@reranker.co",
        subject: "Resumen diario · 2026-11-17",
        text: "hola",
      },
      { idempotencyKey: "ops-digest/2026-11-17" },
    );
    expect(mocks.info).toHaveBeenCalledWith("ops.digest.email_sent", {
      date: "2026-11-17",
      resend_daily_quota: 12,
      resend_monthly_quota: 140,
    });
  });

  test("a rejection or a thrown error reports false and logs only the error name", async () => {
    mocks.send.mockResolvedValueOnce({
      data: null,
      error: { name: "daily_quota_exceeded", message: "x", statusCode: 429 },
      headers: null,
    });
    expect(await sendDailyDigest("2026-11-17", "hola")).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith("ops.digest.email_failed", {
      name: "daily_quota_exceeded",
    });
    mocks.send.mockRejectedValueOnce(new TypeError("socket hang up"));
    expect(await sendDailyDigest("2026-11-17", "hola")).toBe(false);
    expect(mocks.error).toHaveBeenLastCalledWith("ops.digest.email_failed", { name: "TypeError" });
  });

  test("an invalid key counts as unconfigured and names the variable", async () => {
    vi.stubEnv("RESEND_API_KEY", "not-a-resend-key");
    expect(digestEmailConfigured()).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith("ops.digest.email_misconfigured", {
      variables: "RESEND_API_KEY",
    });
  });

  test("without configuration it sends nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendDailyDigest("2026-11-17", "hola")).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
