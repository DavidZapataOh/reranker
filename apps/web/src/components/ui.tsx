import type { ReactNode } from "react";

export function Section({
  id,
  children,
  className = "",
  labelledBy,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={`scroll-mt-20 ${className}`}>
      <div className="mx-auto max-w-[1280px] px-5 md:px-10">{children}</div>
    </section>
  );
}

export function H2({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <h2
      id={id}
      className={`font-display text-[clamp(2rem,3.4vw,3.05rem)] leading-[1.08] font-black tracking-[-0.02em] text-balance text-ink ${className}`}
    >
      {children}
    </h2>
  );
}

export function Lede({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mt-4 max-w-[56ch] text-[clamp(1.05rem,1.2vw,1.15rem)] leading-relaxed text-ink/75 ${className}`}>{children}</p>;
}

export function Example({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex h-6 items-center rounded-full bg-green-light px-2.5 text-[12px] font-semibold text-green ${className}`}>
      Ejemplo
    </span>
  );
}

/** Uniform-stroke icon (2px / 24px), rounded corners. */
export function Icon({ d, className = "h-6 w-6" }: { d: string; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export const icons = {
  gift: "M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 1 1 8 0v4",
  scale: "M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8",
  check: "M5 12.5l4.5 4.5L19 7.5",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  pin: "M12 21s7-6.4 7-12a7 7 0 1 0-14 0c0 5.6 7 12 7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5",
  building: "M4 21V5l8-3 8 3v16M9 21v-5h6v5M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01",
  arrow: "M5 12h13M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
};

/** Public contact. The founder sets up the email address on the domain. */
export const contact = {
  whatsapp: "573334017889",
  whatsappLabel: "+57 333 401 7889",
  email: "hola@reranker.co",
};

export const wa = (text: string) => `https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(text)}`;
