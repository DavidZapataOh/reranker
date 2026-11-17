import { defineEnv } from "@reranker/env";
import { z } from "@reranker/schema";
import { launchEnv } from "../env";
import { httpError, SourceError } from "../providers/source-error";
import { type CheckResult, verdict } from "./types";

// https://betterstack.com/docs/uptime/api/getting-started-with-uptime-api/
const API = "https://incidents.betterstack.com";
const READY_PATH = "/api/ready";
const PRODUCTION_HOSTS = new Set(["reranker.co", "www.reranker.co"]);
const CHECK_SECONDS = 30;

const env = launchEnv.pick({ BETTERSTACK_API_TOKEN: true });

const Paging = z.object({ next: z.string().nullable() });

// A monitor or webhook pages someone when it has an escalation policy or calls or pushes the
// on-call person; with a policy, those switches are ignored.
const Routing = z.object({
  policy_id: z.union([z.string(), z.number()]).nullish(),
  call: z.boolean().nullish(),
  push: z.boolean().nullish(),
  paused: z.boolean().nullish(),
});
type Routing = z.output<typeof Routing>;

const Monitor = z.object({
  attributes: Routing.extend({
    url: z.string(),
    check_frequency: z.number(),
    effective_check_frequency: z.number().nullish(),
    effective_check_frequency_reason: z.string().nullish(),
  }),
});
const Webhook = z.object({ attributes: Routing });

const pages = (r: Routing) => Boolean(r.policy_id) || Boolean(r.call) || Boolean(r.push);

async function list<S extends z.ZodType>(
  path: string,
  row: S,
  signal: AbortSignal | undefined,
): Promise<z.output<S>[]> {
  const token = defineEnv([env]).BETTERSTACK_API_TOKEN;
  if (!token) throw new SourceError("falta BETTERSTACK_API_TOKEN");
  const page = z.object({ data: z.array(row), pagination: Paging });
  const rows: z.output<S>[] = [];
  let url: string | null = `${API}${path}?per_page=250`;
  while (url) {
    // The token only ever goes to the API host, whatever a `next` link says.
    if (new URL(url).origin !== API) throw new SourceError("enlace de paginación ajeno");
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      ...(signal && { signal }),
    });
    if (!response.ok) throw httpError(response);
    const parsed: z.output<typeof page> = page.parse(await response.json());
    rows.push(...parsed.data);
    url = parsed.pagination.next;
  }
  return rows;
}

function isReady(url: string): boolean {
  try {
    const u = new URL(url);
    return PRODUCTION_HOSTS.has(u.hostname) && u.pathname.replace(/\/$/, "") === READY_PATH;
  } catch {
    return false;
  }
}

/** `/api/ready` (a `select 1` through the pooler) watched every 30 s and paging the on-call person. */
export async function checkBetterStackReady(signal?: AbortSignal): Promise<CheckResult> {
  const monitors = await list("/api/v2/monitors", Monitor, signal);
  const monitor = monitors.find((m) => isReady(m.attributes.url))?.attributes;
  if (!monitor) {
    return verdict("betterstack-ready", ["no hay monitor de https://reranker.co/api/ready"], "");
  }
  const problems: string[] = [];
  if (monitor.paused) problems.push("el monitor está en pausa");
  const every = monitor.effective_check_frequency ?? monitor.check_frequency;
  if (every > CHECK_SECONDS) {
    const why = monitor.effective_check_frequency_reason;
    problems.push(`revisa cada ${every} s (pide ${CHECK_SECONDS} s)${why ? ` por ${why}` : ""}`);
  }
  if (!pages(monitor)) problems.push("el monitor no llama ni avisa a la guardia");
  return verdict("betterstack-ready", problems, "/api/ready cada 30 s con aviso a la guardia");
}

/** Critical alerts reach Better Stack through an incoming webhook that pages the on-call person. */
export async function checkBetterStackRouting(signal?: AbortSignal): Promise<CheckResult> {
  const webhooks = await list("/api/v2/incoming-webhooks", Webhook, signal);
  const routed = webhooks.some((w) => !w.attributes.paused && pages(w.attributes));
  return verdict(
    "betterstack-routing",
    routed ? [] : ["ningún webhook de entrada llama ni avisa a la guardia"],
    "las alertas críticas entran por un webhook que avisa a la guardia",
  );
}
