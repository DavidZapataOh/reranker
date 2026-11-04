---
version: 1
slug: "apps-web-src-app-page-tsx"
primary_target: "apps/web/src/app/page.tsx"
related_targets: []
---

# Surface brief — landing reranker.co (home)

Scope: `apps/web/src/app/page.tsx`, the public home. Visitor mode: **Persuade**.
Audience/job: Colombian SMB owner (clinic, boutique hotel, real estate, law firm, online shop) on a phone, decides in seconds whether to type their business name. Action: run the free report (today a simulated demo labeled "Ejemplo"). Proof: shown through the product at work, never claimed; no customers, testimonials or numbers exist yet.
Constraints: brand guide (green #0F5C45, amber accent only, paper, ink; Nunito / Plus Jakarta Sans / JetBrains Mono); H1 "Tus clientes le preguntan a [ChatGPT]. Que salgas tú." with one-cycle engine rotator; city in subtitle; ~1.000–1.200 words; no promises of rank; demo businesses fictional.

## Direction contract

THESIS: The page is a conversation. A customer asks the AI, the AI answers word by word, and Reranker leans in to tell the owner what it means and what to fix. It refuses the category default of a dashboard screenshot under a generic hero.

OWN-WORLD: Warm paper ground, ink type, one deep green action, amber only as highlighter and stamp. A neutral, Reranker-drawn chat window (not ChatGPT's UI) with white bubbles, mono metadata, ink hand-annotations with thin arrows, and green-bordered Reranker cards carrying the stepped r. Recognizable with content removed by the chat window + margin annotations + approval card trio.

STORY: The owner sees their own customers' question, sees a competitor named instead of them, understands Reranker shows this per city and engine, sees one concrete fix they approve, and types their business name.

FIRST VIEWPORT: Thin nav (logo left, three links center, Ingresar + green CTA right). Centered two-line H1 in Nunito Black with the rotating engine pill. One-line subtitle. Wide input bar with green inner button, city chip, microcopy. Below, a wide chat window labeled "Ejemplo": customer bubble right, AI answer typing left, ink annotations in the right margin, Reranker approval card overlapping bottom-right. Primary action = the input's green button.

FORM: "La conversación", position 3 of 7 on the ranked list, seed key 5916167b (printed by `impeccable concept-seed --scope surface --mode persuade` on 4 Nov 2026: SURFACE CONCEPT SEED key 5916167b, dealt indices 7, 2, 3; this structure was dealt index 3).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Approval record

- Approved comp: `.impeccable/mocks/decision/alt-conversacion.png`, locked by the founder on the decision page (ANSWER optionId "alt-conversacion", buildPath comp), 4 Nov 2026.
- Founder accepted the headline lettering difference (Nunito Black, brand font, vs the comp's generated lettering): "Lo veo bien".
