import { readFileSync } from "node:fs";
import { geoForEngine, getGeo, jcs, sha256Hex } from "@reranker/catalog";
import { defineEnv } from "@reranker/env";
import { getCountry } from "@reranker/i18n/countries";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { CaptureProvider } from "@reranker/schema";
import type { GeoKey, QuestionScope } from "@reranker/schema/measurement";
import { afterEach, expect, test, vi } from "vitest";
import { openaiControlEnv } from "../../src/openai/env";
import {
  assertPinnedProfile,
  CONTROL_PROFILE,
  PINNED_PROFILE_HASHES,
} from "../../src/openai/profile";
import { buildControlRequest } from "../../src/openai/request";
import { type FrozenSlot, slotId } from "../../src/slot";

const MEDELLIN = "co-c1003654";
const BOGOTA = "co-c1003659";
const MEASUREMENT = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";
const PROMPT = "¿Qué odontólogo me recomiendas en Medellín?";

afterEach(() => vi.unstubAllEnvs());

function slot(
  geoKey: GeoKey,
  provider: CaptureProvider = "openai",
  scope: QuestionScope = "local",
): FrozenSlot {
  const geoDeclared = geoForEngine("chatgpt", getGeo(geoKey), scope, { provider });
  if (!geoDeclared) throw new Error(`ChatGPT is not offered in ${geoKey}`);
  return {
    engine: "chatgpt",
    provider,
    intentSetId: "is_0123456789abcdef",
    intentId: "dental_clinic.best",
    paraphraseId: "p1",
    geoKey,
    geoDeclared,
    runIndex: 0,
    promptText: PROMPT,
    measurementId: MEASUREMENT,
    slotIndex: 0,
    slotId: slotId(MEASUREMENT, 0),
  };
}

const locationOf = (s: FrozenSlot) => {
  const [tool] = buildControlRequest(s).tools ?? [];
  return tool?.type === "web_search_2025_08_26" ? tool.user_location : undefined;
};

test("Medellín request declares the city, forces search and stores nothing", () =>
  expect(buildControlRequest(slot(MEDELLIN))).toEqual({
    model: CONTROL_PROFILE.model,
    input: PROMPT,
    store: false,
    max_output_tokens: 1200,
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    tools: [
      {
        type: "web_search_2025_08_26",
        search_context_size: "medium",
        user_location: {
          type: "approximate",
          country: "CO",
          city: "Medellín",
          region: "Antioquia",
          timezone: "America/Bogota",
        },
      },
    ],
    ...(CONTROL_PROFILE.reasoningEffort
      ? { reasoning: { effort: CONTROL_PROFILE.reasoningEffort } }
      : {}),
  }));

test("the request is the one the live contract call sent", () => {
  const recorded = readFileSync(
    new URL("../fixtures/recorded/openai/control-medellin.request.json", import.meta.url),
    "utf8",
  );
  expect(buildControlRequest(slot(MEDELLIN))).toEqual(JSON.parse(recorded));
});

test("Bogotá is named as people say it, inside its capital district", () =>
  expect(locationOf(slot(BOGOTA))).toEqual({
    type: "approximate",
    country: "CO",
    city: "Bogotá",
    region: "Bogotá, D.C.",
    timezone: "America/Bogota",
  }));

test("a region target declares the region and no city", () =>
  expect(locationOf(slot("co-r20198"))).toEqual({
    type: "approximate",
    country: "CO",
    region: "Antioquia",
    timezone: "America/Bogota",
  }));

test("a country target declares only the country and its time zone", () =>
  expect(locationOf(slot("co"))).toEqual({
    type: "approximate",
    country: "CO",
    timezone: "America/Bogota",
  }));

test.each([
  [MEDELLIN, "local"],
  [BOGOTA, "local"],
  ["co-r20198", "local"],
  ["co", "local"],
  [MEDELLIN, "national"],
] as const)("the slot declares %s (%s) at the precision the request sends", (key, scope) => {
  const s = slot(key, "openai", scope);
  const sent = locationOf(s);
  const level = sent?.city ? "city" : sent?.region ? "region" : "country";
  expect(s.geoDeclared.level).toBe(level);
  const geo = getGeo(key);
  expect(s.geoDeclared.label).toBe(level === "country" ? getCountry(geo.country).name : geo.name);
});

test("a national question names only the country", () =>
  expect(locationOf(slot(MEDELLIN, "openai", "national"))).toEqual({
    type: "approximate",
    country: "CO",
    timezone: "America/Bogota",
  }));

test("a slot routed to another provider is refused", () =>
  expect(() => buildControlRequest(slot(MEDELLIN, "dataforseo"))).toThrow(InvalidInputError));

test("a different model without a new profile id is refused", () => {
  vi.stubEnv("OPENAI_CONTROL_MODEL", "gpt-6-astra");
  expect(() => assertPinnedProfile()).toThrow(/control-chatgpt@2/);
  expect(() => buildControlRequest(slot(MEDELLIN))).toThrow(/control-chatgpt@2/);
});

test("the pinned model passes", () => {
  vi.stubEnv("OPENAI_CONTROL_MODEL", "gpt-6.1-terra");
  expect(() => assertPinnedProfile()).not.toThrow();
});

test("the profile hash is the sha256 of its JCS and is the pinned one", () => {
  const { hash, ...rest } = CONTROL_PROFILE;
  expect(hash).toBe(sha256Hex(jcs(rest)));
  expect(hash).toBe(PINNED_PROFILE_HASHES["control-chatgpt@1"]);
});

test("the control model defaults to the pinned one and can be set", () => {
  expect(defineEnv([openaiControlEnv], { APP_ENV: "development" }).OPENAI_CONTROL_MODEL).toBe(
    "gpt-6.1-terra",
  );
  expect(
    defineEnv([openaiControlEnv], { APP_ENV: "development", OPENAI_CONTROL_MODEL: "gpt-6-astra" })
      .OPENAI_CONTROL_MODEL,
  ).toBe("gpt-6-astra");
});
