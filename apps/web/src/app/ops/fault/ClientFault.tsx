"use client";

import { useEffect } from "react";

// Throws right after mount, before PostHog has started, the case real first-render errors hit.
export function ClientFault() {
  useEffect(() => {
    throw new Error("ops fault: client");
  }, []);
  return null;
}
