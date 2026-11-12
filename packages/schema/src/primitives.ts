import { z } from "./z.ts";

// Postgres prints uuids in lowercase, so mixed-case input is normalized to compare equal.
export const Uuid = z.uuid().transform((value) => value.toLowerCase());
