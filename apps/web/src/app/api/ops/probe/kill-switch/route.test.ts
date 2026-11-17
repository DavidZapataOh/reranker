import { resetAppEnv } from "@reranker/env";
import { CaptureChannelDisabledError, FlagsNotReadyError } from "@reranker/flags";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const flags = vi.hoisted(() => ({ assertCaptureAllowed: vi.fn() }));
vi.mock("@reranker/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/flags")>()),
  assertCaptureAllowed: flags.assertCaptureAllowed,
}));

const { GET } = await import("./route");

type Tick = { t: string; allowed: boolean; providerCalled: boolean };

const fetchMock = vi.fn<typeof fetch>();
const USER_DATA = "https://sandbox.dataforseo.com/v3/appendix/user_data";

function probe(seconds?: string, init: RequestInit = {}) {
  const url = new URL("https://reranker.co/api/ops/probe/kill-switch");
  if (seconds !== undefined) url.searchParams.set("seconds", seconds);
  return GET(new Request(url, init));
}

async function ticks(response: Response): Promise<Tick[]> {
  const body = response.text();
  await vi.runAllTimersAsync();
  return (await body)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Tick);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("DATAFORSEO_LOGIN", "probe-login");
  vi.stubEnv("DATAFORSEO_PASSWORD", "probe-password");
  resetAppEnv();
  flags.assertCaptureAllowed.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetAppEnv();
});

test("streams one tick every five seconds and stops calling the provider once the switch is off", async () => {
  flags.assertCaptureAllowed
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new CaptureChannelDisabledError(["capture-channel-ui-vendor"]));

  const response = await probe("30");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  expect(response.headers.get("cache-control")).toBe("no-store");

  const lines = await ticks(response);
  expect(lines.map((line) => line.allowed)).toEqual([true, true, true, false, false, false]);
  for (const line of lines) {
    expect(line.providerCalled).toBe(line.allowed);
    expect(new Date(line.t).toISOString()).toBe(line.t);
  }
  const times = lines.map((line) => Date.parse(line.t));
  expect(times.slice(1).map((time, i) => time - (times[i] ?? 0))).toEqual([
    5000, 5000, 5000, 5000, 5000,
  ]);

  expect(flags.assertCaptureAllowed).toHaveBeenCalledWith({
    channel: "ui-vendor",
    provider: "dataforseo",
    engine: "chatgpt",
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe(USER_DATA);
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Basic ${Buffer.from("probe-login:probe-password").toString("base64")}`,
  );
});

test("any other flag failure fails closed", async () => {
  flags.assertCaptureAllowed
    .mockRejectedValueOnce(new FlagsNotReadyError())
    .mockRejectedValueOnce(new Error("posthog down"));

  const lines = await ticks(await probe("10"));
  expect(lines).toMatchObject([
    { allowed: false, providerCalled: false },
    { allowed: false, providerCalled: false },
  ]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a failing provider still counts as called and never breaks the stream", async () => {
  flags.assertCaptureAllowed.mockResolvedValue(undefined);
  fetchMock.mockRejectedValue(new TypeError("fetch failed"));
  vi.stubEnv("DATAFORSEO_LOGIN", "");
  vi.stubEnv("DATAFORSEO_PASSWORD", "");

  const lines = await ticks(await probe("10"));
  expect(lines).toMatchObject([
    { allowed: true, providerCalled: true },
    { allowed: true, providerCalled: true },
  ]);
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
});

test("runs for two minutes by default", async () => {
  flags.assertCaptureAllowed.mockResolvedValue(undefined);
  expect(await ticks(await probe())).toHaveLength(24);
});

test.each(["0", "281", "1.5", "abc", ""])("rejects seconds=%s", async (seconds) => {
  expect((await probe(seconds)).status).toBe(400);
  expect(flags.assertCaptureAllowed).not.toHaveBeenCalled();
});

test("stops cleanly when the request is aborted", async () => {
  flags.assertCaptureAllowed.mockResolvedValue(undefined);
  const controller = new AbortController();
  const response = await probe("280", { signal: controller.signal });
  const body = response.text();
  await vi.advanceTimersByTimeAsync(12_000);
  controller.abort();
  await vi.runAllTimersAsync();
  expect((await body).trim().split("\n")).toHaveLength(3);
  expect(flags.assertCaptureAllowed).toHaveBeenCalledTimes(3);
});

test("production hides the route without the cron bearer", async () => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("CRON_SECRET", "");
  resetAppEnv();
  expect((await probe("10")).status).toBe(404);
  expect(flags.assertCaptureAllowed).not.toHaveBeenCalled();
});
