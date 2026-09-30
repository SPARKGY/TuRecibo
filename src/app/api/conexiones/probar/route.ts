/**
 * `POST /api/conexiones/probar`
 *
 * Dos usos:
 * - con `{ fuente }` solo: prueba la configuración vigente y registra el
 *   resultado en la fila;
 * - con el mismo cuerpo que el PUT: prueba la candidata **sin guardar nada**,
 *   para validar antes de rotar.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { autenticarAdmin } from "@/lib/centria-auth";
import {
  CambioConexionSchema,
  errorARespuesta,
  FUENTES,
  probarCambio,
  probarConexion,
  registrarValidacion,
  resolverConexion,
} from "@/lib/turecibo/conexiones";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SIN_CACHE = { "cache-control": "no-store" };
const VigenteSchema = z.object({ fuente: z.enum(FUENTES) }).strict();

export async function POST(req: Request) {
  const auth = autenticarAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  const cuerpo = await req.json().catch(() => null);
  const { tenantId } = auth.datos;

  try {
    const vigente = VigenteSchema.safeParse(cuerpo);
    if (vigente.success) {
      const conexion = await resolverConexion(tenantId, vigente.data.fuente);
      if (!conexion) {
        return NextResponse.json({ error: "No hay conexión configurada" }, { status: 404, headers: SIN_CACHE });
      }
      const prueba = await probarConexion(conexion.fuente, conexion.modo, conexion.parametros, conexion.secretos);
      const registro = await registrarValidacion(tenantId, conexion.fuente, prueba, conexion.revision);
      return NextResponse.json({ ok: prueba.resultado !== "FALLIDA", prueba, registro }, { headers: SIN_CACHE });
    }

    const candidata = CambioConexionSchema.safeParse(cuerpo);
    if (!candidata.success) {
      const campos = candidata.error.issues.map((i) => i.path.join(".") || "cuerpo");
      return NextResponse.json({ error: "Cuerpo inválido", campos }, { status: 400, headers: SIN_CACHE });
    }
    const prueba = await probarCambio(tenantId, candidata.data);
    return NextResponse.json({ ok: prueba.resultado !== "FALLIDA", prueba }, { headers: SIN_CACHE });
  } catch (error) {
    const r = errorARespuesta(error);
    return NextResponse.json({ error: r.mensaje }, { status: r.status, headers: SIN_CACHE });
  }
}
