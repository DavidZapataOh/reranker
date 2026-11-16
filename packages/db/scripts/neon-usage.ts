import { parseArgs } from "node:util";
import { readNeonUsage } from "../src/neon-usage";

const { values } = parseArgs({ options: { project: { type: "string", multiple: true } } });
const projectIds = values.project?.length ? values.project : [process.env.NEON_PROJECT_ID];
const apiKey = process.env.NEON_API_KEY;

if (!apiKey || projectIds.some((id) => !id)) {
  console.error("NEON_API_KEY and NEON_PROJECT_ID (or --project <id>) are required");
  process.exit(1);
}

console.log(
  JSON.stringify(await readNeonUsage({ apiKey, projectIds: projectIds as string[] }), null, 2),
);
