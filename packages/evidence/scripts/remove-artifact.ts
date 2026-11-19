import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { endPools } from "@reranker/db";
import type { RemovalReason } from "@reranker/verify/format";
import { type RemovableKind, removeArtifact } from "../src/removal";

// Takes one artifact down, as docs/runbooks/evidence-artifact-removal.md describes. Run it with the
// environment it acts on: `vercel env pull .env.production.local --environment=production`, then
// `pnpm --filter @reranker/evidence artifact:remove --env-file=.env.production.local \
//   --kind raw --sha256 <hex> --reason personal_data_request`.
const KINDS: readonly RemovableKind[] = ["raw", "normalized", "extractions"];
const REASONS: readonly RemovalReason[] = ["personal_data_request", "legal_order"];

const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    kind: { type: "string" },
    sha256: { type: "string" },
    reason: { type: "string" },
  },
});
const kind = KINDS.find((k) => k === values.kind);
const reason = REASONS.find((r) => r === values.reason);
if (!kind || !reason || !values.sha256) {
  console.error(
    `Usage: artifact:remove --kind ${KINDS.join("|")} --sha256 <hex> --reason ${REASONS.join("|")}`,
  );
  process.exit(2);
}
// pnpm runs the script from the package; the path is relative to where the command was typed.
if (values["env-file"]) {
  process.loadEnvFile(resolve(process.env.INIT_CWD ?? process.cwd(), values["env-file"]));
}

try {
  await removeArtifact(values.sha256, kind, reason);
  console.log(`removed ${kind}/${values.sha256} (${reason})`);
} finally {
  await endPools();
}
