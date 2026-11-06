import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { respondAfter, respondInvalid, respondWith5xx, server } from "./msw.ts";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const URL = "https://api.example.test/v1";

it("responds 503 by default", async () => {
  respondWith5xx(URL);
  expect((await fetch(URL)).status).toBe(503);
});

it("responds with the requested 5xx status", async () => {
  respondWith5xx(URL, 502);
  expect((await fetch(URL)).status).toBe(502);
});

it("delays the response by the given ms", async () => {
  respondAfter(URL, 200);
  const t = performance.now();
  await fetch(URL);
  expect(performance.now() - t).toBeGreaterThanOrEqual(190);
});

it("returns the invalid body as-is with 200", async () => {
  respondInvalid(URL, "{not json");
  const r = await fetch(URL);
  expect(r.status).toBe(200);
  await expect(r.json()).rejects.toThrow();
});

it("errors on unhandled requests without consumers opting in", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(fetch("https://unhandled.example.test/")).rejects.toThrow();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("without a matching request handler"));
  error.mockRestore();
});
