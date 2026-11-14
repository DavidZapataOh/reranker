import { pixelBasedPreset, type TailwindConfig } from "react-email";
import { tokens, toOpaque } from "../tokens.ts";

const { color, fontStack, radius } = tokens;

// Several mail clients ignore 8-digit hex, so translucent tokens are flattened onto the surface they sit on.
export const emailTailwindConfig = {
  presets: [pixelBasedPreset],
  theme: {
    extend: {
      colors: {
        paper: color.paper,
        ink: color.ink,
        "ink-soft": toOpaque(color.inkSoft, color.surface),
        line: toOpaque(color.line, color.surface),
        green: color.green,
        "green-deep": color.greenDeep,
        "green-light": color.greenLight,
        bubble: color.bubble,
        surface: color.surface,
      },
      fontFamily: {
        display: [fontStack.display],
        sans: [fontStack.text],
        mono: [fontStack.mono],
      },
      borderRadius: {
        sm: `${radius.sm}px`,
        md: `${radius.md}px`,
        lg: `${radius.lg}px`,
        card: `${radius.card}px`,
      },
    },
  },
} satisfies TailwindConfig;
