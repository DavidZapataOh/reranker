import { gunzipSync } from "node:zlib";
import { resetAppEnv } from "@reranker/env";
import { PostHog } from "posthog-node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { requestErrorOptions } from "./request-errors";

const PII = /ana\.prueba@reranker\.co|310 555 1234/;
const env = { POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://us.i.posthog.com" };

// scrubEvent stamps app_env on every event, so the environment must be known.
beforeEach(() => {
  vi.stubEnv("APP_ENV", "preview");
  resetAppEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
});

function decode(body: unknown): string {
  if (typeof body === "string") return body;
  const bytes = Buffer.from(body as Uint8Array);
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
}

describe("request error options", () => {
  test("capture with the server project token and host", () => {
    const options = requestErrorOptions(env);
    expect(options).toMatchObject({
      apiKey: "phc_test",
      host: "https://us.i.posthog.com",
      disabled: false,
    });
    expect(options.serverOptions).toMatchObject({ disableGeoip: true });
  });

  test("stay off without a project token instead of falling back to the browser key", () => {
    expect(requestErrorOptions({}).disabled).toBe(true);
  });

  test("redact personal data from the request properties", async () => {
    const { beforeCapture } = requestErrorOptions(env);
    const properties = await beforeCapture?.({
      error: new Error("boom"),
      request: {},
      context: {},
      properties: {
        $current_url: "https://reranker.co/?email=ana.prueba@reranker.co",
        $pathname: "/",
      },
    });
    expect(JSON.stringify(properties)).not.toMatch(PII);
    expect(properties).toMatchObject({ $pathname: "/" });
  });

  test("the exception leaves the server without personal data, IP or geo", async () => {
    const sent: string[] = [];
    const fetch = vi.fn(async (_url: string, init: { body?: unknown }) => {
      sent.push(decode(init.body));
      return { status: 200, text: async () => "{}", json: async () => ({}) };
    });
    const client = new PostHog("phc_test", {
      ...requestErrorOptions(env).serverOptions,
      host: env.POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
      fetch,
    });

    const error = new Error("ops fault: ana.prueba@reranker.co +57 310 555 1234", {
      cause: { contact: "ana.prueba@reranker.co" },
    });
    await client.captureExceptionImmediate(error, "visitor", { $ip: "203.0.113.7" });
    await client.shutdown();

    const payload = sent.join("\n");
    expect(payload).toContain("$exception");
    expect(payload).toContain("ops fault: [redacted]");
    expect(payload).not.toMatch(PII);
    expect(payload).not.toContain('"$ip"');
    expect(payload).toContain('"$geoip_disable":true');
  });
});
