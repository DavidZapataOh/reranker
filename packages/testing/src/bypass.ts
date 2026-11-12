import { requireEnv } from "./env.ts";

/**
 * Headers for requests to the deployment under test. Send them only to its origin:
 * the browser would otherwise forward the secret to every third party the page loads.
 * No x-vercel-set-bypass-cookie: Vercel answers it with a redirect, which hides the
 * deployment's own status codes, and every request carries the header anyway.
 */
export function bypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret && !process.env.CI) return {};
  return {
    "x-vercel-protection-bypass": requireEnv("VERCEL_AUTOMATION_BYPASS_SECRET"),
    // The preview toolbar adds focusable elements and contrast issues that are not ours.
    "x-vercel-skip-toolbar": "1",
  };
}
