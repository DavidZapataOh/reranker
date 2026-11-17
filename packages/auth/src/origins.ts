import type { AppEnv } from "@reranker/env";
import type { BaseURLConfig } from "better-auth";

export type OriginEnv = {
  APP_ENV: AppEnv;
  BETTER_AUTH_URL?: string | undefined;
  VERCEL_URL?: string | undefined;
  VERCEL_BRANCH_URL?: string | undefined;
};

// A preview answers only on its own deployment and branch hosts: a *.vercel.app pattern would also
// trust any look-alike project someone else deploys on Vercel.
export function authOrigins(env: OriginEnv): { baseURL: BaseURLConfig; trustedOrigins: string[] } {
  if (env.APP_ENV === "preview") {
    const hosts = [env.VERCEL_URL, env.VERCEL_BRANCH_URL].filter((host) => host !== undefined);
    return {
      baseURL: { allowedHosts: hosts, protocol: "https" },
      trustedOrigins: hosts.map((host) => `https://${host}`),
    };
  }
  // authEnv requires it outside preview; the check only narrows the type.
  if (!env.BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is required outside preview");
  return { baseURL: env.BETTER_AUTH_URL, trustedOrigins: [env.BETTER_AUTH_URL] };
}
