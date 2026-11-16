import { appEnv } from "@reranker/env";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClientFault } from "./ClientFault";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Proves client error capture on previews; production never serves it.
export default function OpsFaultPage() {
  if (appEnv() === "production") notFound();
  return <ClientFault />;
}
