import type { ProviderCost } from "../cost";

export type Stance = "recommendation" | "incidental" | "negative";
export type EntityKind =
  | "business"
  | "professional"
  | "chain"
  | "platform"
  | "directory_or_media"
  | "other";
export type Sentiment = "positive" | "neutral" | "negative";
export type AnswerKind = "names_entities" | "no_entities" | "refusal" | "capture_failed";
export type EntityKey =
  | `place:${string}`
  | `chain:${string}`
  | `name:${string}`
  | `platform:${string}`
  | `web:${string}`;
export type ResolutionStatus = "resolved" | "chain" | "unresolvable" | "not_attempted" | "platform";

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
    method: "cache" | "rules" | "judge" | "none";
    score: number | null;
  };
  isTarget: boolean;
}

export interface ResponseExtraction {
  captureId: string;
  configHash: string;
  answerKind: AnswerKind;
  agreement: "agreed" | "adjudicated" | "single";
  mentions: ResolvedMention[];
  /** Model ids as the provider APIs report them. */
  models: { primary: string; secondary: string | null; judge: string | null };
  cost: ProviderCost;
  latencyMs: number;
}
