import { rm } from "node:fs/promises";
import { redactSecret } from "../src/redact.ts";

// Fails closed: reports that might still hold the secret are deleted, never uploaded.
const dir = process.argv[2];
const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
if (!dir) {
  console.log("::error::Usage: redact-bypass-secret.ts <dir>");
  process.exit(1);
}
if (secret) {
  try {
    const changed = await redactSecret(dir, secret);
    console.log(`Redacted the bypass secret from ${changed.length} file(s) in ${dir}`);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    console.log(
      `::error::Could not redact ${dir}, deleted it: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
