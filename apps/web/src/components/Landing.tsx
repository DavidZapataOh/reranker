import type { Metadata } from "next";
import type { Currency } from "@/lib/pricing";
import { ClosingCta } from "./ClosingCta";
import { ForWho } from "./ForWho";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { Nav } from "./Nav";
import { Reveal } from "./Reveal";
import { Agencies, Bento, Connect, Faq, Footer, Pricing, Promises, Shift } from "./Sections";
import { StructuredData } from "./StructuredData";

// Each currency variant is served at "/", so search engines should index only that URL.
export const landingMetadata: Metadata = { alternates: { canonical: "/" } };

/** The home page, prerendered once per currency; the proxy picks one by visitor country. */
export function Landing({ currency }: { currency: Currency }) {
  return (
    <>
      <Nav />
      <main id="contenido" tabIndex={-1} className="focus:outline-none">
        <Hero />
        <Promises />
        <Shift />
        <HowItWorks />
        <Bento />
        <ForWho />
        <Connect />
        <Pricing currency={currency} />
        <Agencies currency={currency} />
        <Faq currency={currency} />
        <ClosingCta />
      </main>
      <Footer />
      <Reveal />
      <StructuredData currency={currency} />
    </>
  );
}
