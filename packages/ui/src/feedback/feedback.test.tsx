import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EmptyState } from "./EmptyState.tsx";
import { ErrorState } from "./ErrorState.tsx";
import { LoadingState } from "./LoadingState.tsx";
import { Notice } from "./Notice.tsx";
import { Skeleton } from "./Skeleton.tsx";

const sources = ["Skeleton", "LoadingState", "EmptyState", "ErrorState", "Notice"];

test("no state component is a client component", () => {
  for (const name of sources) {
    const source = readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");
    expect(source, name).not.toMatch(/["']use client["']/);
  }
});

test("Skeleton is hidden from assistive technology and pulses", () => {
  const html = renderToStaticMarkup(<Skeleton className="h-4 w-24" />);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("animate-pulse");
  expect(html).toContain("bg-bubble");
  expect(html).toContain("h-4 w-24");
});

test("LoadingState is a polite status region", () => {
  const html = renderToStaticMarkup(
    <LoadingState title="Cargando tu medición">
      <Skeleton />
    </LoadingState>,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Cargando tu medición");
});

test("EmptyState shows title, body and action", () => {
  const html = renderToStaticMarkup(
    <EmptyState
      title="Aún no hay mediciones"
      body="Pide la primera."
      action={<a href="/x">Medir</a>}
    />,
  );
  for (const text of ["Aún no hay mediciones", "Pide la primera.", "Medir"]) {
    expect(html).toContain(text);
  }
  expect(html).not.toContain('role="alert"');
});

test("ErrorState alerts only on title and body, never on the action", () => {
  const html = renderToStaticMarkup(
    <ErrorState
      title="No pudimos cargar"
      body="Intenta de nuevo."
      action={<button type="button">Reintentar</button>}
    />,
  );
  for (const text of ["No pudimos cargar", "Intenta de nuevo.", "Reintentar"]) {
    expect(html).toContain(text);
  }
  expect(html.match(/role="alert"/g)).toHaveLength(1);
  const alert = html.slice(html.indexOf('role="alert"'));
  expect(alert.slice(0, alert.indexOf("</div>"))).not.toContain("Reintentar");
});

test("Notice attention is marked by a ring and a dot, never amber text", () => {
  const attention = renderToStaticMarkup(<Notice tone="attention">Ojo</Notice>);
  expect(attention).toContain("ring-amber");
  expect(attention).toContain("bg-amber");
  expect(attention).not.toMatch(/\btext-[a]mber/);
  expect(attention).toContain("text-ink");
  const neutral = renderToStaticMarkup(<Notice tone="neutral">Nota</Notice>);
  expect(neutral).toContain("bg-bubble");
  expect(neutral).not.toContain("ring-amber");
});
