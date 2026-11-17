/**
 * Networks never classified as hosting or VPN, whatever the public lists say. Each entry is a
 * false positive found on people's own connections (residential or mobile) and stays pinned by
 * the contract test that found it. A prefix inside a wider listed one is still honored.
 */
export const NETWORK_EXCLUSIONS: readonly string[] = [];
