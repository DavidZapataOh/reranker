import { Caveat, JetBrains_Mono, Nunito, Plus_Jakarta_Sans } from "next/font/google";

export const display = Nunito({
  variable: "--nf-display",
  subsets: ["latin"],
  weight: ["800", "900"],
  display: "swap",
});
export const text = Plus_Jakarta_Sans({
  variable: "--nf-text",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});
export const mono = JetBrains_Mono({
  variable: "--nf-mono",
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
});
export const hand = Caveat({
  variable: "--nf-hand",
  subsets: ["latin"],
  weight: ["500", "600"],
  display: "swap",
});

// The UI package's font stacks read these variables.
export const fontVariables = `${display.variable} ${text.variable} ${mono.variable} ${hand.variable}`;
