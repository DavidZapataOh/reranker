import { DEFAULT_LOCALE, type Locale } from "@reranker/i18n";
import type { ReactNode } from "react";
import {
  Body,
  Column,
  Container,
  Font,
  Head,
  Html,
  Preview,
  Row,
  Section,
  Tailwind,
} from "react-email";
import { tokens } from "../tokens.ts";
import { emailStyles } from "./dark.ts";
import { emailTailwindConfig } from "./tailwind.config.ts";

// Each Font emits a universal font-family rule and the last one wins, so the body face goes last.
const fonts = "https://fonts.gstatic.com/s";

export function EmailLayout({
  preview,
  lang = DEFAULT_LOCALE,
  footer,
  children,
}: {
  preview: string;
  lang?: Locale;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Html lang={lang}>
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{emailStyles}</style>
        <Font
          fontFamily="Nunito"
          fallbackFontFamily="sans-serif"
          webFont={{
            url: `${fonts}/nunito/v32/XRXI3I6Li01BKofiOc5wtlZ2di8HDDsmdTQ3jw.woff2`,
            format: "woff2",
          }}
          fontWeight={800}
        />
        <Font
          fontFamily="Plus Jakarta Sans"
          fallbackFontFamily="sans-serif"
          webFont={{
            url: `${fonts}/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2`,
            format: "woff2",
          }}
          fontWeight={400}
        />
        <Font
          fontFamily="Plus Jakarta Sans"
          fallbackFontFamily="sans-serif"
          webFont={{
            url: `${fonts}/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2`,
            format: "woff2",
          }}
          fontWeight={600}
        />
        <Font
          fontFamily="Plus Jakarta Sans"
          fallbackFontFamily="sans-serif"
          webFont={{
            url: `${fonts}/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2`,
            format: "woff2",
          }}
          fontWeight={700}
        />
      </Head>
      <Preview>{preview}</Preview>
      <Tailwind config={emailTailwindConfig}>
        <Body
          lang={lang}
          className="rr-body m-0 bg-paper py-8 font-sans"
          style={{ fontFamily: tokens.fontStack.text }}
        >
          <Container className="rr-card max-w-[560px] rounded-card bg-surface">
            <Section>
              <Row>
                <Column className="rr-pad" style={{ padding: "40px 36px" }}>
                  {children}
                </Column>
              </Row>
            </Section>
          </Container>
          {footer ? <Container className="mt-6 max-w-[560px] px-6">{footer}</Container> : null}
        </Body>
      </Tailwind>
    </Html>
  );
}
