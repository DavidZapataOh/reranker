import type { ExtractedMention } from "@reranker/schema/measurement";
import type { ExtractorConfig } from "./config";
import { jaroWinkler, tokenContainment } from "./normalize";
import { assignOrdinals, toExtractedMentions } from "./quote";
import type { MentionsOutput } from "./schema";

export interface MergeInput {
  markdown: string;
  primary: ExtractedMention[];
  /** null runs single mode: the secondary extractor is off or failed. */
  secondary: ExtractedMention[] | null;
  /** Names the engine itself listed (brandEntities, localBusinesses) that neither extractor found. */
  recallHints: string[];
  config: ExtractorConfig;
  /** The caller wraps the paid call; any throw falls back to the primary list. */
  judge: (disputed: DisputeSet) => Promise<MentionsOutput>;
}

export interface DisputeSet {
  agreed: ExtractedMention[];
  onlyPrimary: ExtractedMention[];
  onlySecondary: ExtractedMention[];
  stanceConflicts: Array<[ExtractedMention, ExtractedMention]>;
  recallHints: string[];
}

export interface MergeResult {
  mentions: ExtractedMention[];
  agreement: "agreed" | "adjudicated" | "single";
  judgeUsed: boolean;
  disputedCount: number;
  judgeOutput: MentionsOutput | null;
}

function overlaps(a: ExtractedMention, b: ExtractedMention): boolean {
  return a.startOffset < b.endOffset && b.startOffset < a.endOffset;
}

function sameName(a: ExtractedMention, b: ExtractedMention, nameJw: number): boolean {
  return jaroWinkler(a.nameNorm, b.nameNorm) >= nameJw || tokenContainment(a.nameNorm, b.nameNorm);
}

/**
 * Greedy one-to-one pairing. A name alone cannot pair: the same entity can appear twice in one
 * answer, so the spans must overlap too. A same-stance partner is preferred over a conflicting one.
 */
export function pairMentions(
  a: ExtractedMention[],
  b: ExtractedMention[],
  nameJw: number,
): DisputeSet {
  const set: DisputeSet = {
    agreed: [],
    onlyPrimary: [],
    onlySecondary: [],
    stanceConflicts: [],
    recallHints: [],
  };
  const taken = new Array<boolean>(b.length).fill(false);
  for (const mention of a) {
    let partner = -1;
    for (let i = 0; i < b.length; i++) {
      const other = b[i] as ExtractedMention;
      if (taken[i] || !overlaps(mention, other) || !sameName(mention, other, nameJw)) continue;
      if (other.stance === mention.stance) {
        partner = i;
        break;
      }
      if (partner === -1) partner = i;
    }
    if (partner === -1) {
      set.onlyPrimary.push(mention);
      continue;
    }
    taken[partner] = true;
    const other = b[partner] as ExtractedMention;
    if (other.stance === mention.stance) set.agreed.push(mention);
    else set.stanceConflicts.push([mention, other]);
  }
  b.forEach((other, i) => {
    if (!taken[i]) set.onlySecondary.push(other);
  });
  return set;
}

/** Answer order, one mention per start offset (the store's key), ordinals recounted on copies. */
function finalize(mentions: ExtractedMention[]): ExtractedMention[] {
  const byStart = new Map<number, ExtractedMention>();
  for (const mention of mentions) {
    if (!byStart.has(mention.startOffset)) byStart.set(mention.startOffset, { ...mention });
  }
  return assignOrdinals([...byStart.values()].sort((x, y) => x.startOffset - y.startOffset));
}

function single(primary: ExtractedMention[], disputedCount: number): MergeResult {
  return {
    mentions: finalize(primary),
    agreement: "single",
    judgeUsed: false,
    disputedCount,
    judgeOutput: null,
  };
}

/** Merges both extractors; the judge runs at most once per answer and only on disagreement. */
export async function mergeExtractions(input: MergeInput): Promise<MergeResult> {
  if (input.secondary === null) return single(input.primary, 0);

  const disputed = pairMentions(input.primary, input.secondary, input.config.merge.nameJw);
  disputed.recallHints = input.recallHints;
  const disputedCount =
    disputed.onlyPrimary.length +
    disputed.onlySecondary.length +
    disputed.stanceConflicts.length +
    disputed.recallHints.length;
  if (disputedCount === 0) {
    return {
      mentions: finalize(disputed.agreed),
      agreement: "agreed",
      judgeUsed: false,
      disputedCount: 0,
      judgeOutput: null,
    };
  }

  let judgeOutput: MentionsOutput;
  try {
    judgeOutput = await input.judge(disputed);
  } catch {
    // A judge outage, refusal or timeout must not lose the answer: the primary list stands.
    return single(input.primary, disputedCount);
  }
  // Judge quotes are checked against the answer like any extractor's.
  const { mentions: verdict } = toExtractedMentions(input.markdown, judgeOutput);
  return {
    mentions: finalize([...disputed.agreed, ...verdict]),
    agreement: "adjudicated",
    judgeUsed: true,
    disputedCount,
    judgeOutput,
  };
}
