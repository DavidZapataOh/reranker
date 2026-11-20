import type { MeasurementLanguage, RegisterProfile } from "@reranker/schema/measurement";
import { MeasurementLanguageError } from "../../language";
import type { GuardLanguage } from "../guards";
import { JUDGE_PROMPT_V1, JUDGE_PROMPT_V1_EN } from "./judge.v1";
import { PARAPHRASE_PROMPT_V1, PARAPHRASE_PROMPT_V1_EN } from "./paraphrase.v1";
import { PERSONA_PROMPT_V1, PERSONA_PROMPT_V1_EN } from "./persona.v1";

export interface LanguagePrompts {
  paraphrase: string;
  persona: string;
  judge: string;
  /** How the speech of each register profile is described to the model, in the prompt's language. */
  variety: Readonly<Record<RegisterProfile, string>>;
  /** How the category's form of address is named, for languages that have one. */
  address?: Readonly<Record<"tu" | "usted", string>>;
}

// Each language's prompts are written in it, so the models write paraphrases natively instead of
// translating. Keyed by guard language: a language cannot generate before its guards exist.
const PROMPTS = {
  es: {
    paraphrase: PARAPHRASE_PROMPT_V1,
    persona: PERSONA_PROMPT_V1,
    judge: JUDGE_PROMPT_V1,
    variety: {
      co: "español de Colombia",
      neutral: "español neutro, natural en cualquier país hispanohablante",
    },
    address: { tu: "tú", usted: "usted" },
  },
  en: {
    paraphrase: PARAPHRASE_PROMPT_V1_EN,
    persona: PERSONA_PROMPT_V1_EN,
    judge: JUDGE_PROMPT_V1_EN,
    variety: {
      co: "natural English, as visitors and residents of Colombia write it",
      neutral: "natural English, as people in any English-speaking country write it",
    },
  },
} as const satisfies Partial<Record<GuardLanguage, LanguagePrompts>>;

/** The measurement languages with reviewed generation prompts. */
export type GenerationLanguage = keyof typeof PROMPTS;

export const GENERATION_LANGUAGES = Object.keys(PROMPTS) as GenerationLanguage[];

export function isGenerationLanguage(
  language: MeasurementLanguage,
): language is GenerationLanguage {
  return Object.hasOwn(PROMPTS, language);
}

/** A language without reviewed prompts is refused, never written in another language's prompts. */
export function promptsFor(language: MeasurementLanguage): LanguagePrompts {
  if (!isGenerationLanguage(language)) {
    throw new MeasurementLanguageError(language, "no_prompts", `no ${language} generation prompts`);
  }
  return PROMPTS[language];
}
