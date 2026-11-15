import { CaptureChannel, type CaptureProvider, EngineId } from "@reranker/schema";
import { describe, expect, test, vi } from "vitest";
import {
  definitions,
  productionOnly,
  rejectDefinitions,
  serveDefinitions,
  withOff,
} from "../test/definitions";
import { setAppEnv, setupFlagsTests } from "../test/lifecycle";
import { getFlagsClient } from "./client";
import type { FlagKey } from "./flag-keys.gen";

const mocks = vi.hoisted(() => ({ alert: vi.fn(async () => {}) }));
vi.mock("@reranker/telemetry", () => ({ sendOpsAlert: mocks.alert }));

const { assertCaptureAllowed, captureSwitchSnapshot } = await import("./capture");
const { CaptureChannelDisabledError, FlagsNotReadyError } = await import("./errors");
const { isEnabled } = await import("./evaluate");
const { registry } = await import("./registry");

setupFlagsTests();

const ALL_ON = definitions({
  "capture-channel-ui-vendor": true,
  "capture-channel-api": true,
  "capture-provider-dataforseo": true,
  "capture-provider-openai": true,
  "capture-provider-brightdata": true,
  "capture-engine-chatgpt": true,
  "capture-engine-gemini": true,
  "capture-engine-google-ai-overview": true,
  "capture-engine-perplexity": true,
});

type Input = { channel: CaptureChannel; provider: CaptureProvider; engine?: EngineId };
type Off = "none" | "channel" | "provider" | "engine";

const combinations: [Input, FlagKey[], "allowed" | "blocked"][] = [];
for (const channel of ["ui-vendor", "api"] as const) {
  for (const provider of ["dataforseo", "openai", "brightdata"] as const) {
    for (const engine of [...EngineId.options, undefined]) {
      for (const off of ["none", "channel", "provider", "engine"] as Off[]) {
        const input: Input = engine ? { channel, provider, engine } : { channel, provider };
        const keys: Record<Off, FlagKey[]> = {
          none: [],
          channel: [`capture-channel-${channel}`],
          provider: [`capture-provider-${provider}`],
          engine: engine ? [`capture-engine-${engine}`] : [],
        };
        combinations.push([input, keys[off], keys[off].length === 0 ? "allowed" : "blocked"]);
      }
    }
  }
}

const API_OPENAI = { channel: "api", provider: "openai" } as const;

describe("assertCaptureAllowed", () => {
  test.each(combinations)("%o with %o off is %s", async (input, off, expected) => {
    serveDefinitions(withOff(ALL_ON, off));
    const run = assertCaptureAllowed(input);
    if (expected === "allowed") {
      await expect(run).resolves.toBeUndefined();
    } else {
      const error = await run.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CaptureChannelDisabledError);
      expect(error).toMatchObject({ retryable: false, flags: off });
    }
  });

  test("a flag missing from PostHog counts as off", async () => {
    serveDefinitions(definitions({ "capture-channel-api": true, "capture-engine-chatgpt": true }));
    await expect(assertCaptureAllowed({ ...API_OPENAI, engine: "chatgpt" })).rejects.toMatchObject({
      flags: ["capture-provider-openai"],
    });
  });

  test("ui-own is always closed, even with its flag on", async () => {
    serveDefinitions({
      ...ALL_ON,
      flags: [...ALL_ON.flags, ...definitions({ "capture-channel-ui-own": true }).flags],
    });
    const error = await assertCaptureAllowed({ channel: "ui-own", provider: "dataforseo" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CaptureChannelDisabledError);
    expect(error).toMatchObject({ flags: ["capture-channel-ui-own"] });
    expect(CaptureChannel.options).toContain("ui-own");
  });

  test("ui-own is closed without waiting for definitions", async () => {
    rejectDefinitions(401);
    await expect(
      assertCaptureAllowed({ channel: "ui-own", provider: "brightdata", engine: "perplexity" }),
    ).rejects.toBeInstanceOf(CaptureChannelDisabledError);
  });

  test("definitions not loaded (invalid key, 401) → FlagsNotReadyError, retryable", async () => {
    rejectDefinitions(401);
    const error = await assertCaptureAllowed(API_OPENAI).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlagsNotReadyError);
    expect(error).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
  });

  test("quota limited response → closed", async () => {
    rejectDefinitions(402);
    await expect(assertCaptureAllowed(API_OPENAI)).rejects.toBeInstanceOf(FlagsNotReadyError);
  });

  test("quota limited after definitions loaded → closed", async () => {
    serveDefinitions(ALL_ON);
    await expect(assertCaptureAllowed(API_OPENAI)).resolves.toBeUndefined();
    rejectDefinitions(402);
    await getFlagsClient().reloadFeatureFlags();
    await expect(assertCaptureAllowed(API_OPENAI)).rejects.toBeInstanceOf(FlagsNotReadyError);
  });

  test("without a flags key the client never loads and capture stays closed", async () => {
    vi.stubEnv("POSTHOG_FEATURE_FLAGS_KEY", "");
    serveDefinitions(ALL_ON);
    await expect(assertCaptureAllowed(API_OPENAI)).rejects.toBeInstanceOf(FlagsNotReadyError);
  });

  test("disabled capture logs WARN capture.blocked with provider, channel, engine", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serveDefinitions(withOff(ALL_ON, ["capture-provider-dataforseo"]));
    await assertCaptureAllowed({
      channel: "ui-vendor",
      provider: "dataforseo",
      engine: "gemini",
    }).catch(() => {});
    expect(warn).toHaveBeenCalledWith("capture.blocked", {
      channel: "ui-vendor",
      provider: "dataforseo",
      engine: "gemini",
      flags: ["capture-provider-dataforseo"],
    });
  });
});

describe("flags-not-ready alert", () => {
  // A revoked key keeps a long-lived instance without definitions: every call must keep failing
  // closed while the alert goes out once after five minutes and then at most once an hour.
  test("fires once after 5 min and then once per hour, never per call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    rejectDefinitions(401);
    const start = Date.now();
    const calls: number[] = [];
    mocks.alert.mockImplementation(async () => {
      calls.push(Date.now() - start);
    });
    for (let elapsed = 0; elapsed <= 2 * 60 * 60_000; elapsed += 20_000) {
      vi.setSystemTime(start + elapsed);
      await expect(assertCaptureAllowed(API_OPENAI)).rejects.toBeInstanceOf(FlagsNotReadyError);
    }
    expect(calls).toEqual([320_000, 320_000 + 60 * 60_000]);
    expect(mocks.alert).toHaveBeenCalledWith("flags-not-ready", {
      since: new Date(start).toISOString(),
    });
  });

  test("does not fire when definitions load before 5 min", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    rejectDefinitions(401);
    const start = Date.now();
    await assertCaptureAllowed(API_OPENAI).catch(() => {});
    serveDefinitions(ALL_ON);
    await getFlagsClient().reloadFeatureFlags();
    vi.setSystemTime(start + 10 * 60_000);
    await expect(assertCaptureAllowed(API_OPENAI)).resolves.toBeUndefined();
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});

describe("isEnabled", () => {
  test("paid provider flag evaluates false for env=preview without override", async () => {
    serveDefinitions(productionOnly("capture-provider-dataforseo", true));
    setAppEnv("preview");
    await getFlagsClient().waitForLocalEvaluationReady(3_000);
    expect(
      await isEnabled("capture-provider-dataforseo", { kind: "system", provider: "dataforseo" }),
    ).toBe(false);
    setAppEnv("production");
    expect(
      await isEnabled("capture-provider-dataforseo", { kind: "system", provider: "dataforseo" }),
    ).toBe(true);
  });
});

describe("captureSwitchSnapshot", () => {
  test("lists every kill switch with evaluatedAt and definitionsEtag", async () => {
    serveDefinitions(ALL_ON);
    const snapshot = await captureSwitchSnapshot();
    const switches = registry.filter((f) => f.kind === "kill-switch").map((f) => f.key);
    expect(Object.keys(snapshot.switches).sort()).toEqual(switches.sort());
    expect(snapshot.definitionsEtag).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(snapshot.evaluatedAt).toISOString()).toBe(snapshot.evaluatedAt);
    expect(snapshot.switches["capture-provider-openai"]).toBe(true);
    expect(snapshot.switches["capture-channel-ui-own"]).toBe(false);
    expect(snapshot.switches["intent-generation"]).toBe(false);
  });

  test("the etag changes with the definitions", async () => {
    serveDefinitions(ALL_ON);
    const before = await captureSwitchSnapshot();
    serveDefinitions(withOff(ALL_ON, ["capture-channel-api"]));
    await getFlagsClient().reloadFeatureFlags();
    const after = await captureSwitchSnapshot();
    expect(after.definitionsEtag).not.toBe(before.definitionsEtag);
    expect(after.switches["capture-channel-api"]).toBe(false);
  });

  test("throws FlagsNotReadyError without definitions", async () => {
    rejectDefinitions(401);
    await expect(captureSwitchSnapshot()).rejects.toBeInstanceOf(FlagsNotReadyError);
  });
});
