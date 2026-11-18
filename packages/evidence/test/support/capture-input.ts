import { COUNTRIES, DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
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
