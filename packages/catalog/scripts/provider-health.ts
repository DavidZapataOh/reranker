// A paid seed run stops at once when a provider stops answering, rather than writing a pool or a
// review that silently lacks it.

type Provider = "openai" | "gemini";
type Outcome = { ok: true } | { ok: false; reason: string };

/** A provider that answered nothing usable at the start, or failed too often over a window. */
export class ProviderDownError extends Error {
  readonly provider: Provider;
  readonly reason: string;

  constructor(provider: Provider, reason: string, detail: string) {
    super(`${provider} is not answering (${detail}); last error: ${reason}`);
    this.name = "ProviderDownError";
    this.provider = provider;
    this.reason = reason;
  }
}

export type HealthLimits = {
  /** Calls that may all fail before the provider counts as down. */
  firstCalls: number;
  /** Recent calls whose failure share is checked. */
  window: number;
  maxFailureShare: number;
};

const DEFAULT_LIMITS: HealthLimits = { firstCalls: 4, window: 20, maxFailureShare: 0.5 };

export class ProviderHealth {
  private readonly calls = new Map<Provider, { ok: boolean; reason?: string }[]>();
  private readonly limits: HealthLimits;

  constructor(limits: Partial<HealthLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Records one call; throws ProviderDownError when the provider has stopped answering. */
  record(provider: Provider, outcome: Outcome): void {
    const calls = this.calls.get(provider) ?? [];
    calls.push(outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason });
    this.calls.set(provider, calls);
    if (outcome.ok) return;
    const { firstCalls, window, maxFailureShare } = this.limits;
    if (calls.length >= firstCalls && calls.every((c) => !c.ok)) {
      throw new ProviderDownError(provider, outcome.reason, `${calls.length} calls, none usable`);
    }
    const recent = calls.slice(-window);
    const failed = recent.filter((c) => !c.ok).length;
    if (recent.length >= window && failed > maxFailureShare * window) {
      throw new ProviderDownError(
        provider,
        outcome.reason,
        `${failed} of the last ${window} calls failed`,
      );
    }
  }
}

export const failureReason = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error);
