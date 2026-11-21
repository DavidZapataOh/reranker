import { jcs, sha256Hex } from "@reranker/catalog";
import { InvalidInputError } from "@reranker/jobs/errors";
import { openaiControlEnv } from "./env";

type ProfileId = "control-chatgpt@1";

/** Every parameter that shapes a control answer; changing one is a new profile and a new regime. */
export interface ControlProfile {
  id: ProfileId;
  model: string;
  tool: "web_search_2025_08_26";
  searchContextSize: "medium";
  toolChoice: "required";
  include: ["web_search_call.action.sources"];
  store: false;
  maxOutputTokens: 1200;
  // A reasoning model rejects temperature, so the effort is what gets frozen instead.
  reasoningEffort: "low" | null;
  hash: string;
}

/** sha256 of the profile's JCS without its hash; a change here must come with a new profile id. */
export const PINNED_PROFILE_HASHES: Readonly<Record<ProfileId, string>> = {
  "control-chatgpt@1": "05e5736a8266f7dfb758bf00907d43f1308bbb761bb4d9232a0178000293818f",
};

// Read straight from the variable rather than through defineEnv, which needs APP_ENV: the
// profile is built when the module loads, in every environment.
function configuredModel(): string {
  return openaiControlEnv.shape.OPENAI_CONTROL_MODEL.parse(
    process.env.OPENAI_CONTROL_MODEL || undefined,
  );
}

function profileFor(model: string): ControlProfile {
  const profile: Omit<ControlProfile, "hash"> = {
    id: "control-chatgpt@1",
    model,
    tool: "web_search_2025_08_26",
    searchContextSize: "medium",
    toolChoice: "required",
    include: ["web_search_call.action.sources"],
    store: false,
    maxOutputTokens: 1200,
    reasoningEffort: "low",
  };
  return { ...profile, hash: sha256Hex(jcs(profile)) };
}

export const CONTROL_PROFILE: ControlProfile = profileFor(configuredModel());

const nextProfileId = (id: string) => id.replace(/@(\d+)$/, (_, n: string) => `@${Number(n) + 1}`);

/**
 * Refuses a profile whose parameters drifted from the pinned hash, so a model swap can never
 * enter an existing series in silence. It fails the control call rather than the import, so
 * a wrong control model never stops the other providers that share this package.
 */
export function assertPinnedProfile(): void {
  for (const profile of [CONTROL_PROFILE, profileFor(configuredModel())]) {
    if (profile.hash !== PINNED_PROFILE_HASHES[profile.id]) {
      throw new InvalidInputError(
        `OpenAI control profile ${profile.id} no longer matches its pinned hash (model ${profile.model}): ship the change as ${nextProfileId(profile.id)}`,
      );
    }
  }
}
