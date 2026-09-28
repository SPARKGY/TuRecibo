/**
 * Lectura de la base propia para armar los maestros publicados.
 *
 * Acá se aplica la decisión de retención: **la base guarda historial completo y
 * la ventana corta se aplica solo al publicar**. Un consumidor como Timesheet no
 * necesita las licencias de 2019, pero el módulo sí tiene que tenerlas, porque
 * Tu Recibo no permite ir a buscarlas de nuevo.
 *
 * La ventana se pide por query (`?ventanaDias=`) y tiene un techo duro. La idea
 * es que cada conexión de CENTRIA pueda pedir la suya sin que el módulo tenga
 * que conocer al consumidor: el relay pasa el parámetro y el módulo lo acota.
 */

import { prisma } from "@/lib/prisma";
import type { Fila, MaestroId } from "@/lib/maestros";

// La ventana vive en `@/lib/ventana` para que el manifiesto pueda declarar sus
// límites sin importar Prisma. Se reexporta acá porque las rutas de publicación
// ya venían pidiéndosela a este módulo.
export { resolverVentana, VENTANA_POR_DEFECTO, VENTANA_MAXIMA } from "@/lib/ventana";

const iso = (fecha: Date | null): string | null => (fecha ? fecha.toISOString().slice(0, 10) : null);

export async function leerFilas(
  tenantId: string,
  maestro: MaestroId,
  opciones: { ventanaDias: number; ahora?: Date },
): Promise<Fila[]> {
  if (maestro === "tipos-licencia") return leerTipos(tenantId);
  if (maestro === "feriados") return leerFeriados(tenantId);
  return leerAusencias(tenantId, opciones);
}

async function leerTipos(tenantId: string): Promise<Fila[]> {
  const filas = await prisma.tipoLicencia.findMany({ where: { tenantId } });
  return filas.map((f) => ({
    clave: f.externalId,
    activa: f.activo,
    actualizada: f.actualizadoEn,
    datos: {
      externalId: f.externalId,
      nombre: f.nombre,
      visible: f.visible,
      esVacaciones: f.esVacaciones,
    },
  }));
}

async function leerFeriados(tenantId: string): Promise<Fila[]> {
  const filas = await prisma.feriado.findMany({ where: { tenantId } });
  return filas.map((f) => ({
    clave: iso(f.fecha) ?? "",
    activa: f.activo,
    actualizada: f.actualizadoEn,
    datos: {
      fecha: iso(f.fecha),
      tipo: f.tipo,
      descripcion: f.descripcion,
      // Se publica a propósito: un consumidor que ve una diferencia con Tu
      // Recibo tiene que poder saber que fue una corrección deliberada y no un
      // error de sincronización.
      desdeOverride: f.desdeOverride,
    },
  }));
}

async function leerAusencias(tenantId: string, opciones: { ventanaDias: number; ahora?: Date }): Promise<Fila[]> {
  const ahora = opciones.ahora ?? new Date();
  const corte = new Date(ahora.getTime() - opciones.ventanaDias * 24 * 60 * 60 * 1000);

  const filas = await prisma.ausencia.findMany({
    where: {
      tenantId,
      // La ventana mira el fin de la ausencia, no el inicio: una licencia larga
      // que empezó antes del corte y sigue vigente hoy tiene que publicarse. Con
      // `desde >= corte` esa licencia desaparecería justo mientras la persona
      // está ausente, que es cuando más importa.
      OR: [{ hasta: { gte: corte } }, { hasta: null, desde: { gte: corte } }, { desde: null }],
    },
  });

  return filas.map((f) => ({
    clave: f.externalId,
    activa: f.activa,
    actualizada: f.actualizadaEn,
    datos: {
      externalId: f.externalId,
      personaExternalId: f.personaExternalId,
      tipoExternalId: f.tipoExternalId,
      tipoNombre: f.tipoNombre,
      estado: f.estado,
      desde: iso(f.desde),
      hasta: iso(f.hasta),
      regreso: iso(f.regreso),
      medioDia: f.medioDia,
      horas: f.horas,
      legajo: f.legajo,
      dni: f.dni,
      cuil: f.cuil,
      motivo: f.motivo,
    },
  }));
}

/** Sello del maestro, para que `actualizado` distinga "sin cambios" de "sin sync". */
export async function leerSello(tenantId: string, maestro: MaestroId): Promise<Date | null> {
  const sello = await prisma.selloMaestro.findUnique({
    where: { tenantId_maestro: { tenantId, maestro } },
    select: { actualizadoEn: true },
  });
  return sello?.actualizadoEn ?? null;
}
