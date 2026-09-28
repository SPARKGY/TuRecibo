/**
 * `POST /api/ingesta/feriados`
 *
 * La única puerta de entrada de feriados. La llama el robot de Playwright, que
 * corre fuera del App Service porque el panel legacy de Tu Recibo no tiene API y
 * hay que navegarlo con un browser de verdad.
 *
 * El robot manda lo que raspó; la reconciliación (overrides incluidos) pasa acá,
 * del lado de la base. El robot no decide nada: si decidiera, cada arreglo de
 * datos habría que hacerlo dos veces, una en el scraper y otra en el módulo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { validarSecreto, registrarUsoDelPrevio } from "@/lib/tokens";
import { ingestarFeriados, type FeriadoEntrante } from "@/lib/sync/feriados";
import { parseFechaISO, mapTipoFeriado } from "@/lib/turecibo/normalizar";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ENV_TOKEN = "FERIADOS_TOKEN";

const CuerpoSchema = z
  .object({
    tenantId: z.string().trim().min(1),
    /**
     * Años que la carga cubre. Es obligatorio y no se infiere de las fechas: si
     * se infiriera, un año que vino entero vacío (porque el panel falló) se
     * volvería invisible, y sus feriados quedarían vigentes para siempre.
     */
    anios: z.array(z.number().int().min(2000).max(2100)).nonempty(),
    feriados: z.array(
      z.object({
        fecha: z.string().trim().min(1),
        tipo: z.string().trim().optional(),
        descripcion: z.string().trim().default(""),
      }),
    ),
  })
  .strict();

export async function POST(req: Request) {
  const auth = validarSecreto(ENV_TOKEN, req.headers.get("x-feriados-token"));
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status });
  registrarUsoDelPrevio(ENV_TOKEN, auth.usóPrevio);

  const parsed = CuerpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Cuerpo inválido", detalle: parsed.error.flatten() }, { status: 400 });
  }

  const { tenantId, anios, feriados } = parsed.data;

  const entrantes: FeriadoEntrante[] = [];
  const descartados: string[] = [];

  for (const crudo of feriados) {
    const fecha = parseFechaISO(crudo.fecha);
    if (!fecha) {
      descartados.push(crudo.fecha);
      continue;
    }
    // Fuera de los años declarados no se acepta: si entrara, quedaría un feriado
    // suelto en un año que nadie reconcilia, y ninguna corrida futura lo tocaría.
    if (!anios.includes(fecha.getUTCFullYear())) {
      descartados.push(crudo.fecha);
      continue;
    }
    entrantes.push({ fecha, tipo: mapTipoFeriado(crudo.tipo), descripcion: crudo.descripcion });
  }

  try {
    const corrida = await ingestarFeriados({ tenantId, entrantes, anios, manual: false });
    return NextResponse.json({
      ok: true,
      corridaId: corrida.corridaId,
      ...corrida.conteos,
      descartados: descartados.length,
      fechasDescartadas: descartados.slice(0, 20),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 502 });
  }
}
