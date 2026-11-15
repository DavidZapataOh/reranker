import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import type { FlagKey } from "../src/flag-keys.gen";

export const HOST = "https://us.i.posthog.com";
export const LOCAL_EVAL = `${HOST}/flags/definitions`;

type Condition = {
  properties: { key: string; type: "person"; operator: "exact"; value: string[] }[];
  rollout_percentage: number;
};

type Definition = {
  id: number;
  name: string;
  key: string;
  active: boolean;
  deleted: false;
  rollout_percentage: null;
  ensure_experience_continuity: false;
  experiment_set: number[];
  filters: {
    groups: Condition[];
    multivariate?: { variants: { key: string; rollout_percentage: number }[] };
  };
};

export type Definitions = { flags: Definition[]; group_type_mapping: object; cohorts: object };

function definition(key: string, active: boolean, groups: Condition[], id: number): Definition {
  return {
    id,
    name: key,
    key,
    active,
    deleted: false,
    rollout_percentage: null,
    ensure_experience_continuity: false,
    experiment_set: [],
    filters: { groups },
  };
}

const EVERYONE: Condition = { properties: [], rollout_percentage: 100 };

/** A flag per key, active (on for everyone) or inactive (off), as PostHog serves them. */
export function definitions(state: Partial<Record<FlagKey, boolean>>): Definitions {
  return {
    flags: Object.entries(state).map(([key, active], i) =>
      definition(key, active === true, [EVERYONE], i + 1),
    ),
    group_type_mapping: {},
    cohorts: {},
  };
}

/** Turns the listed keys off while keeping every other definition as it is. */
export function withOff(base: Definitions, off: readonly FlagKey[]): Definitions {
  return {
    ...base,
    flags: base.flags.map((f) => (off.includes(f.key as FlagKey) ? { ...f, active: false } : f)),
  };
}

/** The definition a paid-provider flag gets: on only where the evaluating env is production. */
export function productionOnly(key: FlagKey, active: boolean): Definitions {
  const condition: Condition = {
    properties: [{ key: "env", type: "person", operator: "exact", value: ["production"] }],
    rollout_percentage: 100,
  };
  return { flags: [definition(key, active, [condition], 1)], group_type_mapping: {}, cohorts: {} };
}

/** A multivariate flag that always resolves to `variant`. */
export function variant(key: FlagKey, value: string): Definitions {
  const flag = definition(key, true, [EVERYONE], 1);
  flag.filters.multivariate = { variants: [{ key: value, rollout_percentage: 100 }] };
  return { flags: [flag], group_type_mapping: {}, cohorts: {} };
}

export function serveDefinitions(body: Definitions): void {
  server.use(http.get(LOCAL_EVAL, () => HttpResponse.json(body, { headers: { ETag: '"v1"' } })));
}

export function rejectDefinitions(status: 401 | 402): void {
  server.use(
    http.get(LOCAL_EVAL, () =>
      status === 402
        ? HttpResponse.json({ type: "quota_limited", detail: "Quota exceeded" }, { status })
        : new HttpResponse(null, { status }),
    ),
  );
}
