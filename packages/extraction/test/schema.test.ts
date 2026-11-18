import { z } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import {
  ClassifierSchema,
  JudgeSchema,
  MentionsSchema,
  ProviderIncompleteError,
  ProviderRefusalError,
  ResolveJudgeSchema,
} from "../src/index";

type JsonSchema = {
  type?: string | string[];
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  properties: Record<string, JsonSchema>;
};

const okMention = {
  name: "Clínica Dental Sonrisa",
  quote: "Clínica Dental Sonrisa, en Chapinero",
  stance: "recommendation",
  entityKind: "business",
  sentiment: "positive",
  locationHint: "Chapinero",
  citedUrls: ["https://sonrisa.example.co/"],
};

describe("MentionsSchema", () => {
  test("every field is required and nulls are unions (strict structured outputs)", () => {
    const json = z.toJSONSchema(MentionsSchema) as JsonSchema;
    const item = json.properties.mentions?.items as JsonSchema;
    expect(json.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
    expect(item.required?.sort()).toEqual([
      "citedUrls",
      "entityKind",
      "locationHint",
      "name",
      "quote",
      "sentiment",
      "stance",
    ]);
    // zod 4 writes a nullable primitive as a type union, the form OpenAI's strict mode documents.
    expect(item.properties.locationHint?.type).toEqual(["string", "null"]);
    expect(json.required?.sort()).toEqual(["answerKind", "mentions"]);
  });

  test("accepts a well-formed answer", () => {
    expect(
      MentionsSchema.safeParse({ answerKind: "names_entities", mentions: [okMention] }).success,
    ).toBe(true);
  });

  test("rejects an unknown stance", () => {
    expect(
      MentionsSchema.safeParse({
        answerKind: "names_entities",
        mentions: [{ ...okMention, stance: "maybe" }],
      }).success,
    ).toBe(false);
  });

  test("the extractor never reports a failed capture: that comes from the capture row", () => {
    expect(MentionsSchema.safeParse({ answerKind: "capture_failed", mentions: [] }).success).toBe(
      false,
    );
  });

  test("rejects a mention missing its location hint instead of defaulting it", () => {
    const { locationHint: _, ...withoutHint } = okMention;
    expect(
      MentionsSchema.safeParse({ answerKind: "names_entities", mentions: [withoutHint] }).success,
    ).toBe(false);
  });

  test("the judge returns the same shape as the extractors", () => {
    expect(JudgeSchema).toBe(MentionsSchema);
  });
});

describe("ResolveJudgeSchema", () => {
  test("only picks one of the three candidates or gives up", () => {
    expect(ResolveJudgeSchema.safeParse({ choice: "candidate_3" }).success).toBe(true);
    expect(ResolveJudgeSchema.safeParse({ choice: "unresolvable" }).success).toBe(true);
    expect(ResolveJudgeSchema.safeParse({ choice: "candidate_4" }).success).toBe(false);
  });
});

describe("ClassifierSchema", () => {
  const ok = {
    categoryKey: "gen:cafe-de-origen",
    label: "Café de origen",
    noun: "tienda de café",
    archetype: "food",
    scope: "national",
    register: "tu",
    confidence: 0.82,
  };

  test("accepts a category with a known archetype", () => {
    expect(ClassifierSchema.safeParse(ok).success).toBe(true);
  });

  test("rejects an archetype outside the catalog and a confidence above 1", () => {
    expect(ClassifierSchema.safeParse({ ...ok, archetype: "pets" }).success).toBe(false);
    expect(ClassifierSchema.safeParse({ ...ok, confidence: 1.2 }).success).toBe(false);
  });

  test("is strict for structured outputs", () => {
    const json = z.toJSONSchema(ClassifierSchema) as JsonSchema;
    expect(json.additionalProperties).toBe(false);
    expect(json.required?.sort()).toEqual(Object.keys(ok).sort());
  });
});

describe("provider errors", () => {
  test("a refusal names its provider", () => {
    const error = new ProviderRefusalError("openai", "declined to extract");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProviderRefusal");
    expect(error.provider).toBe("openai");
    expect(error.message).toBe("declined to extract");
  });

  test("an incomplete answer keeps the reason the provider gave", () => {
    const error = new ProviderIncompleteError("gemini", "max_output_tokens");
    expect(error.name).toBe("ProviderIncomplete");
    expect(error.provider).toBe("gemini");
    expect(error.reason).toBe("max_output_tokens");
    expect(error.message).toContain("max_output_tokens");
  });
});
