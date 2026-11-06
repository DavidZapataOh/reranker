import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const APP_ENVS = ["development", "preview", "production"];

export function buildSteps({ appEnv, hasDatabasePackage, isVercel = false }) {
  if (appEnv !== undefined && !APP_ENVS.includes(appEnv)) {
    throw new Error(`Unknown APP_ENV "${appEnv}". Expected one of: ${APP_ENVS.join(", ")}.`);
  }
  if (hasDatabasePackage && isVercel && appEnv === undefined) {
    throw new Error(
      `APP_ENV must be set on Vercel. Expected one of: ${APP_ENVS.join(", ")}. Refusing to build without running migrations.`,
    );
  }
  const steps = [];
  // Only deploys that serve traffic touch the database schema.
  if (hasDatabasePackage && (appEnv === "preview" || appEnv === "production")) {
    steps.push({ command: "pnpm", args: ["--filter", "@reranker/db", "db:migrate"] });
  }
  steps.push({ command: "pnpm", args: ["exec", "turbo", "run", "build"] });
  return steps;
}

export function runSteps(steps, run = defaultRun) {
  for (const { command, args } of steps) {
    const code = run(command, args);
    if (code !== 0) return code;
  }
  return 0;
}

export function runtimeBanner(nodeVersion, pnpmVersion) {
  return `Build runtime: node ${nodeVersion}, pnpm ${pnpmVersion}`;
}

export function defaultRun(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error)
    console.error(`Failed to start "${command} ${args.join(" ")}": ${result.error.message}`);
  return result.status ?? 1;
}

if (import.meta.main) {
  try {
    const pnpmVersion = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout?.trim();
    console.log(runtimeBanner(process.version, pnpmVersion || "unknown"));
    const steps = buildSteps({
      appEnv: process.env.APP_ENV,
      isVercel: process.env.VERCEL === "1",
      hasDatabasePackage: existsSync(new URL("../../../packages/db/package.json", import.meta.url)),
    });
    process.exit(runSteps(steps));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
