import type { EngineId } from "@reranker/i18n";

export const copy = {
  example: "Ejemplo",
  engines: {
    chatgpt: "ChatGPT",
    gemini: "Gemini",
    "google-ai-overview": "Google (respuestas de IA)",
    perplexity: "Perplexity",
  } satisfies Record<EngineId, string>,
  bubble: { expand: "Ver respuesta completa", collapse: "Ver menos" },
  seal: {
    stampLines: ["Guardada", "sin editar"],
    inline: (capturedAtLabel: string, cityLabel: string) =>
      `Respuesta guardada · ${capturedAtLabel} · ${cityLabel} · sin editar`,
    help: "Qué significa respuesta guardada",
    title: "¿Qué significa?",
    explainer:
      'Guardamos esta respuesta tal como la dio la IA, con fecha, hora y ciudad. Nadie puede editarla, ni nosotros. Si alguien cambiara una sola letra, el botón "Comprobar" lo mostraría.',
    verify: "Comprobar esta respuesta",
  },
  sheet: {
    close: "Cerrar",
    termHint: "qué significa",
    termTitle: (term: string) => `¿Qué significa ${term}?`,
  },
  score: {
    score: "Puntaje",
    between: "entre",
    and: "y",
    atMost: "a lo sumo",
    preliminary: "preliminar",
    insufficient: "Pocos datos para darte un nivel",
  },
  sample: {
    of: "de",
    in: "en",
  },
} as const;
