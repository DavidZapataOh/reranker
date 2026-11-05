"use client";

import { useEffect, useRef, useState } from "react";
import { Example } from "./ui";

const levels = ["Invisible", "A veces", "En la lista", "De los fijos"];

/** The brand moment: the score climbs one step (from "A veces" to "En la lista"). */
export function ScoreCard({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [up, setUp] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = window.setTimeout(() => setUp(true), 0);
      return () => window.clearTimeout(t);
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          io.disconnect();
          window.setTimeout(() => setUp(true), 600);
        }
      },
      { threshold: 0.5 },
    );
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  const current = up ? 2 : 1;
  const score = up ? 52 : 34;
  const range = up ? "entre 46 y 58" : "entre 28 y 40";

  return (
    <article ref={ref} className={`reveal rounded-3xl bg-white p-6 ring-1 ring-line md:p-8 ${className}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[19px] font-bold text-ink">Tu puntaje en la IA</h3>
          <p className="mt-1 text-[15px] text-ink/65">Qué tan seguido te nombra, de 0 a 100.</p>
        </div>
        <Example />
      </div>

      <div className="mt-6 flex items-end gap-4" aria-live="polite">
        <p className="font-display text-[clamp(4.5rem,8vw,6rem)] leading-[0.85] font-black tracking-[-0.03em] text-ink tabular-nums">
          <span className="sr-only">Puntaje de ejemplo: </span>
          {score}
        </p>
        <p className="pb-2 font-mono text-[13px] leading-snug text-ink/60">
          {range}
          <br />
          30 preguntas · 04 nov 2026
        </p>
      </div>

      {/* 4-level staircase: the stepped-r motif */}
      <div className="mt-8 grid grid-cols-4 items-end gap-2" aria-hidden="true">
        {levels.map((l, i) => (
          <div key={l} className="flex flex-col gap-2">
            <span
              className="relative block rounded-lg transition-[background-color] duration-[250ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
              style={{ height: 18 + i * 16, backgroundColor: i <= current ? "#0f5c45" : "#d9ebd7", transitionDelay: `${(i - 1) * 150}ms` }}
            >
              {i === current && (
                <span className="absolute -top-2 left-1/2 h-4 w-4 -translate-x-1/2 rounded-full bg-amber ring-4 ring-white" />
              )}
            </span>
            <span className={`text-[13px] ${i === current ? "font-semibold text-ink" : "text-ink/55"}`}>{l}</span>
          </div>
        ))}
      </div>
      <p className="mt-5 text-[14px] text-ink/65">
        {up ? "Subiste un escalón: ya estás en la lista." : "Hoy la IA te nombra a veces."}
      </p>
    </article>
  );
}
