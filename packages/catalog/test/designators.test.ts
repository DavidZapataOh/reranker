import { describe, expect, test } from "vitest";
import {
  localDesignated,
  parseDesignated,
  sameDesignator,
  speller,
} from "../scripts/designators.ts";

const place = (name: string, aliases: string[] = [], names: Record<string, string> = {}) => ({
  name,
  aliases,
  names,
});
const spell = speller([
  place("Córdoba", ["Cordoba"], { it: "Cordova" }),
  place("San José de Ocoa", ["San Jose de Ocoa"]),
  place("San Jose de Ocoa Province", ["San Jose de Ocoa"]),
  place("Alto Paraná", ["Alto Parana"]),
  place("Sevilla", ["Seville"], { en: "Seville", fr: "Séville", it: "Siviglia" }),
]);
const as = (name: string, language: Parameters<typeof localDesignated>[1], country: string) =>
  localDesignated(name, language, country, spell);

describe("designators", () => {
  test.each([
    ["Municipality of Madrid", "ES", "Municipio de Madrid"],
    ["Province of Cordoba", "ES", "Provincia de Córdoba"],
    ["Capital Department", "AR", "Departamento Capital"],
    ["Department Capital", "AR", "Departamento Capital"],
    ["Lerma Municipality", "MX", "Municipio de Lerma"],
    ["Maneiro Municipality", "VE", "Municipio Maneiro"],
    ["San Jose de Ocoa Province", "DO", "Provincia San José de Ocoa"],
    ["Mata Redonda District", "CR", "Distrito Mata Redonda"],
    ["Aguadulce District", "PA", "Distrito de Aguadulce"],
    ["Alto Parana Department", "PY", "Departamento de Alto Paraná"],
    ["Uyuni Municipality", "BO", "Municipio de Uyuni"],
    ["Municipality B", "UY", "Municipio B"],
    ["Kruje District", "AL", "Distrito de Kruje"],
    ["Municipality of Seville", "ES", "Municipio de Sevilla"],
    ["Kaunas District Municipality", "LT", "Municipio del distrito de Kaunas"],
    ["Portneuf Regional County Municipality", "CA", "Municipio regional de condado de Portneuf"],
  ])("%s reads in Spanish in %s as %s", (name, country, spanish) =>
    expect(as(name, "es", country)).toBe(spanish),
  );

  test("Spanish names keep their own form", () => {
    expect(as("Departamento de San Jerónimo", "es", "AR")).toBe("Departamento de San Jerónimo");
    expect(as("Comunidad de Madrid", "es", "ES")).toBe("Comunidad de Madrid");
  });

  test.each([
    ["Departamento Capital", "en", "Capital Department"],
    ["Partido de Morón", "en", "Morón Partido"],
    ["Comunidad de Madrid", "en", "Community of Madrid"],
    ["Municipio de Lerma", "pt", "Município de Lerma"],
    ["Departamento de Alto Paraná", "pt", "Departamento de Alto Paraná", "PY"],
    ["Municipio de Lerma", "fr", "Municipalité de Lerma"],
    ["Provincia de Córdoba", "fr", "Province de Córdoba"],
    ["Departamento de Ituzaingó", "fr", "Département d'Ituzaingó", "PY"],
    ["Municipio de Lerma", "it", "Comune di Lerma"],
    ["Distrito de Aguadulce", "it", "Distretto di Aguadulce"],
    ["Provincia de Córdoba", "de", "Provinz Córdoba"],
    ["Departamento Capital", "de", "Departamento Capital"],
    ["Kruje District", "de", "Distrikt Kruje"],
    ["Kruje District", "en", "Kruje District"],
    ["Provincia di Siviglia", "it", "Provincia di Siviglia"],
    ["Departamento de Guaymallén", "de", "Departamento Guaymallén"],
    ["Partido de Escobar", "de", "Partido Escobar"],
    ["Provincia de Cuando Cubango", "it", "Provincia di Cuando Cubango"],
    ["Partido de Escobar", "it", "Partido di Escobar"],
    ["Partido de Escobar", "fr", "Partido de Escobar"],
    ["Municipio de Sevilla", "it", "Comune di Siviglia"],
    ["Provincia de Córdoba", "it", "Provincia di Cordova"],
    ["Departamento Capital", "pt", "Departamento Capital"],
    [
      "Municipio regional de condado de Portneuf",
      "fr",
      "Municipalité régionale de comté de Portneuf",
    ],
  ] as const)("%s reads in %s as %s", (name, language, written, country: string = "AR") =>
    expect(as(name, language, country)).toBe(written),
  );

  test.each(["Madrid", "State College", "Valle del Cauca", "Departamento del Valle"])(
    "%s carries no designator to translate",
    (name) => {
      expect(parseDesignated(name)).toBeNull();
      expect(as(name, "es", "US")).toBe(name);
    },
  );
});

test.each([
  ["Maipu Department", "Maipú Department", true],
  ["Le Precheur", "Le Prêcheur", true],
  ["Provincia de Manica", "Província de Manica", false],
  ["Region Autonoma del Atlantico Sur", "Región Autónoma del Atlántico Sur", false],
] as const)("%s and %s carry the same designator: %s", (a, b, same) =>
  expect(sameDesignator(a, b)).toBe(same),
);
