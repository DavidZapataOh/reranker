import { parseArgs } from "node:util";
import { readNeonUsage } from "../src/neon-usage";

const { values } = parseArgs({ options: { project: { type: "string", multiple: true } } });
const projectIds = values.project?.length ? values.project : [process.env.NEON_PROJECT_ID];
const apiKey = process.env.NEON_API_KEY;

if (!apiKey || projectIds.some((id) => !id)) {
  console.error("NEON_API_KEY and NEON_PROJECT_ID (or --project <id>) are required");
  process.exit(1);
}

// The month so far, through the end of today (UTC), as the consumption endpoint counts it.
const now = new Date();
const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const to = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
).toISOString();

console.log(
  JSON.stringify(
    await readNeonUsage({ apiKey, projectIds: projectIds as string[], from, to }),
    null,
    2,
  ),
);
