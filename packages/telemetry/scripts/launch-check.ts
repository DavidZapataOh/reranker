import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type CheckResult, repositoryInputs, runLaunchCheck } from "../src/launch";

// Verifies every provider stage the gated flags need, read-only. Report-only by default (exit 0);
// --strict exits 1 unless every check passes. Run it with the production environment:
// `vercel env pull .env.production.local --environment=production`, then
// `pnpm launch:check --env-file=.env.production.local`.
const { values } = parseArgs({
  options: { "env-file": { type: "string" }, strict: { type: "boolean", default: false } },
});
// pnpm runs the script from the package; the path is relative to where the command was typed.
if (values["env-file"]) {
  process.loadEnvFile(resolve(process.env.INIT_CWD ?? process.cwd(), values["env-file"]));
}
process.env.APP_ENV ??= "production";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const results = await runLaunchCheck(repositoryInputs(root));

const mark: Record<CheckResult["status"], string> = {
  pass: "pass",
  fail: "FAIL",
  unknown: "unknown",
};
for (const r of results) console.log(`${mark[r.status].padEnd(7)} ${r.id.padEnd(20)} ${r.reason}`);

if (process.env.GITHUB_ACTIONS === "true") {
  for (const r of results.filter((x) => x.status !== "pass")) {
    console.log(`::warning title=launch:check ${r.id}::${r.status}: ${r.reason}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = results.map((r) => `| \`${r.id}\` | ${r.status} | ${r.reason} |`);
    appendFileSync(
      summary,
      ["### launch:check", "", "| Check | Status | Reason |", "|---|---|---|", ...rows, ""].join(
        "\n",
      ),
    );
  }
}

if (values.strict && results.some((r) => r.status !== "pass")) process.exit(1);
