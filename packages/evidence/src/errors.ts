// The names are error types of the platform's error catalog, so a sealing failure reads the same
// in logs, alerts and step retries.

/** The statement does not fit in one KMS RAW message; retrying cannot help, so sealing fails closed. */
export class StatementTooLargeError extends Error {
  override readonly name = "StatementTooLarge";
  readonly paeBytes: number;

  constructor(paeBytes: number, maxBytes: number) {
    super(`DSSE PAE is ${paeBytes} bytes, over the ${maxBytes}-byte signing limit`);
    this.paeBytes = paeBytes;
  }
}

/** The signing key is not the pinned one or cannot sign; a verifier would reject what it signs. */
export class SigningKeyMismatchError extends Error {
  override readonly name = "SigningKeyMismatch";
  readonly keyid: string;

  constructor(keyid: string, reason: string, options?: ErrorOptions) {
    super(`Signing key ${keyid || "(none)"}: ${reason}`, options);
    this.keyid = keyid;
  }
}

/** KMS is throttling, failing or unreachable; the same call succeeds later. */
export class SigningUnavailableError extends Error {
  override readonly name = "SigningUnavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** R2 answered 5xx or 429, timed out or was unreachable; the same call succeeds later. */
export class EvidenceStorageUnavailableError extends Error {
  override readonly name = "EvidenceStorageUnavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Fewer timestamping services answered than a proof needs; the next hourly run tries again. */
export class TimestampUnavailableError extends Error {
  override readonly name = "TimestampUnavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
