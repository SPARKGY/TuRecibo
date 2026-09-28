/**
 * `GET /centria/manifiesto`
 *
 * Lo que este módulo declara ante CENTRIA. Dos secciones:
 *
 *   `maestros` — los que necesita **leer** de CENTRIA (v1)
 *   `publica`  — los que **ofrece** a los consumidores (v2, aditivo)
 *
 * El manifiesto **no otorga acceso** en ninguna de las dos direcciones: es un
 * pedido y una oferta. Quien aprueba, campo por campo, es el SUPERADMIN desde
 * `/admin/modules`.
 *
 * El armado está en `@/lib/manifiesto` para poder probarlo sin levantar el
 * servidor: la forma de este documento es contrato con otro sistema, y un
 * cambio accidental ahí se paga en la integración, no acá.
 */

import { NextResponse } from "next/server";
import { autenticarCentria } from "@/lib/centria-auth";
import { armarManifiesto } from "@/lib/manifiesto";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = autenticarCentria(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  return NextResponse.json(armarManifiesto(), { headers: { "cache-control": "no-store" } });
}
