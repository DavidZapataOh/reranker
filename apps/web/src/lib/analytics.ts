"use client";

import posthog from "posthog-js";

/**
 * Measurement for reranker.co.
 *
 * - PostHog: funnel, events, errors and, with consent, session replays.
 *   Without consent it runs cookieless (cookieless_mode: "on_reject").
 * - Google Analytics 4: acquisition, with Consent Mode v2 defaulting to "denied".
 * - Microsoft Clarity: heatmaps and replays, loaded only after the visitor accepts.
 *
 * Each tool turns on only when its NEXT_PUBLIC_* variable is set, so in
 * development or without keys the site works the same and sends nothing.
 */

import { CLARITY_ID, GA_ID, POSTHOG_KEY, POSTHOG_REGION } from "./analytics-config";

export { CLARITY_ID, GA_ID, POSTHOG_KEY, POSTHOG_REGION };

/** Banner copy version, stored with every decision (Colombian Decreto 1377/2013). */
export const CONSENT_VERSION = "2026-11-05";
const CONSENT_KEY = "rr_consent";

export type Consent = "granted" | "denied" | "pending";

type Stored = { v: string; c: Exclude<Consent, "pending">; at: string };

export function readConsent(): Consent {
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return "pending";
    const s = JSON.parse(raw) as Stored;
    // Ask again whenever the banner copy changes.
    if (s.v !== CONSENT_VERSION) return "pending";
    return s.c;
  } catch {
    return "pending";
  }
}

export function writeConsent(c: Exclude<Consent, "pending">) {
  try {
    const s: Stored = { v: CONSENT_VERSION, c, at: new Date().toISOString() };
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(s));
  } catch {
    /* no storage available: the decision lasts for this visit only */
  }
}

/**
 * In-memory id for the current visit (lives until the tab reloads; never stored).
 * Accepting cookies makes PostHog switch from a cookieless identity to a new one,
 * so funnels count visits by this id to bridge the two.
 */
export const VISIT_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/* ---------- Origin: which AI assistant sent the visitor ---------- */

const AI_HOSTS: [RegExp, string][] = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)openai\.com$/, "chatgpt"],
  [/(^|\.)perplexity\.ai$/, "perplexity"],
  [/(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/, "gemini"],
  [/(^|\.)claude\.ai$/, "claude"],
  [/(^|\.)copilot\.microsoft\.com$|(^|\.)copilot\.cloud\.microsoft$/, "copilot"],
  [/(^|\.)chat\.deepseek\.com$/, "deepseek"],
  [/(^|\.)grok\.com$/, "grok"],
  [/(^|\.)meta\.ai$/, "meta_ai"],
];

function aiFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.toLowerCase();
  let host = v;
  try {
    host = new URL(v.includes("://") ? v : `https://${v}`).hostname;
  } catch {
    /* utm_source is not a URL, e.g. "chatgpt" */
  }
  for (const [re, name] of AI_HOSTS) if (re.test(host)) return name;
  for (const [, name] of AI_HOSTS) if (v === name || v.startsWith(`${name}.`)) return name;
  return null;
}

export type Origin = {
  ai_source: string | null;
  referrer_domain: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  device_type: "mobile" | "tablet" | "desktop";
  landing_path: string;
};

export function readOrigin(): Origin {
  const q = new URLSearchParams(window.location.search);
  let referrer_domain: string | null = null;
  try {
    if (document.referrer) {
      const h = new URL(document.referrer).hostname;
      if (h !== window.location.hostname) referrer_domain = h;
    }
  } catch {
    /* invalid referrer */
  }
  const w = window.innerWidth;
  return {
    ai_source: aiFrom(q.get("utm_source")) ?? aiFrom(referrer_domain),
    referrer_domain,
    utm_source: q.get("utm_source"),
    utm_medium: q.get("utm_medium"),
    utm_campaign: q.get("utm_campaign"),
    device_type: w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop",
    landing_path: window.location.pathname,
  };
}

/* ---------- Event dispatch ---------- */

type Props = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
    clarity?: (...args: unknown[]) => void;
  }
}

/* Events fired before PostHog finishes loading (it starts after window "load"). */
const queued: [string, Props][] = [];

/** Sends the event to PostHog and GA4; PostHog events are queued until it loads. */
export function track(event: string, props: Props = {}) {
  if (typeof window === "undefined") return;
  if (POSTHOG_KEY) {
    if (posthog.__loaded) posthog.capture(event, props);
    else if (queued.length < 50) queued.push([event, props]);
  }
  if (GA_ID && window.gtag) window.gtag("event", event, props);
}

export function flushQueuedEvents() {
  for (const [event, props] of queued.splice(0)) posthog.capture(event, props);
}

/** Runs fn once the page has loaded and the browser is idle. Returns a cancel function. */
export function afterPageLoad(fn: () => void): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => !cancelled && fn(), { timeout: 2000 });
    else setTimeout(() => !cancelled && fn(), 200);
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", run);
  };
}

/**
 * Short origin code appended to the prefilled WhatsApp message,
 * e.g. "IG-REEL-12" (utm_campaign) or "CHATGPT". Null for direct visits.
 */
export function whatsappRef(): string | null {
  try {
    const saved = window.sessionStorage.getItem("rr_ref");
    if (saved) return saved;
  } catch {
    /* no storage available */
  }
  const o = readOrigin();
  const raw = o.utm_campaign || o.utm_source || o.ai_source || o.referrer_domain?.replace(/^www\./, "").split(".")[0];
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  try {
    window.sessionStorage.setItem("rr_ref", code);
  } catch {
    /* no storage available */
  }
  return code || null;
}
