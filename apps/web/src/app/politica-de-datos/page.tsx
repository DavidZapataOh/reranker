import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/LegalPage";
import { contact } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Política de tratamiento de datos personales · Reranker",
  description:
    "Cómo GLEMO S.A.S. (Reranker) trata tus datos personales, para qué, con qué proveedores y cómo ejercer tus derechos, estés donde estés.",
};

const P = "privacy@reranker.co";

const subprocessors: [string, string, string][] = [
  ["Vercel", "Alojamiento del sitio y la aplicación", "Estados Unidos y red global"],
  ["Cloudflare", "Red de entrega y almacenamiento de archivos", "Red global"],
  ["Amazon Web Services", "Infraestructura y llaves de cifrado", "Estados Unidos"],
  ["Neon", "Base de datos", "Estados Unidos"],
  ["Resend", "Envío de correos", "Estados Unidos"],
  ["PostHog", "Medición del sitio, con tu consentimiento", "Estados Unidos"],
  ["Google Analytics", "Medición del sitio, con tu consentimiento", "Estados Unidos"],
  ["Microsoft Clarity", "Medición del sitio, con tu consentimiento", "Estados Unidos"],
  ["Wompi", "Pagos en Colombia", "Colombia"],
  ["Alegra", "Facturación electrónica en Colombia", "Colombia"],
  [
    "Procesador de pagos para clientes fuera de Colombia",
    "Cobros, impuestos y facturas fuera de Colombia",
    "Lo nombramos aquí antes del primer cobro",
  ],
];

const sections: LegalSection[] = [
  {
    id: "responsable",
    title: "Quién es el responsable",
    body: (
      <>
        <p>El responsable del tratamiento de tus datos personales es:</p>
        <ul>
          <li>
            <strong>Razón social:</strong> GLEMO S.A.S., que opera la marca Reranker.
          </li>
          <li>
            <strong>NIT:</strong> 902.091.972-5.
          </li>
          <li>
            <strong>Domicilio:</strong> Medellín, Antioquia, Colombia.
          </li>
          <li>
            <strong>Dirección de notificaciones:</strong> la registrada en el certificado de
            existencia y representación legal de la Cámara de Comercio de Medellín, consultable en
            el RUES.
          </li>
          <li>
            <strong>Correo para datos personales:</strong> <a href={`mailto:${P}`}>{P}</a>.
          </li>
          <li>
            <strong>Teléfono y WhatsApp:</strong> {contact.whatsappLabel}.
          </li>
          <li>
            <strong>Sitio web:</strong> reranker.co.
          </li>
        </ul>
        <p>
          Esta política aplica a todas las personas que usan Reranker, en cualquier país. Se basa en
          la Ley 1581 de 2012, el Decreto 1377 de 2013 (compilado en el Decreto 1074 de 2015) y las
          instrucciones de la Superintendencia de Industria y Comercio (SIC). Si estás en la Unión
          Europea o el Espacio Económico Europeo, lee también el numeral{" "}
          <a href="#ue">&ldquo;Si estás en la Unión Europea&rdquo;</a>.
        </p>
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
            <tr>
              <th>De quién</th>
              <th>Qué datos</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Visitantes del sitio</td>
              <td>
                Nombre del negocio y ciudad que escribes para el reporte gratis; datos técnicos
                básicos (navegador, dirección IP, páginas visitadas). Usamos el país aproximado de
                tu conexión para mostrarte los precios en tu moneda, sin guardarlo.
              </td>
            </tr>
            <tr>
              <td>Clientes y usuarios</td>
              <td>
                Nombre, correo, teléfono o WhatsApp, cargo, datos del negocio (nombre, dirección
                comercial, categoría, sitio web, perfil de Google) y datos de facturación.
              </td>
            </tr>
            <tr>
              <td>Representantes de agencias</td>
              <td>
                Nombre, correo, teléfono y datos de la agencia; datos de los negocios que la agencia
                gestiona.
              </td>
            </tr>
            <tr>
              <td>Personas que aparecen en respuestas de IA o reseñas</td>
              <td>
                Nombres que la IA o una reseña pública mencionen junto a un negocio. Los reducimos
                al mínimo (ver numeral 5).
              </td>
            </tr>
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
        <li>
          Preparar el reporte gratis y los reportes de tu plan: preguntarle a asistentes de IA lo
          que preguntaría un cliente y mostrarte qué responden.
        </li>
        <li>
          Guardar cada respuesta con fecha, hora, motor y ciudad para que puedas consultarla y
          verificarla.
        </li>
        <li>
          Proponerte correcciones en tu perfil de Google o tu sitio web y aplicarlas solo cuando las
          apruebes.
        </li>
        <li>Crear y administrar tu cuenta, cobrar los planes y emitir las facturas.</li>
        <li>Enviarte alertas y resúmenes por correo y, si lo aceptas, por WhatsApp.</li>
        <li>Atender tus consultas, reclamos y solicitudes de soporte.</li>
        <li>Enviarte información comercial sobre Reranker, solo si lo autorizas.</li>
        <li>
          Mejorar el servicio y elaborar estadísticas e índices con datos agregados y anónimos, que
          no identifican a ninguna persona.
        </li>
        <li>
          Cumplir obligaciones legales, contables y tributarias, y atender requerimientos de
          autoridades.
        </li>
      </ul>
    ),
  },
  {
    id: "autorizacion",
    title: "Tu autorización",
    body: (
      <>
        <p>
          Tratamos tus datos con tu autorización previa, expresa e informada. La pedimos al momento
          de recogerlos, por ejemplo con una casilla en el formulario, y guardamos prueba de ella.
          Tu silencio nunca cuenta como autorización.
        </p>
        <p>
          No necesitamos autorización en los casos que la ley exceptúa, como los datos de naturaleza
          pública o los requeridos por una autoridad en ejercicio de sus funciones.
        </p>
      </>
    ),
  },
  {
    id: "terceros",
    title: "Datos de terceros en respuestas de IA y reseñas",
    body: (
      <>
        <p>
          Las respuestas de los asistentes de IA y las reseñas públicas pueden mencionar personas,
          por ejemplo el nombre de un médico o de quien escribió una reseña. Que esa información
          esté en internet no la convierte en dato público, como lo recuerda la Circular Externa 002
          de 2024 de la SIC.
        </p>
        <p>
          Por eso nos enfocamos en negocios, no en personas: guardamos lo necesario para mostrar qué
          dice la IA de un negocio, reducimos o anonimizamos los nombres de personas cuando no son
          necesarios y atendemos cualquier solicitud de quien aparezca mencionado.
        </p>
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
          <li>
            Revocar la autorización y pedir que borremos tus datos, cuando no exista un deber legal
            o contractual de conservarlos.
          </li>
          <li>Acceder gratis a tus datos.</li>
          <li>
            Presentar quejas ante la SIC, después de agotar el trámite de consulta o reclamo con
            nosotros.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "como",
    title: "Cómo ejercer tus derechos",
    body: (
      <>
        <p>
          El área encargada de atender consultas y reclamos es el equipo de privacidad de Reranker.
          Escríbenos a <a href={`mailto:${P}`}>{P}</a> con tu nombre, tu número de identificación,
          lo que pides y un medio para responderte. Si actúas en nombre de otra persona, adjunta el
          documento que te autoriza.
        </p>
        <h3>Consultas</h3>
        <p>
          Te respondemos en un máximo de 10 días hábiles desde que recibimos la solicitud. Si no
          alcanzamos, te avisamos el motivo y te respondemos en máximo 5 días hábiles más.
        </p>
        <h3>Reclamos</h3>
        <p>Si quieres corregir, actualizar o borrar tus datos, o crees que incumplimos la ley:</p>
        <ul>
          <li>
            Si al reclamo le falta información, te lo pedimos dentro de los 5 días hábiles
            siguientes. Si en 2 meses no la recibimos, entendemos que desististe.
          </li>
          <li>
            Mientras lo resolvemos, marcamos tus datos como &ldquo;reclamo en trámite&rdquo; en un
            máximo de 2 días hábiles.
          </li>
          <li>
            Lo resolvemos en un máximo de 15 días hábiles. Si no alcanzamos, te avisamos el motivo y
            lo resolvemos en máximo 8 días hábiles más.
          </li>
        </ul>
        <p>Cada solicitud recibe un número de radicado con fecha y hora.</p>
      </>
    ),
  },
  {
    id: "encargados",
    title: "Proveedores que tratan datos y transferencias internacionales",
    body: (
      <>
        <p>
          No vendemos tus datos. Los compartimos solo con proveedores que nos ayudan a prestar el
          servicio (encargados o subencargados), bajo contratos que les exigen confidencialidad,
          seguridad y usar los datos solo para lo que les pedimos. Esta es la lista completa:
        </p>
        <table>
          <thead>
            <tr>
              <th>Proveedor</th>
              <th>Para qué</th>
              <th>Dónde</th>
            </tr>
          </thead>
          <tbody>
            {subprocessors.map(([name, purpose, where]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{purpose}</td>
                <td>{where}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Los asistentes de IA que consultamos (por ejemplo, OpenAI, Google y Perplexity) y los
          servicios que capturan sus respuestas reciben las preguntas sobre negocios que hacemos en
          tu nombre, no tus datos de contacto.
        </p>
        <p>
          Si cambiamos esta lista, actualizamos la fecha de esta política. Si tu empresa necesita un
          acuerdo de tratamiento de datos (DPA), pídelo a <a href={`mailto:${P}`}>{P}</a>.
        </p>
        <p>
          Estados Unidos está en la lista de países con un nivel adecuado de protección de la SIC
          (Circular Externa 005 de 2017). No enviamos datos personales a países sin ese nivel sin
          las garantías que exige la ley.
        </p>
      </>
    ),
  },
  {
    id: "ue",
    title: "Si estás en la Unión Europea",
    body: (
      <>
        <p>
          Si estás en la Unión Europea o el Espacio Económico Europeo, el Reglamento General de
          Protección de Datos (RGPD) también protege tus datos. GLEMO S.A.S. es el responsable.
        </p>
        <h3>Por qué tratamos tus datos</h3>
        <ul>
          <li>
            <strong>Para cumplir el contrato:</strong> tu cuenta, tu plan, tus reportes y los
            cobros.
          </li>
          <li>
            <strong>Con tu consentimiento:</strong> cookies de medición, mensajes comerciales y
            alertas por WhatsApp. Puedes retirarlo cuando quieras.
          </li>
          <li>
            <strong>Por interés legítimo:</strong> la seguridad del servicio, prevenir fraudes,
            mejorarlo con datos agregados y mostrar qué dice la IA de un negocio.
          </li>
          <li>
            <strong>Por obligación legal:</strong> facturación, contabilidad e impuestos.
          </li>
        </ul>
        <h3>Tus derechos</h3>
        <p>
          Puedes pedir acceso, rectificación, supresión, limitación del tratamiento y portabilidad
          de tus datos, y oponerte al tratamiento basado en interés legítimo. Escríbenos a{" "}
          <a href={`mailto:${P}`}>{P}</a> y te respondemos en un máximo de un mes. También puedes
          reclamar ante la autoridad de protección de datos de tu país; en España, la Agencia
          Española de Protección de Datos (AEPD).
        </p>
        <h3>Transferencias fuera de Europa</h3>
        <p>
          Tratamos tus datos en Colombia y, con los proveedores de la lista, en Estados Unidos. Esos
          envíos se hacen bajo el Marco de Privacidad de Datos UE-EE. UU. (Data Privacy Framework),
          cuando el proveedor está certificado, o bajo las cláusulas contractuales tipo de la
          Comisión Europea.
        </p>
      </>
    ),
  },
  {
    id: "ia",
    title: "Uso de inteligencia artificial",
    body: (
      <>
        <p>
          Usamos modelos de IA para consultar a los asistentes, clasificar sus respuestas y redactar
          propuestas de corrección. Ninguna de estas tareas toma decisiones con efectos legales
          sobre ti: cada cambio a tu perfil o a tu sitio necesita tu aprobación.
        </p>
        <p>
          Antes de incorporar un nuevo uso de IA que trate datos personales, evaluamos sus riesgos,
          como lo pide la Circular Externa 002 de 2024 de la SIC.
        </p>
      </>
    ),
  },
  {
    id: "seguridad",
    title: "Seguridad",
    body: (
      <p>
        Protegemos tus datos con cifrado en tránsito y en reposo, control de acceso por roles,
        registros de auditoría y copias de seguridad. Ningún sistema es infalible: si ocurre un
        incidente que afecte tus datos, te avisaremos y lo reportaremos a la SIC según la ley.
      </p>
    ),
  },
  {
    id: "conservacion",
    title: "Cuánto tiempo los guardamos",
    body: (
      <ul>
        <li>Mientras tengas una cuenta o un plan activo.</li>
        <li>
          Al cancelar, tienes 30 días para descargar tus reportes; después borramos o anonimizamos
          tus datos.
        </li>
        <li>
          Conservamos los datos de facturación y contabilidad por el tiempo que exigen las normas
          comerciales y tributarias.
        </li>
        <li>
          Los datos del reporte gratis que no se conviertan en cuenta se borran o anonimizan en un
          máximo de 12 meses.
        </li>
      </ul>
    ),
  },
  {
    id: "cookies",
    title: "Cookies y medición del sitio",
    body: (
      <>
        <p>
          Medimos cómo se usa reranker.co para mejorarlo: de dónde llegan las visitas, qué secciones
          se leen, en qué se hace clic y dónde falla el flujo. La primera vez que entras te
          preguntamos si aceptas cookies de medición.
        </p>
        <ul>
          <li>
            <strong>Si aceptas:</strong> usamos cookies de PostHog y Google Analytics para medir tu
            visita, y PostHog y Microsoft Clarity pueden grabar de forma anónima cómo navegas la
            página (movimientos, clics y desplazamiento) y armar mapas de calor. En las grabaciones
            ocultamos todo lo que escribes en los formularios y los nombres de negocios.
          </li>
          <li>
            <strong>Si rechazas o no decides:</strong> no instalamos cookies de medición ni grabamos
            tu visita. Solo contamos visitas de forma agregada, sin cookies y sin identificarte.
          </li>
          <li>
            <strong>Cookies necesarias:</strong> guardamos tu decisión sobre las cookies para no
            preguntarte cada vez.
          </li>
        </ul>
        <p>
          No usamos cookies de publicidad. Si en el futuro las usamos, te pediremos autorización
          antes. Puedes cambiar tu decisión cuando quieras en &ldquo;Preferencias de cookies&rdquo;,
          al pie de cada página, o bloquear y borrar las cookies desde tu navegador.
        </p>
      </>
    ),
  },
  {
    id: "comunicaciones",
    title: "Mensajes comerciales",
    body: (
      <p>
        Solo te enviamos mensajes comerciales si los autorizas, y puedes darte de baja en cualquier
        momento con un clic o respondiendo &ldquo;no más&rdquo;. En Colombia cumplimos la Ley 2300
        de 2023: los enviamos solo de lunes a viernes de 7:00 a. m. a 7:00 p. m. y los sábados de
        8:00 a. m. a 3:00 p. m. Los mensajes del servicio, como alertas que activaste o avisos de
        pago, no son comerciales.
      </p>
    ),
  },
  {
    id: "vigencia",
    title: "Vigencia y cambios",
    body: (
      <>
        <p>
          Esta política rige desde el 4 de noviembre de 2026 y esta versión, desde el 8 de noviembre
          de 2026. Las bases de datos se conservan mientras exista la finalidad para la que se
          recogieron.
        </p>
        <p>
          Si hacemos cambios importantes, te avisaremos por correo o en el sitio antes de que
          apliquen y, cuando la ley lo exija, te pediremos una nueva autorización.
        </p>
      </>
    ),
  },
];

export default function Page() {
  return (
    <LegalPage
      title="Política de tratamiento de datos personales"
      updated="8 de noviembre de 2026"
      intro={
        <p>
          En Reranker cuidamos tus datos como cuidamos las respuestas que guardamos: sin cambiarlas
          y sin usarlas para algo que no sepas. Aquí te contamos qué datos tratamos, para qué y cómo
          ejercer tus derechos.
        </p>
      }
      sections={sections}
    />
  );
}
