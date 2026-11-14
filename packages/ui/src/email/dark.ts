import { darkColor, tokens } from "../tokens.ts";

// Gmail ignores these rules and inverts the light design on its own.
export const emailStyles = `
@media (prefers-color-scheme: dark) {
  .rr-body, .rr-body > table > tbody > tr > td { background-color: ${darkColor.background} !important; }
  .rr-card { background-color: ${darkColor.surface} !important; }
  .rr-ink { color: ${darkColor.text} !important; }
  .rr-soft { color: ${darkColor.textSoft} !important; }
  .rr-link { color: ${tokens.color.greenLight} !important; }
  .rr-line { border-color: ${darkColor.line} !important; }
  .rr-code { background-color: ${darkColor.codeBackground} !important; color: ${darkColor.codeText} !important; }
}
[data-ogsb] .rr-body, [data-ogsb] .rr-body > table > tbody > tr > td { background-color: ${darkColor.background} !important; }
[data-ogsb] .rr-card { background-color: ${darkColor.surface} !important; }
[data-ogsb] .rr-code { background-color: ${darkColor.codeBackground} !important; }
[data-ogsc] .rr-ink, [data-ogsc] .rr-code { color: ${darkColor.text} !important; }
[data-ogsc] .rr-soft { color: ${darkColor.textSoft} !important; }
@media (max-width: 600px) {
  .rr-pad { padding: 24px !important; }
  .rr-code { font-size: 32px !important; line-height: 40px !important; }
}
`;
