import { z } from "@reranker/schema";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { createPostHogRest, PostHogApiError } from "./posthog-rest";

const LIST = "https://us.posthog.com/api/projects/711803/things/";
const Row = z.object({ id: z.number() });

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

test("appends the page size to a path that already has a query", async () => {
  let search = "";
  server.use(
    http.get(LIST, ({ request }) => {
      search = new URL(request.url).search;
      return HttpResponse.json({ next: null, results: [{ id: 1 }] });
    }),
  );
  expect(await createPostHogRest("phx_test").list("things/?saved=true", Row)).toEqual([{ id: 1 }]);
  expect(search).toBe("?saved=true&limit=100");
});

test("never sends the key to another host", async () => {
  server.use(
    http.get(LIST, () => HttpResponse.json({ next: "https://evil.example/things/", results: [] })),
  );
  await expect(createPostHogRest("phx_test").list("things/", Row)).rejects.toThrow(
    /Refusing to call/,
  );
});

test("sends JSON bodies and surfaces the status and detail of a rejection", async () => {
  server.use(
    http.patch(`${LIST}3/`, async ({ request }) => {
      expect(request.headers.get("content-type")).toBe("application/json");
      return HttpResponse.json({ detail: "API key missing required scope" }, { status: 403 });
    }),
  );
  const error = await createPostHogRest("phx_test")
    .send("things/3/", "PATCH", { name: "x" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PostHogApiError);
  expect(error).toMatchObject({ status: 403, detail: "API key missing required scope" });
});

test("falls back to the status text when the body is not JSON", async () => {
  server.use(
    http.get(LIST, () => new HttpResponse("nope", { status: 502, statusText: "Bad Gateway" })),
  );
  await expect(createPostHogRest("phx_test").list("things/", Row)).rejects.toThrow(
    "PostHog API 502: Bad Gateway",
  );
});
