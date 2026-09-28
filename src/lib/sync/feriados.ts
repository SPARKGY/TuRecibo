/**
 * Reconciliación de feriados, con correcciones manuales que sobreviven al sync.
 *
 * Tres cosas que no son obvias y que definen todo el archivo:
 *
 * 1. **El robot trae años sueltos, no el calendario entero.** El panel legacy se
 *    consulta con `type=feriadosPorAño`, así que una corrida trae 2026 y 2027 y
 *    no sabe nada de 2025. Si la reconciliación comparara contra toda la tabla,
 *    daría de baja todos los feriados de los años que no se pidieron. Por eso
 *    todo acá está acotado a los años que vinieron en la carga.
 *
 * 2. **El override gana y persiste.** Se aplica *después* de espejar, sobre el
 *    resultado. Sin eso, corregir un feriado que el panel trae mal duraría hasta
 *    la madrugada siguiente.
 *
 * 3. **El espejo crudo se guarda aparte del valor vigente.** `tipoOrigen` y
 *    `descripcionOrigen` conservan lo que dijo Tu Recibo antes de la corrección.
 *    Sin eso, quitar un override de tipo CAMBIO no tendría a qué volver y el
 *    feriado se daría de baja como si el origen nunca lo hubiera traído: la
 *    corrección sería destructiva en vez de reversible.
 */

import type { AccionOverride, TipoFeriado } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { conteosVacios, CorridaAbortada, ejecutarCorrida, sellarMaestro, type Conteos } from "@/lib/sync/corrida";

export type FeriadoEntrante = { fecha: Date; tipo: TipoFeriado; descripcion: string };

export type OverrideVigente = {
  fecha: Date;
  accion: AccionOverride;
  tipo: TipoFeriado | null;
  descripcion: string | null;
};

/** Fila deseada: el valor vigente más el espejo crudo del que salió. */
export type FeriadoDeseado = {
  fecha: Date;
  tipo: TipoFeriado;
  descripcion: string;
  desdeOverride: boolean;
  enOrigen: boolean;
  tipoOrigen: TipoFeriado | null;
  descripcionOrigen: string | null;
};

type FeriadoExistente = {
  fecha: Date;
  tipo: TipoFeriado;
  descripcion: string;
  desdeOverride: boolean;
  enOrigen: boolean;
  tipoOrigen: TipoFeriado | null;
  descripcionOrigen: string | null;
  activo: boolean;
};

const clave = (fecha: Date): string => fecha.toISOString().slice(0, 10);
const anio = (fecha: Date): number => fecha.getUTCFullYear();

/**
 * Aplica las correcciones manuales sobre lo que trajo el origen.
 *
 * Un `CAMBIO` sobre una fecha que el origen no trajo no inventa el feriado: si
 * alguien quiere que exista, la acción es `ALTA`. Confundirlas haría que un
 * `CAMBIO` viejo resucite un feriado que el origen ya retiró.
 */
export function aplicarOverrides(
  entrantes: FeriadoEntrante[],
  overrides: OverrideVigente[],
): { resultado: FeriadoDeseado[]; aplicados: number } {
  const porFecha = new Map<string, FeriadoDeseado>();
  for (const f of entrantes) {
    porFecha.set(clave(f.fecha), {
      fecha: f.fecha,
      tipo: f.tipo,
      descripcion: f.descripcion,
      desdeOverride: false,
      enOrigen: true,
      tipoOrigen: f.tipo,
      descripcionOrigen: f.descripcion,
    });
  }

  let aplicados = 0;
  for (const override of overrides) {
    const k = clave(override.fecha);
    const existente = porFecha.get(k);

    if (override.accion === "BAJA") {
      if (existente) {
        porFecha.delete(k);
        aplicados++;
      }
      continue;
    }

    if (override.accion === "ALTA") {
      porFecha.set(k, {
        fecha: override.fecha,
        tipo: override.tipo ?? "FERIADO_NACIONAL",
        descripcion: override.descripcion ?? "Feriado cargado a mano",
        desdeOverride: true,
        // `enOrigen` describe el espejo, no el resultado: si el origen igual
        // trajo esa fecha, sigue siendo cierto que la trajo.
        enOrigen: existente?.enOrigen ?? false,
        tipoOrigen: existente?.tipoOrigen ?? null,
        descripcionOrigen: existente?.descripcionOrigen ?? null,
      });
      aplicados++;
      continue;
    }

    // CAMBIO: corrige lo que vino, conservando el crudo.
    if (!existente) continue;
    porFecha.set(k, {
      ...existente,
      tipo: override.tipo ?? existente.tipo,
      descripcion: override.descripcion ?? existente.descripcion,
      desdeOverride: true,
    });
    aplicados++;
  }

  return { resultado: [...porFecha.values()], aplicados };
}

/** Reconciliación pura, acotada a los años cubiertos por la carga. */
export function planificarFeriados(
  deseados: FeriadoDeseado[],
  existentes: FeriadoExistente[],
  aniosCubiertos: Set<number>,
) {
  const porFecha = new Map(existentes.map((e) => [clave(e.fecha), e]));
  const vistos = new Set<string>();

  const altas: FeriadoDeseado[] = [];
  const cambios: FeriadoDeseado[] = [];

  for (const deseado of deseados) {
    const k = clave(deseado.fecha);
    vistos.add(k);
    const actual = porFecha.get(k);
    if (!actual) {
      altas.push(deseado);
      continue;
    }
    const igual =
      actual.activo &&
      actual.tipo === deseado.tipo &&
      actual.descripcion === deseado.descripcion &&
      actual.desdeOverride === deseado.desdeOverride &&
      actual.enOrigen === deseado.enOrigen &&
      actual.tipoOrigen === deseado.tipoOrigen &&
      actual.descripcionOrigen === deseado.descripcionOrigen;
    if (!igual) cambios.push(deseado);
  }

  const bajas = existentes
    .filter((e) => e.activo && aniosCubiertos.has(anio(e.fecha)) && !vistos.has(clave(e.fecha)))
    .map((e) => e.fecha);

  return { altas, cambios, bajas };
}

const CAMPOS_EXISTENTE = {
  fecha: true,
  tipo: true,
  descripcion: true,
  desdeOverride: true,
  enOrigen: true,
  tipoOrigen: true,
  descripcionOrigen: true,
  activo: true,
} as const;

/**
 * Escribe la carga que dejó el robot.
 *
 * El robot corre en GitHub Actions porque necesita un navegador; este módulo
 * solo recibe el resultado. La validación del token de esa llamada está en la
 * ruta de ingesta, no acá.
 */
export async function ingestarFeriados(args: {
  tenantId: string;
  entrantes: FeriadoEntrante[];
  anios: number[];
  manual: boolean;
  /** Permite escribir aunque la carga venga vacía. Solo para reaplicar overrides. */
  permitirVacio?: boolean;
}) {
  const { tenantId, entrantes, anios, manual, permitirVacio = false } = args;

  return ejecutarCorrida(tenantId, "FERIADOS", manual, async (): Promise<Conteos> => {
    // Un año pedido que vuelve sin un solo feriado es casi siempre el robot
    // roto: el panel legacy cambió, el login no estableció la sesión PHP y la
    // respuesta fue un HTML de error que se parseó como lista vacía. Ningún año
    // civil argentino tiene cero feriados, así que se aborta antes de escribir.
    if (entrantes.length === 0 && !permitirVacio) {
      throw new CorridaAbortada(
        `La carga de feriados para ${anios.join(", ")} vino vacía: se aborta sin escribir. Revisar el robot.`,
      );
    }

    const aniosCubiertos = new Set(anios);
    const overrides = await prisma.feriadoOverride.findMany({
      where: { tenantId },
      select: { fecha: true, accion: true, tipo: true, descripcion: true },
    });
    const overridesDelPeriodo = overrides.filter((o) => aniosCubiertos.has(anio(o.fecha)));

    const { resultado, aplicados } = aplicarOverrides(entrantes, overridesDelPeriodo);

    const existentes = (await prisma.feriado.findMany({
      where: { tenantId },
      select: CAMPOS_EXISTENTE,
    })) as FeriadoExistente[];

    const plan = planificarFeriados(resultado, existentes, aniosCubiertos);
    const ahora = new Date();

    await prisma.$transaction(async (tx) => {
      for (const alta of plan.altas) {
        await tx.feriado.create({ data: { tenantId, ...alta, activo: true, bajaEn: null } });
      }
      for (const cambio of plan.cambios) {
        await tx.feriado.update({
          where: { tenantId_fecha: { tenantId, fecha: cambio.fecha } },
          data: {
            tipo: cambio.tipo,
            descripcion: cambio.descripcion,
            desdeOverride: cambio.desdeOverride,
            enOrigen: cambio.enOrigen,
            tipoOrigen: cambio.tipoOrigen,
            descripcionOrigen: cambio.descripcionOrigen,
            activo: true,
            bajaEn: null,
          },
        });
      }
      for (const fecha of plan.bajas) {
        await tx.feriado.update({
          where: { tenantId_fecha: { tenantId, fecha } },
          data: { activo: false, bajaEn: ahora },
        });
      }
    });

    const conteos = conteosVacios();
    conteos.leidas = entrantes.length;
    conteos.altas = plan.altas.length;
    conteos.cambios = plan.cambios.length;
    conteos.bajas = plan.bajas.length;

    if (aplicados > 0) {
      console.warn(
        `[feriados] ${aplicados} corrección(es) manual(es) aplicadas sobre lo que trajo Tu Recibo (tenant ${tenantId}).`,
      );
    }

    await sellarMaestro(tenantId, "feriados", conteos.altas + conteos.cambios + conteos.bajas > 0);
    return conteos;
  });
}

/**
 * Reaplica los overrides sin volver a consultar el origen.
 *
 * Es lo que corre cuando alguien carga o borra una corrección: el efecto tiene
 * que verse ya, no en la próxima corrida del robot. Reconstruye el espejo desde
 * `tipoOrigen`/`descripcionOrigen`, que es justamente para lo que se guardan.
 */
export async function reaplicarOverrides(tenantId: string, anios: number[], manual: boolean) {
  const aniosCubiertos = new Set(anios);
  const filas = await prisma.feriado.findMany({
    where: { tenantId, enOrigen: true },
    select: { fecha: true, tipoOrigen: true, descripcionOrigen: true },
  });

  const entrantes: FeriadoEntrante[] = filas
    .filter((f) => aniosCubiertos.has(anio(f.fecha)) && f.tipoOrigen !== null && f.descripcionOrigen !== null)
    .map((f) => ({ fecha: f.fecha, tipo: f.tipoOrigen as TipoFeriado, descripcion: f.descripcionOrigen as string }));

  // Acá el vacío sí es legítimo: puede que el único feriado del año fuera un
  // ALTA manual que se acaba de borrar. No es el robot roto, así que no se aborta.
  return ingestarFeriados({ tenantId, entrantes, anios, manual, permitirVacio: true });
}
