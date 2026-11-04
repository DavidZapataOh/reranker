"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

const links = [
  { href: "/#como-funciona", label: "Cómo funciona" },
  { href: "/#producto", label: "Lo que recibes" },
  { href: "/#precios", label: "Precios" },
  { href: "/#agencias", label: "Para agencias" },
];

/**
 * Barra fija. En el primer pliegue el botón verde es el del campo del hero (una sola acción verde);
 * el CTA de la barra aparece cuando el campo sale de la vista. En móvil, menú desplegable.
 */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [showCta, setShowCta] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    const t = window.setTimeout(onScroll, 0);
    window.addEventListener("scroll", onScroll, { passive: true });
    const form = document.querySelector("#reporte form");
    const io = new IntersectionObserver(([e]) => setShowCta(!e.isIntersecting && e.boundingClientRect.top < 0));
    if (form) io.observe(form);
    else window.setTimeout(() => setShowCta(true), 0); // fuera de la home: el CTA siempre visible
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("scroll", onScroll);
      io.disconnect();
    };
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-40 transition-[background-color,box-shadow] duration-200 ${
        scrolled || open ? "bg-paper shadow-[0_1px_0_rgb(20_33_27/0.08)]" : "bg-paper"
      }`}
    >
      <nav
        aria-label="Principal"
        className="mx-auto flex h-[60px] max-w-[1536px] items-center justify-between px-5 md:h-[clamp(60px,4.43vw,72px)] md:px-[4.2vw]"
      >
        <Link href="/" aria-label="Reranker, inicio" className="shrink-0 rounded-md" onClick={() => setOpen(false)}>
          <Image src="/brand/reranker-horizontal.svg" alt="reranker" width={154} height={47} priority className="h-[32px] w-auto md:h-[clamp(38px,3.06vw,49px)]" />
        </Link>

        <ul className="hidden items-center gap-[2.6vw] text-[clamp(15px,1.04vw,17px)] text-ink lg:flex">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="rounded-md py-2 transition-colors duration-150 hover:text-green">
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 md:gap-3">
          <Link href="/#ingresar" className="hidden h-10 items-center rounded-xl px-3.5 text-[15px] text-ink transition-colors hover:bg-ink/5 sm:inline-flex md:h-11">
            Ingresar
          </Link>
          <Link
            href="/#reporte"
            tabIndex={showCta ? 0 : -1}
            aria-hidden={!showCta}
            className={`hidden h-10 items-center rounded-xl bg-green px-4 text-[14px] font-semibold text-white shadow-soft transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:bg-green-deep sm:inline-flex md:h-11 md:px-5 md:text-[15px] ${
              showCta ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"
            }`}
          >
            Ver qué dice la IA
          </Link>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="menu-movil"
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            onClick={() => setOpen((o) => !o)}
            className="grid h-10 w-10 place-items-center rounded-xl text-ink ring-1 ring-line lg:hidden"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 8h16M4 16h16" />}
            </svg>
          </button>
        </div>
      </nav>

      {/* Menú móvil */}
      <div id="menu-movil" hidden={!open} className="fixed inset-x-0 top-[60px] bottom-0 overflow-y-auto bg-paper px-5 pt-4 pb-10 lg:hidden">
        <ul className="divide-y divide-line border-y border-line">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} onClick={() => setOpen(false)} className="flex items-center justify-between py-4 font-display text-[24px] font-black text-ink">
                {l.label}
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 text-ink/40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </a>
            </li>
          ))}
        </ul>
        <div className="mt-6 grid gap-3">
          <Link href="/#reporte" onClick={() => setOpen(false)} className="inline-flex h-12 items-center justify-center rounded-xl bg-green text-[16px] font-semibold text-white">
            Ver qué dice la IA
          </Link>
          <Link href="/#ingresar" onClick={() => setOpen(false)} className="inline-flex h-12 items-center justify-center rounded-xl text-[16px] text-ink ring-1 ring-ink/15">
            Ingresar
          </Link>
        </div>
      </div>
    </header>
  );
}
