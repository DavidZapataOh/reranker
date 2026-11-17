import { defineEnv } from "@reranker/env";
import { z } from "@reranker/schema";
import { launchEnv, telemetryEnv } from "../env";
import { createPostHogRest, PostHogApiError } from "../posthog-rest";
import { SourceError } from "../providers/source-error";
import { type CheckResult, verdict } from "./types";

const env = z.object({
  POSTHOG_LAUNCH_READ_KEY: launchEnv.shape.POSTHOG_LAUNCH_READ_KEY,
  POSTHOG_PLAN: telemetryEnv.shape.POSTHOG_PLAN,
  POSTHOG_PROJECT_ID: telemetryEnv.shape.POSTHOG_PROJECT_ID,
  // Required by the app itself; here only compared when present, so a command run without the
  // app's environment still reports what it can.
  POSTHOG_PROJECT_TOKEN: z.string().startsWith("phc_").optional(),
});

const Billing = z.object({ has_active_subscription: z.boolean() });
const Me = z.object({ organization: z.object({ id: z.string() }) });
const Projects = z.object({
  next: z.string().nullable(),
  results: z.array(z.object({ id: z.number(), api_token: z.string() })),
});

function client() {
  const values = defineEnv([env]);
  if (!values.POSTHOG_LAUNCH_READ_KEY) throw new SourceError("falta POSTHOG_LAUNCH_READ_KEY");
  return { rest: createPostHogRest(values.POSTHOG_LAUNCH_READ_KEY), values };
}

async function read<S extends z.ZodType>(
  get: () => Promise<unknown>,
  schema: S,
): Promise<z.output<S>> {
  try {
    return schema.parse(await get());
  } catch (error) {
    if (error instanceof PostHogApiError) throw new SourceError(`respuesta HTTP ${error.status}`);
    throw error;
  }
}

/**
 * Pay-as-you-go: a card on file (an active subscription,
 * https://posthog.com/docs/open-api-spec/billing_list) and the code configured for it, so the Free
 * allowances and the 5-alert cap stop applying.
 */
export async function checkPostHogBilling(signal?: AbortSignal): Promise<CheckResult> {
  const { rest, values } = client();
  const billing = await read(() => rest.get("billing/", signal), Billing);
  const problems: string[] = [];
  if (!billing.has_active_subscription) problems.push("la organización sigue en el plan gratis");
  if (values.POSTHOG_PLAN !== "pay-as-you-go") problems.push("POSTHOG_PLAN sigue en free");
  return verdict("posthog-billing", problems, "pago por uso con tarjeta registrada");
}

/**
 * Production has a project of its own beside another one for previews. The organization's
 * projects are listed; which one previews point at is a Vercel setting no PostHog API shows.
 */
export async function checkPostHogProjects(signal?: AbortSignal): Promise<CheckResult> {
  const { rest, values } = client();
  if (!values.POSTHOG_PROJECT_ID) throw new SourceError("falta POSTHOG_PROJECT_ID");
  const me = await read(() => rest.get("users/@me/", signal), Me);
  const projects: z.output<typeof Projects>["results"] = [];
  let next: string | null = `organizations/${me.organization.id}/projects/`;
  while (next) {
    const path: string = next;
    const page = await read(() => rest.get(path, signal), Projects);
    projects.push(...page.results);
    next = page.next;
  }
  const production = projects.find((p) => String(p.id) === values.POSTHOG_PROJECT_ID);
  const problems: string[] = [];
  if (!production) {
    problems.push(`el proyecto ${values.POSTHOG_PROJECT_ID} no está en la organización`);
  } else if (
    values.POSTHOG_PROJECT_TOKEN &&
    production.api_token !== values.POSTHOG_PROJECT_TOKEN
  ) {
    problems.push("producción envía a otro proyecto que el de POSTHOG_PROJECT_ID");
  }
  if (projects.length < 2) problems.push("producción y preview comparten el mismo proyecto");
  return verdict("posthog-projects", problems, "producción tiene su propio proyecto");
}
