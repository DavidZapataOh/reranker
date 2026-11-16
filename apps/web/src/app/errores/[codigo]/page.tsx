import {
  ERROR_CODES,
  ERRORS,
  type ErrorCode,
  isErrorCode,
  retryAfterParams,
} from "@reranker/schema";
import { Headline, Lede, LinkButton, Section } from "@reranker/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Sections";

// The whole page must come from the build; an unlisted code then waits for its render instead
// of streaming a shell, so notFound() still answers 404.
export const ensureStatic = "navigation";

// Every problem's `type` URL lands here, so each code is a static page that says what to do.
export function generateStaticParams() {
  return ERROR_CODES.map((codigo) => ({ codigo }));
}

async function copyFor(code: ErrorCode) {
  const t = await getTranslations("errors");
  const definition = ERRORS[code];
  // A static page cannot know a response's own Retry-After, so it states the catalog's default.
  const params = definition.retryable ? retryAfterParams(definition.retryAfterSeconds) : {};
  return {
    title: t(`${code}.title`),
    detail: t(`${code}.detail`, params),
    action: t(`${code}.action`),
  };
}

export async function generateMetadata({
  params,
}: PageProps<"/errores/[codigo]">): Promise<Metadata> {
  const { codigo } = await params;
  if (!isErrorCode(codigo)) notFound();
  const { title, detail } = await copyFor(codigo);
  return { title: `${title} · Reranker`, description: detail };
}

export default async function ErrorPage({ params }: PageProps<"/errores/[codigo]">) {
  const { codigo } = await params;
  if (!isErrorCode(codigo)) notFound();
  const [{ title, detail, action }, t] = await Promise.all([
    copyFor(codigo),
    getTranslations("common.actions"),
  ]);
  const goHome = t("goHome");

  return (
    <>
      <Nav />
      <main id="contenido" tabIndex={-1} className="bg-paper focus:outline-none">
        <Section className="pt-14 pb-24 md:pt-20 md:pb-32">
          <div className="max-w-[60ch]">
            <Headline as="h1">{title}</Headline>
            <Lede>{detail}</Lede>
            {/* When the action is going home, the button already says it. */}
            {action !== goHome && (
              <p className="mt-6 text-[17px] leading-snug font-bold text-ink">{action}</p>
            )}
            <LinkButton href="/" className="mt-10">
              {goHome}
            </LinkButton>
          </div>
        </Section>
      </main>
      <Footer />
    </>
  );
}
