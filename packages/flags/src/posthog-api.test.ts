import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { createPostHogApi, PostHogApiError } from "./posthog-api";

const LIST = "https://us.posthog.com/api/projects/711803/feature_flags/";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

test("lists every page and sends the key as a bearer token", async () => {
  const auth: (string | null)[] = [];
  server.use(
    http.get(LIST, ({ request }) => {
      auth.push(request.headers.get("authorization"));
      const offset = new URL(request.url).searchParams.get("offset");
      return offset
        ? HttpResponse.json({ next: null, results: [{ key: "b", active: true, id: 2 }] })
        : HttpResponse.json({
            next: `${LIST}?limit=100&offset=100`,
            results: [{ key: "a", active: false, id: 1 }],
          });
    }),
  );
  expect(await createPostHogApi("phx_test").listFlags()).toEqual([
    { key: "a", active: false },
    { key: "b", active: true },
  ]);
  expect(auth).toEqual(["Bearer phx_test", "Bearer phx_test"]);
});

test("never sends the key to another host", async () => {
  server.use(
    http.get(LIST, () =>
      HttpResponse.json({ next: "https://evil.example/api/feature_flags/", results: [] }),
    ),
  );
  await expect(createPostHogApi("phx_test").listFlags()).rejects.toThrow(/Refusing to call/);
});

test("creates a flag with a JSON body", async () => {
  let received: unknown;
  server.use(
    http.post(LIST, async ({ request }) => {
      expect(request.headers.get("content-type")).toBe("application/json");
      received = await request.json();
      return HttpResponse.json({ id: 1 }, { status: 201 });
    }),
  );
  const payload = {
    key: "accounts",
    name: "Accounts",
    active: false,
    filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    tags: ["kill-switch", "04"],
  };
  await createPostHogApi("phx_test").createFlag(payload);
  expect(received).toEqual(payload);
});

test("surfaces the status and detail of a rejected request", async () => {
  server.use(
    http.get(LIST, () =>
      HttpResponse.json({ detail: "API key missing required scope" }, { status: 403 }),
    ),
  );
  const error = await createPostHogApi("phx_test")
    .listFlags()
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PostHogApiError);
  expect(error).toMatchObject({ status: 403, detail: "API key missing required scope" });
});

test("falls back to the status text when the body is not JSON", async () => {
  server.use(
    http.get(LIST, () => new HttpResponse("nope", { status: 502, statusText: "Bad Gateway" })),
  );
  await expect(createPostHogApi("phx_test").listFlags()).rejects.toThrow(
    "PostHog API 502: Bad Gateway",
  );
});
