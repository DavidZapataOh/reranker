import { z } from "@reranker/schema";
import data from "../registry.json" with { type: "json" };
import { FLAG_KEYS, type FlagKey } from "./flag-keys.gen";

export type FlagKind = "kill-switch" | "release";

export type RegistryEntry = {
  key: FlagKey;
  kind: FlagKind;
  /** The workspace package or area the flag gates; PostHog gets it as a tag. */
  owner: string;
  description: string;
  expires?: string;
  /** Paid providers: PostHog holds them off outside production unless overridden by hand. */
  productionOnly?: boolean;
};

const Entry = z
  .object({
    key: z.enum(FLAG_KEYS),
    kind: z.enum(["kill-switch", "release"]),
    owner: z.string().min(1),
    description: z.string().min(1),
    expires: z.iso.date().optional(),
    productionOnly: z.boolean().optional(),
  })
  .refine((entry) => entry.kind !== "release" || entry.expires !== undefined, {
    message: "a release flag needs an expiry date",
    path: ["expires"],
  });

/** Validates a registry document against the generated keys. */
export function parseRegistry(input: unknown): z.output<typeof Entry>[] {
  return z.array(Entry).parse(input);
}

// A key missing from flag-keys.gen.ts fails here: run `flags:gen` after editing registry.json.
export const registry = parseRegistry(data) as readonly RegistryEntry[];
