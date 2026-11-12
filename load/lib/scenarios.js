/**
 * Keeps only the scenario named by `-e SCENARIO=<name>` (default `nominal`), so the
 * nominal and the 10× `stress` runs share one script but never run together.
 * @param {Record<string, object>} scenarios
 */
export function only(scenarios) {
  const name = __ENV.SCENARIO || "nominal";
  if (!Object.hasOwn(scenarios, name)) {
    throw new Error(
      `Unknown SCENARIO ${JSON.stringify(name)}; expected ${Object.keys(scenarios).join(" or ")}`,
    );
  }
  return { [name]: scenarios[name] };
}
