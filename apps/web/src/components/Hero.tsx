"use client";

import { useEffect, useId, useState } from "react";
import { EngineRotator } from "./EngineRotator";
import { ChatDemo } from "./ChatDemo";

const cities = ["Medellín", "Bogotá"] as const;

export function Hero() {
  const [city, setCity] = useState<(typeof cities)[number]>("Medellín");
  const [business, setBusiness] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // El formulario del cierre manda el nombre aquí, a la demo.
  useEffect(() => {
    const on = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      setBusiness(name === "Tu negocio" ? "" : name);
      setSubmitted(name);
    };
    window.addEventListener("rr:negocio", on);
    return () => window.removeEventListener("rr:negocio", on);
  }, []);
  const inputId = useId();
  const cityId = useId();

  return (
    <section id="reporte" aria-labelledby="hero-title" className="relative overflow-x-clip">
      <div className="mx-auto max-w-[1536px] px-5 pt-12 text-center md:px-16 md:pt-[3.65vw]">
        <h1
          id="hero-title"
          aria-label="Tus clientes le preguntan a ChatGPT, Gemini, Google y Perplexity. Que salgas tú."
          className="mx-auto max-w-[17ch] font-display text-[clamp(2.4rem,3.875vw,3.72rem)] leading-[1.2] font-black tracking-[-0.022em] text-balance text-ink md:max-w-none"
        >
          <span aria-hidden="true">
            Tus clientes le preguntan a <EngineRotator paused={paused} />
            <br />
            Que salgas tú.
          </span>
        </h1>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
          className="sr-only rounded-full bg-white px-3 py-1.5 text-[14px] font-semibold text-ink ring-1 ring-line focus:not-sr-only focus:mt-3 focus:inline-block"
        >
          {paused ? "Reanudar la animación de los motores" : "Pausar la animación de los motores"}
        </button>

        <p className="mx-auto mt-5 max-w-[1000px] lg:whitespace-nowrap text-[clamp(1.05rem,1.25vw,1.19rem)] leading-snug text-ink/80 md:mt-[1.5vw]">
          Te mostramos a quién recomiendan ChatGPT, Gemini, Google y Perplexity cuando alguien busca lo que vendes en {city}.
        </p>

        <form
          className="mx-auto mt-8 max-w-[832px] md:mt-[2.1vw] md:max-w-[54.2vw]"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(business.trim() || "Tu negocio");
            document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        >
          <div className="flex items-center gap-2 rounded-[22px] bg-white p-2 pl-5 shadow-[0_1px_2px_rgb(20_33_27/0.05),0_12px_32px_-14px_rgb(20_33_27/0.22)] ring-1 ring-line transition-shadow focus-within:ring-2 focus-within:ring-green/40">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[22px] w-[22px] shrink-0 text-ink/70" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
            <label htmlFor={inputId} className="sr-only">
              Nombre de tu negocio
            </label>
            <input
              id={inputId}
              name="negocio"
              autoComplete="organization"
              enterKeyHint="go"
              value={business}
              onChange={(e) => setBusiness(e.target.value)}
              placeholder="Nombre de tu negocio"
              className="min-w-0 flex-1 bg-transparent py-2 text-[18px] text-ink outline-none placeholder:text-ink/45 md:text-[19px]"
            />
            <button
              type="submit"
              className="inline-flex h-[54px] md:h-[clamp(48px,3.5vw,56px)] shrink-0 items-center gap-2 rounded-[13px] bg-green px-4 text-[16px] font-semibold text-white transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:-translate-y-px hover:bg-green-deep active:translate-y-0 md:px-6 md:text-[17px]"
            >
              <span className="hidden sm:inline">Ver qué dice la IA</span>
              <span className="sm:hidden">Ver</span>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>

          <div className="mt-4 flex justify-center md:mt-[1.05vw]">
            <label
              htmlFor={cityId}
              className="relative inline-flex h-9 md:h-[2.35vw] md:min-h-8 cursor-pointer items-center gap-2 rounded-full bg-green-light pr-3 pl-3.5 text-[15px] md:text-[clamp(14px,0.98vw,16px)] text-ink transition-colors hover:bg-[#cfe4cc]"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[17px] w-[17px] text-green">
                <path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.6a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z" />
              </svg>
              <span>Buscando en</span>
              <select
                id={cityId}
                value={city}
                onChange={(e) => setCity(e.target.value as (typeof cities)[number])}
                className="cursor-pointer appearance-none bg-transparent pr-5 font-medium outline-none"
              >
                {cities.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute right-3 h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </label>
          </div>

          <p className="mt-4 text-[14px] text-ink/60 md:mt-[1.15vw] md:text-[clamp(13px,0.92vw,15px)]">
            Gratis <span aria-hidden="true" className="px-1">·</span> Sin registro ni tarjeta{" "}
            <span aria-hidden="true" className="px-1">·</span> Resultado en menos de 2 minutos
          </p>
        </form>
      </div>

      <ChatDemo city={city} business={submitted} />
    </section>
  );
}
