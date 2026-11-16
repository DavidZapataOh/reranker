import { z } from "@reranker/schema";
import { createPostHogRest, PostHogApiError } from "@reranker/telemetry/posthog-rest";

export { PostHogApiError };

export type RemoteFlag = { key: string; active: boolean };

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

const Flag = z.object({ key: z.string(), active: z.boolean() });

/**
 * Feature flag definitions API. Listing needs a personal API key with `feature_flag:read`, creating
 * one with `feature_flag:write`; project secret keys do not reach these endpoints.
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
  };
}

export type PostHogApi = ReturnType<typeof createPostHogApi>;
