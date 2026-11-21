import {
  type EntityKind,
  type ExtractedMention,
  PLATFORMS,
  type PlatformEntry,
  platformOfUrl,
} from "@reranker/schema/measurement";
import { normalizeName } from "./normalize";
import { assignOrdinals } from "./quote";

export { PLATFORMS, type PlatformEntry };

// Built once per registry: the module's own and each extractor config's, which is hashed with it.
const NAMES = new WeakMap<readonly PlatformEntry[], Map<string, PlatformEntry>>();

function namesOf(registry: readonly PlatformEntry[]): Map<string, PlatformEntry> {
  let byName = NAMES.get(registry);
  if (byName) return byName;
  // Domains count as names too: answers often write "rappi.com" for Rappi.
  byName = new Map(
    registry.flatMap((entry) =>
      [...entry.names, ...entry.domains].map(
        (alias) => [normalizeName(alias, entry.kind), entry] as const,
      ),
    ),
  );
  NAMES.set(registry, byName);
  return byName;
}

/** Exact alias match only: a business named "Hotel Booking Plaza" is still a business. */
export function platformFor(
  m: Pick<ExtractedMention, "nameNorm" | "citedUrls">,
  registry: readonly PlatformEntry[] = PLATFORMS,
): PlatformEntry | null {
  const byName = namesOf(registry).get(m.nameNorm);
  if (byName) return byName;
  for (const url of m.citedUrls) {
    const entry = platformOfUrl(url, registry);
    if (entry) return entry;
  }
  return null;
}

const CONCRETE_KINDS = new Set<EntityKind>(["business", "professional", "chain"]);

/** The registry overrides the model's entity kind; ranks are recounted since platforms hold none. */
export function tagPlatforms(
  mentions: ExtractedMention[],
  registry: readonly PlatformEntry[] = PLATFORMS,
): ExtractedMention[] {
  const byName = namesOf(registry);
  const tagged = mentions.map((mention) => {
    // A hotel cited through its Booking listing is still the hotel: only its name turns a
    // concrete entity into a platform.
    const entry = CONCRETE_KINDS.has(mention.entityKind)
      ? (byName.get(mention.nameNorm) ?? null)
      : platformFor(mention, registry);
    if (!entry || entry.kind === mention.entityKind) return { ...mention };
    return {
      ...mention,
      entityKind: entry.kind,
      nameNorm: normalizeName(mention.name, entry.kind),
    };
  });
  return assignOrdinals(tagged);
}
