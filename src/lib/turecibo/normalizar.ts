/**
 * Normalización de lo que devuelve Tu Recibo.
 *
 * Todo lo de este archivo es función pura sobre datos crudos: se puede probar
 * entero sin red y sin credenciales, que es justamente donde han estado los
 * errores históricos (fechas DD/MM/YYYY leídas como MM/DD, estados comparados
 * por texto, DNI derivado mal del CUIL).
 */

import type { EstadoAusencia, TipoFeriado } from "@prisma/client";

/** Normaliza un DNI a solo dígitos, sin ceros a la izquierda. */
export function normalizarDni(valor: string | null | undefined): string | null {
  const digitos = (valor ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digitos.length ? digitos : null;
}

/**
 * Deriva el DNI del CUIL/CUIT: 11 dígitos = 2 de prefijo + 8 de DNI + 1
 * verificador. Si el valor ya parece un DNI (7 u 8 dígitos), se usa directo.
 *
 * Tu Recibo no expone el DNI: este cálculo es el único puente con el maestro
 * `personas` de CENTRIA.
 */
export function dniDesdeCuil(cuil: string | null | undefined): string | null {
  const digitos = (cuil ?? "").replace(/\D/g, "");
  if (digitos.length === 11) return normalizarDni(digitos.slice(2, 10));
  if (digitos.length >= 7 && digitos.length <= 8) return normalizarDni(digitos);
  return null;
}

/**
 * Parsea DD/MM/YYYY a medianoche UTC.
 *
 * Tu Recibo manda el día sin zona. Construirlo con `new Date(texto)` lo
 * interpretaría en la zona del servidor y, al oeste de Greenwich, correría cada
 * licencia un día hacia atrás.
 */
export function parseFechaTuRecibo(texto: string | null | undefined): Date | null {
  const m = (texto ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const fecha = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** Parsea YYYY-MM-DD (el formato del panel legacy de feriados) a UTC. */
export function parseFechaISO(texto: string | null | undefined): Date | null {
  const m = (texto ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const fecha = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Catálogo real de estados de Tu Recibo, relevado contra producción por KAiROS
 * el 2026-08-07 sobre 2451 licencias:
 *
 *    7  Asignacion                      1144
 *    5  Aprobado                        1062
 *   10  Cancelada                        154
 *    8  Rechazado                         52
 *    4  En manos de RRHH                  34
 *    2  En manos de aprobador nivel 1      5
 *
 * Se mapea por id y no por texto para que un renombre en el origen no cambie el
 * comportamiento en silencio.
 */
const ESTADO_POR_ID: Record<string, EstadoAusencia> = {
  "2": "SOLICITADA",
  "4": "SOLICITADA",
  "5": "APROBADA",
  "7": "SOLICITADA",
  "8": "RECHAZADA",
  "10": "RECHAZADA",
};

/** Respaldo por texto, solo para ids que no estén en el catálogo relevado. */
export function mapEstadoPorTexto(estado: string | null | undefined): EstadoAusencia {
  const s = (estado ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/rechaz|cancel|anul|deneg|desist/.test(s)) return "RECHAZADA";
  // "aprobada/aprobado" sí; "aprobador" no — es un paso del circuito, no un
  // resultado. Sin esa exclusión, "En manos de aprobador nivel 1" contaría como
  // aprobada y una licencia en trámite se publicaría como firme.
  if (!/aprobador/.test(s) && /aprobad[ao]s?\b|finaliz|gozad|autorizad/.test(s)) {
    return "APROBADA";
  }
  // Ante la duda, en trámite. Publicar de más una ausencia que no pasó es peor
  // que publicarla como pendiente.
  return "SOLICITADA";
}

export function mapEstado(
  idEstado: string | null | undefined,
  estado: string | null | undefined,
): EstadoAusencia {
  const porId = ESTADO_POR_ID[String(idEstado ?? "").trim()];
  return porId ?? mapEstadoPorTexto(estado);
}

/** "Feriado por empresa" → NO_LABORABLE; el resto → FERIADO_NACIONAL. */
export function mapTipoFeriado(tipo: string | null | undefined): TipoFeriado {
  return String(tipo ?? "").toLowerCase().includes("empresa") ? "NO_LABORABLE" : "FERIADO_NACIONAL";
}

/** Interpreta los booleanos flojos del origen ("t"/"f", "1"/"0", true/false). */
export function esVerdadero(valor: unknown): boolean {
  if (typeof valor === "boolean") return valor;
  if (typeof valor === "number") return valor !== 0;
  const s = String(valor ?? "").trim().toLowerCase();
  return s === "t" || s === "true" || s === "1" || s === "si" || s === "sí";
}

/** Convierte a número finito o null; "" y basura caen en null, no en 0. */
export function numeroOpcional(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

export function textoOpcional(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).trim();
  return s.length ? s : null;
}
