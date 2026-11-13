"use client";

import { ExampleChip, StepBars } from "@reranker/ui";
import { useEffect, useRef, useState } from "react";

const levels = ["Invisible", "A veces", "En la lista", "De los fijos"] as const;

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
        if (e?.isIntersecting) {
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
    <article
      ref={ref}
      className={`reveal rounded-3xl bg-white p-6 ring-1 ring-line md:p-8 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[19px] font-bold text-ink">Tu puntaje en la IA</h3>
          <p className="mt-1 text-[15px] text-ink/65">Qué tan seguido te nombra, de 0 a 100.</p>
        </div>
        <ExampleChip />
      </div>

      <div className="mt-6 flex items-end gap-4" aria-live="polite">
        <p className="font-display text-[clamp(4.5rem,8vw,6rem)] leading-[0.85] font-black tracking-[-0.03em] text-ink tabular-nums">
          <span className="sr-only">Puntaje de ejemplo: </span>
          {score}
        </p>
        <p className="pb-2 font-mono text-[13px] leading-snug text-ink/65">
          {range}
          <br />
          30 preguntas · 04 nov 2026
        </p>
      </div>

      <StepBars current={current} labels={levels} />
      <p className="mt-5 text-[14px] text-ink/65">
        {up ? "Subiste un escalón: ya estás en la lista." : "Hoy la IA te nombra a veces."}
      </p>
    </article>
  );
}
