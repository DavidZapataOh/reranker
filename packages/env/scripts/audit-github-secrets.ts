import { execFileSync } from "node:child_process";
import { auditSecrets, catalog } from "../src/catalog";

function listNames(kind: "secret" | "variable"): string[] {
  const out = execFileSync("gh", [kind, "list", "--json", "name"], { encoding: "utf8" });
  return (JSON.parse(out) as { name: string }[]).map((item) => item.name);
}

// Names only: the values never leave GitHub, so the output is safe in any log.
let failed = false;
for (const [label, kind, held] of [
  ["secrets", "secret", listNames("secret")],
  ["variables", "config", listNames("variable")],
] as const) {
  const { unexpected, missing } = auditSecrets(
    held,
    catalog.filter((entry) => entry.kind === kind),
  );
  console.log(`${label}: ${held.length} held`);
  console.log(`  unexpected: ${JSON.stringify(unexpected)}`);
  console.log(`  missing: ${JSON.stringify(missing)}`);
  if (unexpected.length > 0 || missing.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
