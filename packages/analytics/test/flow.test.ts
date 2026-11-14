import { z } from "@reranker/schema";
import { expect, test } from "vitest";
import { flowContextField, flowContextSchema } from "../src/flow";

const flow = {
  visitId: "0b6f8c1e-3c3a-4c7e-9b1e-2d6f0a9c4b11",
  origin: {
    ai_source: "chatgpt",
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    device_type: "mobile",
    landing_path: "/",
  },
  consent: "pending",
};

test("accepts a valid flow", () => {
  expect(flowContextSchema.parse(flow)).toEqual(flow);
});

test("rejects extra keys and a non-UUID visit id", () => {
  expect(flowContextSchema.safeParse({ ...flow, email: "a@b.co" }).success).toBe(false);
  expect(flowContextSchema.safeParse({ ...flow, visitId: "1731500000000-abc" }).success).toBe(
    false,
  );
});

test("a malformed flow never fails the enclosing request schema", () => {
  const body = z.object({ name: z.string(), flow: flowContextField });
  expect(body.parse({ name: "x", flow: { visitId: "nope" } })).toEqual({
    name: "x",
    flow: undefined,
  });
  expect(body.parse({ name: "x" })).toEqual({ name: "x", flow: undefined });
});

test("utm values longer than 200 characters are invalid", () => {
  expect(
    flowContextSchema.safeParse({
      ...flow,
      origin: { ...flow.origin, utm_campaign: "x".repeat(201) },
    }).success,
  ).toBe(false);
});

test("landing path and AI source are bounded", () => {
  expect(
    flowContextSchema.safeParse({ ...flow, origin: { ...flow.origin, landing_path: "x" } }).success,
  ).toBe(false);
  expect(
    flowContextSchema.safeParse({
      ...flow,
      origin: { ...flow.origin, landing_path: `/${"x".repeat(300)}` },
    }).success,
  ).toBe(false);
  expect(
    flowContextSchema.safeParse({ ...flow, origin: { ...flow.origin, ai_source: "x".repeat(41) } })
      .success,
  ).toBe(false);
});
