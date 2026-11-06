import type { ReactNode } from "react";
import { Nav } from "./Nav";
import { Footer } from "./Sections";

export type LegalSection = { id: string; title: string; body: ReactNode };

/** Reading layout for legal documents: sticky side index and 68ch text. */
export function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <>
      <Nav />
      <main className="bg-paper">
        <div className="mx-auto max-w-[1180px] px-5 pt-14 pb-24 md:px-10 md:pt-20 md:pb-32">
          <header className="max-w-[68ch]">
            <h1 className="font-display text-[clamp(2.2rem,4vw,3.4rem)] leading-[1.05] font-black tracking-[-0.02em] text-ink">
              {title}
            </h1>
            <p className="mt-4 font-mono text-[13px] text-ink/55">
              Última actualización: {updated}
            </p>
            <div className="mt-6 text-[17px] leading-relaxed text-ink/80 [&_a]:text-green [&_a]:underline [&_a]:underline-offset-[3px]">
              {intro}
            </div>
          </header>

          <div className="mt-14 grid gap-12 lg:grid-cols-[240px_1fr] lg:gap-16">
            <nav
              aria-label="Contenido"
              className="hidden lg:sticky lg:top-24 lg:block lg:self-start"
            >
              <p className="text-[13px] font-semibold text-ink/50">Contenido</p>
              <ol className="mt-3 space-y-2 border-l border-line pl-4 text-[14.5px]">
                {sections.map((s, i) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} className="text-ink/70 transition-colors hover:text-green">
                      {i + 1}. {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            <article className="legal max-w-[68ch]">
              {sections.map((s, i) => (
                <section
                  key={s.id}
                  id={s.id}
                  className="scroll-mt-24 border-t border-line pt-8 pb-4 first:border-t-0 first:pt-0"
                >
                  <h2 className="text-[22px] leading-snug font-bold text-ink">
                    {i + 1}. {s.title}
                  </h2>
                  <div className="mt-4">{s.body}</div>
                </section>
              ))}
            </article>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
