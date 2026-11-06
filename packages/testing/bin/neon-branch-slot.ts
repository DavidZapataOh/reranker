import { requireEnv } from "../src/env.ts";
import { waitForCiBranchSlot } from "../src/neon-branch-slot.ts";

try {
  await waitForCiBranchSlot({
    apiKey: requireEnv("NEON_API_KEY"),
    projectId: requireEnv("NEON_PROJECT_ID"),
  });
} catch (error) {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
