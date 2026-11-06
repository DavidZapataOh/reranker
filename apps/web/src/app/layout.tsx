import type { Metadata, Viewport } from "next";
import { Caveat, JetBrains_Mono, Nunito, Plus_Jakarta_Sans } from "next/font/google";
import { Analytics } from "@/components/Analytics";
import { GoogleTag } from "@/components/GoogleTag";
import "./globals.css";

const display = Nunito({
  variable: "--nf-display",
  subsets: ["latin"],
  weight: ["800", "900"],
  display: "swap",
});
const text = Plus_Jakarta_Sans({
  variable: "--nf-text",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});
const mono = JetBrains_Mono({
  variable: "--nf-mono",
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
});
const hand = Caveat({
  variable: "--nf-hand",
  subsets: ["latin"],
  weight: ["500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://reranker.co"),
  title: "Reranker · Lo que la IA dice de tu negocio",
  description:
    "Tus clientes le preguntan a ChatGPT, Gemini, Google y Perplexity qué negocio les recomiendan en tu ciudad. Mira qué responden y qué cambiar para que salgas tú. Gratis y en menos de 2 minutos.",
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/brand/apple-touch-icon.png",
  },
  manifest: "/brand/site.webmanifest",
  openGraph: {
    title: "Tus clientes le preguntan a ChatGPT. Que salgas tú.",
    description:
      "Mira qué responden ChatGPT, Gemini, Google y Perplexity cuando alguien busca lo que vendes en tu ciudad.",
    locale: "es_CO",
    type: "website",
    url: "https://reranker.co",
  },
};

export const viewport: Viewport = { themeColor: "#FAF7F0" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es-CO"
      className={`${display.variable} ${text.variable} ${mono.variable} ${hand.variable}`}
    >
      <body>
        {children}
        <Analytics />
        <GoogleTag />
      </body>
    </html>
  );
}
