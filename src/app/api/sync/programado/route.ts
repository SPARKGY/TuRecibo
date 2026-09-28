/**
 * `POST /api/sync/programado`
 *
 * Lo llama el workflow de GitHub Actions con su propio token
 * (`x-sync-token` ← `SYNC_TOKEN`), no con el token de entrada de CENTRIA ni con
 * la credencial del módulo.
 *
 * Tres secretos distintos para tres caminos distintos no es burocracia: es lo
 * que permite rotar el del programador sin tocar el enchufe, y lo que hace que
 * filtrar el secreto de CI no abra la lectura de maestros.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { validarSecreto, registrarUsoDelPrevio } from "@/lib/tokens";
import { tenantsActivos } from "@/lib/turecibo/credenciales";
import { sincronizarTipos } from "@/lib/sync/tipos";
import { sincronizarAusencias } from "@/lib/sync/ausencias";
import { cruzarIdentidades } from "@/lib/sync/identidades";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ENV_TOKEN = "SYNC_TOKEN";

const CuerpoSchema = z
  .object({
    tenantId: z.string().trim().min(1).optional(),
    /** Por defecto corre las dos fuentes de API. Feriados entran por ingesta. */
    fuentes: z.array(z.enum(["tipos", "ausencias"])).nonempty().optional(),
  })
  .strict();

export async function POST(req: Request) {
  const auth = validarSecreto(ENV_TOKEN, req.headers.get("x-sync-token"));
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });
  registrarUsoDelPrevio(ENV_TOKEN, auth.usóPrevio);

  const crudo = await req.json().catch(() => ({}));
  const parsed = CuerpoSchema.safeParse(crudo ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Cuerpo inválido: tenantId y/o fuentes" }, { status: 400 });
  }

  const tenants = parsed.data.tenantId ? [parsed.data.tenantId] : await tenantsActivos();
  if (tenants.length === 0) {
    return NextResponse.json({ error: "No hay tenants con credenciales activas" }, { status: 409 });
  }

  const fuentes = parsed.data.fuentes ?? (["tipos", "ausencias"] as const);
  const resultados: Record<string, unknown>[] = [];
  let huboFallas = false;

  for (const tenantId of tenants) {
    // Un tenant que falla no cancela a los demás: son extracciones
    // independientes y cortar acá dejaría a los siguientes sin sincronizar por
    // un problema que no es suyo.
    for (const fuente of fuentes) {
      try {
        const corrida =
          fuente === "tipos" ? await sincronizarTipos(tenantId, false) : await sincronizarAusencias(tenantId, false);
        resultados.push({ tenantId, fuente, ok: true, ...corrida.conteos });
      } catch (error) {
        huboFallas = true;
        resultados.push({ tenantId, fuente, ok: false, error: (error as Error).message });
      }
    }

    // El cruce va después de las ausencias y solo si se sincronizaron: correrlo
    // sobre datos que no se actualizaron gasta una lectura de CENTRIA para
    // llegar exactamente al mismo resultado.
    if (fuentes.includes("ausencias")) {
      try {
        const cruce = await cruzarIdentidades(tenantId);
        resultados.push({ tenantId, fuente: "identidades", ok: true, ...cruce });
      } catch (error) {
        huboFallas = true;
        resultados.push({ tenantId, fuente: "identidades", ok: false, error: (error as Error).message });
      }
    }
  }

  // 207 y no 200: si un tenant falló, el workflow tiene que poder distinguirlo
  // sin parsear el cuerpo, y marcar la corrida en rojo.
  return NextResponse.json({ resultados }, { status: huboFallas ? 207 : 200 });
}
