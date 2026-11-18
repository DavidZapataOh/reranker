import { resetAppEnv } from "@reranker/env";
import { AppError } from "@reranker/schema";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const house = vi.hoisted(() => ({ provisionHouseOrganization: vi.fn() }));
vi.mock("@reranker/auth/house", () => house);
const telemetry = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  captureServerEvent: vi.fn(),
}));
vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  ...telemetry,
}));

const { POST } = await import("./route");

const CRON_SECRET = "cron-secret-with-enough-length";
const BEARER = { authorization: `Bearer ${CRON_SECRET}` };
const HOUSE = "0b5e7c1e-4a8f-4d0b-9a6e-2f3c4d5e6f70";
const EMAIL = "fundador@reranker.co";

function provision(headers: Record<string, string> = {}, body?: string) {
  return POST(
    new Request("https://reranker.co/api/ops/house", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vercel-id": "iad1::abc", ...headers },
      ...(body === undefined ? {} : { body }),
    }),
  );
}

function logged(): string {
  return JSON.stringify(Object.values(telemetry.log).flatMap((fn) => fn.mock.calls));
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  resetAppEnv();
  house.provisionHouseOrganization.mockReset();
  for (const fn of Object.values(telemetry.log)) fn.mockReset();
  telemetry.captureServerEvent.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("provisions the house for that owner and logs the outcome without the email", async () => {
  house.provisionHouseOrganization.mockResolvedValue({ id: HOUSE, created: true });
  const response = await provision(
    BEARER,
    JSON.stringify({ ownerEmail: ` ${EMAIL.toUpperCase()}` }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ houseId: HOUSE, created: true });
  expect(house.provisionHouseOrganization).toHaveBeenCalledExactlyOnceWith({ ownerEmail: EMAIL });
  expect(telemetry.log.info).toHaveBeenCalledExactlyOnceWith("house provisioned", {
    house_id: HOUSE,
    created: true,
    request_id: "iad1::abc",
  });
  expect(logged()).not.toContain("fundador");
});

test("a second call answers with the same house, not a new one", async () => {
  house.provisionHouseOrganization
    .mockResolvedValueOnce({ id: HOUSE, created: true })
    .mockResolvedValueOnce({ id: HOUSE, created: false });
  const body = JSON.stringify({ ownerEmail: EMAIL });
  await provision(BEARER, body);
  const second = await provision(BEARER, body);
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ houseId: HOUSE, created: false });
});

test("an owner who never signed in is a 404 problem, logged without the email", async () => {
  house.provisionHouseOrganization.mockRejectedValue(
    new AppError("not_found", { detail: "the house owner has never signed in" }),
  );
  const response = await provision(BEARER, JSON.stringify({ ownerEmail: EMAIL }));
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(await response.json()).toMatchObject({ code: "not_found", instance: "/api/ops/house" });
  expect(telemetry.log.info).not.toHaveBeenCalled();
  expect(logged()).not.toContain("fundador");
});

test.each([
  ["a body that is not JSON", "{ownerEmail:"],
  ["no body", undefined],
  ["a body without the email", "{}"],
  ["an address that is not an email", JSON.stringify({ ownerEmail: "fundador" })],
  ["a body that is not an object", JSON.stringify([EMAIL])],
])("refuses %s with a 400 problem", async (_, body) => {
  const response = await provision(BEARER, body);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_request" });
  expect(house.provisionHouseOrganization).not.toHaveBeenCalled();
});

test.each([
  ["production", 404],
  ["preview", 401],
  ["development", 401],
])("without the bearer it answers %s with %i", async (env, status) => {
  vi.stubEnv("APP_ENV", env);
  resetAppEnv();
  for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: CRON_SECRET }]) {
    expect((await provision(headers, JSON.stringify({ ownerEmail: EMAIL }))).status).toBe(status);
  }
  expect(house.provisionHouseOrganization).not.toHaveBeenCalled();
});

test("stays closed while the cron secret is unset", async () => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("CRON_SECRET", "");
  resetAppEnv();
  const response = await provision(
    { authorization: "Bearer " },
    JSON.stringify({ ownerEmail: EMAIL }),
  );
  expect(response.status).toBe(401);
  expect(house.provisionHouseOrganization).not.toHaveBeenCalled();
});
