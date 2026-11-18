import type { EntityKind, ExtractedMention } from "@reranker/schema/measurement";
import { normalizeName } from "./normalize";
import { assignOrdinals } from "./quote";

export interface PlatformEntry {
  slug: string;
  names: readonly string[];
  /** Registrable hosts, optionally with a path prefix ("google.com/maps"). */
  domains: readonly string[];
  kind: "platform" | "directory_or_media";
}

export const PLATFORMS: readonly PlatformEntry[] = [
  {
    slug: "booking",
    names: ["Booking", "Booking.com"],
    domains: ["booking.com"],
    kind: "platform",
  },
  {
    slug: "airbnb",
    names: ["Airbnb", "Air BnB"],
    domains: [
      "airbnb.com",
      "airbnb.com.co",
      "airbnb.mx",
      "airbnb.es",
      "airbnb.com.ar",
      "airbnb.cl",
      "airbnb.com.pe",
      "airbnb.com.ec",
      "airbnb.co.cr",
      "airbnb.com.br",
      "airbnb.pt",
      "airbnb.co.uk",
      "airbnb.ca",
    ],
    kind: "platform",
  },
  {
    slug: "doctoralia",
    names: ["Doctoralia"],
    domains: [
      "doctoralia.com",
      "doctoralia.co",
      "doctoralia.com.mx",
      "doctoralia.es",
      "doctoralia.cl",
      "doctoralia.com.br",
    ],
    kind: "platform",
  },
  {
    slug: "fincaraiz",
    names: ["Finca Raíz", "Fincaraíz"],
    domains: ["fincaraiz.com.co"],
    kind: "platform",
  },
  {
    slug: "metrocuadrado",
    names: ["Metro Cuadrado", "Metrocuadrado"],
    domains: ["metrocuadrado.com"],
    kind: "platform",
  },
  {
    slug: "ciencuadras",
    names: ["Ciencuadras", "Cien Cuadras"],
    domains: ["ciencuadras.com"],
    kind: "platform",
  },
  {
    slug: "tripadvisor",
    names: ["Tripadvisor", "Trip Advisor"],
    domains: [
      "tripadvisor.com",
      "tripadvisor.co",
      "tripadvisor.com.mx",
      "tripadvisor.es",
      "tripadvisor.cl",
      "tripadvisor.com.ar",
      "tripadvisor.com.pe",
      "tripadvisor.com.br",
      "tripadvisor.pt",
      "tripadvisor.co.uk",
      "tripadvisor.ca",
    ],
    kind: "platform",
  },
  {
    slug: "expedia",
    names: ["Expedia"],
    domains: [
      "expedia.com",
      "expedia.mx",
      "expedia.es",
      "expedia.com.ar",
      "expedia.com.br",
      "expedia.co.uk",
      "expedia.ca",
    ],
    kind: "platform",
  },
  {
    slug: "google-maps",
    names: ["Google Maps", "Google Mapas"],
    domains: ["maps.google.com", "maps.app.goo.gl", "goo.gl/maps", "google.com/maps"],
    kind: "platform",
  },
  {
    slug: "instagram",
    names: ["Instagram"],
    domains: ["instagram.com", "instagr.am"],
    kind: "platform",
  },
  {
    slug: "rappi",
    names: ["Rappi"],
    domains: [
      "rappi.com",
      "rappi.com.co",
      "rappi.com.mx",
      "rappi.cl",
      "rappi.com.ar",
      "rappi.com.pe",
      "rappi.com.ec",
      "rappi.com.uy",
      "rappi.co.cr",
      "rappi.com.br",
    ],
    kind: "directory_or_media",
  },
  {
    slug: "didi-food",
    names: ["DiDi Food"],
    domains: ["didi-food.com"],
    kind: "directory_or_media",
  },
  {
    slug: "facebook",
    names: ["Facebook"],
    domains: ["facebook.com", "fb.com", "fb.me"],
    kind: "directory_or_media",
  },
  {
    slug: "tiktok",
    names: ["TikTok", "Tik Tok"],
    domains: ["tiktok.com"],
    kind: "directory_or_media",
  },
  {
    slug: "youtube",
    names: ["YouTube"],
    domains: ["youtube.com", "youtu.be"],
    kind: "directory_or_media",
  },
  { slug: "waze", names: ["Waze"], domains: ["waze.com"], kind: "directory_or_media" },
];

interface DomainRule {
  host: string;
  path: string;
  entry: PlatformEntry;
}

interface RegistryIndex {
  byName: Map<string, PlatformEntry>;
  domainRules: readonly DomainRule[];
}

// Built once per registry: the module's own and each extractor config's, which is hashed with it.
const INDEXES = new WeakMap<readonly PlatformEntry[], RegistryIndex>();

function indexOf(registry: readonly PlatformEntry[]): RegistryIndex {
  let index = INDEXES.get(registry);
  if (index) return index;
  index = {
    // Domains count as names too: answers often write "rappi.com" for Rappi.
    byName: new Map(
      registry.flatMap((entry) =>
        [...entry.names, ...entry.domains].map((alias) => [normalizeName(alias), entry] as const),
      ),
    ),
    domainRules: registry.flatMap((entry) =>
      entry.domains.map((domain) => {
        const slash = domain.indexOf("/");
        return slash === -1
          ? { host: domain, path: "", entry }
          : { host: domain.slice(0, slash), path: domain.slice(slash), entry };
      }),
    ),
  };
  INDEXES.set(registry, index);
  return index;
}

// Label-wise suffix, so "notbooking.com" is not "booking.com".
function onHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function platformOfUrl(raw: string, rules: readonly DomainRule[]): PlatformEntry | null {
  const url = URL.parse(raw);
  if (!url) return null;
  const host = url.hostname.replace(/\.$/, "");
  for (const rule of rules) {
    if (!onHost(host, rule.host)) continue;
    if (rule.path && url.pathname !== rule.path && !url.pathname.startsWith(`${rule.path}/`)) {
      continue;
    }
    return rule.entry;
  }
  return null;
}

/** Exact alias match only: a business named "Hotel Booking Plaza" is still a business. */
export function platformFor(
  m: Pick<ExtractedMention, "nameNorm" | "citedUrls">,
  registry: readonly PlatformEntry[] = PLATFORMS,
): PlatformEntry | null {
  const index = indexOf(registry);
  const byName = index.byName.get(m.nameNorm);
  if (byName) return byName;
  for (const url of m.citedUrls) {
    const entry = platformOfUrl(url, index.domainRules);
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
  const { byName } = indexOf(registry);
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
