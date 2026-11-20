import chisquareCdf from "@stdlib/stats-base-dists-chisquare-cdf";
import { expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import { planMeasurement } from "../src/sample";
import { dentalSet } from "./fixtures/intent-set";

const set = dentalSet();
const geo = getGeo("co-c1003659");

// Non-canonical draws of the first intent across many reports, keyed by persona and paraphrase.
// The design forces one variant without persona per intent, so those are drawn more often than
// variants with a persona; within each of the two groups every variant must be equally likely.
function frequencies(reports: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let r = 0; r < reports; r++) {
    const plan = planMeasurement({
      intentSet: set,
      geo,
      scope: "local",
      neighborhood: "Chapinero",
      noun: "clínica odontológica",
      engines: ["gemini"],
      reportId: `report-${r}`,
      intents: 1,
    });
    for (const o of plan.observations) {
      if (o.isCanonical) continue;
      const key = `${o.personaId ?? ""}|${o.paraphraseId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function chiSquarePValue(counts: Map<string, number>): number {
  const others = set.paraphrases.filter((p) => p.intentId === set.intents[0]?.intentId).length - 1;
  const groups = [
    { size: others, persona: false },
    { size: others * set.personas.length, persona: true },
  ];
  let statistic = 0;
  for (const group of groups) {
    const observed = [...counts].filter(([key]) => !key.startsWith("|") === group.persona);
    expect(observed).toHaveLength(group.size);
    const expected = observed.reduce((sum, [, n]) => sum + n, 0) / group.size;
    for (const [, n] of observed) statistic += (n - expected) ** 2 / expected;
  }
  return 1 - chisquareCdf(statistic, counts.size - groups.length);
}

test("uniformity over 10,000 report ids (chi-square p > 0.001)", () =>
  expect(chiSquarePValue(frequencies(10_000))).toBeGreaterThan(0.001));
