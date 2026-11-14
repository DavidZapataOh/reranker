import {
  EmailBrandMark,
  EmailCode,
  EmailFooter,
  EmailHeading,
  EmailLayout,
  EmailText,
} from "../index.ts";

export default function Code() {
  return (
    <EmailLayout
      preview="Vence en 10 minutos. No se lo compartas a nadie."
      footer={
        <EmailFooter
          legal="Reranker es una marca de GLEMO S.A.S. · NIT 902.091.972-5 · Medellín, Colombia"
          links={[
            { label: "Términos", href: "https://reranker.co/terminos" },
            { label: "Política de datos", href: "https://reranker.co/politica-de-datos" },
          ]}
        />
      }
    >
      <EmailBrandMark />
      <EmailHeading>Tu código para entrar</EmailHeading>
      <EmailCode code="123456" />
      <EmailText>
        Escríbelo en la página de Reranker que dejaste abierta. Vence en 10 minutos.
      </EmailText>
    </EmailLayout>
  );
}
