import { InvalidInputError } from "@reranker/jobs/errors";
import { CAPTURE_ID_PATTERN } from "@reranker/verify/format";
import { expect, test } from "vitest";
import { newCaptureId, parseSlotId, slotId } from "../../src/slot";

const measurementId = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";

test("slot ids round-trip", () => {
  expect(slotId(measurementId, 7)).toBe(`${measurementId}:7`);
  expect(parseSlotId(slotId(measurementId, 7))).toEqual({ measurementId, slotIndex: 7 });
  expect(parseSlotId(slotId(measurementId, 0))).toEqual({ measurementId, slotIndex: 0 });
});

test.each([
  "x",
  "",
  ":1",
  `${measurementId}:`,
  `${measurementId}:-1`,
  `${measurementId}:01`,
  `${measurementId}:1.5`,
  `${measurementId}:32768`,
  "a:b:1",
])("parseSlotId rejects %j", (value) =>
  expect(() => parseSlotId(value)).toThrow(InvalidInputError),
);

test("slotId rejects an index the captures table cannot store and a malformed measurement id", () => {
  expect(() => slotId(measurementId, -1)).toThrow(InvalidInputError);
  expect(() => slotId(measurementId, 1.5)).toThrow(InvalidInputError);
  expect(() => slotId(measurementId, 32768)).toThrow(InvalidInputError);
  expect(() => slotId("", 1)).toThrow(InvalidInputError);
  expect(() => slotId("a:b", 1)).toThrow(InvalidInputError);
});

test("capture ids are cap_ + 26-char ULID and sort by time", () => {
  const ids = Array.from({ length: 1000 }, newCaptureId);
  for (const id of ids) expect(id).toMatch(CAPTURE_ID_PATTERN);
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});
