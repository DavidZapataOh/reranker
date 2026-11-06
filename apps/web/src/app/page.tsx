import { ClosingCta } from "@/components/ClosingCta";
import { ForWho } from "@/components/ForWho";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { Nav } from "@/components/Nav";
import { Reveal } from "@/components/Reveal";
import {
  Agencies,
  Bento,
  Connect,
  Faq,
  Footer,
  Pricing,
  Promises,
  Shift,
} from "@/components/Sections";
import { StructuredData } from "@/components/StructuredData";

export default function Home() {
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
        <Pricing />
        <Agencies />
        <Faq />
        <ClosingCta />
      </main>
      <Footer />
      <Reveal />
      <StructuredData />
    </>
  );
}
