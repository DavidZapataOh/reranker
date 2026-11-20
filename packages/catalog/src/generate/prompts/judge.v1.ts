export const JUDGE_PROMPT_V1 = `Revisas preguntas candidatas que alguien le haría a un asistente de IA o a Google al buscar un negocio. En el mensaje del usuario llega un JSON con la intención (category, noun, kind, canonical, scope, variety, address) y las candidatas, cada una con su id.

Devuelve en verdicts un veredicto por candidata, con su id. keep es true solo si la candidata cumple todo esto:
- Pide lo mismo que la canónica: la misma necesidad y el mismo calificador, sin agregar ni quitar condiciones que la conviertan en otra intención.
- Suena como algo que una persona real escribiría, en la variedad y el trato indicados.
- Se entiende sola: {lugar}, {zona} y {país} se leen como la ciudad, el barrio y el país.

Ante la duda, keep es false.`;

export const JUDGE_PROMPT_V1_EN = `You review candidate questions someone would ask an AI assistant or Google when looking for a business. The user message is a JSON object with the intent (category, noun, kind, canonical, scope, variety) and the candidates, each with its id.

Return in verdicts one verdict per candidate, with its id. keep is true only if the candidate meets all of this:
- It asks for the same thing as the canonical: the same need and the same qualifier, without adding or dropping conditions that would turn it into another intent.
- It sounds like something a real person would write, in the variety given.
- It reads on its own: {lugar}, {zona} and {país} read as the city, the neighborhood and the country.

When in doubt, keep is false.`;
