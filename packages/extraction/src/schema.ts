import { z } from "@reranker/schema";
import { CategoryArchetype } from "@reranker/schema/measurement";

// Strict objects and nullable unions instead of optional keys: OpenAI strict mode, Gemini
// response_format and Anthropic structured outputs all require every property to be listed.
const Mention = z.strictObject({
  name: z.string(),
  quote: z.string(),
  stance: z.enum(["recommendation", "incidental", "negative"]),
  entityKind: z.enum([
    "business",
    "professional",
    "chain",
    "platform",
    "directory_or_media",
    "other",
  ]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  locationHint: z.string().nullable(),
});

// 'capture_failed' is never the model's call: it comes from the capture status.
export const MentionsSchema = z.strictObject({
  answerKind: z.enum(["names_entities", "no_entities", "refusal"]),
  mentions: z.array(Mention),
});
export type MentionsOutput = z.infer<typeof MentionsSchema>;

/** The judge returns the final list for the disputed set, in the extractors' own shape. */
export const JudgeSchema: typeof MentionsSchema = MentionsSchema;

export const ResolveJudgeSchema = z.strictObject({
  choice: z.enum(["candidate_1", "candidate_2", "candidate_3", "unresolvable"]),
});
export type ResolveJudgeOutput = z.infer<typeof ResolveJudgeSchema>;

export const ClassifierSchema = z.strictObject({
  categoryKey: z.string(),
  label: z.string(),
  noun: z.string(),
  archetype: CategoryArchetype,
  // Only the languages whose question templates agree with the noun need it.
  nounGender: z.enum(["m", "f", "n"]).nullable(),
  scope: z.enum(["local", "national"]),
  confidence: z.number().min(0).max(1),
});
export type ClassifierOutput = z.infer<typeof ClassifierSchema>;
