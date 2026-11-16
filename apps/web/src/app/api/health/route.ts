import { appEnv } from "@reranker/env";
import { connection } from "next/server";

const headers = { "Cache-Control": "no-store" };

// Liveness only: no database, flags or provider call, so uptime checks never wake Neon or spend
// quota. `connection()` opts the handler out of build-time prerendering.
export async function GET() {
  await connection();
  try {
    if (globalThis.__envError) throw globalThis.__envError;
    const env = appEnv();
    return Response.json(
      { status: "ok", version: process.env.VERCEL_GIT_COMMIT_SHA || "dev", env },
      { headers },
    );
  } catch {
    // The reason stays in the logs; the public body must not name variables.
    return Response.json({ status: "env_invalid" }, { status: 503, headers });
  }
}
