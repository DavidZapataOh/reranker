import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CRONS } from "./crons";

test("the crons in code are the ones vercel.json registers", () => {
  const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  expect(CRONS).toEqual(vercel.crons);
});
