/**
 * The exact bytes of the last call made through a recording fetch. Evidence is sealed from these
 * bytes, never from a re-serialized response.
 */
export class RawSink {
  #url: string | null = null;
  #request: Uint8Array | null = null;
  #response: Uint8Array | null = null;
  #status: number | null = null;
  #contentType: string | null = null;
  #headers: Headers | null = null;
  #calls = 0;

  get url(): string | null {
    return this.#url;
  }

  get request(): Uint8Array | null {
    return this.#request;
  }

  get response(): Uint8Array | null {
    return this.#response;
  }

  get status(): number | null {
    return this.#status;
  }

  get contentType(): string | null {
    return this.#contentType;
  }

  get headers(): Headers | null {
    return this.#headers;
  }

  get calls(): number {
    return this.#calls;
  }

  /** Starts a call: whatever an earlier call left behind must never pass for this one's response. */
  recordRequest(url: string, body: Uint8Array | null): void {
    this.#calls += 1;
    this.#url = url;
    this.#request = body;
    this.#response = null;
    this.#status = null;
    this.#contentType = null;
    this.#headers = null;
  }

  // Status and headers land before the body, so a body cut by the timeout still leaves them.
  recordResponseHead(response: Response): void {
    this.#status = response.status;
    this.#headers = new Headers(response.headers);
    this.#contentType = response.headers.get("content-type");
  }

  recordResponseBody(body: Uint8Array): void {
    this.#response = body;
  }
}
