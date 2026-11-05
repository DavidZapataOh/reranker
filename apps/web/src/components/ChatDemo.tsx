"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

const QUESTION = "¿Qué marca de ropa de lino hecha en Colombia me recomiendas?";
const ANSWER = "Te recomiendo tres marcas: Lino Andino, Casa Telar y Hilo Caribe, con envíos a todo el país.";

/**
 * The hero demo: our own window (not the ChatGPT UI) where a customer
 * asks and the AI answers word by word. Sample data, fictional businesses.
 * Desktop: stage measured against the comp (1536 px) and scaled with cqw units.
 */
export function ChatDemo({ business }: { business: string | null }) {
  const words = ANSWER.split(" ");
  const [shown, setShown] = useState(0);
  const [phase, setPhase] = useState<"idle" | "typing" | "done">("idle");
  const ref = useRef<HTMLDivElement>(null);
  const question = QUESTION;

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let timer: number | undefined;
    if (reduce) {
      timer = window.setTimeout(() => {
        setShown(words.length);
        setPhase("done");
      }, 0);
      return () => window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      setShown(0);
      setPhase("idle");
    }, 0);
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        let n = 0;
        setPhase("typing");
        const tick = () => {
          n += 1;
          setShown(n);
          if (n < words.length) timer = window.setTimeout(tick, 95);
          else timer = window.setTimeout(() => setPhase("done"), 250);
        };
        timer = window.setTimeout(tick, 700);
      },
      { threshold: 0.35 },
    );
    if (ref.current) io.observe(ref.current);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [business, words.length]);

  const done = phase === "done";
  const answerText = words.slice(0, shown).join(" ");

  return (
    <div id="demo" ref={ref} className="relative mx-auto mt-[34px] max-w-[1536px] md:mt-[2.05vw] [container-type:inline-size]">
      <div className="relative hidden aspect-[1536/416] w-full md:block">
        {/* Window */}
        <div
          className="absolute top-0 left-[7.03%] h-[100%] w-[80.86%] rounded-[1.6cqw] bg-white shadow-[0_1px_2px_rgb(20_33_27/0.05),0_24px_60px_-28px_rgb(20_33_27/0.25)] ring-1 ring-line"
          role="group"
          aria-label="Ejemplo de respuesta de la IA a un cliente"
        >
          <div className="flex h-[3.9cqw] items-center justify-between px-[2.4cqw]">
            <p className="text-[1.05cqw] font-medium text-ink [word-spacing:0.14em]">
              {business ? (
                <>
                  Así le respondería la IA a tus clientes <span className="text-ink/45">·</span> Ejemplo para{" "}
                  <span className="font-semibold">{business}</span>
                </>
              ) : (
                <>
                  Así le responde la IA a tus clientes <span className="text-ink/45">·</span> Ejemplo
                </>
              )}
            </p>
            <span aria-hidden="true" className="flex gap-[0.55cqw]">
              <i className="block h-[0.85cqw] w-[0.85cqw] rounded-full bg-ink/15" />
              <i className="block h-[0.85cqw] w-[0.85cqw] rounded-full bg-ink/15" />
              <i className="block h-[0.85cqw] w-[0.85cqw] rounded-full bg-ink/15" />
            </span>
          </div>

          <div className="absolute inset-x-[0.9cqw] top-[3.85cqw] bottom-[0.9cqw] rounded-[1.05cqw] ring-1 ring-line">
            {/* Customer question */}
            <div className="absolute top-[2.25cqw] right-[2.35cqw] flex items-center gap-[0.6cqw]">
              <p className="rounded-[0.95cqw] bg-bubble px-[1.3cqw] py-[1cqw] text-[1.15cqw] leading-none text-ink">{question}</p>
              <span aria-hidden="true" className="grid h-[2.85cqw] w-[2.85cqw] place-items-center rounded-full bg-[#e7e8ea] text-[#5f666d]">
                <svg viewBox="0 0 24 24" className="h-[1.4cqw] w-[1.4cqw]" fill="currentColor">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7z" />
                </svg>
              </span>
            </div>

            {/* AI answer */}
            <div className="absolute top-[7.85cqw] left-[2.75cqw] flex items-start gap-[0.85cqw]">
              <span aria-hidden="true" className="grid h-[4.05cqw] w-[4.05cqw] shrink-0 place-items-center rounded-full bg-bubble">
                <Image src="/engines/openai.svg" alt="" width={40} height={40} className="h-[2.4cqw] w-[2.4cqw]" />
              </span>
              <div>
                <p className="min-h-[4.2cqw] max-w-[44cqw] rounded-[0.95cqw] bg-white px-[1.4cqw] py-[1.35cqw] text-[1.15cqw] leading-[1.45] text-ink ring-1 ring-line">
                  <span className="sr-only">ChatGPT responde: {ANSWER}</span>
                  <span aria-hidden="true">
                    {answerText}
                    {!done && <span className="caret" />}
                  </span>
                </p>
                <span aria-hidden="true" className={`mt-[1.2cqw] ml-[0.95cqw] flex gap-[0.35cqw] transition-opacity duration-200 ${done ? "opacity-0" : "opacity-100"}`}>
                  {[0, 1, 2].map((d) => (
                    <i key={d} className="block h-[0.42cqw] w-[0.42cqw] rounded-full bg-ink/30" style={{ animation: `dot 1.2s ${d * 0.15}s infinite` }} />
                  ))}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Handwritten annotations */}
        <div aria-hidden="true" className={`transition-opacity duration-[250ms] ${phase === "idle" ? "opacity-0" : "opacity-100"}`}>
          <Image src="/plates/arrow-buscan-v2.png" alt="" width={491} height={163} className="absolute top-[19.5%] left-[85.7%] w-[7.4%] -scale-y-100" />
          <p className="absolute top-[13%] left-[89.2%] -rotate-[6deg] font-hand text-[1.6cqw] leading-none font-medium whitespace-nowrap text-ink">
            Así te buscan
          </p>
        </div>
        <div aria-hidden="true" className={`transition-opacity duration-[250ms] delay-150 ${done ? "opacity-100" : "opacity-0"}`}>
          <Image src="/plates/arrow-apareces-v2.png" alt="" width={1415} height={69} className="absolute top-[52.5%] left-[60.9%] w-[27.3%]" />
          <p className="absolute top-[44%] left-[87.7%] -rotate-[11deg] font-hand text-[1.75cqw] leading-none font-medium whitespace-nowrap text-ink">
            Aquí no apareces
          </p>
        </div>

        {/* Reranker suggestion */}
        <div
          className={`absolute top-[61.5%] left-[59.9%] w-[35.95%] rounded-[1.2cqw] bg-white p-[1.45cqw] shadow-[0_2px_4px_rgb(20_33_27/0.06),0_24px_48px_-16px_rgb(20_33_27/0.24)] ring-1 ring-line ${done ? "step-up" : "opacity-0"}`}
        >
          <div className="flex items-start gap-[1.3cqw]">
            <span aria-hidden="true" className="grid h-[4.15cqw] w-[4.15cqw] shrink-0 place-items-center rounded-full bg-bubble">
              <Image src="/brand/reranker-symbol.svg" alt="" width={40} height={40} className="h-[2.5cqw] w-[2.5cqw]" />
            </span>
            <p className="max-w-[22cqw] flex-1 pt-[0.35cqw] text-[1.1cqw] leading-[1.45] tracking-[-0.005em] text-ink">
              <strong className="font-semibold">Propuesta:</strong> agrega &lsquo;ropa de lino&rsquo; y tus envíos nacionales a tu perfil de Google
            </p>
            <span aria-hidden="true" className="grid h-[1.95cqw] w-[1.95cqw] shrink-0 ml-auto -mt-[0.1cqw] place-items-center rounded-full bg-amber font-display text-[1.2cqw] font-black text-ink">
              !
            </span>
          </div>
          <div className="mt-[1.3cqw] flex gap-[1.15cqw]">
            <button type="button" className="h-[3.25cqw] flex-[1.1] rounded-[0.75cqw] bg-green text-[1.1cqw] font-semibold text-white transition-colors hover:bg-green-deep">
              Aprobar
            </button>
            <button type="button" className="h-[3.25cqw] flex-1 rounded-[0.75cqw] bg-[#f4f4f3] text-[1.1cqw] text-ink ring-1 ring-ink/15 transition-colors hover:bg-bubble">
              Ahora no
            </button>
          </div>
        </div>
      </div>
      {/* Mobile: the same conversation, stacked and legible */}
      <div className="px-4 md:hidden">
        <div className="rounded-[22px] bg-white p-3 shadow-[0_1px_2px_rgb(20_33_27/0.05),0_20px_44px_-24px_rgb(20_33_27/0.28)] ring-1 ring-line">
          <p className="px-2 pt-1 pb-3 text-[13px] font-medium text-ink [word-spacing:0.12em]">
            Así le responde la IA a tus clientes <span className="text-ink/45">·</span> Ejemplo
          </p>
          <div className="rounded-2xl p-3 ring-1 ring-line">
            <p aria-hidden="true" className="text-right font-hand text-[20px] leading-none text-ink">Así te buscan</p>
            <p className="mt-2 ml-auto w-fit max-w-[88%] rounded-2xl rounded-tr-md bg-bubble px-3.5 py-2.5 text-[15px] leading-snug text-ink">{question}</p>
            <div className="mt-4 flex items-start gap-2.5">
              <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-bubble">
                <Image src="/engines/openai.svg" alt="" width={20} height={20} className="h-5 w-5" />
              </span>
              <p className="min-h-[4.5rem] flex-1 rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-[15px] leading-snug text-ink ring-1 ring-line">
                <span className="sr-only">ChatGPT responde: {ANSWER}</span>
                <span aria-hidden="true">
                  {answerText}
                  {!done && <span className="caret" />}
                </span>
              </p>
            </div>
            <p aria-hidden="true" className={`mt-2 pl-12 font-hand text-[20px] leading-none text-ink transition-opacity duration-[250ms] ${done ? "opacity-100" : "opacity-0"}`}>
              Aquí no apareces
            </p>
          </div>
        </div>
        <div className={`relative z-10 mx-3 -mt-5 rounded-2xl bg-white p-4 shadow-[0_2px_4px_rgb(20_33_27/0.06),0_20px_40px_-16px_rgb(20_33_27/0.26)] ring-1 ring-line ${done ? "step-up" : "opacity-0"}`}>
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-bubble">
              <Image src="/brand/reranker-symbol.svg" alt="" width={24} height={24} className="h-6 w-6" />
            </span>
            <p className="flex-1 text-[14.5px] leading-snug text-ink">
              <strong className="font-semibold">Propuesta:</strong> agrega &lsquo;ropa de lino&rsquo; y tus envíos nacionales a tu perfil de Google
            </p>
          </div>
          <div className="mt-3.5 flex gap-2.5">
            <button type="button" className="h-11 flex-[1.1] rounded-xl bg-green text-[15px] font-semibold text-white">Aprobar</button>
            <button type="button" className="h-11 flex-1 rounded-xl bg-[#f4f4f3] text-[15px] text-ink ring-1 ring-ink/15">Ahora no</button>
          </div>
        </div>
      </div>
    </div>
  );
}
