"use client";

import { Button, ErrorState } from "@reranker/ui";
import { useEffect } from "react";
import { Analytics } from "@/components/Analytics";
import { captureException } from "@/lib/analytics";
import { fontVariables } from "./fonts";
import "./globals.css";

// Replaces the root layout, so it brings its own document, styles and measurement. Analytics
// starts PostHog under the visitor's consent; an error caught before it loaded waits in the queue.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    captureException(error);
  }, [error]);

  return (
    <html lang="es" className={fontVariables}>
      <body>
        <title>Algo salió mal · Reranker</title>
        <main className="mx-auto flex min-h-dvh w-full max-w-[560px] items-center px-5 py-10">
          <ErrorState
            title="Algo salió mal"
            body="Recarga la página para seguir."
            action={<Button onClick={() => retry()}>Recargar</Button>}
          />
        </main>
        <Analytics />
      </body>
    </html>
  );
}
