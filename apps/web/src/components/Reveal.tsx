"use client";

import { useEffect } from "react";

/** Scroll-in entrances: only for content below the fold, and only without reduced motion. */
export function Reveal() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal")).filter(
      (el) => el.getBoundingClientRect().top > window.innerHeight * 0.92,
    );
    els.forEach((el) => {
      el.classList.add("pending");
    });
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const el = e.target as HTMLElement;
          el.classList.add("shown");
          el.classList.remove("pending");
          io.unobserve(el);
        }),
      { rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => {
      io.observe(el);
    });
    return () => io.disconnect();
  }, []);
  return null;
}
