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

/**
 * Día ISO de una fecha guardada.
 *
 * Corta en UTC, que es correcto porque **todo lo que se escribe en estas
 * columnas se construye con `Date.UTC` explícito** (`parseFechaTuRecibo` y
 * `parseFechaISO`). Si alguna vez se escribiera una fecha en hora local, acá el
 * día se correría uno al oeste de Greenwich. Hay una prueba de ida y vuelta que
 * ata las dos puntas.
 */
export const iso = (fecha: Date | null): string | null => (fecha ? fecha.toISOString().slice(0, 10) : null);

/** Lo mínimo que la ventana necesita mirar de una ausencia. */
export type FechasAusencia = { desde: Date | null; hasta: Date | null; regreso: Date | null };

/**
 * ¿Esta ausencia entra en la ventana de publicación?
 *
 * Es la **autoridad**: se aplica en memoria sobre lo que devuelve Prisma. El
 * `where` de `filtroDeVentana` es solo una pre-poda que evita traer la tabla
 * entera, y por eso tiene que ser un **superconjunto** de esta función; hay una
 * prueba que lo verifica caso por caso.
 *
 * Esa división existe porque la regla necesita **comparar dos columnas entre
 * sí** —`regreso` contra `desde`— y un `where` de Prisma no lo expresa. Hacer
 * que la base decidiera obligaría a simplificar la regla hasta volverla
 * incorrecta.
 *
 * La ventana mira el **fin** de la ausencia, no el inicio: una licencia larga
 * que empezó antes del corte y sigue vigente hoy tiene que publicarse. Con
 * `desde >= corte` desaparecería justo mientras la persona está ausente.
 *
 * El fin efectivo es `hasta`, y si no hay, `regreso`. `regreso` es el primer día
 * de vuelta (exclusivo), así que el fin real es el día anterior; se compara el
 * propio `regreso` porque incluir un día de más es inocuo y excluir de menos
 * borra del feed a alguien que todavía está ausente.
 *
 * **Un `regreso` anterior a `desde` no es un fin: es un dato roto.** El origen
 * puede mandarlo porque cada fecha se parsea por separado y nadie valida la
 * relación entre ellas. Tratarlo como fin sacaría del feed una ausencia que
 * puede seguir abierta, así que se descarta y la fila cae en el caso "sin fin
 * afirmado".
 *
 * Sin un fin afirmado la ausencia **no se puede dar por terminada**, y se
 * publica siempre. Acotarla por `desde` la haría desaparecer mientras sigue
 * potencialmente abierta, y esa falla es silenciosa: para el consumidor, una
 * fila que falta en una respuesta completa es indistinguible de "no hubo
 * ausencia". El costo de publicar de más es volumen, y el volumen falla ruidoso
 * contra el tope de filas con un 413.
 */
export function alcanzaLaVentana(fechas: FechasAusencia, corte: Date): boolean {
  if (fechas.desde && fechas.desde >= corte) return true;
  if (fechas.hasta) return fechas.hasta >= corte;

  const regresoCoherente = fechas.regreso && (!fechas.desde || fechas.regreso >= fechas.desde);
  if (regresoCoherente) return fechas.regreso! >= corte;

  return true;
}

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

/**
 * Pre-poda que se le manda a Prisma.
 *
 * **Es un superconjunto deliberado de `alcanzaLaVentana`, no su traducción.**
 * Trae de más y deja que la función pura decida, porque la regla real compara
 * `regreso` contra `desde` y eso no se expresa en un `where`.
 *
 * La rama `{ hasta: null }` es la que paga ese precio: se trae toda ausencia sin
 * fecha de fin, sin acotar por fecha. Son pocas —una licencia cerrada tiene
 * `hasta`— y el costo es volumen acotado contra el tope de filas, que falla
 * ruidoso. La alternativa era acotarlas por `desde` y perder en silencio las que
 * siguen abiertas.
 */
export function filtroDeVentana(corte: Date) {
  return [{ desde: { gte: corte } }, { hasta: { gte: corte } }, { hasta: null }];
}

async function leerAusencias(tenantId: string, opciones: { ventanaDias: number; ahora?: Date }): Promise<Fila[]> {
  const ahora = opciones.ahora ?? new Date();
  const corte = new Date(ahora.getTime() - opciones.ventanaDias * 24 * 60 * 60 * 1000);

  const candidatas = await prisma.ausencia.findMany({
    where: {
      tenantId,
      OR: filtroDeVentana(corte),
    },
  });

  const filas = candidatas.filter((f) => alcanzaLaVentana(f, corte));

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
