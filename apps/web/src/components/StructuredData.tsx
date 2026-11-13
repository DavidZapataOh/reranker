import { DEFAULT_LOCALE } from "@reranker/i18n";
import { DEFAULT_COUNTRY_CODE, getCountry } from "@reranker/i18n/countries";
import { contact } from "@/lib/contact";
import { CURRENCIES, type Currency, DEFAULT_CURRENCY, isoCode, PRICES } from "@/lib/pricing";
import { faqItems } from "./Sections";

const BASE = "https://reranker.co";
const LANGUAGE = new Intl.Locale(DEFAULT_LOCALE).language;

/**
 * schema.org JSON-LD for the home page: who operates Reranker, what it is,
 * its public prices and the FAQ. Search engines and AI assistants read this
 * to describe and cite the product accurately. Offers list every currency we sell in.
 */
export function StructuredData({ currency }: { currency: Currency }) {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${BASE}/#organization`,
        name: "Reranker",
        legalName: "GLEMO S.A.S.",
        taxID: "902.091.972-5",
        url: BASE,
        logo: `${BASE}/brand/icon-512.png`,
        email: contact.email,
        telephone: `+${contact.whatsapp}`,
        address: {
          "@type": "PostalAddress",
          addressLocality: "Medellín",
          addressRegion: "Antioquia",
          addressCountry: getCountry(DEFAULT_COUNTRY_CODE).code,
        },
      },
      {
        "@type": "WebSite",
        "@id": `${BASE}/#website`,
        url: BASE,
        name: "Reranker",
        inLanguage: LANGUAGE,
        publisher: { "@id": `${BASE}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${BASE}/#app`,
        name: "Reranker",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: BASE,
        inLanguage: LANGUAGE,
        description:
          "Reranker muestra qué recomiendan ChatGPT, Gemini, Google y Perplexity cuando alguien busca lo que vende un negocio en su ciudad, y qué cambiar en su perfil de Google o su sitio web para que lo recomienden.",
        publisher: { "@id": `${BASE}/#organization` },
        offers: [
          {
            "@type": "Offer",
            name: "Reporte gratis",
            price: "0",
            priceCurrency: isoCode(DEFAULT_CURRENCY),
          },
          ...CURRENCIES.flatMap((c) => [
            {
              "@type": "Offer",
              name: "Esencial",
              price: String(PRICES[c].essential),
              priceCurrency: isoCode(c),
              description: "Mensual. Un negocio en una ciudad.",
            },
            {
              "@type": "Offer",
              name: "Pro",
              price: String(PRICES[c].pro),
              priceCurrency: isoCode(c),
              description: "Mensual. Varias sedes o ciudades.",
            },
          ]),
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${BASE}/#faq`,
        mainEntity: faqItems(currency).map(([q, a]) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own serialized JSON-LD, the form Next documents; "<" is escaped to keep "</script>" out of the payload
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph).replace(/</g, "\\u003c") }}
    />
  );
}
