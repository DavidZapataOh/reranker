import { EmailCode, EmailFooter, EmailHeading, EmailLayout, EmailText } from "../index.ts";

export default function Code() {
  return (
    <EmailLayout preview="Tu código para entrar">
      <EmailHeading>Tu código para entrar</EmailHeading>
      <EmailText>Escríbelo en la pantalla donde lo pediste. Vence en 10 minutos.</EmailText>
      <EmailCode code="123456" />
      <EmailFooter legalName="GLEMO S.A.S." />
    </EmailLayout>
  );
}
