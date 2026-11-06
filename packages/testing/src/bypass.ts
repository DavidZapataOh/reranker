import { requireEnv } from "./env.ts";

export function bypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret && !process.env.CI) return {};
  return {
    "x-vercel-protection-bypass": requireEnv("VERCEL_AUTOMATION_BYPASS_SECRET"),
    "x-vercel-set-bypass-cookie": "true",
  };
}
