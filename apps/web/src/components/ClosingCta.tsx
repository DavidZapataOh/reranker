"use client";

import Image from "next/image";
import { useEffect, useId, useState } from "react";

const asks = [
  { q: "¿Qué clínica dental me recomiendas en Bucaramanga?", a: "Te recomiendo Dental Cabecera y" },
  { q: "Un hotel boutique tranquilo en Cartagena, ¿cuál?", a: "Te sugiero Casa Arbórea y" },
  {
    q: "Necesito un abogado de inmigración en Bogotá.",
    a: "Puedes escribirle a Ruiz & Asociados y",
  },
  { q: "¿Dónde compro ropa de lino hecha en Colombia?", a: "Mira Lino Andino y" },
];

/**
 * Closing: the same question as the hero, now with a blank for the owner's business name.
 * The form sends the name to the demo above (rr:business event) and scrolls up.
 */
export function ClosingCta() {
  const [k, setK] = useState(0);
  const [name, setName] = useState("");
  const id = useId();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => setK((v) => (v + 1) % asks.length), 3800);
    return () => window.clearInterval(t);
  }, []);

  const ask = asks[k];

  return (
    <section aria-labelledby="closing-title" className="py-24 md:py-32">
      <div className="mx-auto max-w-[1280px] px-5 md:px-10">
        <div className="grid overflow-hidden rounded-[32px] bg-white ring-1 ring-line md:grid-cols-[1.05fr_1fr]">
          {/* Left: the action */}
          <div className="min-w-0 p-6 sm:p-8 md:p-14">
            <h2
              id="closing-title"
              className="font-display text-[clamp(2.1rem,3.6vw,3.3rem)] leading-[1.06] font-black tracking-[-0.02em] text-balance text-ink"
            >
              Mira qué le responde la IA a tus clientes hoy.
            </h2>
            <form
              className="mt-8"
              onSubmit={(e) => {
                e.preventDefault();
                window.dispatchEvent(
                  new CustomEvent("rr:business", { detail: name.trim() || "Tu negocio" }),
                );
                document
                  .getElementById("demo")
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              <label htmlFor={id} className="sr-only">
                Nombre de tu negocio
              </label>
              <div className="flex items-center gap-2 rounded-[18px] bg-paper p-2 pl-4 ring-1 ring-line focus-within:ring-2 focus-within:ring-green/40">
                <input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="organization"
                  enterKeyHint="go"
                  placeholder="Nombre de tu negocio"
                  className="min-w-0 flex-1 bg-transparent py-2.5 text-[17px] text-ink outline-none placeholder:text-ink/45"
                />
                <button
                  type="submit"
                  className="inline-flex h-12 shrink-0 items-center gap-2 rounded-xl bg-green px-5 text-[16px] font-semibold text-white transition-[background-color,transform] duration-150 hover:-translate-y-px hover:bg-green-deep"
                >
                  <span className="hidden sm:inline">Ver qué dice la IA</span>
                  <span className="sm:hidden">Ver</span>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-[18px] w-[18px]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h13M13 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
              <p className="mt-3.5 text-[14px] text-ink/60">
                Gratis · Sin registro ni tarjeta · Resultado en menos de 2 minutos
              </p>
            </form>
          </div>

          {/* Right: a customer's question, with a blank for their name */}
          <div
            aria-hidden="true"
            className="relative flex min-w-0 flex-col justify-center gap-4 bg-paper p-6 sm:p-8 md:border-l md:border-line md:p-12"
          >
            <div key={k} className="step-in space-y-4">
              <p className="ml-auto w-fit max-w-[92%] rounded-2xl rounded-tr-md bg-white px-4 py-3 text-[15.5px] leading-snug text-ink ring-1 ring-line">
                {ask.q}
              </p>
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line">
                  <Image
                    src="/engines/openai.svg"
                    alt=""
                    width={22}
                    height={22}
                    className="h-[22px] w-[22px]"
                  />
                </span>
                <p className="min-w-0 rounded-2xl rounded-tl-md bg-white px-4 py-3 text-[15.5px] leading-relaxed text-ink ring-1 ring-line">
                  {ask.a}{" "}
                  <span className="marker rounded-sm px-1 font-semibold">
                    {name.trim() || "¿tu negocio?"}
                  </span>
                </p>
              </div>
            </div>
            <p className="-rotate-[4deg] self-end pr-2 font-hand text-[28px] leading-none text-ink">
              ¿Sales tú?
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
