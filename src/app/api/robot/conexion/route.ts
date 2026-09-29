/**
 * `GET|POST /api/robot/conexion`
 *
 * Lo que el robot de feriados necesita para entrar al panel legacy, sin tener
 * credenciales propias en GitHub: modo, parámetros y el secreto que
 * corresponda. Protegido con `FERIADOS_TOKEN` (`x-feriados-token`), el mismo que
 * ya autoriza la ingesta: quien puede escribir feriados ya es el robot.
 *
 * - `GET ?tenantId=` → conexión `FERIADOS_PANEL` resuelta. 404 si el tenant no
 *   tiene nada configurado: el robot cae a sus variables de entorno.
 * - `POST { tenantId, ok, detalle, revision }` → el robot informa si la
 *   credencial/sesión sirvió, y queda en `ultimoResultadoValidacion`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { registrarUsoDelPrevio, validarSecreto } from "@/lib/tokens";
import { errorARespuesta, registrarValidacion, resolverConexion } from "@/lib/turecibo/conexiones";

export const dynamic = "force-dynamic";

const ENV_TOKEN = "FERIADOS_TOKEN";
const SIN_CACHE = { "cache-control": "no-store" };

const TenantSchema = z.string().trim().min(1).max(200);

const ReporteSchema = z
  .object({
    tenantId: TenantSchema,
    ok: z.boolean(),
    detalle: z.string().trim().max(1000).default(""),
    revision: z.string().trim().max(100).optional(),
  })
  .strict();

function autenticar(req: Request) {
  const auth = validarSecreto(ENV_TOKEN, req.headers.get("x-feriados-token"));
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });
  registrarUsoDelPrevio(ENV_TOKEN, auth.usóPrevio);
  return null;
}

export async function GET(req: Request) {
  const rechazo = autenticar(req);
  if (rechazo) return rechazo;

  const tenant = TenantSchema.safeParse(new URL(req.url).searchParams.get("tenantId"));
  if (!tenant.success) return NextResponse.json({ error: "Falta tenantId" }, { status: 400 });

  try {
    const conexion = await resolverConexion(tenant.data, "FERIADOS_PANEL");
    if (!conexion) {
      return NextResponse.json({ error: "El tenant no tiene conexión al panel" }, { status: 404, headers: SIN_CACHE });
    }
    return NextResponse.json(
      {
        tenantId: conexion.tenantId,
        fuente: conexion.fuente,
        modo: conexion.modo,
        parametros: conexion.parametros,
        credenciales: conexion.secretos,
        origen: conexion.origen,
        revision: conexion.revision,
      },
      { headers: SIN_CACHE },
    );
  } catch (error) {
    const r = errorARespuesta(error);
    return NextResponse.json({ error: r.mensaje }, { status: r.status, headers: SIN_CACHE });
  }
}

export async function POST(req: Request) {
  const rechazo = autenticar(req);
  if (rechazo) return rechazo;

  const parsed = ReporteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });

  const { tenantId, ok, detalle, revision } = parsed.data;
  try {
    const registro = await registrarValidacion(
      tenantId,
      "FERIADOS_PANEL",
      { resultado: ok ? "OK" : "FALLIDA", detalle: detalle || (ok ? "Validado por el robot." : "Falló en el robot.") },
      revision,
    );
    return NextResponse.json({ ok: true, registro }, { headers: SIN_CACHE });
  } catch (error) {
    const r = errorARespuesta(error);
    return NextResponse.json({ error: r.mensaje }, { status: r.status, headers: SIN_CACHE });
  }
}
