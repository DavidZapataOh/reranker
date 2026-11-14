import type { EngineStatus } from "@reranker/schema/measurement";
import type { ReactNode } from "react";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { Button } from "../src/actions/Button.tsx";
import { Bubble } from "../src/conversation/Bubble.tsx";
import { StatusBadge } from "../src/data/StatusBadge.tsx";
import { ExampleChip } from "../src/feedback/ExampleChip.tsx";
import { Checkbox } from "../src/forms/Checkbox.tsx";

afterEach(cleanup);

const words: Record<EngineStatus, string> = {
  regular: "Aparece entre los fijos de las respuestas",
  on_the_list: "Aparece en la lista de recomendados",
  sometimes: "A veces aparece entre las respuestas",
  invisible: "No aparece en ninguna respuesta",
  few_data: "Aún hay pocos datos para decirlo",
};

// A 320 px screen at 200% zoom lays the page out in 160 CSS px, rendered at twice the size.
function Zoomed({ children }: { children: ReactNode }) {
  return (
    <div data-testid="zoomed" style={{ zoom: 2, width: 160 }} className="bg-paper text-ink">
      {children}
    </div>
  );
}

function clipped(root: Element): string[] {
  const found: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) {
      // Inline boxes report zero client size, so only block-level boxes can be judged this way.
      if (el.clientWidth === 0) continue;
      found.push(`${el.tagName.toLowerCase()}.${el.className}`);
    }
  }
  return found;
}

async function expectContained(ui: ReactNode) {
  await page.viewport(320, 568);
  await render(<Zoomed>{ui}</Zoomed>);
  const zoomed = document.querySelector<HTMLElement>('[data-testid="zoomed"]');
  if (!zoomed) throw new Error("missing container");
  expect(zoomed.getBoundingClientRect().width).toBeLessThanOrEqual(320);
  expect(clipped(zoomed)).toEqual([]);
  for (const el of zoomed.querySelectorAll("*")) {
    const box = el.getBoundingClientRect();
    expect(box.right, `${el.tagName} overflows the 320 px screen`).toBeLessThanOrEqual(320.5);
  }
}

test("buttons in every size keep their label inside at 320 px and 200% zoom", async () => {
  await expectContained(
    <div className="flex flex-col gap-2">
      <Button size="md">Pedir mi medición</Button>
      <Button size="lg">Pedir mi medición gratis ahora</Button>
      <Button size="xl">Pedir mi medición completa</Button>
    </div>,
  );
});

test("example chip, status badges and checkbox stay inside at 320 px and 200% zoom", async () => {
  await expectContained(
    <div className="flex flex-col gap-3">
      <ExampleChip />
      {(Object.keys(words) as EngineStatus[]).map((status) => (
        <StatusBadge key={status} status={status} words={words} />
      ))}
      <Checkbox name="terms">Acepto los términos y la política de privacidad de Reranker</Checkbox>
    </div>,
  );
});

test("a bubble with an 80-character name does not overflow 320 px at 200% zoom", async () => {
  const name = "TallerDeMotosYRepuestosOriginalesHermanosRestrepoDelValleDeAburraSedeCentro20266";
  expect(name).toHaveLength(80);
  const lead = "Te recomiendo ";
  await expectContained(
    <Bubble
      role="answer"
      engine="chatgpt"
      text={`${lead}${name} para tu moto.`}
      highlights={[{ start: lead.length, end: lead.length + name.length, kind: "self" }]}
    />,
  );
});
