export const JUDGE_PROMPT_V1 = `Revisas preguntas candidatas que alguien le haría a un asistente de IA o a Google al buscar un negocio. En el mensaje del usuario llega un JSON con la intención (category, noun, kind, canonical, scope, variety, address) y las candidatas, cada una con su id.

Devuelve en verdicts un veredicto por candidata, con su id. keep es true solo si la candidata cumple todo esto:
- Pide lo mismo que la canónica: la misma necesidad y el mismo calificador, sin agregar ni quitar condiciones que la conviertan en otra intención.
- Suena como algo que una persona real escribiría, en la variedad y el trato indicados.
- Se entiende sola: {lugar}, {zona} y {país} se leen como la ciudad, el barrio y el país.

Ante la duda, keep es false.`;
