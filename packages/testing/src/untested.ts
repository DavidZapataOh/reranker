export function classify(score: number): string {
  if (score > 0.9) {
    return "strong";
  }
  if (score > 0.5) {
    return "medium";
  }
  if (score > 0.1) {
    return "weak";
  }
  return "none";
}
