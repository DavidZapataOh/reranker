import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { ExampleChip } from "../feedback/ExampleChip.tsx";
import { Headline } from "./Headline.tsx";
import { Lede } from "./Lede.tsx";
import { Section } from "./Section.tsx";

test("Section wraps its content in the page container", () => {
  expect(html(<Section>c</Section>)).toBe(
    '<section class="scroll-mt-20"><div class="mx-auto max-w-[1280px] px-5 md:px-10">c</div></section>',
  );
  expect(
    html(
      <Section id="x" labelledBy="h" className="py-24">
        c
      </Section>,
    ),
  ).toBe(
    '<section id="x" aria-labelledby="h" class="scroll-mt-20 py-24"><div class="mx-auto max-w-[1280px] px-5 md:px-10">c</div></section>',
  );
});

test("Headline is the section h2 with the display scale", () => {
  expect(
    html(
      <Headline id="t" className="mx-auto">
        t
      </Headline>,
    ),
  ).toBe(
    '<h2 id="t" class="font-display text-[clamp(2rem,3.4vw,3.05rem)] leading-[1.08] font-black tracking-[-0.02em] text-balance text-ink mx-auto">t</h2>',
  );
});

test("Lede is the paragraph under a headline", () => {
  expect(html(<Lede>l</Lede>)).toBe(
    '<p class="mt-4 max-w-[56ch] text-[clamp(1.05rem,1.2vw,1.15rem)] leading-relaxed text-ink/75">l</p>',
  );
});

test("ExampleChip marks sample data", () => {
  expect(html(<ExampleChip />)).toBe(
    '<span class="inline-flex min-h-6 items-center rounded-full bg-green-light px-2.5 text-[12px] font-semibold text-green">Ejemplo</span>',
  );
  expect(html(<ExampleChip className="ml-2" />)).toContain('text-green ml-2">Ejemplo<');
});
