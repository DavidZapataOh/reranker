/**
 * Why a digest source has no data, in words safe for the email: a missing variable, an HTTP
 * status or a provider code, never the provider's own text.
 */
export class SourceError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SourceError";
  }
}

export function httpError(response: Response): SourceError {
  return new SourceError(`respuesta HTTP ${response.status}`);
}
