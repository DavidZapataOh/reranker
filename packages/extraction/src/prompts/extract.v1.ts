import type { MentionsOutput } from "../schema";

// The capture goes in the user message; this system prompt never changes between calls, so
// the providers' prompt caching applies to it.

/** Stance and entity definitions shared by the extractors and the disagreement judge. */
export const MENTION_DEFINITIONS_V1 = `## Qué es una mención

Una mención es cada negocio, profesional, cadena, plataforma, directorio, medio u otra organización que la respuesta nombra con nombre propio. No son menciones los lugares geográficos (países, ciudades, barrios, parques, calles) ni las categorías genéricas ("una clínica dental", "los hoteles del centro").

Si el mismo nombre aparece varias veces refiriéndose a lo mismo, es una sola mención. Si se refiere a cosas distintas (dos sedes ofrecidas por separado, o una vez recomendada y otra desaconsejada), son menciones distintas, cada una con su propia cita.

## Postura (stance)

- "recommendation": la respuesta la ofrece como opción para lo que pide el usuario: aparece en la lista de opciones, se sugiere, "te recomiendo", "puedes ir a", "una buena opción es".
- "incidental": se nombra sin ofrecerla como opción: referencia de ubicación ("cerca del Hotel X", "frente al Éxito"), fuente de la información ("según Booking", "en las reseñas de Google Maps"), comparación de fondo, ejemplo histórico o contexto.
- "negative": se desaconseja o se advierte sobre ella: "evita", "tiene quejas", "no está habilitada", "cerró", ironía que la descalifica.

Decide por lo que la respuesta hace con la entidad, no por las palabras sueltas: una lista de opciones es recomendación aunque no diga "recomiendo"; "muy bueno... si te gusta esperar dos horas" es negativa.

## Tipo de entidad (entityKind)

- "business": un establecimiento o empresa que ofrece el producto o servicio (clínica, restaurante, hotel, taller, inmobiliaria, tienda, IPS).
- "professional": una persona natural que ofrece el servicio ("Dr. Gómez", "la Dra. Ana Ruiz", "el abogado Pedro Díaz").
- "chain": una marca con varias sedes nombrada como marca, sin una sede concreta ("Cruz Verde", "Crepes & Waffles"). Si la respuesta nombra una sede concreta ("Crepes & Waffles del Parque 93"), es "business" con esa sede en locationHint.
- "platform": un intermediario donde se reserva, compra o busca el servicio (Booking, Airbnb, Doctoralia, Fincaraíz, Metrocuadrado, Ciencuadras, Tripadvisor, Expedia, Google Maps, Instagram).
- "directory_or_media": directorios, apps de domicilios, redes sociales que no son plataforma del servicio, periódicos, blogs, guías y revistas (Rappi, Facebook, TikTok, YouTube, El Tiempo).
- "other": cualquier otra organización con nombre propio: entidades públicas, aseguradoras y EPS nombradas como forma de pago, asociaciones, universidades que no son el servicio buscado, marcas de producto.

## Campos

- name: el nombre como lo escribe la respuesta, sin agregar ni completar nada.
- quote: un fragmento copiado exactamente de la respuesta, carácter por carácter, que contiene el nombre y deja ver la postura; idealmente la frase o el ítem de la lista donde aparece, sin pasar de una oración. No lo resumas, no lo traduzcas, no corrijas tildes ni errores y no quites signos. Si el nombre aparece varias veces, usa un fragmento de la primera aparición que corresponde a esta mención.
- sentiment: el tono de la respuesta hacia la entidad: "positive", "neutral" o "negative".
- locationHint: la sede, barrio, dirección o ciudad que la respuesta da para esa entidad, copiada tal cual ("sede Laureles", "Cra. 43A #1-50"); null si no da ninguna.
- citedUrls: las URL que la respuesta enlaza o cita junto a esa entidad, copiadas completas; [] si no hay.

## answerKind

- "names_entities": la respuesta nombra al menos una entidad.
- "no_entities": responde sin nombrar ninguna (consejos generales, preguntas de vuelta).
- "refusal": se niega a responder o dice que no puede ayudar con eso.`;

/** One per hard case, written by hand so no labeled evaluation answer leaks into the prompt. */
export const EXTRACT_EXAMPLES_V1: readonly { answer: string; output: MentionsOutput }[] = [
  {
    answer:
      "Para ortodoncia en Medellín te recomiendo:\n1. Clínica Dental Sonrisas (sede Laureles): tiene buenas reseñas en Google Maps.\n2. La Dra. Marcela Ríos, especialista en alineadores.\nEvita Dentix: tiene muchas quejas por cobros.",
    output: {
      answerKind: "names_entities",
      mentions: [
        {
          name: "Clínica Dental Sonrisas",
          quote: "Clínica Dental Sonrisas (sede Laureles): tiene buenas reseñas",
          stance: "recommendation",
          entityKind: "business",
          sentiment: "positive",
          locationHint: "sede Laureles",
          citedUrls: [],
        },
        {
          name: "Google Maps",
          quote: "tiene buenas reseñas en Google Maps",
          stance: "incidental",
          entityKind: "platform",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Dra. Marcela Ríos",
          quote: "La Dra. Marcela Ríos, especialista en alineadores",
          stance: "recommendation",
          entityKind: "professional",
          sentiment: "positive",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Dentix",
          quote: "Evita Dentix: tiene muchas quejas por cobros",
          stance: "negative",
          entityKind: "business",
          sentiment: "negative",
          locationHint: null,
          citedUrls: [],
        },
      ],
    },
  },
  {
    answer:
      "Hay varias opciones de hospedaje cerca del Hotel Caribe, en Bocagrande. Puedes buscar apartamentos en Airbnb o reservar en Casa Lola ([casalola.com.co](https://casalola.com.co)).",
    output: {
      answerKind: "names_entities",
      mentions: [
        {
          name: "Hotel Caribe",
          quote: "cerca del Hotel Caribe, en Bocagrande",
          stance: "incidental",
          entityKind: "business",
          sentiment: "neutral",
          locationHint: "Bocagrande",
          citedUrls: [],
        },
        {
          name: "Airbnb",
          quote: "Puedes buscar apartamentos en Airbnb",
          stance: "recommendation",
          entityKind: "platform",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Casa Lola",
          quote: "reservar en Casa Lola",
          stance: "recommendation",
          entityKind: "business",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: ["https://casalola.com.co"],
        },
      ],
    },
  },
  {
    answer:
      "Para exámenes de laboratorio puedes ir a la IPS Colsanitas o a Cruz Verde, que tiene sedes en toda la ciudad. Si tu EPS es Sanitas, revisa la cobertura primero.",
    output: {
      answerKind: "names_entities",
      mentions: [
        {
          name: "IPS Colsanitas",
          quote: "puedes ir a la IPS Colsanitas",
          stance: "recommendation",
          entityKind: "business",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Cruz Verde",
          quote: "Cruz Verde, que tiene sedes en toda la ciudad",
          stance: "recommendation",
          entityKind: "chain",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Sanitas",
          quote: "Si tu EPS es Sanitas, revisa la cobertura primero",
          stance: "incidental",
          entityKind: "other",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
      ],
    },
  },
  {
    answer:
      "El Taller El Paisa es famoso... por tenerte el carro una semana para un cambio de aceite. Mejor llévalo a Autoservicio La 80, según una nota de El Colombiano.",
    output: {
      answerKind: "names_entities",
      mentions: [
        {
          name: "Taller El Paisa",
          quote:
            "El Taller El Paisa es famoso... por tenerte el carro una semana para un cambio de aceite",
          stance: "negative",
          entityKind: "business",
          sentiment: "negative",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Autoservicio La 80",
          quote: "Mejor llévalo a Autoservicio La 80",
          stance: "recommendation",
          entityKind: "business",
          sentiment: "positive",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "El Colombiano",
          quote: "según una nota de El Colombiano",
          stance: "incidental",
          entityKind: "directory_or_media",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
      ],
    },
  },
  {
    answer:
      "Para encontrar un buen abogado laboral te sugiero comparar honorarios, pedir referencias y verificar la tarjeta profesional.",
    output: { answerKind: "no_entities", mentions: [] },
  },
  {
    answer: "I can't help with finding that kind of service.",
    output: { answerKind: "refusal", mentions: [] },
  },
];

export const EXTRACT_PROMPT_V1 = `Eres un anotador experto en español de cualquier país, con dominio del español de Colombia. Recibes la respuesta que un asistente de IA o un buscador dio a una persona que busca un producto, servicio o negocio. Tu trabajo es listar cada entidad que esa respuesta nombra, con su postura y su tipo, siguiendo estas definiciones al pie de la letra.

${MENTION_DEFINITIONS_V1}

## Casos difíciles

- Ironía y quejas: "dicen que es la mejor, si no te importa que te cancelen la cita" es "negative".
- Ubicación: en "queda a dos cuadras del Hotel Dann", el Hotel Dann es "incidental", aunque sea un negocio.
- Títulos: "Dr.", "Dra.", "Doctor" van en el nombre si la respuesta los usa; son "professional".
- Siglas: "IPS Sura" y "la IPS Salud Total" son "business"; una EPS nombrada solo como forma de pago es "other" e "incidental".
- Cadenas: "Cruz Verde tiene sedes en toda la ciudad" es "chain"; "Cruz Verde de la 70" es "business" con locationHint "de la 70".
- Plataformas: "reserva en Booking" es una recomendación de la plataforma; "según las reseñas de Tripadvisor" es "incidental".
- La respuesta puede estar en otro idioma o mezclar idiomas: aplica las mismas reglas y copia la cita en el idioma original.
- No inventes entidades que la respuesta no nombra, aunque las conozcas.

## Ejemplos

${EXTRACT_EXAMPLES_V1.map(
  (e) => `Respuesta:\n"""\n${e.answer}\n"""\nSalida:\n${JSON.stringify(e.output)}`,
).join("\n\n")}`;
