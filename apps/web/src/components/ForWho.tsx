"use client";

import {
  ArrowUp,
  BedDouble,
  Dumbbell,
  GraduationCap,
  House,
  PawPrint,
  Scale,
  ShoppingBag,
  Stethoscope,
  UtensilsCrossed,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { H2, Section } from "./ui";

const kinds = [
  { k: "Restaurantes", Icon: UtensilsCrossed, q: "¿Dónde almuerzo rico en Ciudad de México?" },
  { k: "Clínicas", Icon: Stethoscope, q: "¿Qué clínica dental me recomiendas en Medellín?" },
  { k: "Talleres", Icon: Wrench, q: "Un taller de confianza para mi auto en Santiago" },
  { k: "Tiendas", Icon: ShoppingBag, q: "¿Dónde compro ropa de lino hecha en Colombia?" },
  { k: "Hoteles", Icon: BedDouble, q: "Un hotel boutique tranquilo en Cartagena" },
  { k: "Gimnasios", Icon: Dumbbell, q: "¿Qué gimnasio tiene yoga en Madrid?" },
  { k: "Colegios", Icon: GraduationCap, q: "Un colegio bilingüe en Lima" },
  { k: "Abogados", Icon: Scale, q: "Necesito un abogado laboral en Buenos Aires" },
  { k: "Veterinarias", Icon: PawPrint, q: "¿Qué veterinaria atiende urgencias en Bogotá?" },
  {
    k: "Inmobiliarias",
    Icon: House,
    q: "Una inmobiliaria confiable para rentar en Guadalajara",
  },
];

/** Every business gets asked: one business type at a time, its question typing out in a bar. */
export function ForWho() {
  const [i, setI] = useState(0);
  const [typed, setTyped] = useState(kinds[0]?.q.length ?? 0);
  const [auto, setAuto] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const row = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e?.isIntersecting ?? false), {
      threshold: 0.4,
    });
    if (box.current) io.observe(box.current);
    return () => io.disconnect();
  }, []);

  // Types the active business's question, letter by letter.
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const full = kinds[i]?.q.length ?? 0;
    if (reduce) {
      const t = window.setTimeout(() => setTyped(full), 0);
      return () => window.clearTimeout(t);
    }
    if (typed < full) {
      const t = window.setTimeout(() => setTyped((n) => n + 1), 28);
      return () => window.clearTimeout(t);
    }
    if (!auto || !visible) return;
    const t = window.setTimeout(() => {
      setI((v) => (v + 1) % kinds.length);
      setTyped(0);
    }, 2200);
    return () => window.clearTimeout(t);
  }, [i, typed, auto, visible]);

  // On mobile the row slides to show the active business (without scrolling the page).
  useEffect(() => {
    const ul = row.current;
    const li = ul?.children[i] as HTMLElement | undefined;
    if (!ul || !li || ul.scrollWidth <= ul.clientWidth) return;
    ul.scrollTo({ left: li.offsetLeft - 20, behavior: "smooth" });
  }, [i]);

  const pick = (n: number) => {
    setAuto(false);
    setI(n);
    setTyped(0);
  };

  return (
    <Section id="para-quien" labelledBy="who-title" className="bg-white py-24 md:py-32">
      <div className="text-center">
        <H2 id="who-title" className="mx-auto max-w-[18ch]">
          A cualquier negocio le preguntan.
        </H2>
      </div>

      <div ref={box} className="mx-auto mt-12 max-w-[860px]">
        {/* The bar where the customer types */}
        <div className="flex items-center gap-3 rounded-[26px] bg-paper p-3 pl-6 shadow-[0_1px_2px_rgb(20_33_27/0.05),0_16px_40px_-20px_rgb(20_33_27/0.25)] ring-1 ring-line md:p-3.5 md:pl-7">
          <p
            className="min-h-[1.5em] flex-1 text-[clamp(1.1rem,2.1vw,1.6rem)] leading-snug text-ink"
            aria-live="polite"
          >
            <span className="sr-only">Pregunta de ejemplo: </span>
            {kinds[i]?.q.slice(0, typed)}
            <span aria-hidden="true" className="caret" />
          </p>
          <span
            aria-hidden="true"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink text-paper md:h-12 md:w-12"
          >
            <ArrowUp className="h-5 w-5" strokeWidth={2.2} />
          </span>
        </div>

        {/* Business types: icon + one word */}
        <ul
          ref={row}
          className="-mx-5 mt-7 flex snap-x scroll-px-5 gap-2.5 overflow-x-auto px-5 pb-2 [scrollbar-width:none] md:mx-0 md:mt-8 md:flex-wrap md:justify-center md:overflow-visible md:px-0"
        >
          {kinds.map(({ k, Icon }, n) => (
            <li key={k} className="shrink-0 snap-start">
              <button
                type="button"
                onClick={() => pick(n)}
                aria-pressed={i === n}
                className={`inline-flex h-11 items-center gap-2 rounded-full px-4 text-[15px] transition-colors duration-200 ${
                  i === n
                    ? "bg-green-light font-semibold text-ink ring-1 ring-green/40"
                    : "bg-paper text-ink ring-1 ring-line hover:bg-green-light/60"
                }`}
              >
                <Icon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={2} />
                {k}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
