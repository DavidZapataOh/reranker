import { ClosingCta } from "@/components/ClosingCta";
import { ForWho } from "@/components/ForWho";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { Nav } from "@/components/Nav";
import { Reveal } from "@/components/Reveal";
import { Agencies, Bento, Faq, Footer, Pricing, Promises, Shift, Connect } from "@/components/Sections";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
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
    </>
  );
}
