import {
  CategoryArchetype,
  IntentKind,
  IntentSetKind,
  MeasurementLanguage,
  Paraphrase,
  ParaphraseFormat,
  QuestionScope,
  RegisterProfile,
} from "@reranker/schema/measurement";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { bytea, enumValues } from "./_columns";
import { publicPanelSchema } from "./_schemas";
import { sharedTable } from "./_tables";

const at = () => timestamp({ withTimezone: true });
const sha256 = (table: string, column: string) =>
  check(`${table}_${column}_length`, sql`octet_length(${sql.identifier(column)}) = 32`);

export const categoryArchetype = publicPanelSchema.enum(
  "category_archetype",
  enumValues(CategoryArchetype),
);
export const questionScope = publicPanelSchema.enum("question_scope", enumValues(QuestionScope));
export const speechRegister = publicPanelSchema.enum("speech_register", ["tu", "usted"]);
export const intentKind = publicPanelSchema.enum("intent_kind", enumValues(IntentKind));
export const paraphraseFormat = publicPanelSchema.enum(
  "paraphrase_format",
  enumValues(ParaphraseFormat),
);
export const paraphraseGenerator = publicPanelSchema.enum(
  "paraphrase_generator",
  enumValues(Paraphrase.shape.generator),
);
export const intentSetKind = publicPanelSchema.enum("intent_set_kind", enumValues(IntentSetKind));
export const registerProfile = publicPanelSchema.enum(
  "register_profile",
  enumValues(RegisterProfile),
);

/** One frozen version of the reviewed seed; its JSON lives in the repository. */
export const promptSets = sharedTable(
  "prompt_sets",
  {
    version: text().notNull().unique("prompt_sets_version_key"),
    contentHash: bytea().notNull().unique("prompt_sets_content_hash_key"),
    merkleRoot: bytea().notNull(),
    variantCount: integer().notNull(),
    publishedAt: at().notNull().defaultNow(),
  },
  () => [sha256("prompt_sets", "content_hash"), sha256("prompt_sets", "merkle_root")],
);

export const categories = sharedTable("categories", {
  key: text().notNull().unique("categories_key_key"),
  labelKey: text().notNull(),
  archetype: categoryArchetype().notNull(),
  placesTypes: text().array().notNull(),
  defaultScope: questionScope().notNull(),
  register: speechRegister().notNull(),
});

export const intents = sharedTable(
  "intents",
  {
    promptSet: text()
      .notNull()
      .references(() => promptSets.version),
    intentId: text().notNull(),
    category: text()
      .notNull()
      .references(() => categories.key),
    kind: intentKind().notNull(),
    slug: text().notNull(),
    labelKey: text().notNull(),
    demandWeight: doublePrecision().notNull(),
    freeReport: boolean().notNull(),
    canonicalParaphraseId: text().notNull(),
  },
  (t) => [
    unique("intents_prompt_set_intent_id_key").on(t.promptSet, t.intentId),
    index("intents_category_idx").on(t.category),
  ],
);

export const personas = sharedTable(
  "personas",
  {
    promptSet: text()
      .notNull()
      .references(() => promptSets.version),
    personaId: text().notNull(),
    category: text()
      .notNull()
      .references(() => categories.key),
    preamble: text().notNull(),
  },
  (t) => [
    unique("personas_prompt_set_persona_id_key").on(t.promptSet, t.personaId),
    index("personas_category_idx").on(t.category),
  ],
);

export const paraphrases = sharedTable(
  "paraphrases",
  {
    promptSet: text().notNull(),
    paraphraseId: text().notNull(),
    intentId: text().notNull(),
    text: text().notNull(),
    format: paraphraseFormat().notNull(),
    generator: paraphraseGenerator().notNull(),
    humanReviewed: boolean().notNull(),
  },
  (t) => [
    unique("paraphrases_prompt_set_paraphrase_id_key").on(t.promptSet, t.paraphraseId),
    index("paraphrases_prompt_set_intent_id_idx").on(t.promptSet, t.intentId),
    foreignKey({
      name: "paraphrases_intent_fk",
      columns: [t.promptSet, t.intentId],
      foreignColumns: [intents.promptSet, intents.intentId],
    }),
  ],
);

/**
 * Every intent set a measurement used. The set itself is an artifact addressed by
 * artifact_sha256; the row is what reuse looks up.
 */
export const intentSets = sharedTable(
  "intent_sets",
  // Fixed-width columns first, widest alignment first, so the row carries no padding.
  {
    createdAt: at().notNull().defaultNow(),
    kind: intentSetKind().notNull(),
    scope: questionScope().notNull(),
    registerProfile: registerProfile().notNull(),
    generators: smallint().notNull(),
    variantCount: smallint().notNull(),
    setId: text().notNull().unique("intent_sets_set_id_key"),
    version: text().notNull(),
    categoryKey: text().notNull(),
    contentHash: bytea().notNull().unique("intent_sets_content_hash_key"),
    merkleRoot: bytea().notNull(),
    generatorConfigHash: bytea(),
    // Null for the seed, which ships with the code.
    artifactSha256: bytea(),
    // Part of the reuse key, since a set is asked in one language; rows written before languages
    // were recorded are Spanish. Two-letter text takes 3 bytes, an enum 4 plus alignment.
    language: text({ enum: enumValues(MeasurementLanguage) })
      .notNull()
      .default("es"),
  },
  (t) => [
    index("intent_sets_reuse_idx").on(
      t.categoryKey,
      t.scope,
      t.registerProfile,
      t.generatorConfigHash,
      t.createdAt.desc(),
    ),
    check("intent_sets_set_id_check", sql`${t.setId} ~ '^is_[0-9a-f]{16}$'`),
    check("intent_sets_generators_check", sql`${t.generators} between 0 and 2`),
    // The MeasurementLanguage values; a schema test keeps the two lists equal.
    check("intent_sets_language_check", sql`${t.language} in ('es', 'en', 'pt', 'fr', 'de', 'it')`),
    sha256("intent_sets", "content_hash"),
    sha256("intent_sets", "merkle_root"),
    sha256("intent_sets", "generator_config_hash"),
    sha256("intent_sets", "artifact_sha256"),
  ],
);
