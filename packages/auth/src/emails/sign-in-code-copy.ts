import { LOCALES, type Locale } from "@reranker/i18n";

export type SignInCodeCopy = {
  subject: (code: string) => string;
  preheader: (minutes: number) => string;
  heading: string;
  instruction: (minutes: number) => string;
  requestedFrom: (city: string, country: string) => string;
  doNotShare: string;
  ignoreIfNotYou: string;
  legal: (legalName: string, taxId: string, city: string, country: string) => string;
  terms: string;
  privacy: string;
};

const es = {
  subject: (code) => `${code} es tu código para entrar a Reranker`,
  preheader: (minutes) => `Vence en ${minutes} minutos. No se lo compartas a nadie.`,
  heading: "Tu código para entrar",
  instruction: (minutes) =>
    `Escríbelo en la página de Reranker que dejaste abierta. Vence en ${minutes} minutos.`,
  requestedFrom: (city, country) => `Se pidió desde ${city}, ${country}.`,
  doNotShare:
    "No le compartas este código a nadie. Reranker nunca te lo va a pedir por WhatsApp, llamada ni correo.",
  ignoreIfNotYou: "Si no fuiste tú, ignora este correo. Sin el código nadie puede entrar.",
  legal: (legalName, taxId, city, country) =>
    `Reranker es una marca de ${legalName} · NIT ${taxId} · ${city}, ${country}`,
  terms: "Términos",
  privacy: "Política de datos",
} satisfies SignInCodeCopy;

/** Written ahead of time: it becomes selectable by adding "en" to LOCALES, which the type below then requires. */
export const pendingLocaleCopy = {
  en: {
    subject: (code) => `${code} is your Reranker sign-in code`,
    preheader: (minutes) => `It expires in ${minutes} minutes. Don't share it with anyone.`,
    heading: "Your sign-in code",
    instruction: (minutes) =>
      `Enter it on the Reranker page you left open. It expires in ${minutes} minutes.`,
    requestedFrom: (city, country) => `Requested from ${city}, ${country}.`,
    doNotShare:
      "Don't share this code with anyone. Reranker will never ask for it by WhatsApp, phone or email.",
    ignoreIfNotYou: "If this wasn't you, ignore this email. No one can sign in without the code.",
    legal: (legalName, taxId, city, country) =>
      `Reranker is a brand of ${legalName} · NIT ${taxId} · ${city}, ${country}`,
    terms: "Terms",
    privacy: "Privacy policy",
  },
} satisfies Record<string, SignInCodeCopy>;

export const signInCodeCopy: Record<Locale, SignInCodeCopy> = { [LOCALES[0]]: es };
