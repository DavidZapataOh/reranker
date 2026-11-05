"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const engines = [
  { id: "chatgpt", name: "ChatGPT", icon: "/engines/openai.svg", scale: 1.3 },
  { id: "gemini", name: "Gemini", icon: "/engines/gemini.svg", scale: 0.94 },
  { id: "google", name: "Google", icon: "/engines/google.svg", scale: 0.86 },
  { id: "perplexity", name: "Perplexity", icon: "/engines/perplexity.svg", scale: 1.02 },
] as const;

const N = engines.length;
// The list repeats the first item at the end so the slot rolls over without a jump.
const loop = [...engines, engines[0]];
const HOLD = 2200;
const ROLL = 520;
const EASE = "cubic-bezier(0.65, 0, 0.2, 1)";

/**
 * AI engine slot: the logo and name roll up together, endlessly.
 * Pauses on hover, via `paused` (the parent's button) and when off-screen.
 * With reduced motion it stays on ChatGPT. Decorative: the headline has its own accessible name.
 */
export function EngineRotator({ paused = false }: { paused?: boolean }) {
  const [pos, setPos] = useState(0); // 0..N (N = copy of the first)
  const [animate, setAnimate] = useState(true);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reduce, setReduce] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const names = useRef<(HTMLSpanElement | null)[]>([]);
  const [w, setW] = useState<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduce(mq.matches);
    const t = window.setTimeout(set, 0);
    mq.addEventListener("change", set);
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    if (wrap.current) io.observe(wrap.current);
    return () => {
      window.clearTimeout(t);
      mq.removeEventListener("change", set);
      io.disconnect();
    };
  }, []);

  const running = !reduce && !paused && !hover && visible;

  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => {
      setAnimate(true);
      setPos((p) => p + 1);
    }, HOLD);
    return () => window.clearTimeout(t);
  }, [running, pos]);

  // On reaching the copy of the first, jump back to the start without animation.
  useEffect(() => {
    if (pos !== N) return;
    const t = window.setTimeout(() => {
      setAnimate(false);
      setPos(0);
    }, ROLL + 30);
    return () => window.clearTimeout(t);
  }, [pos]);

  const current = pos % N;

  useLayoutEffect(() => {
    const measure = () => setW(names.current[current]?.offsetWidth ?? null);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [current]);

  const dur = animate ? ROLL : 0;

  return (
    <span
      ref={wrap}
      aria-hidden="true"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="mx-[0.1em] inline-flex h-[1.3em] translate-y-[-0.04em] items-center gap-[0.2em] rounded-full bg-white pr-[0.36em] pl-[0.24em] align-middle shadow-[0_1px_1px_rgb(20_33_27/0.04),0_8px_24px_-12px_rgb(20_33_27/0.22)] ring-1 ring-line"
    >
      {/* Logo: all in the same 1em box, optically adjusted */}
      <span className="relative block h-[1em] w-[1em] overflow-hidden">
        <span className="absolute inset-x-0 top-0 block" style={{ transform: `translateY(${-pos}em)`, transition: `transform ${dur}ms ${EASE}` }}>
          {loop.map((e, k) => (
            <span key={k} className="grid h-[1em] w-[1em] place-items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={e.icon} alt="" width={64} height={64} className="block" style={{ width: `${e.scale * 0.86}em`, height: `${e.scale * 0.86}em` }} />
            </span>
          ))}
        </span>
      </span>
      {/* Name: the same slot; width adapts to the visible engine */}
      <span
        className="relative block h-[1.2em] overflow-hidden"
        style={{ width: w ? `${w}px` : undefined, transition: `width ${dur}ms ${EASE}` }}
      >
        <span className="absolute top-0 left-0 block" style={{ transform: `translateY(${-pos * 1.2}em)`, transition: `transform ${dur}ms ${EASE}` }}>
          {loop.map((e, k) => (
            <span
              key={k}
              ref={(el) => {
                if (k < N) names.current[k] = el;
              }}
              className="block h-[1.2em] w-max leading-[1.2em] whitespace-nowrap"
            >
              {e.name}.
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
