/**
 * Ventana de publicación de ausencias.
 *
 * Vive en su propio archivo, separado de `maestros-lectura.ts`, porque el
 * manifiesto necesita declarar estos límites y esa ruta no toca la base. Si los
 * leyera desde el módulo de lectura, importaría Prisma para responder un
 * documento estático.
 */

import { leerEntero } from "@/lib/env";

/** Días hacia atrás que se publican por defecto para `ausencias`. */
export const VENTANA_POR_DEFECTO = leerEntero("PUBLICACION_AUSENCIAS_DIAS", 31, 1, 3650);

/** Techo duro. Una ventana sin límite publicaría el legajo completo de todos. */
export const VENTANA_MAXIMA = leerEntero("PUBLICACION_AUSENCIAS_DIAS_MAX", 400, 1, 3650);

/**
 * Acota lo que pide el llamador.
 *
 * Un valor ausente, no numérico o no positivo cae al default en vez de
 * rechazarse: el parámetro es una preferencia del consumidor, no parte del
 * contrato, y fallar la lectura entera por un query mal escrito dejaría al
 * consumidor sin datos por un motivo que no es suyo.
 */
export function resolverVentana(pedida: string | null): number {
  if (!pedida) return VENTANA_POR_DEFECTO;
  const n = Number.parseInt(pedida, 10);
  if (!Number.isFinite(n) || n <= 0) return VENTANA_POR_DEFECTO;
  return Math.min(n, VENTANA_MAXIMA);
}
