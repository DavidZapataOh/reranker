/** Public analytics IDs, readable from both server and client components. */
export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
export const POSTHOG_REGION = process.env.NEXT_PUBLIC_POSTHOG_REGION === "eu" ? "eu" : "us";

// Previews and local builds can carry the same keys as production; GA and Clarity
// must still only measure real visitors on the production deployment.
const PRODUCTION = process.env.NEXT_PUBLIC_VERCEL_ENV === "production";
export const GA_ID = PRODUCTION ? process.env.NEXT_PUBLIC_GA_ID : undefined;
export const CLARITY_ID = PRODUCTION ? process.env.NEXT_PUBLIC_CLARITY_ID : undefined;
