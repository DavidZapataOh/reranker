import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { repositoryInputs, runLaunchCheck } from "@reranker/telemetry/launch";
import { runEnable } from "../src/launch-gate";
import { createPostHogApi } from "../src/posthog-api";
import { registry } from "../src/registry";
import { runSync } from "../src/sync";

// Creates the registry's missing flags in PostHog; run locally with a personal API key.
// `--enable <key>` turns one on; free-report-live and accounts only when launch:check passes,
// so run it with the production environment (`--env-file=.env.production.local`).
const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    enable: { type: "string" },
    "env-file": { type: "string" },
  },
});
// pnpm runs the script from the package; the path is relative to where the command was typed.
if (values["env-file"]) {
  process.loadEnvFile(resolve(process.env.INIT_CWD ?? process.cwd(), values["env-file"]));
}

const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
if (!apiKey) {
  console.error("POSTHOG_PERSONAL_API_KEY (personal API key with feature_flag:write) is required");
  process.exit(1);
}
const api = createPostHogApi(apiKey);

if (values.enable) {
  process.env.APP_ENV ??= "production";
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const enabled = await runEnable(api, values.enable, () => runLaunchCheck(repositoryInputs(root)));
  process.exit(enabled ? 0 : 1);
}

await runSync(api, registry, { dryRun: values["dry-run"] });
