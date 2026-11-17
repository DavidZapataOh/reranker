import { spawnSync } from "node:child_process";

const APP_ENVS = ["development", "preview", "production"];

// The build never migrates and never holds migration credentials: production migrates in CI
// once every gate is green, and each preview's database branch is migrated before it deploys.
export function buildSteps({ appEnv, isVercel = false }) {
  if (appEnv !== undefined && !APP_ENVS.includes(appEnv)) {
    throw new Error(`Unknown APP_ENV "${appEnv}". Expected one of: ${APP_ENVS.join(", ")}.`);
  }
  if (isVercel && appEnv === undefined) {
    throw new Error(`APP_ENV must be set on Vercel. Expected one of: ${APP_ENVS.join(", ")}.`);
  }
  return [{ command: "pnpm", args: ["exec", "turbo", "run", "build"] }];
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
    const steps = buildSteps({ appEnv: process.env.APP_ENV, isVercel: process.env.VERCEL === "1" });
    process.exit(runSteps(steps));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
