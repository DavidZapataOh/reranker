import { CategoryArchetype, SeedCategoryKey } from "@reranker/schema/measurement";

// A Record, so a new archetype fails the build until the classifier learns it.
const ARCHETYPES: Record<CategoryArchetype, string> = {
  health:
    "salud: clínicas, consultorios, odontología, laboratorios, ópticas, fisioterapia, veterinarias",
  beauty_wellness: "belleza y bienestar: peluquerías, barberías, spas, uñas, gimnasios, yoga",
  lodging: "alojamiento: hoteles, hostales, glampings, fincas y apartamentos turísticos",
  food: "comida y bebida: restaurantes, cafés, panaderías, bares, domicilios de comida",
  home_auto_services:
    "servicios para el hogar y el vehículo: talleres, lavaderos, plomería, cerrajería, mudanzas, aseo",
  local_retail: "comercio con local: tiendas, ferreterías, droguerías, floristerías, almacenes",
  professional_services:
    "servicios profesionales: abogados, contadores, notarías, agencias, consultoría, seguros",
  real_estate: "finca raíz: inmobiliarias, arriendo y venta de vivienda, constructoras",
  education: "educación: colegios, jardines, idiomas, cursos, preuniversitarios, academias",
  online_national: "negocio en línea que vende o atiende en todo el país sin depender de un local",
};

export const CLASSIFY_PROMPT_V1 = `Clasificas un negocio para saber qué le preguntaría la gente a un asistente de IA cuando lo busca.

## Lo que recibes

En el mensaje del usuario llega un JSON con el nombre del negocio, sus tipos de Google Places, la etiqueta que muestra Google Maps y, si solo tiene sitio web, el título y la descripción de la página.

## Lo que devuelves

- categoryKey: una de estas categorías si el negocio es exactamente eso: ${SeedCategoryKey.options.join(", ")}. Si no, un identificador nuevo en minúsculas, sin tildes, con palabras separadas por guiones, de 2 a 40 caracteres, que nombre lo que vende o hace ("cafe-de-origen", "abogado-laboral").
- label: el nombre de la categoría en español, como lo diría un cliente ("Café de origen", "Abogado laboral").
- noun: el sustantivo en singular con que un cliente pide ese servicio en una pregunta, sin artículo ("café de origen", "abogado laboral").
- archetype: el que mejor describe el negocio, entre:
${CategoryArchetype.options.map((key) => `  - ${key}: ${ARCHETYPES[key]}`).join("\n")}
- scope: "national" si vende o atiende en todo el país sin que el cliente vaya a un local (tienda en línea, envíos nacionales, servicio remoto); si no, "local".
- register: "usted" para salud, derecho y educación; "tu" para lo demás.
- confidence: de 0 a 1, qué tan seguro estás de categoryKey y scope juntos. Usa menos de 0,8 si los datos son ambiguos o escasos.

Decide solo con los datos recibidos; si no alcanzan, elige la categoría más probable y baja la confianza.`;
