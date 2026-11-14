import { COUNTRIES } from "@reranker/i18n/countries";
import { EmailCode, EmailFooter, EmailHeading, EmailLayout, EmailText } from "@reranker/ui/email";

export const signInCodeCopy = {
  subject: (otp: string) => `Tu código para entrar a Reranker: ${otp}`,
  heading: "Tu código para entrar",
  body: "Escribe este código en la página donde lo pediste. Vence en 10 minutos. Si no lo pediste, ignora este correo.",
} as const;

export function SignInCodeEmail({ otp }: { otp: string }) {
  return (
    <EmailLayout preview={signInCodeCopy.subject(otp)}>
      <EmailHeading>{signInCodeCopy.heading}</EmailHeading>
      <EmailText>{signInCodeCopy.body}</EmailText>
      <EmailCode code={otp} />
      <EmailFooter legalName={COUNTRIES.CO.legalEntity.name} />
    </EmailLayout>
  );
}
