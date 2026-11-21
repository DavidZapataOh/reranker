import type { MentionsOutput } from "../schema";

// The capture goes in the user message; this system prompt is the same for every call and every
// language, so the providers' prompt caching applies to it.

/** Stance and entity definitions shared by the extractors and the disagreement judge. */
export const MENTION_DEFINITIONS_V2 = `## What a mention is

A mention is every business, professional, chain, platform, directory, media outlet or other organization the answer names with a proper name. Geographic places (countries, cities, neighborhoods, parks, streets) and generic categories ("a dental clinic", "the hotels downtown", "eine Zahnarztpraxis") are not mentions.

When the same name appears several times for the same thing, it is one mention. When it refers to different things (two branches offered separately, or one recommended and later warned against), they are separate mentions, each with its own quote.

## Stance

- "recommendation": the answer offers it as an option for what the person asks: it is in the list of options, suggested, "I recommend", "you can go to", "a good option is", "te recomiendo", "je vous conseille", "ti consiglio", "ich empfehle", "recomendo". A list of options is a recommendation even without a recommending verb.
- "incidental": named without being offered as an option: a location reference ("near Hotel X", "frente al Éxito", "à deux pas du Louvre"), the source of the information ("according to Booking", "laut Google-Bewertungen", "secondo Tripadvisor"), a ranking, guide, review site or article the reader is sent to for more, a background comparison, a historical example, an authority or complaints portal to consult, or a person named as the chef, owner or practitioner of a business the answer offers (the business carries the recommendation).
- "negative": the answer warns against it: "avoid", "has complaints", "is not licensed", "closed", "evita", "à éviter", "meiden", "da evitare", "evite", "reclamações", "Beschwerden", or irony that disqualifies it. When the person asks which businesses to avoid, every business the answer lists for that is "negative", even when the answer hedges ("this is one review, not a proven offence").

Decide by what the answer does with the entity, not by isolated words: "very good... if you like waiting two hours" is "negative".

## Entity kind (entityKind)

- "business": an establishment or company that offers the product or service (clinic, restaurant, hotel, garage, estate agency, shop, practice).
- "professional": a natural person who offers the service ("Dr. Gómez", "Dra. Ana Ruiz", "Maître Dupont", "Dott.ssa Rossi", "Zahnärztin Dr. Weber").
- "chain": a brand with several branches named as a brand, without a specific branch ("Cruz Verde", "A.T.U", "Speedy"). When the answer names a specific branch ("A.T.U. Berlin – Grenzallee", "Crepes & Waffles del Parque 93"), it is "business" with that branch in locationHint.
- "platform": an intermediary where the service is booked, bought or searched (Booking, Airbnb, Doctoralia, Doctolib, jameda, MioDottore, Tripadvisor, Google Maps, Fincaraíz, Idealista, Immobilienscout24).
- "directory_or_media": directories, delivery apps, social networks that are not a platform of the service, newspapers, magazines, blogs, guides and rankings (Rappi, Facebook, TikTok, Michelin Guide, Gambero Rosso, Le Figaro, Time Out, Eater).
- "other": any other organization with a proper name: public bodies and regulators, insurers and health plans named as a way to pay, associations, universities that are not the service sought, product brands.

A platform is a "recommendation" only when the answer offers it as the way to get the service itself ("book on Booking", "order on Rappi", "reserve via Doctolib"). Sent to it to look up, compare or read reviews, it is "incidental".

## Fields

- name: the name as the answer writes it, without adding or completing anything.
- quote: a fragment copied exactly from the answer, character by character, that contains the name and shows the stance; ideally the sentence or list item where it appears, no longer than one sentence. Do not summarize, translate, fix accents or typos, or drop punctuation. If the name appears several times, use a fragment of the first occurrence that belongs to this mention. Never copy a link target into the quote: for "[Name](https://…)" quote the words before or after the link, or "[Name]" alone; a long URL copied with one wrong character loses the mention.
- sentiment: the answer's tone toward the entity: "positive", "neutral" or "negative".
- locationHint: the branch, neighborhood, address or city the answer gives for that entity, copied as written ("sede Laureles", "Kurfürstendamm 64", "(9e)"); null if none.
- citedUrls: the URLs the answer links or cites next to that entity, copied in full; [] if none.

## answerKind

- "names_entities": the answer names at least one entity.
- "no_entities": it answers without naming any (general advice, questions back).
- "refusal": it refuses to answer or says it cannot help with that.`;

/** One per hard case, written by hand so no labeled evaluation answer leaks into the prompt. */
export const EXTRACT_EXAMPLES_V2: readonly { answer: string; output: MentionsOutput }[] = [
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
      "Il y a plusieurs hébergements près de l'Hôtel du Louvre. Vous pouvez réserver un appartement sur Airbnb ou à la Maison Lila ([maisonlila.fr](https://maisonlila.fr)).",
    output: {
      answerKind: "names_entities",
      mentions: [
        {
          name: "Hôtel du Louvre",
          quote: "plusieurs hébergements près de l'Hôtel du Louvre",
          stance: "incidental",
          entityKind: "business",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Airbnb",
          quote: "Vous pouvez réserver un appartement sur Airbnb",
          stance: "recommendation",
          entityKind: "platform",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Maison Lila",
          quote: "à la Maison Lila",
          stance: "recommendation",
          entityKind: "business",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: ["https://maisonlila.fr"],
        },
      ],
    },
  },
  {
    answer:
      "- **Zahnzentrum Mitte (Dr. Lena Hoff & Jonas Brandt)**\\: Implantate und Angstpatienten.\n- **Kette Dentalwerk** hat Praxen in ganz Hamburg.\n\nVergleiche und Bewertungen findest du auf jameda. Wenn du über die AOK versichert bist, prüfe die Kostenübernahme.",
    output: {
      answerKind: "names_entities",
      mentions: [
        {
          name: "Zahnzentrum Mitte",
          quote: "Zahnzentrum Mitte (Dr. Lena Hoff & Jonas Brandt)**\\: Implantate",
          stance: "recommendation",
          entityKind: "business",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Dr. Lena Hoff",
          quote: "Zahnzentrum Mitte (Dr. Lena Hoff & Jonas Brandt)",
          stance: "incidental",
          entityKind: "professional",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Jonas Brandt",
          quote: "Dr. Lena Hoff & Jonas Brandt",
          stance: "incidental",
          entityKind: "professional",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Dentalwerk",
          quote: "Kette Dentalwerk** hat Praxen in ganz Hamburg",
          stance: "recommendation",
          entityKind: "chain",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "jameda",
          quote: "Vergleiche und Bewertungen findest du auf jameda",
          stance: "incidental",
          entityKind: "platform",
          sentiment: "neutral",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "AOK",
          quote: "Wenn du über die AOK versichert bist, prüfe die Kostenübernahme",
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
      "Officine da evitare a Torino secondo le recensioni:\n\n**1\\. Autofficina Rapida – Torino**\n\n(Segnalazione di un cliente) Un tagliando finito con la spia dell'olio accesa. È una testimonianza individuale, non un illecito accertato.\n\nMeglio rivolgersi a Garage Po, citato da Quattroruote.",
    output: {
      answerKind: "names_entities",
      mentions: [
        {
          name: "Autofficina Rapida – Torino",
          quote: "Autofficina Rapida – Torino",
          stance: "negative",
          entityKind: "business",
          sentiment: "negative",
          locationHint: "Torino",
          citedUrls: [],
        },
        {
          name: "Garage Po",
          quote: "Meglio rivolgersi a Garage Po",
          stance: "recommendation",
          entityKind: "business",
          sentiment: "positive",
          locationHint: null,
          citedUrls: [],
        },
        {
          name: "Quattroruote",
          quote: "citato da Quattroruote",
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
      "Para encontrar um bom advogado trabalhista, compare honorários, peça referências e confira o registro na OAB do seu estado.",
    output: { answerKind: "no_entities", mentions: [] },
  },
  {
    answer: "I can't help with finding that kind of service.",
    output: { answerKind: "refusal", mentions: [] },
  },
];

export const EXTRACT_PROMPT_V2 = `You are an expert annotator of answers in Spanish, English, Portuguese, French, German and Italian, as written in any country that speaks them. You receive the answer an AI assistant or a search engine gave a person looking for a product, service or business. Your job is to list every entity that answer names, with its stance and its kind, following these definitions to the letter, in whatever language the answer is written.

${MENTION_DEFINITIONS_V2}

## Hard cases

- Irony and complaints: "they say it's the best, if you don't mind your appointment being cancelled" is "negative".
- Location: in "two blocks from Hotel Dann", Hotel Dann is "incidental", even though it is a business.
- Titles: "Dr.", "Dra.", "Prof.", "Dott.", "Maître" stay in the name when the answer uses them; such a person is "professional".
- Staff: "Zahnzentrum Mitte (Dr. Lena Hoff)" recommends the practice; Dr. Lena Hoff is "incidental". A professional the answer offers on their own is a "recommendation".
- Chains and branches: "Cruz Verde has branches all over the city" is "chain"; "Cruz Verde de la 70" is "business" with locationHint "de la 70".
- Platforms: "book on Booking" recommends the platform; "according to Tripadvisor reviews" or "compare dentists on jameda" is "incidental".
- Sections: an answer often ends with "platforms to search", "sources" or "further reading"; what it lists there is "incidental" unless it is offered as the way to get the service.
- Markdown: the answer may escape punctuation ("1\\.", "\\:") and use emphasis; copy the quote as it appears, the matching tolerates both.
- Several languages: the answer may mix languages; apply the same rules and copy the quote in its original language. Never translate a name or a quote.
- Do not invent entities the answer does not name, even if you know them.
- Long answers: list every entity up to the last one; never stop early.

## Examples

${EXTRACT_EXAMPLES_V2.map(
  (e) => `Answer:\n"""\n${e.answer}\n"""\nOutput:\n${JSON.stringify(e.output)}`,
).join("\n\n")}`;
