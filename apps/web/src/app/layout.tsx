import type { Metadata, Viewport } from "next";
import { Analytics } from "@/components/Analytics";
import { GoogleTag } from "@/components/GoogleTag";
import { fontVariables } from "./fonts";
import "./globals.css";

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
    locale: "es_LA",
    alternateLocale: ["es_ES"],
    type: "website",
    url: "https://reranker.co",
  },
};

export const viewport: Viewport = { themeColor: "#FAF7F0" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={fontVariables}>
      <body>
        <a
          href="#contenido"
          className="sr-only rounded-xl bg-white px-4 py-2.5 text-[15px] font-semibold text-ink shadow-soft ring-1 ring-line focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70]"
        >
          Saltar al contenido
        </a>
        {children}
        <Analytics />
        <GoogleTag />
      </body>
    </html>
  );
}
