/**
 * `GET /centria/salud`
 *
 * Ping autenticado, pensado para probar una rotación de secreto sin tocar datos.
 *
 * Valida **solo** el token de entrada: no exige usuario, no devuelve nada de
 * negocio y no dice qué tenants existen. Un ping que filtra información es la
 * forma más común de convertir un chequeo de salud en un enumerador.
 */

import { NextResponse } from "next/server";
import { autenticarCentria } from "@/lib/centria-auth";
import { CODIGO_MODULO, VERSION_MODULO } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = autenticarCentria(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  return NextResponse.json({
    ok: true,
    codigo: CODIGO_MODULO,
    version: VERSION_MODULO,
    ahora: new Date().toISOString(),
  });
}
