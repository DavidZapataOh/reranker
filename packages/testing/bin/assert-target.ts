import { assertDeploymentUrl } from "../src/target.ts";

// Prints the normalized origin so callers use exactly what was validated.
try {
  const { origin } = assertDeploymentUrl(process.argv[2] ?? "", {
    allowProduction: !process.argv.includes("--preview-only"),
  });
  console.log(origin);
} catch (error) {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
