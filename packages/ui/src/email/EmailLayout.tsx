import { DEFAULT_LOCALE } from "@reranker/i18n";
import type { ReactNode } from "react";
import { Body, Container, Font, Head, Html, Preview, Tailwind } from "react-email";
import { tokens } from "../tokens.ts";
import { emailTailwindConfig } from "./tailwind.config.ts";

// Each Font emits a universal font-family rule and the last one wins, so the body face goes last.
const fonts = "https://fonts.gstatic.com/s";

export function EmailLayout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang={DEFAULT_LOCALE}>
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
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
      </Head>
      <Preview>{preview}</Preview>
      <Tailwind config={emailTailwindConfig}>
        <Body className="m-0 bg-paper py-8 font-sans" style={{ fontFamily: tokens.fontStack.text }}>
          <Container className="max-w-[560px] rounded-card bg-surface px-8 py-8">
            {children}
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
