import { expect, test } from "vitest";
import {
  BANNED_PROPERTY_KEYS,
  CLIENT_EVENT_KEYS,
  SERVER_EVENT_KEYS,
  sanitizeClientProps,
  sanitizeServerProps,
} from "../src/events";

const viewed = {
  report_id: "fr_01J",
  country: "MX",
  origin_visit_id: null,
  is_origin_visit: true,
  first_view: true,
  time_to_view_s: 42,
} as const;

test("server catalog names every event the other plans emit", () => {
  expect(Object.keys(SERVER_EVENT_KEYS).sort()).toEqual([
    "account_deleted",
    "account_ready",
    "auth_code_sent",
    "auth_email_failed",
    "auth_rate_limited",
    "auth_sign_in",
    "auth_sign_in_failed",
    "commercial_consent_confirmed",
    "confirmation_link_sent",
    "data_policy_accepted",
    "db_compute_unavailable",
    "db_pool_exhausted",
    "db_rls_violation",
    "email_code_blocked",
    "free_report_verify_mode",
    "jobs.breaker.state",
    "jobs.lease.denied",
    "jobs.lease.wait_ms",
    "jobs.spend.cap_reached",
    "jobs.spend.reserved",
    "jobs.spend.settled",
    "jobs.step.fatal",
    "jobs.step.retry",
    "lead_created",
    "lead_erased",
    "lead_unsubscribed",
    "ops_alert",
    "problem_returned",
    "regime_opened",
    "remeasure_completed",
    "report_completed",
    "report_deferred",
    "report_email_deferred",
    "report_email_failed",
    "report_email_sent",
    "report_failed",
    "report_requested",
    "report_verification_required",
    "report_verified",
    "report_viewed",
  ]);
});

test("client catalog keeps the live landing events and adds the funnel ones", () => {
  expect(Object.keys(CLIENT_EVENT_KEYS).sort()).toEqual([
    "confirm_email_shown",
    "confirm_email_started",
    "consent_decided",
    "cta_clicked",
    "glossary_opened",
    "lead_form_started",
    "lead_form_submitted",
    "report_cta_clicked",
    "report_form_error",
    "report_form_started",
    "report_form_submitted",
    "report_shared",
    "section_viewed",
    "verification_completed",
    "verification_text_compared",
    "whatsapp_clicked",
  ]);
});

test("banned keys are the shared list", () => {
  expect(BANNED_PROPERTY_KEYS).toEqual([
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
  ]);
});

test("no allow-list contains a banned key", () => {
  for (const keys of [...Object.values(SERVER_EVENT_KEYS), ...Object.values(CLIENT_EVENT_KEYS)]) {
    expect(keys.filter((k) => (BANNED_PROPERTY_KEYS as readonly string[]).includes(k))).toEqual([]);
  }
});

test("decision events carry country", () => {
  for (const n of [
    "report_requested",
    "report_completed",
    "report_viewed",
    "lead_created",
  ] as const) {
    expect(SERVER_EVENT_KEYS[n]).toContain("country");
  }
});

test("keeps allowed props untouched", () => {
  expect(sanitizeServerProps("report_viewed", viewed)).toEqual({ props: viewed, dropped: [] });
});

test("drops banned, unknown and non-primitive props and reports them", () => {
  const r = sanitizeServerProps("report_viewed", {
    ...viewed,
    business_name: "Panadería Ana",
    email: "ana@x.co",
    extra: 1,
    first_view: { nested: true },
  });
  const { first_view: _, ...rest } = viewed;
  expect(r?.props).toEqual(rest);
  expect(r?.dropped).toEqual(["business_name", "email", "extra", "first_view"]);
});

test("caps strings at 200 characters", () => {
  expect(
    sanitizeServerProps("auth_rate_limited", { route: "x".repeat(500) })?.props.route,
  ).toHaveLength(200);
});

test("keeps arrays of strings", () => {
  expect(
    sanitizeServerProps("report_verification_required", {
      report_id: "fr_1",
      reason: "network",
      methods: ["google", "email_code"],
    })?.dropped,
  ).toEqual([]);
});

test("drops arrays holding non-strings and non-finite numbers", () => {
  const r = sanitizeServerProps("report_verification_required", {
    report_id: "fr_1",
    reason: "network",
    methods: ["google", 1],
  });
  expect(r?.dropped).toEqual(["methods"]);
  expect(
    sanitizeServerProps("report_viewed", { ...viewed, time_to_view_s: Number.NaN })?.dropped,
  ).toEqual(["time_to_view_s"]);
});

test("a non-object payload yields no props", () => {
  expect(sanitizeServerProps("auth_code_sent", null)).toEqual({ props: {}, dropped: [] });
  expect(sanitizeServerProps("auth_code_sent", ["x"])).toEqual({ props: {}, dropped: [] });
});

test("unknown event is rejected", () => {
  expect(sanitizeServerProps("report_seen" as never, {})).toBeNull();
  expect(sanitizeServerProps("toString" as never, {})).toBeNull();
  expect(sanitizeClientProps("report_seen" as never, {})).toBeNull();
});

test("client sanitize drops a banned key", () => {
  expect(
    sanitizeClientProps("report_form_submitted", {
      section_id: "hero",
      has_name: true,
      query: "Panadería",
    })?.dropped,
  ).toEqual(["query"]);
});
