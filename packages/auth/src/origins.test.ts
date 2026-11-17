import { describe, expect, test, vi } from "vitest";
import { authOrigins } from "./origins";

vi.mock("./send-auth-email", () => ({ sendAuthEmail: vi.fn() }));

const DEPLOYMENT_HOST = "reranker-a1b2c3d4e-davidzapataohs-projects.vercel.app";
const BRANCH_HOST = "reranker-git-auth-handler-davidzapataohs-projects.vercel.app";
// Anyone can deploy a look-alike project on vercel.app, so a pattern would trust it too.
const FOREIGN_HOST = "reranker-git-x-davidzapataohs-projects-evil.vercel.app";

describe("authOrigins", () => {
  test("production is pinned to reranker.co, whatever the deployment URL", () => {
    expect(
      authOrigins({
        APP_ENV: "production",
        BETTER_AUTH_URL: "https://reranker.co",
        VERCEL_URL: DEPLOYMENT_HOST,
        VERCEL_BRANCH_URL: BRANCH_HOST,
      }),
    ).toEqual({ baseURL: "https://reranker.co", trustedOrigins: ["https://reranker.co"] });
  });

  test("development serves its configured origin", () => {
    expect(
      authOrigins({ APP_ENV: "development", BETTER_AUTH_URL: "http://localhost:3000" }),
    ).toEqual({ baseURL: "http://localhost:3000", trustedOrigins: ["http://localhost:3000"] });
  });

  test("outside preview the origin is required", () => {
    expect(() => authOrigins({ APP_ENV: "production", VERCEL_URL: DEPLOYMENT_HOST })).toThrow(
      /BETTER_AUTH_URL is required/,
    );
  });

  test("a preview serves its own deployment and branch hosts over https", () => {
    expect(
      authOrigins({
        APP_ENV: "preview",
        VERCEL_URL: DEPLOYMENT_HOST,
        VERCEL_BRANCH_URL: BRANCH_HOST,
      }),
    ).toEqual({
      baseURL: { allowedHosts: [DEPLOYMENT_HOST, BRANCH_HOST], protocol: "https" },
      trustedOrigins: [`https://${DEPLOYMENT_HOST}`, `https://${BRANCH_HOST}`],
    });
  });

  test("a preview without a branch URL serves its deployment host only", () => {
    expect(authOrigins({ APP_ENV: "preview", VERCEL_URL: DEPLOYMENT_HOST })).toEqual({
      baseURL: { allowedHosts: [DEPLOYMENT_HOST], protocol: "https" },
      trustedOrigins: [`https://${DEPLOYMENT_HOST}`],
    });
  });
});

// The server reads its environment once, when the module loads, so one preview instance is built
// for the file instead of a fresh module graph per case.
vi.stubEnv("APP_ENV", "preview");
vi.stubEnv("VERCEL_URL", DEPLOYMENT_HOST);
vi.stubEnv("VERCEL_BRANCH_URL", BRANCH_HOST);
vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(32));
vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
vi.stubEnv("RESEND_API_KEY", "re_test");
vi.stubEnv("TURNSTILE_SECRET_KEY", "turnstile-secret");
vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "turnstile-site");
vi.stubEnv("CAPACITY_HMAC_KEY", "h".repeat(32));

const { auth, trustedOrigins } = await import("./server");

// A disabled path answers 404 once the host resolves, before anything reaches the database.
const reach = (host: string) =>
  auth.handler(
    new Request(`https://${host}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );

describe("the auth instance of a preview", () => {
  test("is built from authOrigins", () => {
    const expected = authOrigins({
      APP_ENV: "preview",
      VERCEL_URL: DEPLOYMENT_HOST,
      VERCEL_BRANCH_URL: BRANCH_HOST,
    });
    expect(auth.options.baseURL).toEqual(expected.baseURL);
    expect(trustedOrigins).toEqual(expected.trustedOrigins);
  });

  test("trusts and serves its own hosts", async () => {
    const context = await auth.$context;
    for (const host of [DEPLOYMENT_HOST, BRANCH_HOST]) {
      expect(context.isTrustedOrigin(`https://${host}`)).toBe(true);
      expect((await reach(host)).status).toBe(404);
    }
  });

  test("rejects a foreign vercel.app host and origin", async () => {
    expect((await auth.$context).isTrustedOrigin(`https://${FOREIGN_HOST}`)).toBe(false);
    await expect(reach(FOREIGN_HOST)).rejects.toThrow(/not in the allowed hosts/);
  });
});
