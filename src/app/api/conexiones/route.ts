/**
 * `GET|PUT /api/conexiones`
 *
 * Administración de las conexiones a Tu Recibo del tenant. Solo ADMIN del
 * módulo. Ninguna respuesta incluye valores de secreto: el GET muestra
 * referencias y una máscara fija; el PUT recibe valores y los escribe en Key
 * Vault, nunca en la base.
 */

import { NextResponse } from "next/server";
import { autenticarAdmin } from "@/lib/centria-auth";
import { aplicarCambio, CambioConexionSchema, describirConexiones, errorARespuesta } from "@/lib/turecibo/conexiones";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SIN_CACHE = { "cache-control": "no-store" };

export async function GET(req: Request) {
  const auth = autenticarAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  try {
    const conexiones = await describirConexiones(auth.datos.tenantId);
    return NextResponse.json({ conexiones }, { headers: SIN_CACHE });
  } catch (error) {
    const r = errorARespuesta(error);
    return NextResponse.json({ error: r.mensaje }, { status: r.status, headers: SIN_CACHE });
  }
}

export async function PUT(req: Request) {
  const auth = autenticarAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  const parsed = CambioConexionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Sin `detalle` crudo de zod: el error podría repetir el valor recibido.
    const campos = parsed.error.issues.map((i) => i.path.join(".") || "cuerpo");
    return NextResponse.json({ error: "Cuerpo inválido", campos }, { status: 400, headers: SIN_CACHE });
  }

  try {
    const { tenantId, usuarioId, email } = auth.datos;
    const resultado = await aplicarCambio(tenantId, parsed.data, { usuarioId, email });
    if (!resultado.guardado) {
      return NextResponse.json(
        {
          ok: false,
          error: "La prueba falló y no se guardó nada. Reintentar con forzar=true para guardar igual.",
          prueba: resultado.prueba,
        },
        { status: 422, headers: SIN_CACHE },
      );
    }
    // Rastro de auditoría: quién rotó qué campo (nombres, no valores).
    console.warn(
      `[conexiones] ${tenantId}/${parsed.data.fuente} modo=${parsed.data.modo} rotados=[${resultado.rotados.join(",")}] ` +
        `prueba=${resultado.prueba.resultado} por=${usuarioId}`,
    );
    return NextResponse.json({ ok: true, ...resultado }, { headers: SIN_CACHE });
  } catch (error) {
    const r = errorARespuesta(error);
    return NextResponse.json({ error: r.mensaje }, { status: r.status, headers: SIN_CACHE });
  }
}
