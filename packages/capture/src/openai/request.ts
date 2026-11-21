import { getGeo, spokenPlaceName } from "@reranker/catalog";
import { getCountry } from "@reranker/i18n/countries";
import { InvalidInputError } from "@reranker/jobs/errors";
import type {
  ResponseCreateParamsNonStreaming,
  WebSearchTool,
} from "openai/resources/responses/responses";
import type { FrozenSlot } from "../slot";
import { assertPinnedProfile, CONTROL_PROFILE } from "./profile";

// Without a declared location OpenAI searches as if the user were in the United States. The
// slot's frozen location decides how precise it is, so the report never declares less than
// what was sent; a national question names only the country.
function userLocation(slot: FrozenSlot): WebSearchTool.UserLocation {
  const geo = getGeo(slot.geoKey);
  const level = slot.geoDeclared.level;
  const location: WebSearchTool.UserLocation = { type: "approximate", country: geo.country };
  if (level === "city") location.city = spokenPlaceName(geo.name);
  const region = level === "country" ? null : geo.level === "region" ? geo.name : geo.regionName;
  if (region) location.region = region;
  location.timezone = getCountry(geo.country).timeZone;
  return location;
}

/** The Responses API call for one control slot, with every parameter the profile freezes. */
export function buildControlRequest(slot: FrozenSlot): ResponseCreateParamsNonStreaming {
  if (slot.provider !== "openai" || slot.engine !== "chatgpt") {
    throw new InvalidInputError(`Slot ${slot.slotId} is not a ChatGPT control slot`);
  }
  assertPinnedProfile();
  const p = CONTROL_PROFILE;
  return {
    model: p.model,
    input: slot.promptText,
    store: p.store,
    max_output_tokens: p.maxOutputTokens,
    tool_choice: p.toolChoice,
    include: [...p.include],
    ...(p.reasoningEffort ? { reasoning: { effort: p.reasoningEffort } } : {}),
    tools: [
      {
        type: p.tool,
        search_context_size: p.searchContextSize,
        user_location: userLocation(slot),
      },
    ],
  };
}
