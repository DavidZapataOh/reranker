import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./send-auth-email", () => ({ sendAuthEmail: vi.fn() }));

const DEPLOYMENT_HOST = "reranker-a1b2c3d4e-davidzapataohs-projects.vercel.app";
const BRANCH_HOST = "reranker-git-auth-handler-davidzapataohs-projects.vercel.app";
// Anyone can deploy a look-alike project on vercel.app, so a pattern would trust it too.
const FOREIGN_HOST = "reranker-git-x-davidzapataohs-projects-evil.vercel.app";

const shared = {
  BETTER_AUTH_SECRET: "s".repeat(32),
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  RESEND_API_KEY: "re_test",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "turnstile-site",
  CAPACITY_HMAC_KEY: "h".repeat(32),
};

async function loadServer(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...shared, ...env })) vi.stubEnv(name, value);
  return import("./server");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// A disabled path answers 404 once the host resolves, before anything reaches the database.
const reach = (auth: Awaited<ReturnType<typeof loadServer>>["auth"], host: string) =>
  auth.handler(
    new Request(`https://${host}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );

describe("production", () => {
  const env = {
    APP_ENV: "production",
    BETTER_AUTH_URL: "https://reranker.co",
    VERCEL_URL: DEPLOYMENT_HOST,
  };

  test("is pinned to reranker.co, whatever the deployment URL", async () => {
    const { auth, trustedOrigins } = await loadServer(env);
    expect(auth.options.baseURL).toBe("https://reranker.co");
    expect(trustedOrigins).toEqual(["https://reranker.co"]);
    const context = await auth.$context;
    expect(context.isTrustedOrigin("https://reranker.co")).toBe(true);
    expect(context.isTrustedOrigin(`https://${DEPLOYMENT_HOST}`)).toBe(false);
  });
});

describe("preview", () => {
  const env = { APP_ENV: "preview", VERCEL_URL: DEPLOYMENT_HOST, VERCEL_BRANCH_URL: BRANCH_HOST };

  test("serves its own deployment and branch hosts over https", async () => {
    const { auth, trustedOrigins } = await loadServer(env);
    expect(auth.options.baseURL).toEqual({
      allowedHosts: [DEPLOYMENT_HOST, BRANCH_HOST],
      protocol: "https",
    });
    expect(trustedOrigins).toEqual([`https://${DEPLOYMENT_HOST}`, `https://${BRANCH_HOST}`]);
    const context = await auth.$context;
    for (const host of [DEPLOYMENT_HOST, BRANCH_HOST]) {
      expect(context.isTrustedOrigin(`https://${host}`)).toBe(true);
      expect((await reach(auth, host)).status).toBe(404);
    }
  });

  test("rejects a foreign vercel.app host and origin", async () => {
    const { auth } = await loadServer(env);
    expect((await auth.$context).isTrustedOrigin(`https://${FOREIGN_HOST}`)).toBe(false);
    await expect(reach(auth, FOREIGN_HOST)).rejects.toThrow(/not in the allowed hosts/);
  });

  test("a deployment without a branch URL serves its deployment host only", async () => {
    const { auth } = await loadServer({ APP_ENV: "preview", VERCEL_URL: DEPLOYMENT_HOST });
    expect(auth.options.baseURL).toEqual({ allowedHosts: [DEPLOYMENT_HOST], protocol: "https" });
  });
});
