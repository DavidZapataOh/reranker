---
name: Reranker
description: Lo que la IA dice de tu negocio, con pruebas.
colors:
  green: "#0f5c45"
  green-deep: "#0b4a37"
  green-light: "#d9ebd7"
  amber: "#f2b544"
  paper: "#faf7f0"
  surface: "#ffffff"
  bubble: "#f1f2ef"
  ink: "#14211b"
  ink-soft: "#14211bb3"
  line: "#14211b14"
typography:
  display:
    fontFamily: "Nunito, ui-rounded, 'SF Pro Rounded', system-ui, sans-serif"
    fontSize: "clamp(2.4rem, 3.875vw, 3.72rem)"
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: "-0.022em"
  statement:
    fontFamily: "Nunito, ui-rounded, 'SF Pro Rounded', system-ui, sans-serif"
    fontSize: "clamp(2.1rem, 4.4vw, 4.1rem)"
    fontWeight: 900
    lineHeight: 1.06
    letterSpacing: "-0.022em"
  headline:
    fontFamily: "Nunito, ui-rounded, 'SF Pro Rounded', system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 3.05rem)"
    fontWeight: 900
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  numeral:
    fontFamily: "Nunito, ui-rounded, 'SF Pro Rounded', system-ui, sans-serif"
    fontSize: "clamp(4.5rem, 8vw, 6rem)"
    fontWeight: 900
    lineHeight: 0.85
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  title:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  lede:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.05rem, 1.2vw, 1.15rem)"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.2
  evidence:
    fontFamily: "JetBrains Mono, ui-monospace, 'SFMono-Regular', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  hand:
    fontFamily: "Caveat, 'Segoe Print', cursive"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: 1
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  field: "22px"
  card: "24px"
  band: "28px"
  pill: "9999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  section: "96px"
  section-md: "128px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 20px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.green-deep}"
    textColor: "{colors.surface}"
  button-primary-large:
    backgroundColor: "{colors.green}"
    textColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "0 32px"
    height: "56px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "48px"
  input-business:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "8px 8px 8px 20px"
  chip-city:
    backgroundColor: "{colors.green-light}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "36px"
    padding: "0 12px 0 14px"
  chip-example:
    backgroundColor: "{colors.green-light}"
    textColor: "{colors.green}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 10px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "32px"
  card-inset:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  bubble-question:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "10px 16px"
  nav-link:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
---

# Design System: Reranker

## Overview

**Creative North Star: "La conversación anotada"**

Reranker se ve como una conversación con una IA impresa sobre papel cálido, que alguien de confianza ya leyó con un lápiz en la mano. Una ventana de chat propia (blanca, neutra, nunca la interfaz de ChatGPT) muestra lo que pregunta un cliente y lo que responde la IA; en el margen, notas a mano en tinta con flechas finas dicen qué significa; y una tarjeta de Reranker con la r escalonada propone un arreglo que el dueño aprueba. Ese trío, chat + anotación al margen + tarjeta de aprobación, es la firma del sistema y se reconoce aun sin texto.

El suelo es papel (70 % de la superficie), la voz es tinta, y el color se gana: un solo verde profundo carga la acción, y el ámbar aparece solo como resaltador detrás de la tinta o como sello. La densidad es baja y editorial: secciones de 96–128 px de aire, titulares Nunito Black grandes y redondeados, cuerpo en Plus Jakarta Sans, y los datos (fechas, rangos, IDs) en JetBrains Mono para decir "esto es un dato". La prueba se muestra con producto funcionando dentro de tarjetas, nunca con un pantallazo de dashboard.

Rechazos confirmados por la marca: la estética de "IA mágica" (violeta, destellos, robots), los degradados de color y el verde WhatsApp.

**Key Characteristics:**
- Papel cálido, tinta, un verde de acción, ámbar solo como resaltador o sello.
- Ventana de chat propia con burbujas blancas y grises, como escenario del producto.
- Anotaciones a mano (Caveat, tinta) con flechas finas en el margen.
- Tarjetas blancas de 24 px con borde de tinta al 8 %, sin sombra en reposo.
- Metadatos en mono como evidencia.
- El escalón (subir dos pasos) como único movimiento de marca.

## Colors

Paleta cálida y contenida: papel y tinta hacen casi todo el trabajo; el verde actúa y el ámbar subraya.

### Primary
- **Verde verificado** (green): botones de acción, número del paso activo, barras de datos, check de listas, borde del plan destacado, enlaces de texto. Nunca se aclara.
- **Verde hondo** (green-deep): solo estado hover/active del verde.
- **Verde claro** (green-light): chips (ciudad, "Ejemplo"), pista de la escalera de niveles, selección de texto, hover del botón sobre tinta.

### Secondary
- **Ámbar sello** (amber): resaltador detrás de frases clave, sello circular "Guardada sin editar", punto del nivel actual, barra de "Tu negocio" frente a la competencia. Siempre con tinta encima o como forma sin texto.

### Neutral
- **Papel** (paper): fondo base, interior de tarjetas de plan y de paneles internos (recibo, alertas, panel de pasos).
- **Blanco superficie** (surface): tarjetas, ventana de chat, campo de búsqueda, y bandas de sección alternas (Cómo funciona, Para quién, Precios, Preguntas).
- **Burbuja** (bubble): burbuja de pregunta del cliente, avatares circulares, pista de barras, botón circular del acordeón.
- **Tinta** (ink): todo el texto, la regla gruesa de 2 px que abre listas editoriales, y la única banda oscura (agencias).
- **Tinta suave** (ink-soft) y opacidades de tinta (75 %, 65 %, 60 %, 45 %): ledes, descripciones, metadatos y placeholder, en ese orden de jerarquía.
- **Línea** (line): todos los bordes y divisores (tinta al 8 %), aplicados como ring de 1 px.

### Named Rules
**The One Green Action Rule.** El verde es la acción. Los demás botones son blancos con ring de tinta al 15 %, o papel sobre tinta.

**The Ink-Over-Amber Rule.** El ámbar nunca es texto ni ícono suelto sobre papel (1,7:1). Va detrás de la tinta como resaltador (franja del 58 % al 92 % de la línea, 75 % de opacidad) o como forma con tinta encima.

## Typography

**Display Font:** Nunito 800–900 (con ui-rounded, SF Pro Rounded)
**Body Font:** Plus Jakarta Sans 400–700 (con system-ui)
**Label/Mono Font:** JetBrains Mono 400/600 para evidencia; Caveat 500–600 para anotaciones a mano

**Character:** Titulares redondeados, gruesos y apretados que hablan de cerca, sobre un cuerpo limpio con un poco de espacio entre palabras (0,04em). El mono y la mano son dos voces opuestas del mismo margen: el dato exacto y el comentario humano.

### Hierarchy
- **Display** (900, clamp 2.4–3.72rem, 1.2): solo el H1 del hero, dos líneas centradas con la píldora de motor en línea.
- **Statement** (900, clamp 2.1–4.1rem, 1.06): frase-tesis a toda anchura sobre papel, máx. 22ch, con resaltador ámbar en el remate.
- **Headline** (900, clamp 2–3.05rem, 1.08, text-balance): H2 de sección; el cierre sube a 3.6rem.
- **Numeral** (900, clamp 4.5–6rem, 0.85, tabular): puntaje; precios en 44 px con el mismo trato.
- **Title** (Jakarta 700, 18–19 px): títulos de tarjeta, pasos, criterios de confianza. Preguntas del FAQ en 17 px 600.
- **Body / Lede** (16 px 1.5 / clamp 1.05–1.15rem 1.625): ledes a 56ch máx. al 75 % de tinta; cuerpo de tarjeta en 15–15.5 px.
- **Label** (Jakarta 600, 14–17 px): botones, chips, nombres.
- **Evidence** (Mono 12–13 px, tinta al 45–60 %): fechas, horas, rangos, IDs, contadores (8/10, ×10), fuentes de datos.
- **Hand** (Caveat 500, 20–30 px, rotada −4° a −11°): anotaciones en el margen, siempre en tinta, siempre aria-hidden.

### Named Rules
**The Two Margins Rule.** Mono es el dato, la mano es el comentario. La mano nunca carga información que no esté también en el texto real.

## Layout

Contenedor de 1280 px con 20 px de margen en móvil y 40 px desde md; nav y hero se abren a 1536 px y escalan con vw para seguir el comp. Secciones con 96 px de padding vertical (128 px desde md) y el cierre con 112/144 px. Las bandas alternan papel y blanco para separar secciones sin líneas.

Patrones recurrentes: titular a la izquierda + lede, y debajo una retícula (bento de 6 columnas con tarjetas de 3+3 y 2+2+2; precios en 3; confianza en 2). Secciones de lista usan dos columnas asimétricas (1fr / 1.25–1.6fr) con el titular a la izquierda. Gaps de 16–20 px entre tarjetas, 32–48 px entre columnas de texto.

Responsive (breakpoints Tailwind sm 640, md 768, lg 1024): la ventana de chat del hero es un escenario fijo 1536×416 escalado con unidades cqw desde md; en móvil se reemplaza por la misma conversación apilada, con la tarjeta de aprobación solapando 20 px el borde inferior. Las anotaciones al margen de bento y precios solo existen desde lg.

## Elevation & Depth

Plano por defecto, con capas tonales (papel → blanco → papel) y rings de tinta al 8 %. La sombra se reserva para lo que flota sobre la página: el campo de búsqueda, la ventana de chat, la píldora de motor, la tarjeta de propuesta y el CTA. Todas son difusas, de tinta y de baja opacidad.

### Shadow Vocabulary
- **Soft** (`0 1px 2px rgb(20 33 27 / 0.06), 0 4px 16px rgb(20 33 27 / 0.06)`): CTA de nav y cierre, sello ámbar, campo de búsqueda pequeño.
- **Lift** (`0 2px 4px rgb(20 33 27 / 0.06), 0 18px 40px -12px rgb(20 33 27 / 0.18)`): tarjeta de propuesta dentro del bento.
- **Float** (`0 1px 2px rgb(20 33 27 / 0.05), 0 12px 32px -14px rgb(20 33 27 / 0.22)`, hasta `0 24px 60px -28px … 0.25` en la ventana): objetos del escenario del hero.

### Named Rules
**The Flat Card Rule.** Las tarjetas de contenido no tienen sombra; se separan con ring y cambio de tono. La sombra significa "esto es un objeto en la conversación".

## Shapes

Esquinas generosas y redondeadas, coherentes con la r del logo: 24 px en tarjetas y paneles grandes, 28 px en la banda oscura, 22 px en el campo del hero, 16 px en paneles internos y burbujas, 12 px en botones, 8 px en las barras de la escalera y el foco, píldora completa en chips, avatares y la píldora de motor. Las burbujas de chat recortan una esquina hacia quien habla (6 px). Los bordes son rings de 1 px en tinta al 8 %; la regla de 2 px en tinta sólida abre listas editoriales (promesas, confianza). El ring de 2 px verde marca el plan destacado.

**The Stepped Bar Rule.** El progreso se dibuja como escalones que suben (cuatro barras de alturas crecientes de 16 px por paso), nunca como gauge o donut.

## Components

### Buttons
Firmes y amables: verde lleno, sin borde, con un levantamiento de 1 px.
- **Shape:** 12 px; 16 px en el CTA grande de cierre; 13 px dentro del campo del hero.
- **Primary:** verde con texto blanco 600, alto 44 px (nav), 48 px (planes), 54–56 px (hero, cierre).
- **Hover / Focus:** pasa a verde hondo y sube 1 px (150 ms, curva de marca); vuelve a 0 en active. Foco global: contorno verde de 2 px a 3 px de distancia, radio 8 px.
- **Secondary:** blanco con ring de tinta al 15 % (30 % en hover). Sobre la banda de tinta: papel con texto tinta, hover verde claro.
- **Text link:** verde 600 con flecha de trazo, subrayado en hover.

### Chips
- **Ciudad:** verde claro, alto 36 px, pin verde lleno, select sin apariencia con chevron.
- **Ejemplo:** verde claro con texto verde 600 12 px, alto 24 px. Toda demo con datos inventados lo lleva.

### Cards / Containers
- **Corner Style:** 24 px.
- **Background:** blanco sobre papel; papel sobre bandas blancas.
- **Shadow Strategy:** ninguna (ver The Flat Card Rule).
- **Border:** ring de 1 px, tinta al 8 %.
- **Internal Padding:** 24 px móvil, 28–32 px desde md. Cada tarjeta de bento contiene un mini-producto funcionando (escalera, barras, recibo, propuesta, alertas).

### Inputs / Fields
- **Style:** barra blanca de 22 px con lupa de trazo, texto 18–19 px, botón verde interno; sombra float y ring de línea.
- **Focus:** el ring pasa a 2 px verde al 40 %; caret verde.

### Navigation
Barra fina (60–72 px) sobre papel con borde inferior de línea: logo a la izquierda, tres enlaces centrales (solo desde lg) en tinta que pasan a verde en hover, "Ingresar" como texto y el CTA verde a la derecha.

### Ventana de conversación (firma)
Ventana blanca de esquinas amplias con barra de título en Jakarta 500 ("Así le responde la IA a tus clientes · Ejemplo"), panel interno con ring, burbuja del cliente gris a la derecha con avatar, respuesta de la IA en burbuja blanca con ring a la izquierda, que se escribe palabra por palabra (95 ms) con caret parpadeante. Anotaciones a mano aparecen en el margen; al terminar, la tarjeta de propuesta (símbolo r en avatar, "Propuesta:" en negrita, Aprobar verde + Ahora no) entra con el movimiento escalón.

### Recibo de evidencia
Panel papel con texto mono (motor · ciudad, fecha · hora, ID), la cita en Jakarta, y un sello circular ámbar rotado −12° con texto Nunito Black en tinta.

### Movimiento
Curva de marca `cubic-bezier(0.2, 0.8, 0.2, 1)`: 150 ms en hover, 250 ms en cambios de paso, 400 ms en entradas al hacer scroll (14 px), 600 ms en barras. El escalón (340 ms: sube, pausa, sube) es el único gesto de marca. Todo se apaga con reduced motion.

## Do's and Don'ts

### Do:
- **Do** dejar que el papel ocupe la mayor parte de la pantalla y usar el verde solo para la acción.
- **Do** poner el ámbar detrás de la tinta (resaltador) o como sello con texto en tinta.
- **Do** mostrar el producto funcionando dentro de tarjetas blancas de 24 px, con el chip "Ejemplo" cuando los datos son inventados.
- **Do** escribir fechas, horas, rangos e IDs en JetBrains Mono a 12–13 px.
- **Do** anotar en el margen con Caveat en tinta y la flecha fina de las placas, siempre aria-hidden y con la información repetida en texto real.
- **Do** usar íconos de trazo uniforme (2 px sobre 24 px, extremos redondeados).
- **Do** dibujar el progreso como escalones que suben.

### Don't:
- **Don't** usar el ámbar como color de texto o de glifo, ni texto blanco sobre ámbar.
- **Don't** aclarar el verde ni usar violeta, morado, rojo, turquesa o verde WhatsApp.
- **Don't** usar degradados de color visibles, destellos o robots (el resaltador es una franja de corte duro, no un degradado).
- **Don't** copiar la interfaz de ChatGPT u otro motor: la ventana es propia y neutra; los logos de motores solo identifican junto a su nombre.
- **Don't** dar sombra a las tarjetas de contenido; la sombra es solo para objetos que flotan.
