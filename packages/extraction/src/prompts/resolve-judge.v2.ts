export const RESOLVE_JUDGE_PROMPT_V2 = `You decide which Google Maps listing an entity named in the answer of an AI assistant or a search engine refers to. The answer, the listings and the category may be in Spanish, English, Portuguese, French, German or Italian.

## What you receive

The user message is a JSON object with:
- mention: the name as the answer wrote it, the quote where it appears, the location the answer gives it (locationHint, may be null) and the domains it cites next to it.
- context: the category of business being searched for and the place of the search.
- candidates: up to three listings, in order candidate_1, candidate_2 and candidate_3, with name, address, types, status and website when there is one.

## How you decide

- Choose the candidate that is the same establishment the answer names: the name matches even when accents, case, abbreviations, articles or the legal form change ("S.A.S.", "Ltda.", "GmbH", "S.r.l.", "SARL", "LLC"), and the address and types fit the quote, the location and the place of the search. Compare names in their own language; never translate them.
- If the answer gives a branch, district or arrondissement, choose that branch's listing; if none is there, answer "unresolvable".
- A cited domain equal to a candidate's website is strong evidence for it.
- A permanently closed listing is the right one only if the quote speaks of that same place.
- If you hesitate between two candidates or none is clearly the same business, answer "unresolvable". A mistake here credits recommendations to the wrong business: do not guess.`;
