# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 16 (App Router) + Tailwind CSS 4 in `apps/web`, inside the project monorepo. The landing is prerendered (static HTML served from Vercel's cache) with small client islands for motion and the demo. Hosting: Vercel. Confirmed by the founder on 4 Nov 2026.

## Users

- **Primary:** owners of SMBs anywhere in the Spanish-speaking world (anyone in any country can use and pay; distribution effort concentrates in Colombia) with high-ticket customers — aesthetic and dental clinics, boutique hotels, real estate, lawyers, online shops (DTC brands) — first in Bogotá and Medellín. Not technical, live in WhatsApp, distrust marketing "humo". Most are unaware or barely aware that customers ask ChatGPT/Gemini for recommendations; half of the firms not adopting AI call it "irrelevant".
- **Secondary:** marketing coordinators at those businesses, and marketing agencies that resell the product.
- **Situation on the landing:** arrive from Meta ads, search, agency referrals or AI answers, mostly on mobile; decide in seconds whether to type their business name.

## Product Purpose

Reranker (reranker.co) shows a business owner what ChatGPT, Gemini and Google's AI answer when a customer asks for what they sell in their city, helps them fix what the AI gets wrong or omits, and keeps the record of each answer exactly as it came out. Success on the landing: the visitor types their business name and runs the free report.

## Positioning

- City-level measurement in Spanish for local businesses (competitors measure at country level, in English, or for enterprises).
- Every AI answer is stored as-is with date, engine and city, and can be checked by anyone (the "evidence receipt"). This is shown, never shouted: the founder ruled that headlines must not stress "proof" because users take it for granted.
- Priced in the visitor's currency, chosen at the edge from the visitor's country: COP in Colombia (PSE, Nequi or card, Colombian electronic invoicing), EUR in the euro area and USD elsewhere (card, Apple Pay or Google Pay). Operated by GLEMO S.A.S. (Medellín).

## Operating Context

- Free report: business name + detected city → the AI answers about that category and city. **The backend does not exist yet**: the landing runs a simulated demo clearly labeled "Ejemplo".
- Engines measured in the MVP: ChatGPT, Gemini, Google (AI Overviews / AI Mode) and Perplexity; Copilot, Claude and Meta AI later. Rotator order: ChatGPT ▸ Gemini ▸ Google ▸ Perplexity (the four engines in the MVP).
- Customers reach the company by WhatsApp (+57) and email; agencies through a partner program.

## Capabilities and Constraints

- Recommendation score 0–100, always shown as a big number with its range in small print; levels *Invisible / A veces / En la lista / De los fijos*.
- "Corregir con un clic" proposals the owner approves (Google Business Profile, website, catalog); nothing is published without approval.
- Leads from AI counted via WhatsApp — only shown once the mechanism works, with "atribuidos" and "probables" separated.
- Free report promise: "menos de 2 minutos" (not "60 segundos") until measured in production.
- Never promise rankings or positions ("te ponemos primero en ChatGPT" is banned). Never say "tus datos no entrenan IA".
- Same HTML for humans and bots; no hidden `sr-only` content written for AI crawlers (cloaking risk).
- Pricing (founder-approved starting points): free report · Esencial COP 149.000 / €45 / US$39 · Pro COP 299.000 / €95 / US$79 · agencies from COP 249.000 / €179 / US$69, monthly, no lock-in. Prices always carry their currency code or symbol.
- Example questions and receipts mix cities across Spanish-speaking countries, Colombia included but not exclusive. Receipt labels stay honest: ChatGPT and Perplexity per country, Gemini and Google per city.

## Brand Commitments

- Name always lowercase "reranker" via the logo files in `apps/web/public/brand/`. Descriptor: "lo que la IA dice de tu negocio".
- Personality: "La app que te cuenta" — warm, close, clear, honest. Voice: tú by default; usted for health, legal and universities.
- Headline (chosen 4 Nov 2026 after research): **"Tus clientes le preguntan a [ChatGPT]. Que salgas tú."** with a one-cycle rotating engine name + logo (ChatGPT, Gemini, Google, Perplexity), and the city in the subtitle.
- Palette, type and logo are fixed in the brand guide: green #0F5C45, amber #F2B544 (accent only, never text), paper #FAF7F0, ink #14211B, light green #D9EBD7; Nunito 800–900, Plus Jakarta Sans 400/500/700, JetBrains Mono 400/600. Bans: purple/violet, gradients, sparkles ✨, robots, WhatsApp green.
- Founder's visual references: Searchable (main: product-led sections, AI logos rotating in the hero, typing agent), Beside (business-name + detected-city hero with the product working below), Visitors (bento cards with live mini-products), Wise (ownable branding). Disliked: Profound (dark, cluttered), Jobber (dated, static).
- Engine logos (ChatGPT, Gemini, Google) shown in color in the rotator, per the founder; use them per each owner's brand guidelines.

## Evidence on Hand

- Logo kit: `apps/web/public/brand/` (copied from the internal brand folder).
- **No customers, testimonials, case studies, press or usage numbers exist yet. None may be fabricated.** AI-generated people may be used only as ambience, never with a name or a quote.
- External facts usable with source: 66% of adults in 21 countries, including Spain, Mexico and Argentina, used AI in the last year (Google/Ipsos Multi-Country AI Survey, Jan 2026; shown on the landing); 83% of connected Colombians use AI (Google/Ipsos, Oct 2026); 45% of Colombian travelers use AI for local recommendations (Booking 2026); 1 in 4 working-age Colombians use generative AI (Microsoft AI Diffusion via Forbes Colombia, Q2 2026).

## Product Principles

1. Show the product doing the thing; don't describe it.
2. Warm in words, exact in numbers (ranges, dates, sources).
3. Never promise what the AI will do; show what it says today and what can be changed.
4. Follow patterns experts repeat; treat gaps as possible red flags; keep a few labeled bets.
5. Mobile first: the owner decides on a phone.

## Accessibility & Inclusion

WCAG 2.2 AA. Rotating text runs one cycle under 5 s then stops (2.2.2), reduced motion respected, contrast ≥ 4.5:1 (amber never as text).
