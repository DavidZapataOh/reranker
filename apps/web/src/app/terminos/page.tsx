import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/LegalPage";
import { contact } from "@/components/ui";

export const metadata: Metadata = {
  title: "Términos y condiciones · Reranker",
  description: "Las reglas para usar Reranker: qué incluye el servicio, cómo se cobra y se cancela, qué significan las mediciones y qué responsabilidades tiene cada parte.",
};

const L = "legal@reranker.co";

const sections: LegalSection[] = [
  {
    id: "quienes",
    title: "Quiénes somos",
    body: (
      <>
        <p>Reranker es una marca de <strong>GLEMO S.A.S.</strong>, NIT 902.091.972-5, con domicilio en Medellín, Antioquia, Colombia. Nuestra dirección de notificaciones judiciales es la registrada en la Cámara de Comercio de Medellín, consultable en el RUES.</p>
        <ul>
          <li>Correo: <a href={`mailto:${L}`}>{L}</a></li>
          <li>Teléfono y WhatsApp: {contact.whatsappLabel}</li>
          <li>Autoridad de protección al consumidor: <a href="https://www.sic.gov.co" target="_blank" rel="noopener">Superintendencia de Industria y Comercio</a></li>
        </ul>
        <p>Al crear una cuenta, pedir un reporte o pagar un plan, aceptas estos términos y nuestra <Link href="/politica-de-datos">política de tratamiento de datos</Link>. Si usas Reranker en nombre de un negocio, declaras que tienes facultad para hacerlo.</p>
      </>
    ),
  },
  {
    id: "servicio",
    title: "Qué hace Reranker",
    body: (
      <>
        <p>Reranker le pregunta a asistentes de inteligencia artificial (como ChatGPT, Gemini, Google y Perplexity) lo que preguntaría un cliente que busca lo que vendes en tu ciudad, y te muestra qué responden. Además:</p>
        <ul>
          <li>Guarda cada respuesta con fecha, hora, motor y ciudad.</li>
          <li>Calcula un puntaje de recomendación con su rango.</li>
          <li>Te propone correcciones en tu perfil de Google o tu sitio web, que se aplican solo si las apruebas.</li>
          <li>Te avisa cuando algo cambia.</li>
        </ul>
        <p>Los ejemplos que aparecen en el sitio marcados como &ldquo;Ejemplo&rdquo; son ilustrativos y usan negocios ficticios.</p>
      </>
    ),
  },
  {
    id: "mediciones",
    title: "Lo que significan las mediciones",
    body: (
      <>
        <p>Los asistentes de IA son de terceros. No los controlamos y cambian sus respuestas de una consulta a otra, de un día a otro y con cada actualización de sus modelos. Por eso:</p>
        <ul>
          <li>Hacemos la misma pregunta varias veces y de varias formas, y te mostramos un <strong>puntaje con un rango</strong>. Es una estimación estadística, no una cifra exacta.</li>
          <li><strong>No garantizamos</strong> que un asistente te mencione, te recomiende, te ponga en un puesto determinado ni que recibas más visitas, clientes o ventas. Nadie puede garantizarlo con honestidad.</li>
          <li>Nuestras mediciones y recomendaciones son informativas. Las decisiones sobre tu negocio son tuyas.</li>
        </ul>
      </>
    ),
  },
  {
    id: "evidencia",
    title: "Las respuestas guardadas",
    body: (
      <>
        <p>Guardamos cada respuesta tal como la entregó el asistente, con fecha, hora, motor y ciudad, y no la editamos después. Puedes comprobarlo en reranker.co/verificar.</p>
        <p>La respuesta guardada prueba <strong>qué respondió un asistente en ese momento</strong>. No prueba que esa sea la única respuesta posible, ni que lo que dice el asistente sea cierto, ni que la siguiente respuesta vaya a ser igual.</p>
      </>
    ),
  },
  {
    id: "correcciones",
    title: "Correcciones con tu aprobación",
    body: (
      <>
        <p>Para aplicar correcciones puedes darnos acceso a tu perfil de Google, a tu sitio web o a tu tienda. Al hacerlo:</p>
        <ul>
          <li>Cada cambio te llega como propuesta y <strong>solo se aplica si lo apruebas</strong>. Puedes retirar el acceso cuando quieras.</li>
          <li>Eres responsable de que la información que apruebas sea cierta y de que puedas publicarla.</li>
          <li>Google, tu proveedor de sitio web y las demás plataformas toman sus propias decisiones, por ejemplo revisar, rechazar o suspender un perfil. Esas decisiones no dependen de nosotros.</li>
        </ul>
      </>
    ),
  },
  {
    id: "planes",
    title: "Reporte gratis, planes y precios",
    body: (
      <>
        <p>El reporte gratis no requiere registro ni tarjeta. Los planes de pago (Esencial, Pro y el programa para agencias) y sus precios están en <Link href="/#precios">reranker.co/#precios</Link>.</p>
        <p>Los precios están en pesos colombianos y son el valor final que pagas. Las suscripciones son un servicio de computación en la nube excluido de IVA (artículo 476, numeral 21, del Estatuto Tributario). Si algún servicio adicional llevara IVA, su precio ya lo incluiría. Cada plan tiene límites de uso razonables (negocios, ciudades, preguntas y competidores). Si una cuenta los supera de forma sostenida, te avisaremos y podremos limitar el uso o proponerte un plan mayor.</p>
      </>
    ),
  },
  {
    id: "pagos",
    title: "Pagos, renovación y cancelación",
    body: (
      <ul>
        <li>Pagas por adelantado con PSE, Nequi o tarjeta, a través de Wompi. Recibes factura electrónica.</li>
        <li>Los planes se renuevan cada mes de forma automática hasta que los canceles.</li>
        <li><strong>Puedes cancelar cuando quieras</strong>, desde tu cuenta o escribiendo a <a href={`mailto:${L}`}>{L}</a>, sin penalidades y sin pasos más difíciles que los de suscribirte. La cancelación aplica al final del periodo que ya pagaste, y hasta entonces conservas el acceso.</li>
        <li>Si cambia el precio de tu plan, te avisamos con al menos 15 días de anticipación y el nuevo precio aplica desde la siguiente renovación.</li>
      </ul>
    ),
  },
  {
    id: "retracto",
    title: "Derecho de retracto y reversión del pago",
    body: (
      <>
        <p>Si eres consumidor según la Ley 1480 de 2011, tienes derecho a retractarte de una compra hecha en línea dentro de los 5 días hábiles siguientes, siempre que el servicio no haya empezado a prestarse con tu acuerdo. Al activar un plan te pedimos que confirmes si quieres empezar de inmediato. Si te retractas a tiempo, te devolvemos el dinero en un máximo de 15 días calendario.</p>
        <p>También puedes pedir la reversión del pago en los casos del artículo 51 de la Ley 1480 (fraude, operación no solicitada o servicio no prestado), dentro de los 5 días hábiles siguientes a que lo notes, escribiendo a <a href={`mailto:${L}`}>{L}</a> y a tu banco.</p>
      </>
    ),
  },
  {
    id: "alertas",
    title: "Alertas y mensajes",
    body: (
      <p>Te enviamos alertas y resúmenes por correo y, si lo aceptas, por WhatsApp. Puedes cambiar o desactivar estos avisos cuando quieras. Los mensajes comerciales cumplen la Ley 2300 de 2023 y solo los recibes si los autorizas.</p>
    ),
  },
  {
    id: "agencias",
    title: "Agencias y marca blanca",
    body: (
      <ul>
        <li>Las agencias pueden usar Reranker para medir a sus clientes y entregarles reportes con su propia marca.</li>
        <li>La agencia debe tener la autorización de sus clientes para darnos sus datos y para pedir correcciones en su nombre. Frente a esos datos, la agencia es la responsable y GLEMO S.A.S. actúa como encargado.</li>
        <li>Los reportes conservan el enlace de verificación de Reranker, para que el cliente final pueda comprobar las respuestas.</li>
        <li>La agencia no puede revender el acceso a la plataforma fuera del programa de socios.</li>
      </ul>
    ),
  },
  {
    id: "uso",
    title: "Uso aceptable",
    body: (
      <>
        <p>No puedes usar Reranker para:</p>
        <ul>
          <li>Publicar información falsa o engañosa sobre tu negocio o el de otros.</li>
          <li>Medir o modificar negocios sobre los que no tienes autorización, salvo como competencia visible en tus propios reportes.</li>
          <li>Hacer spam, manipular reseñas o intentar engañar a los asistentes de IA.</li>
          <li>Extraer datos de la plataforma de forma automatizada, hacer ingeniería inversa o intentar acceder sin permiso.</li>
        </ul>
        <p>Si incumples estas reglas, podemos suspender tu cuenta después de avisarte, salvo que el riesgo exija actuar de inmediato.</p>
      </>
    ),
  },
  {
    id: "propiedad",
    title: "Tus datos y nuestra plataforma",
    body: (
      <ul>
        <li>Tus datos y tus reportes son tuyos. Puedes descargarlos cuando quieras y hasta 30 días después de cancelar.</li>
        <li>La plataforma, la marca Reranker, el método de medición y el software son de GLEMO S.A.S.</li>
        <li>Podemos usar datos agregados y anónimos, que no identifican a tu negocio ni a ninguna persona, para mejorar el servicio y publicar estadísticas e índices.</li>
      </ul>
    ),
  },
  {
    id: "marcas",
    title: "Marcas de terceros",
    body: (
      <p>ChatGPT y OpenAI, Gemini y Google, y Perplexity son marcas de sus respectivos dueños. Las mencionamos solo para indicar qué asistentes consultamos. Reranker no está afiliado a ellos ni cuenta con su patrocinio.</p>
    ),
  },
  {
    id: "cambios-servicio",
    title: "Disponibilidad y cambios del servicio",
    body: (
      <p>Trabajamos para que Reranker esté disponible siempre, pero puede haber interrupciones por mantenimiento o fallas de proveedores. Si un asistente de IA cambia sus condiciones, su acceso o sus límites, podemos dejar de consultarlo o reemplazarlo; te avisaremos y ajustaremos lo que corresponda en tu plan.</p>
    ),
  },
  {
    id: "responsabilidad",
    title: "Responsabilidad",
    body: (
      <>
        <p>Respondemos por prestar el servicio con diligencia. Cuando contratas como empresa para tu actividad comercial, nuestra responsabilidad total se limita a lo que hayas pagado en los 12 meses anteriores al hecho, y no respondemos por lucro cesante ni por decisiones de terceros, como los asistentes de IA o las plataformas donde se aplican las correcciones.</p>
        <p>Estos límites nunca aplican a casos de dolo o culpa grave, y no afectan los derechos que la Ley 1480 de 2011 te reconoce como consumidor.</p>
      </>
    ),
  },
  {
    id: "cambios",
    title: "Cambios a estos términos",
    body: (
      <p>Si cambiamos estos términos, te avisamos por correo y en el sitio con al menos 15 días de anticipación. Los cambios aplican desde tu siguiente renovación. Si no estás de acuerdo, puedes cancelar antes sin costo.</p>
    ),
  },
  {
    id: "pqr",
    title: "Peticiones, quejas y ley aplicable",
    body: (
      <>
        <p>Escríbenos a <a href={`mailto:${L}`}>{L}</a> o por WhatsApp al {contact.whatsappLabel}. Cada petición, queja o reclamo recibe un número de radicado con fecha y hora, y te respondemos en un máximo de 15 días hábiles.</p>
        <p>Estos términos se rigen por la ley colombiana. Si surge una diferencia, buscaremos resolverla directamente contigo durante 30 días. Si no lo logramos, podrás acudir a los jueces de Medellín o, si eres consumidor, a la Superintendencia de Industria y Comercio.</p>
      </>
    ),
  },
];

export default function Page() {
  return (
    <LegalPage
      title="Términos y condiciones"
      updated="4 de noviembre de 2026"
      intro={<p>Estas son las reglas para usar Reranker, escritas para que se entiendan. Si algo no queda claro, escríbenos a <a href={`mailto:${L}`}>{L}</a>.</p>}
      sections={sections}
    />
  );
}
