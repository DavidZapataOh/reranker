import type { Messages } from "@reranker/i18n";

type Namespace = keyof Messages;

// What each layout hands to NextIntlClientProvider: only the namespaces its Client Components
// render, never the whole catalog. The provider alone adds about 10 KB gzip of client JS, so a
// layout mounts it only once a Client Component below it renders messages; none does yet.
export const CLIENT_NAMESPACES = {
  root: [],
} as const satisfies Record<string, readonly Namespace[]>;

export function pick<N extends Namespace>(
  messages: Messages,
  namespaces: readonly N[],
): Pick<Messages, N> {
  return Object.fromEntries(namespaces.map((ns) => [ns, messages[ns]])) as Pick<Messages, N>;
}
