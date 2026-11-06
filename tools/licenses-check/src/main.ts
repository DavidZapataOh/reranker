import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateLicenses, type LicensesReport } from "./licenses.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function loadReport(): LicensesReport {
  const reportFile = process.env.LICENSES_REPORT_FILE;
  const json = reportFile
    ? readFileSync(reportFile, "utf8")
    : execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "--recursive"], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
  return JSON.parse(json) as LicensesReport;
}

const report = loadReport();
const violations = evaluateLicenses(report);

if (violations.length > 0) {
  for (const { name, versions, license } of violations) {
    console.error(`${name}@${versions.join(",")} ${license}`);
  }
  process.exitCode = 1;
} else {
  const total = Object.values(report).reduce((sum, packages) => sum + packages.length, 0);
  console.log(`licenses: ${total} packages OK`);
}
