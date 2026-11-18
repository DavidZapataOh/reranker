const COMBINING_MARKS = /\p{M}+/gu;
const CAPITAL_DISTRICT = /\bd\.\s*c\b\.?/g;
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/**
 * Comparable form of a place name: the same city must match whether it comes from Places
 * ("Bogotá"), DataForSEO ("Bogota,Bogota,Colombia" split by the caller) or DIVIPOLA
 * ("BOGOTÁ, D.C.").
 */
export function normalizePlaceName(name: string): string {
  return name
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(CAPITAL_DISTRICT, " ")
    .replace(SEPARATORS, " ")
    .trim();
}
