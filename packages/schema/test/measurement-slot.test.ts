import { expect, test } from "vitest";
import { MAX_SLOT_INDEX, parseSlotId, SLOT_ID_PATTERN, slotId } from "../src/measurement/index";

const measurementId = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";
const invalid = expect.objectContaining({ code: "validation_failed" });

test("slot ids round-trip up to the largest smallint index", () => {
  for (const i of [0, 7, MAX_SLOT_INDEX]) {
    expect(slotId(measurementId, i)).toMatch(SLOT_ID_PATTERN);
    expect(parseSlotId(slotId(measurementId, i))).toEqual({ measurementId, slotIndex: i });
  }
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
])("parseSlotId rejects %j as validation_failed", (value) =>
  expect(() => parseSlotId(value)).toThrow(invalid),
);

test.each([
  [measurementId, -1],
  [measurementId, 1.5],
  [measurementId, 32768],
  ["", 1],
  ["a:b", 1],
] as const)("slotId(%j, %j) is rejected as validation_failed", (id, index) =>
  expect(() => slotId(id, index)).toThrow(invalid),
);
