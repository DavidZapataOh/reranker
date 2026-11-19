import type { ProviderCost } from "../cost";
import { z } from "../z";
import type { BusinessCategory, GeoTarget } from "./catalog";

export const Stance = z.enum(["recommendation", "incidental", "negative"]);
export type Stance = z.infer<typeof Stance>;

export const EntityKind = z.enum([
  "business",
  "professional",
  "chain",
  "platform",
  "directory_or_media",
  "other",
]);
export type EntityKind = z.infer<typeof EntityKind>;

export const Sentiment = z.enum(["positive", "neutral", "negative"]);
export type Sentiment = z.infer<typeof Sentiment>;

export const AnswerKind = z.enum(["names_entities", "no_entities", "refusal", "capture_failed"]);
export type AnswerKind = z.infer<typeof AnswerKind>;

export const Agreement = z.enum(["agreed", "adjudicated", "single"]);
export type Agreement = z.infer<typeof Agreement>;

export type EntityKey =
  | `place:${string}`
  | `chain:${string}`
  | `name:${string}`
  | `platform:${string}`
  | `web:${string}`;

export const ResolutionStatus = z.enum([
  "resolved",
  "chain",
  "unresolvable",
  "not_attempted",
  "platform",
]);
export type ResolutionStatus = z.infer<typeof ResolutionStatus>;

export const ResolutionMethod = z.enum(["cache", "rules", "judge", "none"]);
export type ResolutionMethod = z.infer<typeof ResolutionMethod>;

export interface ExtractedMention {
  /** Surface form as written in the response. */
  name: string;
  nameNorm: string;
  /** Exact substring of the response. */
  quote: string;
  /** UTF-16 offsets into the captured answer's markdown. */
  startOffset: number;
  endOffset: number;
  /** 1-based among recommended commercial entities; null when not recommended. */
  ordinal: number | null;
  stance: Stance;
  entityKind: EntityKind;
  sentiment: Sentiment;
  locationHint: string | null;
  citedUrls: string[];
}

export interface ResolvedMention extends ExtractedMention {
  entityKey: EntityKey;
  placeId: string | null;
  resolution: {
    status: ResolutionStatus;
    method: ResolutionMethod;
    score: number | null;
  };
  isTarget: boolean;
}

export interface ResponseExtraction {
  captureId: string;
  configHash: string;
  answerKind: AnswerKind;
  agreement: Agreement;
  mentions: ResolvedMention[];
  /** Model ids as the provider APIs report them. */
  models: { primary: string; secondary: string | null; judge: string | null };
  cost: ProviderCost;
  latencyMs: number;
}

/** The business a report is about: its place, or its domain when it has no Places listing. */
export interface TargetBusiness {
  placeId: string | null;
  domain: string | null;
  inputName: string;
  geo: GeoTarget;
  category: BusinessCategory;
  aliases: string[];
}

/** A business the owner may mean, found by name in Places or by the domain they typed. */
export interface BusinessCandidate {
  kind: "place" | "website";
  placeId: string | null;
  domain: string | null;
  displayName: string;
  formattedAddress: string | null;
  /** Null only for a website without a country signal: the owner is asked for the country. */
  geo: GeoTarget | null;
  neighborhood: string | null;
  categoryHint: BusinessCategory | null;
  confidence: number;
  attribution: "Google Maps" | null;
  /** In memory only, for category inference; Places content is never stored. */
  places?: {
    types: string[];
    primaryType: string | null;
    primaryTypeDisplayName: string | null;
    googleMapsTypeLabel: string | null;
    pureServiceAreaBusiness: boolean;
  };
  website?: { title: string | null; siteName: string | null; description: string | null };
}
