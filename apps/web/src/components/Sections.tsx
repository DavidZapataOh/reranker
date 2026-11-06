import Image from "next/image";
import Link from "next/link";
import { Example, H2, Icon, Lede, Section, contact, icons, wa } from "./ui";
import { ScoreCard } from "./ScoreCard";
import { CookiePrefsButton } from "./Analytics";

/* 2 · Three promises, in the page's own language: highlighted phrases, no icons */
export function Promises() {
  const items = [
    { k: "Gratis y sin registro.", t: "Solo el nombre de tu negocio y tu ciudad." },
    { k: "Cada respuesta, tal como salió.", t: "Con fecha, hora, motor y ciudad. Nadie la edita, ni siquiera nosotros." },
    { k: "No vendemos puestos en ChatGPT.", t: "Nadie puede. Te mostramos qué responde y qué depende de ti." },
  ];
  return (
    <Section className="pt-20 pb-24 md:pt-24 md:pb-32">
      <ul className="grid gap-8 border-t-2 border-ink pt-8 md:grid-cols-3 md:gap-12">
        {items.map((it) => (
          <li key={it.k} className="reveal">
            <p className="font-display text-[22px] leading-tight font-black text-ink">
              <span className="marker">{it.k}</span>
            </p>
            <p className="mt-2 max-w-[34ch] text-[15.5px] leading-relaxed text-ink/70">{it.t}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* 3 · The habit shift: big sentence on paper, with a handwritten note and the stat as metadata */
export function Shift() {
  return (
    <Section labelledBy="shift-title" className="pb-24 md:pb-32">
      <div className="relative">
        <p id="shift-title" className="reveal max-w-[22ch] font-display text-[clamp(2.1rem,4.4vw,4.1rem)] leading-[1.06] font-black tracking-[-0.022em] text-balance text-ink">
          Antes te buscaban en Google y veían diez opciones. Ahora le preguntan a la IA y escuchan{" "}
          <span className="marker">dos o tres nombres.</span>
        </p>
        <div aria-hidden="true" className="reveal pointer-events-none absolute bottom-[3%] left-[52%] hidden w-[300px] lg:block">
          <p className="ml-[110px] -rotate-[5deg] font-hand text-[30px] leading-[1.05] text-ink">¿Está el tuyo?</p>
          <Image src="/plates/arrow-buscan-v2.png" alt="" width={491} height={163} className="mt-0 w-[120px]" />
        </div>
        <p className="reveal mt-8 font-mono text-[13px] text-ink/60">
          83 % de los colombianos conectados ya usa inteligencia artificial · Google e Ipsos, octubre de 2026
        </p>
      </div>
    </Section>
  );
}

/* 5 · What you get: bento with live product in each card */
export function Bento() {
  return (
    <Section id="producto" labelledBy="bento-title" className="py-24 md:py-32">
      <H2 id="bento-title">Todo lo que la IA dice de ti, en un solo lugar.</H2>
      <Lede>Sin jerga: quién sale cuando te buscan, qué tan seguido apareces tú y qué cambiar primero.</Lede>

      <div className="relative mt-12 grid gap-4 md:grid-cols-6 md:gap-5">
        <div aria-hidden="true" className="pointer-events-none absolute -top-14 left-[34%] hidden items-end gap-1 lg:flex">
          <Image src="/plates/arrow-buscan-v2.png" alt="" width={491} height={163} className="w-[86px] translate-y-6 -rotate-[30deg] -scale-y-100" />
          <p className="-rotate-[4deg] font-hand text-[26px] leading-none text-ink">Empieza por aquí</p>
        </div>
        <ScoreCard className="md:col-span-3" />

        {/* Competitors */}
        <article className="reveal rounded-3xl bg-white p-6 ring-1 ring-line md:col-span-3 md:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[19px] font-bold text-ink">Quién sale en tu lugar</h3>
              <p className="mt-1 text-[15px] text-ink/65">Clínicas dentales · Bogotá · 10 preguntas</p>
            </div>
            <Example />
          </div>
          <ol className="mt-7 space-y-3.5">
            {[
              { n: "Dental Usaquén", v: 8 },
              { n: "Sonrisa Chicó", v: 6 },
              { n: "Odonto Norte", v: 4 },
              { n: "Tu negocio", v: 1, you: true },
            ].map((r, i) => (
              <li key={r.n} className="grid grid-cols-[1.4rem_1fr_auto] items-center gap-3">
                <span className="font-mono text-[13px] text-ink/45">{i + 1}</span>
                <div>
                  <p className={`text-[15px] ${r.you ? "font-semibold text-ink" : "text-ink/85"}`}>{r.n}</p>
                  <span className="mt-1.5 block h-2 rounded-full bg-bubble">
                    <span
                      className={`bar block h-2 rounded-full ${r.you ? "bg-amber" : "bg-green"}`}
                      style={{ width: `${r.v * 10}%` }}
                    />
                  </span>
                </div>
                <span className="font-mono text-[13px] text-ink/70">{r.v}/10</span>
              </li>
            ))}
          </ol>
        </article>

        {/* Receipt */}
        <article className="reveal rounded-3xl bg-white p-6 ring-1 ring-line md:col-span-2 md:p-7">
          <h3 className="text-[19px] font-bold text-ink">Cada respuesta, guardada tal cual</h3>
          <p className="mt-1 text-[15px] text-ink/65">Para que puedas volver a ella cuando quieras.</p>
          <div className="relative mt-6 rounded-2xl bg-paper p-5 font-mono text-[12.5px] leading-relaxed text-ink/80 ring-1 ring-line">
            <p>Perplexity · Cali</p>
            <p>04 nov 2026 · 10:42</p>
            <p className="mt-2 font-sans text-[14px] text-ink">“Para un taller de confianza en Cali, te sugiero Motor Valle y…”</p>
            <p className="mt-3 text-ink/50">ID rr_7f3a·91c2</p>
            <span className="stamp absolute -top-4 -right-3 grid h-[74px] w-[74px] rotate-[-12deg] place-items-center rounded-full bg-amber text-center font-display text-[11px] leading-tight font-black text-ink shadow-soft">
              Guardada
              <br />
              sin editar
            </span>
          </div>
          <a href="#preguntas" className="mt-5 inline-flex items-center gap-1.5 text-[15px] font-semibold text-green hover:underline">
            Cómo se verifica <Icon d={icons.arrow} className="h-4 w-4" />
          </a>
        </article>

        {/* Fix */}
        <article className="reveal rounded-3xl bg-white p-6 ring-1 ring-line md:col-span-2 md:p-7">
          <h3 className="text-[19px] font-bold text-ink">Corrige en un clic</h3>
          <p className="mt-1 text-[15px] text-ink/65">Te proponemos el cambio. Tú decides.</p>
          <div className="mt-6 rounded-2xl p-4 shadow-lift ring-1 ring-line">
            <p className="text-[14px] leading-snug text-ink">
              <strong className="font-semibold">Perfil de Google:</strong> agrega la categoría “Clínica dental”.
            </p>
            <div className="mt-4 flex gap-2">
              <span className="inline-flex h-9 flex-1 items-center justify-center rounded-lg bg-green text-[14px] font-semibold text-white">Aprobar</span>
              <span className="inline-flex h-9 flex-1 items-center justify-center rounded-lg text-[14px] text-ink ring-1 ring-ink/15">Ahora no</span>
            </div>
          </div>
          <p className="mt-4 text-[13.5px] text-ink/60">Nada se publica sin tu aprobación.</p>
        </article>

        {/* Alerts */}
        <article className="reveal rounded-3xl bg-white p-6 ring-1 ring-line md:col-span-2 md:p-7">
          <h3 className="text-[19px] font-bold text-ink">Te avisamos cuando algo cambia</h3>
          <p className="mt-1 text-[15px] text-ink/65">Por correo, o por WhatsApp si lo prefieres.</p>
          <div className="mt-6 space-y-2.5">
            <div className="flex gap-3 rounded-2xl bg-paper p-4 ring-1 ring-line">
              <Image src="/engines/gemini.svg" alt="" width={20} height={20} className="mt-0.5 h-5 w-5" />
              <p className="text-[14px] leading-snug text-ink">
                Gemini empezó a recomendar a <strong className="font-semibold">Sonrisa Chicó</strong>.
                <span className="mt-1 block font-mono text-[12px] text-ink/50">hoy · 08:15</span>
              </p>
            </div>
            <div className="flex gap-3 rounded-2xl bg-paper p-4 ring-1 ring-line">
              <Image src="/brand/reranker-symbol.svg" alt="" width={20} height={20} className="mt-0.5 h-5 w-5" />
              <p className="text-[14px] leading-snug text-ink">
                Semana tranquila: nada cambió.
                <span className="mt-1 block font-mono text-[12px] text-ink/50">lun · 07:00</span>
              </p>
            </div>
          </div>
        </article>
      </div>
    </Section>
  );
}

function Tile({ t }: { t: { icon: string | null; name: string; note: string; soon?: boolean } }) {
  return (
  <li className="flex items-center gap-3.5 rounded-2xl bg-white px-4 py-3.5 shadow-soft ring-1 ring-line">
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-paper ring-1 ring-line">
      {t.icon ? (
        <Image src={t.icon} alt="" width={24} height={24} className="h-6 w-6" />
      ) : (
        <Icon d={t.name === "Correo" ? "M3 6h18v12H3zM3 7l9 6 9-6" : "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"} className="h-[22px] w-[22px] text-ink/75" />
      )}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[15.5px] font-semibold text-ink">{t.name}</span>
      <span className="block text-[13.5px] text-ink/60">{t.note}</span>
    </span>
    {t.soon && <span className="rounded-full bg-bubble px-2 py-0.5 text-[11.5px] font-semibold text-ink/60">Pronto</span>}
  </li>
);
}

/* 8 · Where it acts: the AI builds its answer from what it finds about you; that's where we plug in */
export function Connect() {
  const reads = [
    { icon: "/engines/google.svg", name: "Perfil de Google", note: "Horarios, categorías, fotos" },
    { icon: "/engines/googlemaps.svg", name: "Reseñas y mapas", note: "Lo que dicen tus clientes" },
    { icon: null, name: "Tu página web", note: "Servicios, precios, preguntas" },
  ];
  const tells = [
    { icon: "/engines/whatsapp.svg", name: "WhatsApp", note: "Alertas, si las aceptas" },
    { icon: null, name: "Correo", note: "Tu resumen cada semana" },
    { icon: "/engines/shopify.svg", name: "Shopify", note: "Tu catálogo", soon: true },
  ];
  const ys = [16.5, 50, 83.5];
  return (
    <Section id="conexiones" labelledBy="connect-title" className="py-24 md:py-32">
      <div className="max-w-[640px]">
        <H2 id="connect-title">Corregimos donde la IA lee.</H2>
        <Lede>La IA arma su respuesta con lo que encuentra de ti en internet. Ahí hacemos los cambios, y te avisamos por donde ya hablas.</Lede>
      </div>

      <div className="relative mt-14 grid gap-6 lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-0">
        {/* Lines connecting everything to the center (desktop only) */}
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" viewBox="0 0 100 100" preserveAspectRatio="none">
          {ys.map((y) => (
            <g key={y}>
              <path d={`M33 ${y} C 42 ${y}, 41 50, 50 50`} className="flow" />
              <path d={`M67 ${y} C 58 ${y}, 59 50, 50 50`} className="flow flow-out" />
            </g>
          ))}
        </svg>

        <div className="relative">
          <p className="mb-3 text-[13px] font-semibold text-ink/55 lg:hidden">Lo que lee la IA</p>
          <ul className="space-y-4 lg:pr-[22%]">{reads.map((t) => <Tile key={t.name} t={t} />)}</ul>
        </div>

        <div className="relative z-10 order-first flex flex-col items-center lg:order-none lg:px-6">
          <span className="grid h-20 w-20 place-items-center rounded-[22px] lg:h-[112px] lg:w-[112px] lg:rounded-[30px] bg-white shadow-lift ring-1 ring-line">
            <Image src="/brand/reranker-symbol.svg" alt="" width={64} height={64} className="h-11 w-11 lg:h-16 lg:w-16" />
          </span>
          <span className="mt-3 text-[14px] font-semibold text-ink">reranker</span>
        </div>

        <div className="relative">
          <p className="mb-3 text-[13px] font-semibold text-ink/55 lg:hidden">Por donde te contamos</p>
          <ul className="space-y-4 lg:pl-[22%]">{tells.map((t) => <Tile key={t.name} t={t} />)}</ul>
        </div>
      </div>
    </Section>
  );
}

/* 9 · Pricing in pesos */
export function Pricing() {
  const plans = [
    {
      name: "Reporte gratis",
      price: "$0",
      per: "",
      note: "Para ver dónde estás hoy.",
      items: ["ChatGPT, Gemini, Google y Perplexity", "Tu negocio frente a tu competencia", "La primera corrección que puedes hacer"],
      cta: "Ver qué dice la IA",
      href: "#reporte",
      primary: false,
    },
    {
      name: "Esencial",
      price: "$149.000",
      per: "al mes",
      note: "Para un negocio en una ciudad.",
      items: ["Seguimiento cada semana", "Correcciones guiadas en un clic", "Alertas cuando algo cambia", "Respuestas guardadas y verificables"],
      cta: "Empezar con Esencial",
      href: "#reporte",
      primary: true,
    },
    {
      name: "Pro",
      price: "$299.000",
      per: "al mes",
      note: "Para varias sedes o ciudades.",
      items: ["Todo lo de Esencial", "Varias sedes y ciudades", "Competidores sin límite", "Correcciones automáticas que tú apruebas"],
      cta: "Empezar con Pro",
      href: "#reporte",
      primary: false,
    },
  ];
  return (
    <Section id="precios" labelledBy="pricing-title" className="bg-white py-24 md:py-32">
      <H2 id="pricing-title">Precios en pesos, sin permanencia.</H2>
      <Lede>Pagas con PSE, Nequi o tarjeta, y cancelas cuando quieras.</Lede>
      <div className="relative mt-12 grid gap-5 lg:grid-cols-3">
        <div aria-hidden="true" className="pointer-events-none absolute -top-12 left-[52%] hidden items-end gap-1 lg:flex">
          <Image src="/plates/arrow-buscan-v2.png" alt="" width={491} height={163} className="w-[80px] translate-y-6 -rotate-[30deg] -scale-y-100" />
          <p className="-rotate-[4deg] font-hand text-[26px] leading-none text-ink">Con este empiezas bien</p>
        </div>
        {plans.map((p) => (
          <article
            key={p.name}
            className={`reveal flex flex-col rounded-3xl p-7 md:p-8 ${p.primary ? "bg-paper ring-2 ring-green" : "bg-paper ring-1 ring-line"}`}
          >
            <h3 className="text-[18px] font-bold text-ink">{p.name}</h3>
            <p className="mt-1 text-[15px] text-ink/65">{p.note}</p>
            <p className="mt-6 flex items-baseline gap-2">
              <span className="font-display text-[44px] leading-none font-black tracking-[-0.02em] text-ink tabular-nums">{p.price}</span>
              {p.per && <span className="text-[15px] text-ink/60">{p.per}</span>}
            </p>
            <ul className="mt-7 flex-1 space-y-3">
              {p.items.map((i) => (
                <li key={i} className="flex gap-2.5 text-[15.5px] text-ink/85">
                  <Icon d={icons.check} className="mt-0.5 h-5 w-5 shrink-0 text-green" />
                  {i}
                </li>
              ))}
            </ul>
            <a
              href={p.href}
              className={`mt-8 inline-flex h-12 items-center justify-center rounded-xl text-[15.5px] font-semibold transition-colors ${
                p.primary ? "bg-green text-white hover:bg-green-deep" : "bg-white text-ink ring-1 ring-ink/15 hover:ring-ink/30"
              }`}
            >
              {p.cta}
            </a>
          </article>
        ))}
      </div>
    </Section>
  );
}

/* 10 · Agencies */
export function Agencies() {
  return (
    <Section id="agencias" labelledBy="agencies-title" className="py-24 md:py-28">
      <div className="reveal grid gap-8 rounded-[28px] bg-ink p-8 text-paper md:grid-cols-[1.3fr_1fr] md:items-center md:p-14">
        <div>
          <h2 id="agencies-title" className="font-display text-[clamp(1.9rem,3vw,2.6rem)] leading-[1.1] font-black tracking-[-0.02em]">
            ¿Tienes una agencia? Mide a tus clientes con tu marca.
          </h2>
          <p className="mt-4 max-w-[48ch] text-[16.5px] leading-relaxed text-paper/75">
            Reportes con tu logo y tu dominio, en pesos y con margen para ti. El programa de socios empieza en $249.000 al mes.
          </p>
        </div>
        <div className="md:justify-self-end">
          <a href={wa("Hola, tengo una agencia y quiero conocer el programa de socios de Reranker.")} target="_blank" rel="noopener" className="inline-flex h-12 items-center gap-2 rounded-xl bg-paper px-6 text-[15.5px] font-semibold text-ink transition-colors hover:bg-green-light">
            Conocer el programa <Icon d={icons.arrow} className="h-4 w-4" />
          </a>
        </div>
      </div>
    </Section>
  );
}

/* 11 · FAQ */
/** FAQ copy, shared with the FAQPage structured data in app/page.tsx. */
export const faqItems: [string, string][] = [
  ["¿Por qué ChatGPT habla de mi negocio si yo nunca le dije nada?", "La IA arma sus respuestas con lo que encuentra publicado: tu perfil de Google, tus reseñas, directorios y tu página. Por eso conviene saber qué está diciendo y de dónde lo saca."],
  ["¿Me pueden poner de primeros en ChatGPT?", "No, y nadie puede prometerlo con honestidad. Te mostramos qué responde hoy, corregimos contigo lo que depende de ti y medimos si cambia."],
  ["Si yo le pregunto a ChatGPT, ¿me sale lo mismo?", "No siempre: la IA cambia sus respuestas de una vez a otra. Por eso preguntamos varias veces y te damos un rango, no una sola captura."],
  ["¿Cómo sé que la respuesta que me muestran es la real?", "Guardamos cada respuesta tal como la dio la IA, con fecha y hora. Nadie puede editarla, ni siquiera nosotros, y puedes revisarla en reranker.co/verificar."],
  ["¿Tengo que saber de tecnología o cambiar mi página?", "No. Te decimos una acción a la vez, en palabras normales. Muchas correcciones se hacen en tu perfil de Google."],
  ["¿Van a publicar algo en nombre de mi negocio sin preguntarme?", "No. Cada cambio te llega como propuesta y solo se aplica si lo apruebas."],
  ["¿Cuánto cuesta y tengo que firmar permanencia?", "El primer reporte es gratis. Los planes cuestan lo que ves arriba, sin permanencia. Pagas con PSE, Nequi o tarjeta y recibes factura electrónica."],
];

export function Faq() {
  const qa = faqItems;
  return (
    <Section id="preguntas" labelledBy="faq-title" className="bg-white py-24 md:py-32">
      <div className="grid gap-12 md:grid-cols-[1fr_1.6fr] md:gap-16">
        <H2 id="faq-title">Lo que nos preguntan los dueños.</H2>
        <div className="divide-y divide-line border-y border-line">
          {qa.map(([q, a]) => (
            <details key={q} className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 rounded-lg py-5 text-[17px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                {q}
                <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bubble text-ink transition-transform duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-open:rotate-45">
                  <Icon d={icons.plus} className="h-4 w-4" />
                </span>
              </summary>
              <p className="max-w-[60ch] pr-12 pb-6 text-[16px] leading-relaxed text-ink/75">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* Footer: columns like the reference sites + the large wordmark as our own sign-off */
export function Footer() {
  const cols = [
    {
      t: "Producto",
      l: [
        ["Cómo funciona", "/#como-funciona"],
        ["Lo que recibes", "/#producto"],
        ["Dónde corregimos", "/#conexiones"],
        ["Precios", "/#precios"],
        ["Para quién", "/#para-quien"],
      ],
    },
    {
      t: "Ayuda",
      l: [
        ["Preguntas frecuentes", "/#preguntas"],
        ["Para agencias", "/#agencias"],
      ],
    },
  ];
  return (
    <footer id="contacto" className="overflow-hidden border-t border-line bg-white">
      <div className="mx-auto max-w-[1280px] px-5 pt-16 md:px-10 md:pt-20">
        <div className="grid gap-12 md:grid-cols-[1.3fr_2fr]">
          <div>
            <Image src="/brand/reranker-horizontal.svg" alt="reranker" width={131} height={40} className="h-10 w-auto" />
            <p className="mt-4 max-w-[30ch] text-[15.5px] leading-relaxed text-ink/70">Lo que la IA dice de tu negocio, y qué cambiar para que salgas tú.</p>
            <Link href="/#reporte" className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-green ring-1 ring-green/30 transition-colors hover:bg-green-light">
              Ver qué dice la IA <Icon d={icons.arrow} className="h-4 w-4" />
            </Link>
          </div>
          <nav aria-label="Pie de página" className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 md:justify-self-end md:gap-x-16">
            {cols.map((c) => (
              <div key={c.t}>
                <p className="text-[13px] font-semibold text-ink/50">{c.t}</p>
                <ul className="mt-4 space-y-3">
                  {c.l.map(([label, href]) => (
                    <li key={label}>
                      <a href={href} className="text-[15px] text-ink/85 transition-colors hover:text-green">
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <p className="text-[13px] font-semibold text-ink/50">Hablemos</p>
              <ul className="mt-4 space-y-3">
                <li>
                  <a href={wa("Hola, quiero saber más sobre Reranker.")} target="_blank" rel="noopener" className="inline-flex items-center gap-2 text-[15px] text-ink/85 transition-colors hover:text-green">
                    <Image src="/engines/whatsapp.svg" alt="" width={18} height={18} className="h-[18px] w-[18px]" />
                    WhatsApp
                  </a>
                </li>
                <li>
                  <a href={`mailto:${contact.email}`} className="text-[15px] text-ink/85 transition-colors hover:text-green">
                    {contact.email}
                  </a>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="mt-16 flex flex-col gap-3 border-t border-line py-6 text-[13.5px] text-ink/55 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Reranker</p>
          <ul className="flex gap-6">
            <li><Link href="/politica-de-datos" className="hover:text-green">Política de datos</Link></li>
            <li><Link href="/terminos" className="hover:text-green">Términos</Link></li>
            <li><CookiePrefsButton /></li>
          </ul>
        </div>
      </div>

      {/* The wordmark, large and cropped: our own visual sign-off */}
      <div aria-hidden="true" className="mx-auto max-w-[1280px] px-5 md:px-10">
        <div
          className="aspect-[609/200] w-full translate-y-[30%] bg-green-light"
          style={{
            WebkitMaskImage: "url(/brand/reranker-wordmark.svg)",
            maskImage: "url(/brand/reranker-wordmark.svg)",
            WebkitMaskSize: "100% auto",
            maskSize: "100% auto",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
          }}
        />
      </div>
    </footer>
  );
}
