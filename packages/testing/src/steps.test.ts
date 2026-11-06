import { describe, expect, it } from "vitest";
import { createStepCounter } from "./steps.ts";

describe("createStepCounter", () => {
  it("counts every attempted action and returns its value", async () => {
    const steps = createStepCounter();
    expect(await steps.act("type", async () => 7)).toBe(7);
    await expect(
      steps.act("click", async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(steps.count()).toBe(2);
  });

  it("runs each action through the provided step runner with its label", async () => {
    const labels: string[] = [];
    const steps = createStepCounter(async (label, fn) => {
      labels.push(label);
      return fn();
    });
    await steps.act("see report", async () => undefined);
    expect(labels).toEqual(["see report"]);
  });
});
