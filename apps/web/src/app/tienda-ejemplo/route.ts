// What tienda-ejemplo.reranker.co serves: a stand-in for a store website with no Google Maps
// listing, which the target contract test resolves as a website candidate in Colombia. It is a
// bare document on purpose, without the app's layout, analytics or consent banner.
const PAGE = `<!doctype html>
<html lang="es-CO">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Tienda de ejemplo</title>
    <meta name="description" content="Página de prueba de Reranker. No es un negocio real.">
  </head>
  <body>
    <h1>Tienda de ejemplo</h1>
    <p>Página de prueba de Reranker. No es un negocio real y no vende nada.</p>
  </body>
</html>
`;

export function GET() {
  return new Response(PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
