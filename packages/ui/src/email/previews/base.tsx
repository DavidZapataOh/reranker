import {
  EmailBubble,
  EmailButton,
  EmailFooter,
  EmailHeading,
  EmailLayout,
  EmailSeal,
  EmailText,
} from "../index.ts";

export default function Base() {
  return (
    <EmailLayout preview="Tu reporte está listo">
      <EmailHeading>Tu reporte está listo</EmailHeading>
      <EmailText>Esto es lo que respondió ChatGPT cuando le preguntamos por tu negocio.</EmailText>
      <EmailBubble
        engineLabel="ChatGPT · Colombia"
        text="Para un restaurante de comida casera en Medellín, te recomendaría revisar las reseñas recientes y los precios del menú del día."
      />
      <EmailSeal
        capturedAtLabel="3 nov 2026, 9:14 a. m."
        cityLabel="Medellín"
        verifyUrl="https://reranker.co/verificar/8F2K"
      />
      <EmailButton href="https://reranker.co/reporte/abc">Ver reporte</EmailButton>
      <EmailFooter legalName="GLEMO S.A.S." unsubscribeUrl="https://reranker.co/baja/x" />
    </EmailLayout>
  );
}
