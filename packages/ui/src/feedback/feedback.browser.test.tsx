import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { expectNoAxeViolations } from "../../test/axe.ts";
import { EmptyState } from "./EmptyState.tsx";
import { ErrorState } from "./ErrorState.tsx";
import { LoadingState } from "./LoadingState.tsx";
import { Notice } from "./Notice.tsx";
import { Skeleton } from "./Skeleton.tsx";

afterEach(cleanup);

const action = (
  <button type="button" className="min-h-12 px-4">
    Reintentar
  </button>
);

const surfaces = ["bg-surface", "bg-paper"] as const;

for (const surface of surfaces) {
  test(`every state passes axe on ${surface}, with and without action`, async () => {
    await render(
      <div className={`${surface} flex flex-col gap-8 p-6 text-ink`}>
        <Skeleton className="h-4 w-24" />
        <LoadingState title="Cargando tu medición">
          <Skeleton className="h-4 w-full" />
        </LoadingState>
        <LoadingState title="Cargando" />
        <EmptyState title="Aún no hay mediciones" body="Pide la primera." />
        <EmptyState title="Aún no hay mediciones" body="Pide la primera." action={action} />
        <ErrorState title="No pudimos cargar" body="Intenta de nuevo en un momento." />
        <ErrorState
          title="No pudimos cargar"
          body="Intenta de nuevo en un momento."
          action={action}
        />
        <Notice tone="neutral">Tu medición sigue en curso.</Notice>
        <Notice tone="attention">Esta cifra es preliminar.</Notice>
      </div>,
    );
    await expectNoAxeViolations(document.body);
  });
}

test("the skeleton stops pulsing under prefers-reduced-motion", async () => {
  const { container } = await render(<Skeleton className="h-4 w-24" />);
  const skeleton = container.firstElementChild as HTMLElement;
  expect(parseFloat(getComputedStyle(skeleton).animationDuration)).toBeGreaterThan(0.5);
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    expect(parseFloat(getComputedStyle(skeleton).animationDuration)).toBeLessThanOrEqual(0.00001);
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});
