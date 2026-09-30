/**
 * Estado del último refresco de la base propia, por fuente.
 *
 * Es lo que muestra la página de inicio del módulo. La pregunta que responde es
 * la que más cuesta contestar cuando algo anda mal: "¿cuándo fue la última vez
 * que trajimos datos de Tu Recibo, y salió bien?". Por eso, si la última corrida
 * no fue OK, también se busca la última que sí lo fue: sin eso, un sync que
 * falla todas las noches se ve igual que uno que falló solo hoy.
 *
 * La lectura es **tolerante a fallas**: cada consulta se resuelve por separado y
 * una que falla deja su parte en `null` en vez de tirar la página entera. La
 * página de inicio es justamente adonde se entra cuando algo está roto.
 */

import type { EstadoCorrida, Fuente } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { MaestroId } from "@/lib/maestros";

export const ZONA_REFRESCO = "America/Argentina/Buenos_Aires";

export type FuenteRefresco = {
  fuente: Fuente;
  nombre: string;
  maestro: MaestroId;
};

/** Orden en que se muestran. Feriados primero: es el que depende de un robot. */
export const FUENTES_REFRESCO: readonly FuenteRefresco[] = [
  { fuente: "FERIADOS", nombre: "Feriados", maestro: "feriados" },
  { fuente: "AUSENCIAS", nombre: "Licencias y ausencias", maestro: "ausencias" },
  { fuente: "TIPOS_LICENCIA", nombre: "Tipos de licencia", maestro: "tipos-licencia" },
];

export type CorridaResumen = {
  id: string;
  estado: EstadoCorrida;
  manual: boolean;
  iniciadaEn: Date;
  terminadaEn: Date | null;
  leidas: number;
  altas: number;
  cambios: number;
  bajas: number;
  descartadas: number;
  error: string | null;
};

export type SelloResumen = { revision: number; actualizadoEn: Date };

export type EstadoFuente = FuenteRefresco & {
  /** `null` si no hubo corridas o si la consulta falló (ver `consultaOk`). */
  ultima: CorridaResumen | null;
  /** Solo se busca si la última no fue OK. */
  ultimaOk: CorridaResumen | null;
  /** Si se pudo resolver la consulta de la última corrida OK cuando fue necesaria. */
  consultaUltimaOk: boolean;
  sello: SelloResumen | null;
  activas: number | null;
  /** `false` si alguna consulta de esta fuente falló. */
  consultaOk: boolean;
};

const SELECT_CORRIDA = {
  id: true,
  estado: true,
  manual: true,
  iniciadaEn: true,
  terminadaEn: true,
  leidas: true,
  altas: true,
  cambios: true,
  bajas: true,
  descartadas: true,
  error: true,
} as const;

function contarActivas(tenantId: string, maestro: MaestroId): Promise<number> {
  switch (maestro) {
    case "feriados":
      return prisma.feriado.count({ where: { tenantId, activo: true } });
    case "ausencias":
      return prisma.ausencia.count({ where: { tenantId, activa: true } });
    case "tipos-licencia":
      return prisma.tipoLicencia.count({ where: { tenantId, activo: true } });
  }
}

type Intento<T> = { ok: true; valor: T } | { ok: false };

async function intentar<T>(fn: () => Promise<T>): Promise<Intento<T>> {
  try {
    return { ok: true, valor: await fn() };
  } catch (error) {
    console.error("refresco: consulta fallida", error instanceof Error ? error.message : error);
    return { ok: false };
  }
}

async function leerFuente(tenantId: string, f: FuenteRefresco): Promise<EstadoFuente> {
  const [ultima, sello, activas] = await Promise.all([
    intentar(() =>
      prisma.corridaSync.findFirst({
        where: { tenantId, fuente: f.fuente },
        orderBy: { iniciadaEn: "desc" },
        select: SELECT_CORRIDA,
      }),
    ),
    intentar(() =>
      prisma.selloMaestro.findUnique({
        where: { tenantId_maestro: { tenantId, maestro: f.maestro } },
        select: { revision: true, actualizadoEn: true },
      }),
    ),
    intentar(() => contarActivas(tenantId, f.maestro)),
  ]);

  let ultimaOk: Intento<CorridaResumen | null> = { ok: true, valor: null };
  let consultaUltimaOk = true;
  if (ultima.ok && ultima.valor && ultima.valor.estado !== "OK") {
    ultimaOk = await intentar(() =>
      prisma.corridaSync.findFirst({
        where: { tenantId, fuente: f.fuente, estado: "OK" },
        orderBy: { iniciadaEn: "desc" },
        select: SELECT_CORRIDA,
      }),
    );
    consultaUltimaOk = ultimaOk.ok;
  }

  return {
    ...f,
    ultima: ultima.ok ? ultima.valor : null,
    ultimaOk: ultimaOk.ok ? ultimaOk.valor : null,
    consultaUltimaOk,
    sello: sello.ok ? sello.valor : null,
    activas: activas.ok ? activas.valor : null,
    consultaOk: ultima.ok && consultaUltimaOk && sello.ok && activas.ok,
  };
}

export async function leerEstadoRefresco(tenantId: string): Promise<EstadoFuente[]> {
  return Promise.all(FUENTES_REFRESCO.map((f) => leerFuente(tenantId, f)));
}

/** `29/09/2026 19:32`, en la zona dada. */
export function formatearFechaHora(fecha: Date, zona: string = ZONA_REFRESCO): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("es-AR", {
      timeZone: zona,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(fecha)
      .map((p) => [p.type, p.value]),
  );
  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

/** `hace 3 h`, `hace 5 min`, `hace 2 d`. Lo que está en el futuro (reloj corrido) cuenta como "recién". */
export function formatearRelativo(fecha: Date, ahora: Date = new Date()): string {
  const segundos = Math.floor((ahora.getTime() - fecha.getTime()) / 1000);
  if (segundos < 60) return "recién";
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 60) return `hace ${dias} d`;
  const meses = Math.floor(dias / 30);
  return `hace ${meses} meses`;
}

/** Duración legible de una corrida terminada. */
export function formatearDuracion(desde: Date, hasta: Date | null): string | null {
  if (!hasta) return null;
  const segundos = Math.max(0, Math.round((hasta.getTime() - desde.getTime()) / 1000));
  if (segundos < 60) return `${segundos} s`;
  const minutos = Math.floor(segundos / 60);
  const resto = segundos % 60;
  return resto ? `${minutos} min ${resto} s` : `${minutos} min`;
}

export type TonoEstado = "ok" | "mal" | "medio" | "curso";

export const ESTADOS: Readonly<Record<EstadoCorrida, { texto: string; tono: TonoEstado }>> = {
  OK: { texto: "OK", tono: "ok" },
  FALLIDA: { texto: "Fallida", tono: "mal" },
  ABORTADA: { texto: "Abortada", tono: "medio" },
  EN_CURSO: { texto: "En curso", tono: "curso" },
};

/** Recorta un error largo para que una traza no se coma la pantalla. */
export function recortarError(error: string, max = 600): string {
  const limpio = error.trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
}
