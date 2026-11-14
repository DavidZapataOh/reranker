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
}
