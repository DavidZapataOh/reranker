import { geoForEngine, getGeo } from "@reranker/catalog";
import { resetAppEnv } from "@reranker/env";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import type { GeoKey, QuestionScope } from "@reranker/schema/measurement";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDataForSeo } from "../../src/dataforseo/client";
import { geoFields } from "../../src/dataforseo/geo";
import { buildRequest, requestBytes } from "../../src/dataforseo/request";
import { RawSink } from "../../src/raw/raw-sink";
import { type FrozenSlot, slotId } from "../../src/slot";

// The catalog's entry is marked server-only; tests run outside a React Server Components bundler.
vi.mock("server-only", () => ({}));

const MEDELLIN = "co-c1003654";
const SALENTO = "co-c63690";
const GUADALAJARA = "mx-c9047210";
const MEASUREMENT = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";

function slot(
  engine: EngineId,
  geoKey: GeoKey,
  opts: { scope?: QuestionScope; promptText?: string; slotIndex?: number } = {},
): FrozenSlot {
  const geoDeclared = geoForEngine(engine, getGeo(geoKey), opts.scope ?? "local", {
    provider: "dataforseo",
  });
  if (!geoDeclared) throw new Error(`${engine} is not offered in ${geoKey}`);
  const slotIndex = opts.slotIndex ?? 3;
  return {
    engine,
    provider: "dataforseo",
    intentSetId: "is_0123456789abcdef",
    intentId: "dental_clinic.best",
    paraphraseId: "p1",
    geoKey,
    geoDeclared,
    runIndex: 0,
    promptText: opts.promptText ?? "¿Cuál es el mejor odontólogo cerca de mí?",
    measurementId: MEASUREMENT,
    slotIndex,
    slotId: slotId(MEASUREMENT, slotIndex),
  };
}

const serialized = (s: FrozenSlot, mode: "live" | "task") =>
  JSON.parse(new TextDecoder().decode(requestBytes(s, mode)));

describe("geo per engine", () => {
  test("AI Overview in Medellín uses the city code on mobile Android", () =>
    expect(buildRequest(slot("google-ai-overview", MEDELLIN), "live")).toMatchObject({
      keyword: "¿Cuál es el mejor odontólogo cerca de mí?",
      location_code: 1003654,
      device: "mobile",
      os: "android",
      load_async_ai_overview: true,
      language_code: "es",
      tag: expect.stringMatching(/:\d+$/),
    }));

  test("AI Mode uses the same codes as AI Overview", () => {
    expect(buildRequest(slot("google-ai-mode", MEDELLIN), "live")).toMatchObject({
      location_code: 1003654,
      device: "mobile",
      os: "android",
      language_code: "es",
    });
    expect(buildRequest(slot("google-ai-mode", SALENTO), "live").location_code).toBe(21519);
  });

  test("Salento falls back to Quindío and the slot declares region", () => {
    const s = slot("google-ai-overview", SALENTO);
    expect(buildRequest(s, "live").location_code).toBe(21519);
    expect(s.geoDeclared.level).toBe("region");
  });

  test.each(["google-ai-overview", "google-ai-mode"] as const)(
    "national scope of %s uses the country code 2170",
    (engine) =>
      expect(buildRequest(slot(engine, MEDELLIN, { scope: "national" }), "live")).toMatchObject({
        location_code: 2170,
        device: "mobile",
        os: "android",
      }),
  );

  test("ChatGPT by DataForSEO goes by country with web search forced", () =>
    expect(buildRequest(slot("chatgpt", MEDELLIN), "live")).toMatchObject({
      location_code: 2170,
      force_web_search: true,
      language_code: "es",
    }));

  test("Gemini uses the municipality centroid with 7 decimals", () => {
    const request = buildRequest(slot("gemini", MEDELLIN), "live");
    expect(request.location_coordinate).toMatch(/^6\.\d{7},-75\.\d{7},199999$/);
    expect(request.location_code).toBeUndefined();
  });

  test("Gemini asked nationwide goes by the country code", () => {
    const request = buildRequest(slot("gemini", MEDELLIN, { scope: "national" }), "live");
    expect(request).toMatchObject({ location_code: 2170 });
    expect(request.location_coordinate).toBeUndefined();
  });

  test("no country literal leaks: a Mexican slot uses Mexico codes", () => {
    const guadalajara = getGeo(GUADALAJARA);
    expect(buildRequest(slot("google-ai-overview", GUADALAJARA), "live").location_code).toBe(
      guadalajara.dataforseo.locationCode,
    );
    expect(buildRequest(slot("chatgpt", GUADALAJARA), "live").location_code).toBe(2484);
    // Guadalajara has no centroid, so Gemini is asked (and declared) by country.
    expect(buildRequest(slot("gemini", GUADALAJARA), "live").location_code).toBe(2484);
    expect(geoFields("google-ai-mode", guadalajara, "national").location_code).toBe(2484);
  });

  test("perplexity is not a DataForSEO engine", () =>
    expect(() => geoFields("perplexity", getGeo(MEDELLIN), "local")).toThrow(InvalidInputError));

  test("a slot routed to another provider is refused", () =>
    expect(() =>
      buildRequest({ ...slot("chatgpt", MEDELLIN), provider: "brightdata" }, "live"),
    ).toThrow(InvalidInputError));
});

describe("request bodies", () => {
  // The fields each endpoint documents (docs.dataforseo.com/v3, read 2026-11-18); a key outside
  // them would be ignored by the API or rejected.
  const DOCUMENTED = {
    "google-ai-overview": {
      live: [
        "keyword",
        "location_code",
        "language_code",
        "device",
        "os",
        "load_async_ai_overview",
        "tag",
      ],
      task: [
        "keyword",
        "location_code",
        "language_code",
        "device",
        "os",
        "load_async_ai_overview",
        "tag",
      ],
    },
    "google-ai-mode": {
      live: ["keyword", "location_code", "language_code", "device", "os", "tag"],
      task: ["keyword", "location_code", "language_code", "device", "os", "tag"],
    },
    gemini: {
      live: ["keyword", "location_coordinate", "language_code", "tag"],
      task: ["keyword", "location_coordinate", "language_code", "tag"],
    },
    chatgpt: {
      live: ["keyword", "location_code", "language_code", "force_web_search", "tag"],
      task: ["keyword", "location_code", "language_code", "force_web_search", "tag"],
    },
  } as const;

  test.each(
    Object.entries(DOCUMENTED).flatMap(([engine, modes]) =>
      Object.entries(modes).map(([mode, keys]) => [
        engine as EngineId,
        mode as "live" | "task",
        keys,
      ]),
    ),
  )("%s %s sends one task with only documented fields", (engine, mode, keys) => {
    const body = serialized(slot(engine, MEDELLIN), mode);
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual([...keys].sort());
  });

  test("the tag is the slot id", () =>
    expect(serialized(slot("gemini", MEDELLIN, { slotIndex: 41 }), "task")[0].tag).toBe(
      `${MEASUREMENT}:41`,
    ));

  test("live and task bodies differ only by endpoint, never by content", () => {
    for (const engine of ["google-ai-overview", "google-ai-mode", "gemini", "chatgpt"] as const) {
      const s = slot(engine, MEDELLIN);
      expect(serialized(s, "task")).toEqual(serialized(s, "live"));
    }
  });

  test("a literal % or + in the prompt reaches DataForSEO percent-encoded", () =>
    expect(
      serialized(
        slot("chatgpt", MEDELLIN, { promptText: "clínica 24/7 + urgencias al 100%" }),
        "live",
      )[0].keyword,
    ).toBe("clínica 24/7 %2B urgencias al 100%25"));

  test("non-ASCII text is sent as UTF-8, unescaped", () =>
    expect(new TextDecoder().decode(requestBytes(slot("gemini", MEDELLIN), "live"))).toContain(
      "¿Cuál es el mejor odontólogo cerca de mí?",
    ));
});

describe("request bytes equal what the client sends", () => {
  const LIVE = {
    "google-ai-overview": "*/v3/serp/google/organic/live/advanced",
    "google-ai-mode": "*/v3/serp/google/ai_mode/live/advanced",
    gemini: "*/v3/ai_optimization/gemini/llm_scraper/live/advanced",
    chatgpt: "*/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
  } as const;
  const TASK = {
    "google-ai-overview": "*/v3/serp/google/organic/task_post",
    "google-ai-mode": "*/v3/serp/google/ai_mode/task_post",
    gemini: "*/v3/ai_optimization/gemini/llm_scraper/task_post",
    chatgpt: "*/v3/ai_optimization/chat_gpt/llm_scraper/task_post",
  } as const;

  beforeAll(() => server.listen());
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("DATAFORSEO_LOGIN", "capture-unit@example.com");
    vi.stubEnv("DATAFORSEO_PASSWORD", "capture-unit-password");
    resetAppEnv();
    for (const path of [...Object.values(LIVE), ...Object.values(TASK)]) {
      server.use(
        http.post(path, () =>
          HttpResponse.json({ status_code: 20000, status_message: "Ok.", tasks: [] }),
        ),
      );
    }
  });
  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllEnvs();
    resetAppEnv();
  });
  afterAll(() => server.close());

  // biome-ignore lint/suspicious/noExplicitAny: the client's request classes differ per endpoint.
  type Send = (request: any) => Promise<unknown>;
  const send = (sink: RawSink): Record<keyof typeof LIVE, Record<"live" | "task", Send>> => {
    const { ai, serp } = createDataForSeo(sink, { base: "sandbox" });
    return {
      "google-ai-overview": {
        live: (r) => serp.googleOrganicLiveAdvanced([r]),
        task: (r) => serp.googleOrganicTaskPost([r]),
      },
      "google-ai-mode": {
        live: (r) => serp.googleAiModeLiveAdvanced([r]),
        task: (r) => serp.googleAiModeTaskPost([r]),
      },
      gemini: {
        live: (r) => ai.geminiLlmScraperLiveAdvanced([r]),
        task: (r) => ai.geminiLlmScraperTaskPost([r]),
      },
      chatgpt: {
        live: (r) => ai.chatGptLlmScraperLiveAdvanced([r]),
        task: (r) => ai.chatGptLlmScraperTaskPost([r]),
      },
    };
  };

  test.each(
    (Object.keys(LIVE) as (keyof typeof LIVE)[]).flatMap((engine) =>
      (["live", "task"] as const).map((mode) => [engine, mode] as const),
    ),
  )("%s %s", async (engine, mode) => {
    const s = slot(engine, SALENTO, { promptText: "spa 100% natural + sauna en Salento" });
    const sink = new RawSink();
    await send(sink)[engine][mode](buildRequest(s, mode));
    expect(Buffer.from(sink.request ?? []).equals(Buffer.from(requestBytes(s, mode)))).toBe(true);
  });
});
