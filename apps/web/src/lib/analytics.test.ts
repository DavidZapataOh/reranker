import { beforeEach, expect, test, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  __loaded: false,
  capture: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));
vi.mock("./analytics-config", () => ({
  POSTHOG_KEY: "phc_test",
  POSTHOG_REGION: "us",
  GA_ID: undefined,
  CLARITY_ID: undefined,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", {});
  posthog.__loaded = false;
  posthog.capture.mockClear();
  posthog.captureException.mockClear();
});

test("an error raised before PostHog loads is reported once it does, in order with events", async () => {
  const { captureException, flushQueuedEvents, track } = await import("./analytics");
  const error = new Error("first render");
  track("section_viewed", { section_id: "hero" });
  captureException(error);
  expect(posthog.captureException).not.toHaveBeenCalled();

  posthog.__loaded = true;
  flushQueuedEvents();
  expect(posthog.capture).toHaveBeenCalledWith("section_viewed", { section_id: "hero" });
  expect(posthog.captureException).toHaveBeenCalledExactlyOnceWith(error);
  expect(posthog.capture.mock.invocationCallOrder[0]).toBeLessThan(
    posthog.captureException.mock.invocationCallOrder[0] ?? 0,
  );

  flushQueuedEvents();
  expect(posthog.captureException).toHaveBeenCalledOnce();
});

test("an error raised after PostHog loads is reported at once", async () => {
  const { captureException } = await import("./analytics");
  posthog.__loaded = true;
  const error = new Error("later");
  captureException(error);
  expect(posthog.captureException).toHaveBeenCalledExactlyOnceWith(error);
});

test("nothing is reported on the server", async () => {
  vi.unstubAllGlobals();
  const { captureException } = await import("./analytics");
  captureException(new Error("server render"));
  expect(posthog.captureException).not.toHaveBeenCalled();
});

function storage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  };
}

function visit({ url = "https://reranker.co/", referrer = "", width = 1280 } = {}) {
  vi.stubGlobal("window", {
    location: new URL(url),
    innerWidth: width,
    localStorage: storage(),
    sessionStorage: storage(),
  });
  vi.stubGlobal("document", { referrer });
}

test("consent is pending until decided and asked again when the banner copy changes", async () => {
  visit();
  const { CONSENT_VERSION, readConsent, writeConsent } = await import("./analytics");
  expect(readConsent()).toBe("pending");
  writeConsent("granted");
  expect(readConsent()).toBe("granted");
  window.localStorage.setItem(
    "rr_consent",
    JSON.stringify({ v: `${CONSENT_VERSION}-old`, c: "denied", at: "" }),
  );
  expect(readConsent()).toBe("pending");
  window.localStorage.setItem("rr_consent", "{not json");
  expect(readConsent()).toBe("pending");
});

test("the AI assistant is read from the campaign or the referrer", async () => {
  visit({ url: "https://reranker.co/?utm_source=chatgpt.com&utm_campaign=bio", width: 390 });
  const { readOrigin } = await import("./analytics");
  expect(readOrigin()).toMatchObject({
    ai_source: "chatgpt",
    utm_campaign: "bio",
    device_type: "mobile",
    landing_path: "/",
  });

  visit({ referrer: "https://www.perplexity.ai/search?q=x", width: 800 });
  expect(readOrigin()).toMatchObject({
    ai_source: "perplexity",
    referrer_domain: "www.perplexity.ai",
    device_type: "tablet",
  });

  visit({ referrer: "https://reranker.co/terminos" });
  expect(readOrigin()).toMatchObject({ ai_source: null, referrer_domain: null });
});

test("the WhatsApp code comes from the campaign and lasts the whole visit", async () => {
  visit({ url: "https://reranker.co/?utm_source=instagram&utm_campaign=ig-reel_12" });
  const { whatsappRef } = await import("./analytics");
  expect(whatsappRef()).toBe("IG-REEL-12");
  window.location.search = "";
  expect(whatsappRef()).toBe("IG-REEL-12");
});

test("a direct visit has no WhatsApp code", async () => {
  visit();
  const { whatsappRef } = await import("./analytics");
  expect(whatsappRef()).toBeNull();
});

test("work deferred to page load can be cancelled before it runs", async () => {
  vi.useFakeTimers();
  try {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    vi.stubGlobal("document", { readyState: "loading" });
    const { afterPageLoad } = await import("./analytics");

    const ran = vi.fn();
    afterPageLoad(ran);
    listeners.get("load")?.();
    vi.runAllTimers();
    expect(ran).toHaveBeenCalledOnce();

    const cancelled = vi.fn();
    const cancel = afterPageLoad(cancelled);
    listeners.get("load")?.();
    cancel();
    vi.runAllTimers();
    expect(cancelled).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
