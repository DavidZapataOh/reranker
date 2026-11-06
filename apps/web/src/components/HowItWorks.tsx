"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { H2, Lede, Section } from "./ui";

const steps = [
  {
    t: "Escribe el nombre de tu negocio",
    d: "No necesitas registrarte ni conectar nada para el primer reporte.",
  },
  {
    t: "Le preguntamos a la IA como lo haría un cliente",
    d: "ChatGPT, Gemini, Google y Perplexity, varias veces y de varias formas.",
  },
  {
    t: "Ves quién sale y qué cambiar",
    d: "Tu puntaje, quién aparece en tu lugar y la primera corrección, en palabras normales.",
  },
];

export function HowItWorks() {
  const [s, setS] = useState(0);
  const [auto, setAuto] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  // Auto-advances only while in view and untouched by the user; not with reduced motion.
  useEffect(() => {
    if (!auto || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.4 });
    if (ref.current) io.observe(ref.current);
    const t = window.setInterval(() => visible && setS((v) => (v + 1) % 3), 4200);
    return () => {
      io.disconnect();
      window.clearInterval(t);
    };
  }, [auto]);

  const pick = (i: number) => {
    setAuto(false);
    setS(i);
  };
  return (
    <Section id="como-funciona" labelledBy="how-title" className="bg-white py-24 md:py-32">
      <H2 id="how-title">Así funciona.</H2>
      <Lede>Tres pasos y menos de 2 minutos.</Lede>

      <div
        ref={ref}
        className="mt-12 grid gap-8 lg:grid-cols-[1fr_1.15fr] lg:items-stretch lg:gap-14"
      >
        <div
          role="tablist"
          aria-label="Pasos"
          aria-orientation="vertical"
          className="flex flex-col gap-2"
        >
          {steps.map((st, i) => (
            <button
              key={st.t}
              type="button"
              role="tab"
              id={`step-${i}`}
              aria-selected={s === i}
              aria-controls="step-panel"
              onClick={() => pick(i)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowRight") pick((i + 1) % 3);
                if (e.key === "ArrowUp" || e.key === "ArrowLeft") pick((i + 2) % 3);
              }}
              className={`grid grid-cols-[2.25rem_1fr] gap-4 rounded-2xl p-5 text-left transition-colors duration-200 ${
                s === i ? "bg-paper ring-1 ring-line" : "hover:bg-paper/60"
              }`}
            >
              <span
                className={`grid h-9 w-9 place-items-center rounded-full font-display text-[16px] font-black transition-colors ${
                  s === i ? "bg-green text-white" : "bg-bubble text-ink/60"
                }`}
              >
                {i + 1}
              </span>
              <span>
                <span className="block text-[18px] font-bold text-ink">{st.t}</span>
                <span
                  className={`mt-1 block text-[15.5px] leading-relaxed text-ink/70 ${s === i ? "" : "max-lg:hidden"}`}
                >
                  {st.d}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div
          id="step-panel"
          role="tabpanel"
          aria-labelledby={`step-${s}`}
          className="relative flex min-h-[320px] items-center overflow-hidden rounded-3xl bg-paper p-6 pb-14 ring-1 ring-line md:p-9 md:pb-14"
        >
          <div key={s} className="step-in w-full">
            {s === 0 && (
              <div className="mx-auto w-full max-w-[440px]">
                <div className="flex items-center gap-2 rounded-2xl bg-white p-2 pl-4 shadow-soft ring-1 ring-line">
                  <span className="flex-1 text-[16px] text-ink">
                    Hotel Brisa Marina
                    <span className="caret" />
                  </span>
                  <span className="rounded-xl bg-green px-4 py-2.5 text-[14px] font-semibold text-white">
                    Ver
                  </span>
                </div>
                <ul className="mt-8 space-y-2.5">
                  {[
                    ["/engines/openai.svg", "ChatGPT"],
                    ["/engines/gemini.svg", "Gemini"],
                    ["/engines/google.svg", "Google"],
                    ["/engines/perplexity.svg", "Perplexity"],
                  ].map(([src, n], k) => (
                    <li
                      key={n}
                      className="flex items-center gap-3 rounded-xl bg-white/70 px-4 py-3 ring-1 ring-line"
                      style={{ animationDelay: `${150 + k * 120}ms` }}
                    >
                      <Image src={src} alt="" width={20} height={20} className="h-5 w-5" />
                      <span className="flex-1 text-[14.5px] text-ink">{n}</span>
                      <span className="font-mono text-[12px] text-ink/50">en cola</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {s === 1 && (
              <ul className="space-y-3">
                {[
                  ["/engines/openai.svg", "ChatGPT", "¿Qué hotel me recomiendas en Santa Marta?"],
                  [
                    "/engines/gemini.svg",
                    "Gemini",
                    "Hotel frente al mar en Santa Marta para ir en pareja",
                  ],
                  ["/engines/google.svg", "Google", "mejores hoteles Santa Marta El Rodadero"],
                  [
                    "/engines/perplexity.svg",
                    "Perplexity",
                    "Hoteles boutique bien calificados en Santa Marta",
                  ],
                ].map(([src, n, q], k) => (
                  <li
                    key={n}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl bg-white p-4 ring-1 ring-line"
                    style={{ animationDelay: `${k * 120}ms` }}
                  >
                    <Image src={src} alt="" width={24} height={24} className="h-6 w-6" />
                    <span className="w-20 text-[13px] font-semibold text-ink/70">{n}</span>
                    <span className="font-mono text-[12px] text-ink/45 sm:order-last">×10</span>
                    <span className="w-full text-[15px] text-ink sm:w-auto sm:flex-1">{q}</span>
                  </li>
                ))}
              </ul>
            )}
            {s === 2 && (
              <div className="rounded-2xl bg-white p-6 ring-1 ring-line">
                <p className="text-[14px] text-ink/60">Hotel Brisa Marina · Santa Marta</p>
                <p className="mt-2 font-display text-[56px] leading-none font-black text-ink">34</p>
                <p className="font-mono text-[12.5px] text-ink/55">entre 28 y 40</p>
                <p className="mt-5 text-[15px] text-ink">
                  Sale en tu lugar: <strong className="font-semibold">Casa Rodadero</strong> y{" "}
                  <strong className="font-semibold">Hotel Taganga Azul</strong>.
                </p>
                <p className="mt-2 text-[15px] text-ink">
                  Primera corrección:{" "}
                  <span className="rounded bg-amber/70 px-1">
                    agrega fotos de las habitaciones a tu perfil de Google
                  </span>
                  .
                </p>
              </div>
            )}
          </div>
          <span className="absolute right-6 bottom-5 inline-flex h-6 items-center rounded-full bg-green-light px-2.5 text-[12px] font-semibold text-green">
            Ejemplo
          </span>
        </div>
      </div>
    </Section>
  );
}
