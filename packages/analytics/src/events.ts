import type { AppEnv, CaptureChannel, CountryCode, EngineId, ErrorCode } from "@reranker/schema";
import type { LevelKey } from "@reranker/schema/measurement";

type VerificationReason =
  | "connection_limit"
  | "network"
  | "outside_supported_region"
  | "high_demand";
type VerificationMethod = "google" | "email_code" | "email_link";
type Mode = "live" | "reduced";
type IntentSetKind = "seed" | "generated" | "template";
type LeadRef = { lead_id: string; report_id: string };
type Spend = { provider: string; purpose: string; micro_usd: number };
// `error` is an error class or code, never a message.
type Step = { workflow: string; step: string; error: string };
type Db = { pool: "app" | "system"; pg_code?: string; reason?: string };
type Verdict =
  | "intact_dated"
  | "intact_dating"
  | "valid_content_removed"
  | "mismatch"
  | "untrusted_signature"
  | "not_found"
  | "incomplete";

export interface ServerEventMap {
  report_requested: {
    report_id: string;
    country: CountryCode;
    geo_key: string;
    geo_level: "city" | "region" | "country";
    category_key: string;
    category_source: "seed" | "places_type" | "inferred";
    scope: "local" | "national";
    intent_set_kind: IntentSetKind;
    mode: Mode;
    reused: boolean;
    needs_choice: boolean;
    queue_eta_s: number;
    admission_path: "anonymous" | "verified";
    pool: "free-report-anonymous" | "free-report-verified" | null;
  };
  report_verification_required: {
    report_id: string;
    reason: VerificationReason;
    methods: VerificationMethod[];
  };
  report_verified: { report_id: string; method: VerificationMethod };
  free_report_verify_mode: {
    state: "tripped" | "released";
    reason: string;
    count_10m: number;
    spend_10m_micros: number;
    flagged_10m: number;
  };
  report_completed: {
    report_id: string;
    country: CountryCode;
    mode: Mode;
    reused: boolean;
    partial: boolean;
    observations: number;
    duration_s: number;
    cost_micros: number;
    engines_measured: number;
    intent_set_kind: IntentSetKind;
    score_level: LevelKey | null;
  };
  report_failed: { report_id: string; error_code: ErrorCode; duration_s: number };
  report_deferred: {
    report_id: string;
    reason: "budget" | "identity_limit" | "ip_limit" | "remeasure";
    queue_position: number;
  };
  report_viewed: {
    report_id: string;
    country: CountryCode;
    origin_visit_id: string | null;
    is_origin_visit: boolean;
    first_view: boolean;
    time_to_view_s: number | null;
  };
  lead_created: {
    lead_id: string;
    report_id: string;
    country: CountryCode;
    geo_key: string;
    category_key: string;
    score_level: LevelKey | null;
    consent_version: string;
    source: "lead_form" | "verify";
  };
  email_code_blocked: { reason: "disposable" | "no_mx" | "rate_limited" | "quota" };
  confirmation_link_sent: LeadRef;
  remeasure_completed: LeadRef & { level_changed: boolean };
  report_email_sent: LeadRef;
  report_email_deferred: LeadRef;
  report_email_failed: LeadRef;
  commercial_consent_confirmed: { lead_id: string };
  lead_unsubscribed: { lead_id: string };
  lead_erased: { lead_id: string };
  auth_code_sent: Record<never, never>;
  auth_sign_in: { method: "google" | "email_otp"; new_user: boolean };
  auth_sign_in_failed: {
    reason: "otp_expired" | "invalid_otp" | "too_many_attempts" | "oauth_error";
  };
  auth_rate_limited: { route: string };
  data_policy_accepted: { version: string };
  account_ready: { claimed_reports: number };
  account_deleted: Record<never, never>;
  auth_email_failed: Record<never, never>;
  ops_alert: { kind: string; severity: "info" | "warning" | "critical"; env: AppEnv };
  problem_returned: { code: ErrorCode; status: number };
  db_rls_violation: Db;
  db_pool_exhausted: Db;
  db_compute_unavailable: Db;
  "jobs.spend.reserved": Spend;
  "jobs.spend.settled": Spend;
  "jobs.spend.cap_reached": { scope: string };
  "jobs.lease.wait_ms": { provider: string; wait_ms: number };
  "jobs.lease.denied": { provider: string };
  "jobs.breaker.state": { provider: string; state: string };
  "jobs.step.retry": Step;
  "jobs.step.fatal": Step;
  regime_opened: {
    engine: EngineId;
    channel: CaptureChannel;
    from: string | null;
    to: string;
    first_capture_id: string;
  };
}

export interface ClientEventMap {
  section_viewed: { section_id: string };
  cta_clicked: { cta_id: string; section_id: string; destination: string | null };
  whatsapp_clicked: { section_id: string; cta_id: string; ref: string | null };
  consent_decided: { consent: "granted" | "denied" };
  report_form_started: { section_id: string };
  report_form_submitted: { section_id: string; has_name: boolean };
  report_form_error: { section_id: string; error_type: ErrorCode | "network" };
  report_shared: {
    report_id: string;
    channel: "native" | "whatsapp" | "copy" | "card" | "agency";
  };
  report_cta_clicked: { report_id: string; cta_id: string };
  glossary_opened: { term: string };
  confirm_email_shown: { reason: VerificationReason };
  confirm_email_started: { method: VerificationMethod };
  verification_completed: {
    verdict: Verdict;
    source: "report" | "email" | "direct" | "upload";
  };
  verification_text_compared: { result: "match" | "changed" };
  lead_form_started: { report_id: string; channel: "email" };
  lead_form_submitted: { report_id: string; channel: "email" };
}

export type ServerEventName = keyof ServerEventMap;
export type ServerEventProps<N extends ServerEventName> = ServerEventMap[N];
export type ServerEventOf<N extends ServerEventName> = { name: N; props: ServerEventProps<N> };
export type ServerEvent = { [N in ServerEventName]: ServerEventOf<N> }[ServerEventName];

export type ClientEventName = keyof ClientEventMap;
export type ClientEventProps<N extends ClientEventName> = ClientEventMap[N];
export type ClientEventOf<N extends ClientEventName> = { name: N; props: ClientEventProps<N> };
export type ClientEvent = { [N in ClientEventName]: ClientEventOf<N> }[ClientEventName];

export const SERVER_EVENT_KEYS = {
  report_requested: [
    "report_id",
    "country",
    "geo_key",
    "geo_level",
    "category_key",
    "category_source",
    "scope",
    "intent_set_kind",
    "mode",
    "reused",
    "needs_choice",
    "queue_eta_s",
    "admission_path",
    "pool",
  ],
  report_verification_required: ["report_id", "reason", "methods"],
  report_verified: ["report_id", "method"],
  free_report_verify_mode: ["state", "reason", "count_10m", "spend_10m_micros", "flagged_10m"],
  report_completed: [
    "report_id",
    "country",
    "mode",
    "reused",
    "partial",
    "observations",
    "duration_s",
    "cost_micros",
    "engines_measured",
    "intent_set_kind",
    "score_level",
  ],
  report_failed: ["report_id", "error_code", "duration_s"],
  report_deferred: ["report_id", "reason", "queue_position"],
  report_viewed: [
    "report_id",
    "country",
    "origin_visit_id",
    "is_origin_visit",
    "first_view",
    "time_to_view_s",
  ],
  lead_created: [
    "lead_id",
    "report_id",
    "country",
    "geo_key",
    "category_key",
    "score_level",
    "consent_version",
    "source",
  ],
  email_code_blocked: ["reason"],
  confirmation_link_sent: ["lead_id", "report_id"],
  remeasure_completed: ["lead_id", "report_id", "level_changed"],
  report_email_sent: ["lead_id", "report_id"],
  report_email_deferred: ["lead_id", "report_id"],
  report_email_failed: ["lead_id", "report_id"],
  commercial_consent_confirmed: ["lead_id"],
  lead_unsubscribed: ["lead_id"],
  lead_erased: ["lead_id"],
  auth_code_sent: [],
  auth_sign_in: ["method", "new_user"],
  auth_sign_in_failed: ["reason"],
  auth_rate_limited: ["route"],
  data_policy_accepted: ["version"],
  account_ready: ["claimed_reports"],
  account_deleted: [],
  auth_email_failed: [],
  ops_alert: ["kind", "severity", "env"],
  problem_returned: ["code", "status"],
  db_rls_violation: ["pool", "pg_code", "reason"],
  db_pool_exhausted: ["pool", "pg_code", "reason"],
  db_compute_unavailable: ["pool", "pg_code", "reason"],
  "jobs.spend.reserved": ["provider", "purpose", "micro_usd"],
  "jobs.spend.settled": ["provider", "purpose", "micro_usd"],
  "jobs.spend.cap_reached": ["scope"],
  "jobs.lease.wait_ms": ["provider", "wait_ms"],
  "jobs.lease.denied": ["provider"],
  "jobs.breaker.state": ["provider", "state"],
  "jobs.step.retry": ["workflow", "step", "error"],
  "jobs.step.fatal": ["workflow", "step", "error"],
  regime_opened: ["engine", "channel", "from", "to", "first_capture_id"],
} as const satisfies { [N in ServerEventName]: readonly (keyof ServerEventMap[N])[] };

export const CLIENT_EVENT_KEYS = {
  section_viewed: ["section_id"],
  cta_clicked: ["cta_id", "section_id", "destination"],
  whatsapp_clicked: ["section_id", "cta_id", "ref"],
  consent_decided: ["consent"],
  report_form_started: ["section_id"],
  report_form_submitted: ["section_id", "has_name"],
  report_form_error: ["section_id", "error_type"],
  report_shared: ["report_id", "channel"],
  report_cta_clicked: ["report_id", "cta_id"],
  glossary_opened: ["term"],
  confirm_email_shown: ["reason"],
  confirm_email_started: ["method"],
  verification_completed: ["verdict", "source"],
  verification_text_compared: ["result"],
  lead_form_started: ["report_id", "channel"],
  lead_form_submitted: ["report_id", "channel"],
} as const satisfies { [N in ClientEventName]: readonly (keyof ClientEventMap[N])[] };

// Single owner of the personal-data deny list; telemetry scrubbing reuses it.
export const BANNED_PROPERTY_KEYS = [
  "business_name",
  "name",
  "email",
  "phone",
  "query",
  "answer",
  "text",
  "wa_id",
  "prompt",
  "response",
  "$ip",
] as const;
export type BannedKey = (typeof BANNED_PROPERTY_KEYS)[number];

export type Sanitized<P> = { props: Partial<P>; dropped: string[] };

const MAX_STRING_LENGTH = 200;

function isAllowedValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function clip(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) return value.map((item: string) => item.slice(0, MAX_STRING_LENGTH));
  return value;
}

function sanitize(allowed: readonly string[] | undefined, input: unknown) {
  if (!allowed) return null;
  const source =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const props: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key) && isAllowedValue(value)) props[key] = clip(value);
    else dropped.push(key);
  }
  return { props, dropped: dropped.sort() };
}

export function sanitizeServerProps<N extends ServerEventName>(
  name: N,
  props: unknown,
): Sanitized<ServerEventProps<N>> | null {
  return sanitize(
    Object.hasOwn(SERVER_EVENT_KEYS, name) ? SERVER_EVENT_KEYS[name] : undefined,
    props,
  ) as Sanitized<ServerEventProps<N>> | null;
}

export function sanitizeClientProps<N extends ClientEventName>(
  name: N,
  props: unknown,
): Sanitized<ClientEventProps<N>> | null {
  return sanitize(
    Object.hasOwn(CLIENT_EVENT_KEYS, name) ? CLIENT_EVENT_KEYS[name] : undefined,
    props,
  ) as Sanitized<ClientEventProps<N>> | null;
}
