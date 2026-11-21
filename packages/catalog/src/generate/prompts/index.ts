import type { MeasurementLanguage, RegisterProfile } from "@reranker/schema/measurement";
import { MeasurementLanguageError } from "../../language";
import type { GuardLanguage } from "../guards";
import {
  JUDGE_PROMPT_V2,
  JUDGE_PROMPT_V2_DE,
  JUDGE_PROMPT_V2_EN,
  JUDGE_PROMPT_V2_FR,
  JUDGE_PROMPT_V2_IT,
  JUDGE_PROMPT_V2_PT,
} from "./judge.v2";
import {
  PARAPHRASE_PROMPT_V1,
  PARAPHRASE_PROMPT_V1_DE,
  PARAPHRASE_PROMPT_V1_EN,
  PARAPHRASE_PROMPT_V1_FR,
  PARAPHRASE_PROMPT_V1_IT,
  PARAPHRASE_PROMPT_V1_PT,
} from "./paraphrase.v1";
import {
  PERSONA_PROMPT_V1,
  PERSONA_PROMPT_V1_DE,
  PERSONA_PROMPT_V1_EN,
  PERSONA_PROMPT_V1_FR,
  PERSONA_PROMPT_V1_IT,
  PERSONA_PROMPT_V1_PT,
} from "./persona.v1";

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
    judge: JUDGE_PROMPT_V2,
    variety: {
      co: "español de Colombia",
      neutral: "español neutro, natural en cualquier país hispanohablante",
    },
    address: { tu: "tú", usted: "usted" },
  },
  en: {
    paraphrase: PARAPHRASE_PROMPT_V1_EN,
    persona: PERSONA_PROMPT_V1_EN,
    judge: JUDGE_PROMPT_V2_EN,
    variety: {
      co: "natural English, as visitors and residents of Colombia write it",
      neutral: "natural English, as people in any English-speaking country write it",
    },
  },
  // Brazilian Portuguese, the variety the templates come from. "Você" is how people address an
  // assistant; "o senhor" is the formal register.
  pt: {
    paraphrase: PARAPHRASE_PROMPT_V1_PT,
    persona: PERSONA_PROMPT_V1_PT,
    judge: JUDGE_PROMPT_V2_PT,
    variety: {
      co: "português do Brasil, como escrevem brasileiros que visitam a Colômbia ou moram lá",
      neutral: "português do Brasil, natural para qualquer brasileiro",
    },
    address: { tu: "você", usted: "o senhor ou a senhora" },
  },
  // French as written in France, where the templates come from; people "tutoient" an assistant.
  fr: {
    paraphrase: PARAPHRASE_PROMPT_V1_FR,
    persona: PERSONA_PROMPT_V1_FR,
    judge: JUDGE_PROMPT_V2_FR,
    variety: {
      co: "français courant, tel que l'écrivent les francophones qui visitent la Colombie ou y vivent",
      neutral: "français courant de France, naturel pour n'importe quel francophone",
    },
    address: { tu: "tu", usted: "vous" },
  },
  // German as written in Germany, where the templates come from; people say "du" to an assistant.
  de: {
    paraphrase: PARAPHRASE_PROMPT_V1_DE,
    persona: PERSONA_PROMPT_V1_DE,
    judge: JUDGE_PROMPT_V2_DE,
    variety: {
      co: "Alltagsdeutsch, wie es Deutschsprachige schreiben, die Kolumbien besuchen oder dort leben",
      neutral: "Alltagsdeutsch aus Deutschland, natürlich für alle Deutschsprachigen",
    },
    address: { tu: "du", usted: "Sie" },
  },
  // Standard Italian, the templates' register: people use "tu" with an assistant, "Lei" is formal.
  it: {
    paraphrase: PARAPHRASE_PROMPT_V1_IT,
    persona: PERSONA_PROMPT_V1_IT,
    judge: JUDGE_PROMPT_V2_IT,
    variety: {
      co: "italiano corrente, come lo scrivono gli italiani che visitano la Colombia o ci vivono",
      neutral: "italiano corrente, naturale per qualsiasi italiano",
    },
    address: { tu: "tu", usted: "Lei" },
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
