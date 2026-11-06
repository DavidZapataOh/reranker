import { faqItems } from "./Sections";
import { contact } from "./ui";

const BASE = "https://reranker.co";

/**
 * schema.org JSON-LD for the home page: who operates Reranker, what it is,
 * its public prices and the FAQ. Search engines and AI assistants read this
 * to describe and cite the product accurately. Keep prices in sync with Pricing().
 */
export function StructuredData() {
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
          addressCountry: "CO",
        },
        areaServed: { "@type": "Country", name: "Colombia" },
      },
      {
        "@type": "WebSite",
        "@id": `${BASE}/#website`,
        url: BASE,
        name: "Reranker",
        inLanguage: "es-CO",
        publisher: { "@id": `${BASE}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${BASE}/#app`,
        name: "Reranker",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: BASE,
        inLanguage: "es-CO",
        description:
          "Reranker muestra qué recomiendan ChatGPT, Gemini, Google y Perplexity cuando alguien busca lo que vende un negocio en Colombia, y qué cambiar en su perfil de Google o su sitio web para que lo recomienden.",
        publisher: { "@id": `${BASE}/#organization` },
        offers: [
          { "@type": "Offer", name: "Reporte gratis", price: "0", priceCurrency: "COP" },
          {
            "@type": "Offer",
            name: "Esencial",
            price: "149000",
            priceCurrency: "COP",
            description: "Mensual. Un negocio en una ciudad.",
          },
          {
            "@type": "Offer",
            name: "Pro",
            price: "299000",
            priceCurrency: "COP",
            description: "Mensual. Varias sedes o ciudades.",
          },
        ],
      },
      {
        "@type": "FAQPage",
        "@id": `${BASE}/#faq`,
        mainEntity: faqItems.map(([q, a]) => ({
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
