/**
 * `POST /api/sync/manual`
 *
 * La misma extracción, disparada por una persona desde el módulo. Entra por el
 * proxy de CENTRIA, así que valida el token de entrada **y** exige rol ADMIN en
 * el módulo.
 *
 * Solo corre el tenant de quien la dispara. Un admin de un tenant no tiene por
 * qué poder forzar una corrida contra el proveedor en nombre de otro.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { autenticarUsuario, exigirAdmin } from "@/lib/centria-auth";
import { sincronizarTipos } from "@/lib/sync/tipos";
import { sincronizarAusencias } from "@/lib/sync/ausencias";
import { cruzarIdentidades } from "@/lib/sync/identidades";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CuerpoSchema = z
  .object({ fuente: z.enum(["tipos", "ausencias"]) })
  .strict();

export async function POST(req: Request) {
  const auth = autenticarUsuario(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  const admin = exigirAdmin(auth.datos);
  if (!admin.ok) return NextResponse.json({ error: admin.mensaje }, { status: admin.status });

  const parsed = CuerpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Cuerpo inválido: fuente debe ser 'tipos' o 'ausencias'" }, { status: 400 });
  }

  const { tenantId } = admin.datos;

  try {
    const corrida =
      parsed.data.fuente === "tipos"
        ? await sincronizarTipos(tenantId, true)
        : await sincronizarAusencias(tenantId, true);

    const cruce = parsed.data.fuente === "ausencias" ? await cruzarIdentidades(tenantId) : null;

    return NextResponse.json({ ok: true, corridaId: corrida.corridaId, ...corrida.conteos, cruce });
  } catch (error) {
    // El detalle va en el cuerpo porque quien lo ve es un ADMIN del módulo, que
    // es exactamente quien tiene que poder leer por qué falló la corrida.
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 502 });
  }
}
