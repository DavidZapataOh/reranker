import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { EvidenceSeal } from "./EvidenceSeal.tsx";

test("the stamp says the answer was kept unedited, positioned by the caller", () => {
  expect(html(<EvidenceSeal variant="stamp" className="absolute -top-4" />)).toBe(
    '<span class="grid h-[74px] w-[74px] rotate-[-12deg] place-items-center rounded-full bg-amber text-center font-display text-[11px] leading-tight font-black text-ink shadow-soft absolute -top-4">Guardada<br/>sin editar</span>',
  );
});
