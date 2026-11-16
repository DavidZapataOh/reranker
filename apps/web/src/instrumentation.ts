import { createOnRequestError } from "@posthog/next";
import { requestErrorOptions } from "./lib/request-errors";

declare global {
  // Read by the health endpoint to report a deployment that started with a bad environment.
  var __envError: Error | undefined;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("./env");
  try {
    getEnv();
  } catch (error) {
    globalThis.__envError = error instanceof Error ? error : new Error(String(error));
    throw error;
  }
  const { getPostHogServer, registerLogger } = await import("@reranker/telemetry");
  registerLogger();
  // Started with the server so uncaught exceptions and unhandled rejections are captured from the first request.
  getPostHogServer();
}

export const onRequestError = createOnRequestError(requestErrorOptions());
