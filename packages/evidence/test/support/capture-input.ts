import { randomBytes } from "node:crypto";
import { COUNTRIES, DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import type { CaptureId } from "@reranker/verify/format";
import type { SealCaptureInput } from "../../src/seal";
import type { CapturePredicateInput } from "../../src/statement";

const country = COUNTRIES[DEFAULT_COUNTRY_CODE];

/** A ChatGPT capture as the capture step describes it, before this package adds time and worker. */
export const predicateInput: CapturePredicateInput = {
  plan: { digest: { sha256: "c".repeat(64) }, slot: 3, attempt: 1 },
  prompt: {
    set_version: "2026-11",
    set_root: "d".repeat(64),
    intent_id: "odontologia.blanqueamiento-dental",
    paraphrase_id: "p1",
    persona_id: null,
    lang: country.defaultLocale,
    text: "¿Qué clínica recomiendas para blanqueamiento dental en Medellín?",
  },
  engine: {
    name: "chatgpt",
    surface: "chatgpt-web",
    channel: "ui-vendor",
    vendor: "dataforseo",
    vendor_task_id: null,
    endpoint: "/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
    model_reported: null,
    mode: "live",
    tool_version: null,
    fan_out_queries: null,
  },
  params: { force_web_search: true, temperature: null },
  geo: {
    declared: {
      country: country.code,
      region: null,
      city: null,
      vendor_location_code: country.providers.dataforseo.locationCode,
    },
    egress: null,
  },
  session: { state: "anonymous", fresh: true },
  provider_signature: null,
  tlsn: null,
  c2pa: null,
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A fresh capture id in the cap_ + ULID alphabet. */
export function newCaptureId(): CaptureId {
  const chars = Array.from(randomBytes(26), (b) => CROCKFORD[b % CROCKFORD.length]);
  return `cap_${chars.join("")}` as CaptureId;
}

/**
 * A capture as the capture step hands it to sealCapture, with a response of about `responseBytes`
 * bytes, unique to its id so no two seals share an artifact.
 */
export function sealInputFor(captureId: CaptureId, responseBytes = 2048): SealCaptureInput {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const markdown = randomBytes(Math.ceil((responseBytes * 3) / 4)).toString("base64");
  return {
    captureId,
    responseBytes: utf8(`{"tasks":[{"id":"${captureId}","result":[{"markdown":"${markdown}"}]}]}`),
    responseContentType: "application/json",
    requestBytes: utf8(`[{"user_prompt":"blanqueamiento dental","id":"${captureId}"}]`),
    normalized: {
      json: utf8(`{"answer":"Clínica Sonrisa","id":"${captureId}"}`),
      parserVersion: 1,
    },
    predicate: predicateInput,
  };
}
