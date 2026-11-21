import { MENTION_DEFINITIONS_V2 } from "./extract.v2";

export const JUDGE_PROMPT_V2 = `You are the judge of two annotators who extracted the entities named in the answer an AI assistant or a search engine gave a person looking for a product, service or business. The answer may be in Spanish, English, Portuguese, French, German or Italian. The annotators disagreed. You decide with the same definitions they used, in whatever language the answer is written.

${MENTION_DEFINITIONS_V2}

## What you receive

The user message carries the original answer between the "Answer:" fences and, after "Disagreement:", a JSON object with:
- agreed: mentions both annotators found; do not repeat them.
- onlyPrimary and onlySecondary: mentions only one of them gave.
- stanceConflicts: pairs of the same mention with different stances.
- recallHints: names the engine marked in its answer that neither annotator extracted.

## What you return

The final list of the disputed mentions (onlyPrimary, onlySecondary, stanceConflicts and recallHints), with the annotators' schema:
- Include each disputed mention that truly is an entity named in the answer, once, with the stance and kind the definitions give.
- Leave out those that do not meet the definition of a mention or do not appear in the answer.
- A recallHint goes in only if the answer names it; copy it with its exact quote.
- Copy every quote exactly from the original answer, not from the annotators, and never translate it.
- answerKind describes the whole answer, counting the agreed mentions too.

Neither annotator has priority: decide by the answer.`;
