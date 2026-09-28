/**
 * `GET /centria/maestros/<id>` — la publicación.
 *
 * Solo responde al token de entrada de CENTRIA. **No es público y no atiende a
 * otros módulos directamente**: quien filtra por campo y fila, y quien decide
 * qué consumidor puede ver qué, es CENTRIA. Si un módulo pudiera llamar acá, el
 * enchufe entero dejaría de tener sentido, porque el filtro por conexión se
 * saltearía pidiendo el maestro completo.
 *
 * Parámetros:
 *   ?campos=a,b       subconjunto de campos; la clave siempre viaja
 *   ?desde=<ISO>      incremental: solo lo que cambió, más `bajas[]`
 *   ?ventanaDias=N    ventana de publicación (solo aplica a `ausencias`)
 */

import { NextResponse } from "next/server";
import { autenticarCentriaConTenant } from "@/lib/centria-auth";
import { armarRespuesta, buscarMaestro, LIMITE_BYTES, LIMITE_FILAS } from "@/lib/maestros";
import { leerFilas, leerSello, resolverVentana } from "@/lib/maestros-lectura";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const auth = autenticarCentriaConTenant(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  const maestro = buscarMaestro(params.id);
  if (!maestro) {
    return NextResponse.json({ error: `Maestro desconocido: ${params.id}` }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);

  const desdeTexto = searchParams.get("desde");
  const desde = desdeTexto ? new Date(desdeTexto) : null;
  if (desde && Number.isNaN(desde.getTime())) {
    return NextResponse.json({ error: "desde debe ser una fecha ISO" }, { status: 400 });
  }

  const conocidos = new Set(maestro.campos.map((c) => c.id));
  const pedidos = searchParams
    .get("campos")
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const desconocidos = pedidos?.filter((c) => !conocidos.has(c)) ?? [];
  if (desconocidos.length) {
    return NextResponse.json(
      { error: `Campos fuera del catálogo de ${maestro.id}: ${desconocidos.join(", ")}`, campos: desconocidos },
      { status: 400 },
    );
  }

  const campos = pedidos ?? maestro.campos.map((c) => c.id);
  const ventanaDias = resolverVentana(searchParams.get("ventanaDias"));

  const [filas, selloActualizado] = await Promise.all([
    leerFilas(auth.datos.tenantId, maestro.id, { ventanaDias }),
    leerSello(auth.datos.tenantId, maestro.id),
  ]);

  const respuesta = armarRespuesta({ maestro, filas, campos, desde, selloActualizado });

  // Los topes del contrato se validan antes de responder. Que la salida quede
  // corta no es una opción: el consumidor no puede distinguir una lista
  // truncada de una completa, así que un exceso tiene que doler acá y no
  // convertirse en ausencias que nadie ve.
  const cuerpo = JSON.stringify(respuesta);
  const total = respuesta.filas.length + respuesta.bajas.length;
  const bytes = Buffer.byteLength(cuerpo, "utf8");

  if (total > LIMITE_FILAS || bytes > LIMITE_BYTES) {
    return NextResponse.json(
      {
        error:
          `La respuesta de ${maestro.id} excede los límites del contrato ` +
          `(${total} filas, ${bytes} bytes; máximo ${LIMITE_FILAS} filas y ${LIMITE_BYTES} bytes). ` +
          "Acotar con ?desde=, ?ventanaDias= o ?campos=.",
        filas: total,
        bytes,
      },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }

  // `no-store` a propósito: el que cachea es CENTRIA, que ya lo hace cinco
  // minutos y sabe marcar la respuesta como desactualizada si el origen no
  // contesta. Una segunda capa de caché acá haría que ese aviso mintiera.
  return new NextResponse(cuerpo, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
