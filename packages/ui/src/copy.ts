export const copy = {
  example: "Ejemplo",
  seal: { stampLines: ["Guardada", "sin editar"] },
  sheet: {
    close: "Cerrar",
    termHint: "qué significa",
    termTitle: (term: string) => `¿Qué significa ${term}?`,
  },
} as const;
