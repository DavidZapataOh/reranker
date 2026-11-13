import axe from "axe-core";
import { expect } from "vitest";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export async function expectNoAxeViolations(el: Element): Promise<void> {
  const { violations } = await axe.run(el, { runOnly: { type: "tag", values: TAGS } });
  expect(
    violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) })),
  ).toEqual([]);
}
