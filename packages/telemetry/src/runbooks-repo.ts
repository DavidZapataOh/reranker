import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { externalAlerts, opsAlerts, procedures } from "./alerts";
import { checkRunbooks, type RunbookDocs } from "./runbooks";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIR = `${ROOT}docs/runbooks/`;

const insights = JSON.parse(
  readFileSync(new URL("../posthog-alerts.json", import.meta.url), "utf8"),
) as { id: string; runbook?: string }[];

const docs: RunbookDocs = {
  files: readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "_template.md"),
  read: (file) => readFileSync(`${DIR}${file}`, "utf8"),
  exists: (path) => existsSync(`${ROOT}${path}`),
  template: existsSync(`${DIR}_template.md`) ? readFileSync(`${DIR}_template.md`, "utf8") : "",
};

export function repoProblems(): string[] {
  return checkRunbooks(docs, { opsAlerts, externalAlerts, procedures, insights });
}
