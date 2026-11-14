"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import {
  afterPageLoad,
  CLARITY_ID,
  type Consent,
  flushQueuedEvents,
  GA_ID,
  POSTHOG_KEY,
  POSTHOG_REGION,
  readConsent,
  readOrigin,
  track,
  VISIT_ID,
  whatsappRef,
  writeConsent,
} from "@/lib/analytics";

const anyTool = Boolean(POSTHOG_KEY || GA_ID || CLARITY_ID);

/* ---------- Clarity: injected only after the visitor accepts ---------- */
function loadClarity() {
  if (!CLARITY_ID || document.getElementById("rr-clarity")) return;
  const s = document.createElement("script");
  s.id = "rr-clarity";
  s.text = `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");`;
  document.head.appendChild(s);
  window.clarity?.("consent");
}

/* Super properties set at init; re-registered after opt-in because switching
   from cookieless to cookie persistence drops them. */
let baseProps: Record<string, string | null> = {};
let firstTouchProps: Record<string, string | null> = {};

/* ---------- Apply the consent decision to every tool ---------- */
function applyConsent(c: Consent) {
  if (POSTHOG_KEY && posthog.__loaded) {
    if (c === "granted") {
      posthog.opt_in_capturing({ captureProperties: baseProps });
      posthog.register(baseProps);
      posthog.register_once(firstTouchProps);
      posthog.startSessionRecording();
    } else {
      // Pending or rejected: PostHog keeps measuring, but cookieless and without replays.
      if (c === "denied") posthog.opt_out_capturing();
      else if (posthog.get_explicit_consent_status() !== "pending")
        posthog.clear_opt_in_out_capturing();
      posthog.stopSessionRecording();
    }
  }
  if (GA_ID && window.gtag) {
    window.gtag("consent", "update", { analytics_storage: c === "granted" ? "granted" : "denied" });
  }
  if (c === "granted") loadClarity();
}

function sectionOf(el: Element): string {
  const s = el.closest("section[id], section[aria-labelledby], footer, nav, header");
  if (!s) return "other";
  return (
    s.id || s.getAttribute("aria-labelledby")?.replace(/-title$/, "") || s.tagName.toLowerCase()
  );
}

/** Mounts measurement: tools, funnel events and the cookie banner. */
export function Analytics() {
  const [showBanner, setShowBanner] = useState(false);
  const pathname = usePathname();
  const started = useRef(new WeakSet<HTMLFormElement>());

  // 1 · Init PostHog and read the stored consent decision.
  useEffect(() => {
    if (!anyTool) return;
    const c = readConsent();
    const origin = readOrigin();
    whatsappRef(); // persists the origin code for the whole visit

    const start = () => {
      if (POSTHOG_KEY && !posthog.__loaded) {
        posthog.init(POSTHOG_KEY, {
          api_host: "/ingest",
          ui_host: `https://${POSTHOG_REGION}.posthog.com`,
          defaults: "2025-05-24",
          cookieless_mode: "on_reject",
          // Treat "no decision yet" as rejected, so pending visitors are counted cookieless.
          opt_out_capturing_by_default: true,
          person_profiles: "identified_only",
          capture_pageview: "history_change",
          capture_pageleave: true,
          capture_exceptions: true,
          disable_session_recording: true, // turned on only after consent
          session_recording: {
            maskAllInputs: true,
            // Business names shown in the demo and the closing CTA.
            maskTextSelector: ".marker, [data-mask]",
          },
        });
        // Skip nulls so an internal navigation never erases the original AI source.
        baseProps = {
          ...(process.env.APP_ENV ? { app_env: process.env.APP_ENV } : {}),
          visit_id: VISIT_ID,
          device_type: origin.device_type,
          ...(origin.ai_source ? { ai_source: origin.ai_source } : {}),
        };
        firstTouchProps = {
          first_ai_source: origin.ai_source,
          first_referrer_domain: origin.referrer_domain,
          first_landing_path: origin.landing_path,
        };
        posthog.register(baseProps);
        posthog.register_once(firstTouchProps);
        flushQueuedEvents();
      }
      applyConsent(readConsent());
    };

    // Third-party scripts start only after the page has fully loaded and hydrated:
    // injecting them earlier puts foreign nodes in the DOM React is hydrating.
    const cancel = afterPageLoad(start);
    const t = window.setTimeout(() => setShowBanner(c === "pending"), 0);
    return () => {
      cancel();
      window.clearTimeout(t);
    };
  }, []);

  // 2 · Reopen the banner from the footer "cookie preferences" link.
  useEffect(() => {
    const open = () => setShowBanner(true);
    window.addEventListener("rr:consent-open", open);
    return () => window.removeEventListener("rr:consent-open", open);
  }, []);

  // 3 · Clicks, WhatsApp and forms, one delegated listener per type.
  useEffect(() => {
    if (!anyTool) return;

    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest("a, button") : null;
      if (!el || el.closest("[data-no-track]")) return;
      const section_id = sectionOf(el);
      const label = (
        el.getAttribute("data-cta") ||
        el.getAttribute("aria-label") ||
        el.textContent ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60);

      if (
        el instanceof HTMLAnchorElement &&
        /(^|\/\/)(wa\.me|api\.whatsapp\.com)\//.test(el.href)
      ) {
        const ref = whatsappRef();
        if (ref) {
          try {
            const u = new URL(el.href);
            const text = u.searchParams.get("text") ?? "";
            if (!text.includes(`[${ref}]`)) {
              u.searchParams.set("text", `${text} [${ref}]`.trim());
              el.href = u.toString();
            }
          } catch {
            /* malformed link: leave it untouched */
          }
        }
        track("whatsapp_clicked", { section_id, cta_id: label, ref });
        return;
      }
      if (el instanceof HTMLButtonElement && el.type === "submit") return; // counted by the form submit event
      const destination = el instanceof HTMLAnchorElement ? el.getAttribute("href") : null;
      track("cta_clicked", { cta_id: label, section_id, destination });
    };

    const onFocus = (e: FocusEvent) => {
      const form = e.target instanceof Element ? e.target.closest("form") : null;
      if (!form || started.current.has(form)) return;
      started.current.add(form);
      track("report_form_started", { section_id: sectionOf(form) });
    };

    const onSubmit = (e: SubmitEvent) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const input = form.querySelector("input");
      // Never send the business name, only whether one was typed.
      track("report_form_submitted", {
        section_id: sectionOf(form),
        has_name: Boolean(input?.value.trim()),
      });
    };

    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("submit", onSubmit, { capture: true });
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("submit", onSubmit, { capture: true });
    };
  }, []);

  // 4 · Section views: at least half the section or half the viewport visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname re-arms the observer on each route change
  useEffect(() => {
    if (!anyTool) return;
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const big =
            en.intersectionRatio >= 0.5 || en.intersectionRect.height >= window.innerHeight * 0.5;
          if (!big) continue;
          const id = sectionOf(en.target);
          if (seen.has(id)) continue;
          seen.add(id);
          track("section_viewed", { section_id: id });
          io.unobserve(en.target);
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75] },
    );
    document
      .querySelectorAll("main section[id], main section[aria-labelledby], footer")
      .forEach((s) => {
        io.observe(s);
      });
    return () => io.disconnect();
  }, [pathname]);

  const decide = (c: "granted" | "denied") => {
    writeConsent(c);
    setShowBanner(false);
    applyConsent(c);
    track("consent_decided", { consent: c });
  };

  return (
    <>
      {anyTool && showBanner ? (
        <div
          role="dialog"
          aria-label="Aviso de cookies"
          data-no-track
          className="fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-[440px] rounded-2xl bg-white p-5 shadow-[0_1px_2px_rgb(20_33_27/0.06),0_18px_44px_-16px_rgb(20_33_27/0.35)] ring-1 ring-line sm:inset-x-auto sm:left-5 sm:bottom-5 sm:mx-0"
        >
          <p className="text-[15.5px] font-semibold text-ink">¿Nos dejas medir tu visita?</p>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink/70">
            Usamos cookies para entender cómo se usa el sitio y mejorarlo. Si no aceptas, solo
            contamos visitas sin cookies.{" "}
            <Link
              href="/politica-de-datos#cookies"
              className="text-green underline underline-offset-[3px]"
            >
              Política de datos
            </Link>
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => decide("denied")}
              className="h-11 rounded-xl text-[15px] font-semibold text-ink ring-1 ring-ink/15 transition-colors hover:bg-ink/5"
            >
              Rechazar
            </button>
            <button
              type="button"
              onClick={() => decide("granted")}
              className="h-11 rounded-xl text-[15px] font-semibold text-ink ring-1 ring-ink/15 transition-colors hover:bg-ink/5"
            >
              Aceptar
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Footer control to change the consent decision at any time. */
export function CookiePrefsButton() {
  return (
    <button
      type="button"
      data-no-track
      onClick={() => window.dispatchEvent(new Event("rr:consent-open"))}
      className="hover:text-green"
    >
      Preferencias de cookies
    </button>
  );
}
