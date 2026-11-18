import type { EntityKind, ExtractedMention } from "@reranker/schema/measurement";
import { normalizeName } from "./normalize";
import type { MentionsOutput } from "./schema";

const MARKS = /\p{M}/gu;
const WHITESPACE = /\s/u;
const WORD_START = /^[\p{L}\p{N}]/u;
const WORD_END = /[\p{L}\p{N}]$/u;
const DOUBLE_QUOTES = new Set(["“", "”", "„", "«", "»"]);
const SINGLE_QUOTES = new Set(["‘", "’", "‚"]);
// Models quote the words and drop markdown emphasis, so it must not break a match.
const EMPHASIS = new Set(["*", "_", "`"]);
const RANKED_KINDS = new Set<EntityKind>(["business", "professional", "chain"]);

/** Text folded for matching, with the original UTF-16 span behind each of its code units. */
interface Comparable {
  text: string;
  starts: number[];
  ends: number[];
}

function fold(char: string): string {
  if (WHITESPACE.test(char)) return " ";
  if (EMPHASIS.has(char)) return "";
  if (DOUBLE_QUOTES.has(char)) return '"';
  if (SINGLE_QUOTES.has(char)) return "'";
  // Marks are stripped again after lowercasing: "İ" lowercases to "i" plus a combining dot.
  return char.normalize("NFD").replace(MARKS, "").toLowerCase().replace(MARKS, "");
}

function comparable(source: string): Comparable {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let last = " ";
  let offset = 0;
  for (const char of source) {
    const end = offset + char.length;
    const folded = fold(char);
    for (let unit = 0; unit < folded.length; unit++) {
      const piece = folded[unit] as string;
      if (piece === " " && last === " ") continue;
      parts.push(piece);
      starts.push(offset);
      ends.push(end);
      last = piece;
    }
    offset = end;
  }
  return { text: parts.join(""), starts, ends };
}

/** First whole-word occurrence of the quote after folding, as UTF-16 offsets into `markdown`. */
export function locateQuote(
  markdown: string,
  quote: string,
): { start: number; end: number } | null {
  const needle = comparable(quote).text.trim();
  if (needle === "") return null;
  const haystack = comparable(markdown);
  const checkStart = WORD_START.test(needle);
  const checkEnd = WORD_END.test(needle);

  for (
    let at = haystack.text.indexOf(needle);
    at !== -1;
    at = haystack.text.indexOf(needle, at + 1)
  ) {
    const after = at + needle.length;
    if (checkStart && WORD_END.test(haystack.text.slice(Math.max(0, at - 2), at))) continue;
    if (checkEnd && WORD_START.test(haystack.text.slice(after, after + 2))) continue;
    return { start: haystack.starts[at] as number, end: haystack.ends[after - 1] as number };
  }
  return null;
}

/** Keeps the mentions whose quote is in the answer, in answer order, with their rank. */
export function toExtractedMentions(
  markdown: string,
  out: MentionsOutput,
): { mentions: ExtractedMention[]; quoteMisses: number } {
  const mentions: ExtractedMention[] = [];
  for (const mention of out.mentions) {
    const at = locateQuote(markdown, mention.quote);
    if (!at) continue;
    mentions.push({
      name: mention.name,
      nameNorm: normalizeName(mention.name, mention.entityKind),
      quote: markdown.slice(at.start, at.end),
      startOffset: at.start,
      endOffset: at.end,
      ordinal: null,
      stance: mention.stance,
      entityKind: mention.entityKind,
      sentiment: mention.sentiment,
      locationHint: mention.locationHint,
      citedUrls: mention.citedUrls,
    });
  }
  mentions.sort((a, b) => a.startOffset - b.startOffset);

  let ordinal = 0;
  for (const mention of mentions) {
    if (mention.stance === "recommendation" && RANKED_KINDS.has(mention.entityKind)) {
      mention.ordinal = ++ordinal;
    }
  }
  return { mentions, quoteMisses: out.mentions.length - mentions.length };
}
