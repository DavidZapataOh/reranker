// Read-only mirror of the @theme block in styles/theme.css; a test keeps both in sync.
export const cssVariables = {
  "--color-paper": "#faf7f0",
  "--color-ink": "#14211b",
  "--color-ink-soft": "#14211bb3",
  "--color-line": "#14211b14",
  "--color-green": "#0f5c45",
  "--color-green-deep": "#0b4a37",
  "--color-green-light": "#d9ebd7",
  "--color-amber": "#f2b544",
  "--color-bubble": "#f1f2ef",
  "--color-surface": "#ffffff",
  "--color-action": "var(--color-green)",
  "--color-action-hover": "var(--color-green-deep)",
  "--color-action-soft": "var(--color-green-light)",
  "--color-canvas": "var(--color-paper)",
  "--color-text": "var(--color-ink)",
  "--color-text-soft": "var(--color-ink-soft)",
  "--color-border": "var(--color-line)",
  "--font-display": 'var(--nf-display), ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  "--font-sans": 'var(--nf-text), system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-mono": 'var(--nf-mono), ui-monospace, "SFMono-Regular", monospace',
  "--font-hand": 'var(--nf-hand), "Segoe Print", cursive',
  "--ease-out-brand": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "--shadow-soft": "0 1px 2px rgb(20 33 27 / 0.06), 0 4px 16px rgb(20 33 27 / 0.06)",
  "--shadow-lift": "0 2px 4px rgb(20 33 27 / 0.06), 0 18px 40px -12px rgb(20 33 27 / 0.18)",
  "--shadow-float": "0 1px 2px rgb(20 33 27 / 0.05), 0 12px 32px -14px rgb(20 33 27 / 0.22)",
  "--radius-field": "22px",
  "--radius-card": "24px",
  "--radius-band": "28px",
} as const satisfies Readonly<Record<`--${string}`, string>>;

type VariableName = keyof typeof cssVariables;

export function resolveVar(value: string): string {
  const match = /^var\((--[\w-]+)\)$/.exec(value);
  if (!match) return value;
  const next = cssVariables[match[1] as VariableName];
  if (next === undefined) throw new Error(`Unknown CSS variable ${match[1]}`);
  return resolveVar(next);
}

export function toOpaque(hex8: string, background: string): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const alpha = channel(hex8, 3) / 255;
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(channel(hex8, i) * alpha + channel(background, i) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const color = (name: VariableName) => resolveVar(`var(${name})`);
// next/font injects the family behind --nf-*, which does not exist outside the app.
const font = (name: VariableName, family: string) =>
  cssVariables[name].replace(/^var\(--nf-\w+\)/, family);

export const tokens = {
  color: {
    paper: color("--color-paper"),
    ink: color("--color-ink"),
    inkSoft: color("--color-ink-soft"),
    line: color("--color-line"),
    green: color("--color-green"),
    greenDeep: color("--color-green-deep"),
    greenLight: color("--color-green-light"),
    amber: color("--color-amber"),
    bubble: color("--color-bubble"),
    surface: color("--color-surface"),
    action: color("--color-action"),
    actionHover: color("--color-action-hover"),
    actionSoft: color("--color-action-soft"),
    canvas: color("--color-canvas"),
    text: color("--color-text"),
    textSoft: color("--color-text-soft"),
    border: color("--color-border"),
  },
  radius: { sm: 8, md: 12, lg: 16, field: 22, card: 24, band: 28, pill: 9999 },
  shadow: {
    soft: cssVariables["--shadow-soft"],
    lift: cssVariables["--shadow-lift"],
    float: cssVariables["--shadow-float"],
  },
  ease: { brand: cssVariables["--ease-out-brand"] },
  fontStack: {
    display: font("--font-display", "Nunito"),
    text: font("--font-sans", '"Plus Jakarta Sans"'),
    mono: font("--font-mono", '"JetBrains Mono"'),
    hand: font("--font-hand", "Caveat"),
  },
} as const;
