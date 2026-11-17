import { z } from "@reranker/schema";
import { createPostHogRest, PostHogApiError } from "@reranker/telemetry/posthog-rest";

export { PostHogApiError };

const Property = z
  .object({ key: z.string(), operator: z.string().nullish(), value: z.unknown() })
  .loose();

const Flag = z.object({
  id: z.number(),
  key: z.string(),
  active: z.boolean(),
  filters: z
    .object({
      groups: z
        .array(
          z
            .object({
              properties: z.array(Property).nullish(),
              rollout_percentage: z.number().nullish(),
            })
            .loose(),
        )
        .nullish(),
    })
    .loose()
    .nullish(),
});

export type RemoteFlag = z.output<typeof Flag>;

export type CreateFlagPayload = {
  key: string;
  name: string;
  active: boolean;
  filters: {
    groups: {
      properties: { key: string; type: "person"; operator: "exact"; value: string[] }[];
      rollout_percentage: number;
    }[];
  };
  tags: string[];
};

/**
 * Feature flag definitions API. Listing needs a personal API key with `feature_flag:read`, creating
 * and enabling with `feature_flag:write`; project secret keys do not reach these endpoints.
 */
export function createPostHogApi(apiKey: string) {
  const rest = createPostHogRest(apiKey);

  return {
    listFlags(): Promise<RemoteFlag[]> {
      return rest.list("feature_flags/", Flag);
    },
    async createFlag(payload: CreateFlagPayload): Promise<void> {
      await rest.send("feature_flags/", "POST", payload);
    },
    // https://posthog.com/docs/api/feature-flags (partial update)
    async setActive(id: number, active: boolean): Promise<void> {
      await rest.send(`feature_flags/${id}/`, "PATCH", { active });
    },
  };
}

export type PostHogApi = ReturnType<typeof createPostHogApi>;
