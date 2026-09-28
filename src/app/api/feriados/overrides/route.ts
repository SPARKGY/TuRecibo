/**
 * `GET|PUT|DELETE /api/feriados/overrides`
 *
 * Las correcciones manuales del calendario. Sobreviven al sync: se guardan
 * aparte del espejo crudo del origen y se reaplican después de cada ingesta.
 *
 * Todo override exige motivo escrito. No es ceremonia: dentro de seis meses, la
 * única forma de saber si una diferencia con Tu Recibo fue deliberada o un bug
 * es que alguien lo haya escrito cuando lo hizo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { autenticarUsuario, exigirAdmin } from "@/lib/centria-auth";
import { prisma } from "@/lib/prisma";
import { reaplicarOverrides } from "@/lib/sync/feriados";
import { parseFechaISO } from "@/lib/turecibo/normalizar";

export const dynamic = "force-dynamic";

const AltaSchema = z
  .object({
    fecha: z.string().trim().min(1),
    accion: z.enum(["ALTA", "BAJA", "CAMBIO"]),
    tipo: z.enum(["FERIADO_NACIONAL", "NO_LABORABLE"]).optional(),
    descripcion: z.string().trim().max(300).optional(),
    motivo: z.string().trim().min(10, "El motivo tiene que explicar la corrección"),
  })
  .strict();

const BajaSchema = z.object({ fecha: z.string().trim().min(1) }).strict();

export async function GET(req: Request) {
  const auth = autenticarUsuario(req);
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });

  const overrides = await prisma.feriadoOverride.findMany({
    where: { tenantId: auth.datos.tenantId },
    orderBy: { fecha: "desc" },
  });

  return NextResponse.json({ overrides }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(req: Request) {
  const admin = await exigirAdminDe(req);
  if ("respuesta" in admin) return admin.respuesta;

  const parsed = AltaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Cuerpo inválido", detalle: parsed.error.flatten() }, { status: 400 });
  }

  const fecha = parseFechaISO(parsed.data.fecha);
  if (!fecha) return NextResponse.json({ error: "fecha debe ser YYYY-MM-DD" }, { status: 400 });

  // ALTA y CAMBIO tienen que traer el valor que va a quedar vigente; si no, la
  // reaplicación no sabría qué escribir y dejaría una fila a medio construir.
  if (parsed.data.accion !== "BAJA" && (!parsed.data.tipo || !parsed.data.descripcion)) {
    return NextResponse.json({ error: `La acción ${parsed.data.accion} exige tipo y descripción` }, { status: 400 });
  }

  const { tenantId, usuarioId, email } = admin.identidad;

  await prisma.feriadoOverride.upsert({
    where: { tenantId_fecha: { tenantId, fecha } },
    create: {
      tenantId,
      fecha,
      accion: parsed.data.accion,
      tipo: parsed.data.tipo ?? null,
      descripcion: parsed.data.descripcion ?? null,
      motivo: parsed.data.motivo,
      autorId: usuarioId,
      autorEmail: email,
    },
    update: {
      accion: parsed.data.accion,
      tipo: parsed.data.tipo ?? null,
      descripcion: parsed.data.descripcion ?? null,
      motivo: parsed.data.motivo,
      autorId: usuarioId,
      autorEmail: email,
    },
  });

  const corrida = await reaplicarOverrides(tenantId, [fecha.getUTCFullYear()], true);
  return NextResponse.json({ ok: true, ...corrida.conteos });
}

export async function DELETE(req: Request) {
  const admin = await exigirAdminDe(req);
  if ("respuesta" in admin) return admin.respuesta;

  const parsed = BajaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Cuerpo inválido: fecha" }, { status: 400 });

  const fecha = parseFechaISO(parsed.data.fecha);
  if (!fecha) return NextResponse.json({ error: "fecha debe ser YYYY-MM-DD" }, { status: 400 });

  const { tenantId } = admin.identidad;

  const borrado = await prisma.feriadoOverride.deleteMany({ where: { tenantId, fecha } });
  if (borrado.count === 0) return NextResponse.json({ error: "No hay override para esa fecha" }, { status: 404 });

  // Sacar un override tiene que devolver la fila al valor del origen, no dejarla
  // como quedó: para eso existe el espejo crudo en `Feriado`.
  const corrida = await reaplicarOverrides(tenantId, [fecha.getUTCFullYear()], true);
  return NextResponse.json({ ok: true, ...corrida.conteos });
}

async function exigirAdminDe(req: Request) {
  const auth = autenticarUsuario(req);
  if (!auth.ok) return { respuesta: NextResponse.json({ error: auth.mensaje }, { status: auth.status }) };

  const admin = exigirAdmin(auth.datos);
  if (!admin.ok) return { respuesta: NextResponse.json({ error: admin.mensaje }, { status: admin.status }) };

  return { identidad: admin.datos };
}
