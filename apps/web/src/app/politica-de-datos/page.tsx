import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/LegalPage";
import { contact } from "@/components/ui";

export const metadata: Metadata = {
  title: "Política de tratamiento de datos personales · Reranker",
  description: "Cómo GLEMO S.A.S. (Reranker) trata tus datos personales, para qué y cómo ejercer tus derechos según la Ley 1581 de 2012.",
};

const P = "privacy@reranker.co";

const sections: LegalSection[] = [
  {
    id: "responsable",
    title: "Quién es el responsable",
    body: (
      <>
        <p>El responsable del tratamiento de tus datos personales es:</p>
        <ul>
          <li><strong>Razón social:</strong> GLEMO S.A.S., que opera la marca Reranker.</li>
          <li><strong>NIT:</strong> 902.091.972-5.</li>
          <li><strong>Domicilio:</strong> Medellín, Antioquia, Colombia.</li>
          <li><strong>Dirección de notificaciones:</strong> la registrada en el certificado de existencia y representación legal de la Cámara de Comercio de Medellín, consultable en el RUES.</li>
          <li><strong>Correo para datos personales:</strong> <a href={`mailto:${P}`}>{P}</a>.</li>
          <li><strong>Teléfono y WhatsApp:</strong> {contact.whatsappLabel}.</li>
          <li><strong>Sitio web:</strong> reranker.co.</li>
        </ul>
        <p>Esta política cumple la Ley 1581 de 2012, el Decreto 1377 de 2013 (compilado en el Decreto 1074 de 2015) y las instrucciones de la Superintendencia de Industria y Comercio (SIC).</p>
      </>
    ),
  },
  {
    id: "datos",
    title: "Qué datos tratamos",
    body: (
      <>
        <p>Pedimos solo los datos que necesitamos para prestar el servicio.</p>
        <table>
          <thead>
            <tr><th>De quién</th><th>Qué datos</th></tr>
          </thead>
          <tbody>
            <tr><td>Visitantes del sitio</td><td>Nombre del negocio y ciudad que escribes para el reporte gratis; datos técnicos básicos (navegador, dirección IP, páginas visitadas).</td></tr>
            <tr><td>Clientes y usuarios</td><td>Nombre, correo, teléfono o WhatsApp, cargo, datos del negocio (nombre, dirección comercial, categoría, sitio web, perfil de Google) y datos de facturación.</td></tr>
            <tr><td>Representantes de agencias</td><td>Nombre, correo, teléfono y datos de la agencia; datos de los negocios que la agencia gestiona.</td></tr>
            <tr><td>Personas que aparecen en respuestas de IA o reseñas</td><td>Nombres que la IA o una reseña pública mencionen junto a un negocio. Los reducimos al mínimo (ver numeral 5).</td></tr>
          </tbody>
        </table>
        <p>No pedimos datos sensibles ni datos de niñas, niños o adolescentes.</p>
      </>
    ),
  },
  {
    id: "finalidades",
    title: "Para qué los usamos",
    body: (
      <ul>
        <li>Preparar el reporte gratis y los reportes de tu plan: preguntarle a asistentes de IA lo que preguntaría un cliente y mostrarte qué responden.</li>
        <li>Guardar cada respuesta con fecha, hora, motor y ciudad para que puedas consultarla y verificarla.</li>
        <li>Proponerte correcciones en tu perfil de Google o tu sitio web y aplicarlas solo cuando las apruebes.</li>
        <li>Crear y administrar tu cuenta, cobrar los planes y emitir la factura electrónica.</li>
        <li>Enviarte alertas y resúmenes por correo y, si lo aceptas, por WhatsApp.</li>
        <li>Atender tus consultas, reclamos y solicitudes de soporte.</li>
        <li>Enviarte información comercial sobre Reranker, solo si lo autorizas.</li>
        <li>Mejorar el servicio y elaborar estadísticas e índices con datos agregados y anónimos, que no identifican a ninguna persona.</li>
        <li>Cumplir obligaciones legales, contables y tributarias, y atender requerimientos de autoridades.</li>
      </ul>
    ),
  },
  {
    id: "autorizacion",
    title: "Tu autorización",
    body: (
      <>
        <p>Tratamos tus datos con tu autorización previa, expresa e informada. La pedimos al momento de recogerlos, por ejemplo con una casilla en el formulario, y guardamos prueba de ella. Tu silencio nunca cuenta como autorización.</p>
        <p>No necesitamos autorización en los casos que la ley exceptúa, como los datos de naturaleza pública o los requeridos por una autoridad en ejercicio de sus funciones.</p>
      </>
    ),
  },
  {
    id: "terceros",
    title: "Datos de terceros en respuestas de IA y reseñas",
    body: (
      <>
        <p>Las respuestas de los asistentes de IA y las reseñas públicas pueden mencionar personas, por ejemplo el nombre de un médico o de quien escribió una reseña. Que esa información esté en internet no la convierte en dato público, como lo recuerda la Circular Externa 002 de 2024 de la SIC.</p>
        <p>Por eso nos enfocamos en negocios, no en personas: guardamos lo necesario para mostrar qué dice la IA de un negocio, reducimos o anonimizamos los nombres de personas cuando no son necesarios y atendemos cualquier solicitud de quien aparezca mencionado.</p>
      </>
    ),
  },
  {
    id: "derechos",
    title: "Tus derechos",
    body: (
      <>
        <p>Como titular de los datos, tienes derecho a:</p>
        <ul>
          <li>Conocer, actualizar y rectificar tus datos.</li>
          <li>Pedir prueba de la autorización que nos diste.</li>
          <li>Saber, previa solicitud, qué uso le hemos dado a tus datos.</li>
          <li>Revocar la autorización y pedir que borremos tus datos, cuando no exista un deber legal o contractual de conservarlos.</li>
          <li>Acceder gratis a tus datos.</li>
          <li>Presentar quejas ante la SIC, después de agotar el trámite de consulta o reclamo con nosotros.</li>
        </ul>
      </>
    ),
  },
  {
    id: "como",
    title: "Cómo ejercer tus derechos",
    body: (
      <>
        <p>El área encargada de atender consultas y reclamos es el equipo de privacidad de Reranker. Escríbenos a <a href={`mailto:${P}`}>{P}</a> con tu nombre, tu número de identificación, lo que pides y un medio para responderte. Si actúas en nombre de otra persona, adjunta el documento que te autoriza.</p>
        <h3>Consultas</h3>
        <p>Te respondemos en un máximo de 10 días hábiles desde que recibimos la solicitud. Si no alcanzamos, te avisamos el motivo y te respondemos en máximo 5 días hábiles más.</p>
        <h3>Reclamos</h3>
        <p>Si quieres corregir, actualizar o borrar tus datos, o crees que incumplimos la ley:</p>
        <ul>
          <li>Si al reclamo le falta información, te lo pedimos dentro de los 5 días hábiles siguientes. Si en 2 meses no la recibimos, entendemos que desististe.</li>
          <li>Mientras lo resolvemos, marcamos tus datos como &ldquo;reclamo en trámite&rdquo; en un máximo de 2 días hábiles.</li>
          <li>Lo resolvemos en un máximo de 15 días hábiles. Si no alcanzamos, te avisamos el motivo y lo resolvemos en máximo 8 días hábiles más.</li>
        </ul>
        <p>Cada solicitud recibe un número de radicado con fecha y hora.</p>
      </>
    ),
  },
  {
    id: "encargados",
    title: "Con quién compartimos datos y transferencias internacionales",
    body: (
      <>
        <p>No vendemos tus datos. Los compartimos solo con proveedores que nos ayudan a prestar el servicio (encargados), bajo contratos que les exigen confidencialidad, seguridad y usar los datos solo para lo que les pedimos:</p>
        <ul>
          <li>Infraestructura y alojamiento en la nube: Amazon Web Services, Cloudflare y Vercel.</li>
          <li>Envío de correos: Resend.</li>
          <li>Pagos: Wompi. Facturación electrónica y contabilidad: Alegra.</li>
          <li>Asistentes de IA que consultamos (por ejemplo, OpenAI, Google y Perplexity): reciben las preguntas sobre negocios que hacemos en tu nombre, no tus datos de contacto.</li>
        </ul>
        <p>Algunos de estos proveedores procesan datos en Estados Unidos, país que la SIC reconoce con un nivel adecuado de protección (Circular Externa 005 de 2017). No procesamos datos personales en países que no tengan ese nivel sin las garantías que exige la ley.</p>
      </>
    ),
  },
  {
    id: "ia",
    title: "Uso de inteligencia artificial",
    body: (
      <>
        <p>Usamos modelos de IA para consultar a los asistentes, clasificar sus respuestas y redactar propuestas de corrección. Ninguna de estas tareas toma decisiones con efectos legales sobre ti: cada cambio a tu perfil o a tu sitio necesita tu aprobación.</p>
        <p>Antes de incorporar un nuevo uso de IA que trate datos personales, evaluamos sus riesgos, como lo pide la Circular Externa 002 de 2024 de la SIC.</p>
      </>
    ),
  },
  {
    id: "seguridad",
    title: "Seguridad",
    body: (
      <p>Protegemos tus datos con cifrado en tránsito y en reposo, control de acceso por roles, registros de auditoría y copias de seguridad. Ningún sistema es infalible: si ocurre un incidente que afecte tus datos, te avisaremos y lo reportaremos a la SIC según la ley.</p>
    ),
  },
  {
    id: "conservacion",
    title: "Cuánto tiempo los guardamos",
    body: (
      <ul>
        <li>Mientras tengas una cuenta o un plan activo.</li>
        <li>Al cancelar, tienes 30 días para descargar tus reportes; después borramos o anonimizamos tus datos.</li>
        <li>Conservamos los datos de facturación y contabilidad por el tiempo que exigen las normas comerciales y tributarias.</li>
        <li>Los datos del reporte gratis que no se conviertan en cuenta se borran o anonimizan en un máximo de 12 meses.</li>
      </ul>
    ),
  },
  {
    id: "cookies",
    title: "Cookies",
    body: (
      <p>Usamos cookies necesarias para que el sitio funcione y recuerde tus preferencias, y herramientas de medición con datos agregados para saber cómo se usa el sitio. Puedes bloquear o borrar las cookies desde tu navegador; algunas funciones podrían dejar de funcionar.</p>
    ),
  },
  {
    id: "comunicaciones",
    title: "Mensajes comerciales",
    body: (
      <p>Solo te enviamos mensajes comerciales si los autorizas, y puedes darte de baja en cualquier momento con un clic o respondiendo &ldquo;no más&rdquo;. Cumplimos la Ley 2300 de 2023: los enviamos solo de lunes a viernes de 7:00 a. m. a 7:00 p. m. y los sábados de 8:00 a. m. a 3:00 p. m. Los mensajes del servicio, como alertas que activaste o avisos de pago, no son comerciales.</p>
    ),
  },
  {
    id: "vigencia",
    title: "Vigencia y cambios",
    body: (
      <>
        <p>Esta política rige desde el 4 de noviembre de 2026. Las bases de datos se conservan mientras exista la finalidad para la que se recogieron.</p>
        <p>Si hacemos cambios importantes, te avisaremos por correo o en el sitio antes de que apliquen y, cuando la ley lo exija, te pediremos una nueva autorización.</p>
      </>
    ),
  },
];

export default function Page() {
  return (
    <LegalPage
      title="Política de tratamiento de datos personales"
      updated="4 de noviembre de 2026"
      intro={<p>En Reranker cuidamos tus datos como cuidamos las respuestas que guardamos: sin cambiarlas y sin usarlas para algo que no sepas. Aquí te contamos qué datos tratamos, para qué y cómo ejercer tus derechos.</p>}
      sections={sections}
    />
  );
}
