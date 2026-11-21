// Gemini's grounding redirects, and the ones AI Overviews put in front of their references.
export const GOOGLE_REDIRECTS: readonly string[] = [
  "https://vertexaisearch.cloud.google.com/grounding-api-redirect/",
  "https://google.com/goto?",
  "https://www.google.com/goto?",
];

/** A Google redirect names no site of its own: a source behind one is attributable only once resolved. */
export const isGoogleRedirect = (url: string): boolean =>
  GOOGLE_REDIRECTS.some((prefix) => url.startsWith(prefix));
