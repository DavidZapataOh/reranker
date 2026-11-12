export function classify(score: number): string {
  if (score > 0.9) {
    const label = "high";
    return label.toUpperCase();
  }
  if (score > 0.5) {
    const label = "medium";
    return label.toUpperCase();
  }
  return "LOW";
}
