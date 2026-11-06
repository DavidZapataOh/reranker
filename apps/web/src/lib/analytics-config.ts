/** Public analytics IDs, readable from both server and client components. */
export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
export const POSTHOG_REGION = process.env.NEXT_PUBLIC_POSTHOG_REGION === "eu" ? "eu" : "us";
export const GA_ID = process.env.NEXT_PUBLIC_GA_ID;
export const CLARITY_ID = process.env.NEXT_PUBLIC_CLARITY_ID;

export const probeOne = 1;
