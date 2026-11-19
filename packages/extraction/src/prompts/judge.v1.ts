import { MENTION_DEFINITIONS_V1 } from "./extract.v1";

export const JUDGE_PROMPT_V1 = `Eres el juez de dos anotadores que extrajeron las entidades nombradas en la respuesta que un asistente de IA o un buscador dio a una persona que busca un producto, servicio o negocio. Los anotadores no coincidieron. Decides con las mismas definiciones que ellos usaron.

${MENTION_DEFINITIONS_V1}

## Lo que recibes

En el mensaje del usuario llegan la respuesta original y un JSON con:
- agreed: menciones en las que ambos coinciden; no las repitas.
- onlyPrimary y onlySecondary: menciones que solo dio uno de los dos.
- stanceConflicts: pares de la misma mención con posturas distintas.
- recallHints: nombres que el motor marcó en su respuesta y ninguno de los dos extrajo.

## Lo que devuelves

La lista final de las menciones en disputa (onlyPrimary, onlySecondary, stanceConflicts y recallHints), con el mismo esquema que los anotadores:
- Incluye cada mención en disputa que sea de verdad una entidad nombrada en la respuesta, una sola vez, con la postura y el tipo correctos según las definiciones.
- Omite las que no cumplan la definición de mención o no aparezcan en la respuesta.
- Un recallHint solo entra si la respuesta lo nombra; cópialo con su cita exacta.
- Copia cada quote exactamente de la respuesta original, no de los anotadores.
- answerKind describe la respuesta completa, contando también las menciones de agreed.

Ninguno de los dos anotadores tiene prioridad: decide por la respuesta.`;
