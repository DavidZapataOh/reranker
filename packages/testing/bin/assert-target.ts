import { assertDeploymentUrl } from "../src/target.ts";

try {
  assertDeploymentUrl(process.argv[2] ?? "", {
    allowProduction: !process.argv.includes("--preview-only"),
  });
} catch (error) {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
