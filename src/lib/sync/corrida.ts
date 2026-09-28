/**
 * Ciclo de vida de una corrida y contadores compartidos.
 *
 * Toda corrida queda registrada, incluso si falla antes de leer nada. Una
 * corrida que no dejó rastro es una corrida que nadie va a notar que no pasó, y
 * el modo de falla más caro de estas integraciones no es el error ruidoso: es el
 * sync que dejó de correr y nadie se enteró hasta que alguien cargó mal las
 * horas.
 */

import type { Fuente } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type Conteos = {
  leidas: number;
  altas: number;
  cambios: number;
  bajas: number;
  descartadas: number;
};

export const conteosVacios = (): Conteos => ({ leidas: 0, altas: 0, cambios: 0, bajas: 0, descartadas: 0 });

/**
 * Se lanza cuando el origen devolvió algo que no se puede distinguir de "se
 * dieron todos de baja". Corta la corrida **sin escribir**.
 *
 * Es el caso que más caro sale: un catálogo vacío por un 200 con cuerpo raro, si
 * se reconcilia, marca de baja todas las filas y se propaga a los consumidores
 * en la siguiente lectura. Preferimos un dato viejo a un dato borrado.
 */
export class CorridaAbortada extends Error {}

export async function abrirCorrida(tenantId: string, fuente: Fuente, manual: boolean): Promise<string> {
  const corrida = await prisma.corridaSync.create({
    data: { tenantId, fuente, manual, estado: "EN_CURSO" },
    select: { id: true },
  });
  return corrida.id;
}

export async function cerrarCorridaOk(id: string, conteos: Conteos): Promise<void> {
  await prisma.corridaSync.update({
    where: { id },
    data: { estado: "OK", terminadaEn: new Date(), ...conteos },
  });
}

export async function cerrarCorridaConError(id: string, error: unknown, abortada: boolean): Promise<void> {
  await prisma.corridaSync.update({
    where: { id },
    data: {
      estado: abortada ? "ABORTADA" : "FALLIDA",
      terminadaEn: new Date(),
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

/**
 * Marca que el maestro se revisó recién, haya cambiado o no.
 *
 * Es lo que permite a un consumidor distinguir "no cambió nada" de "hace tres
 * días que no sincronizamos". Sin el sello, las dos situaciones se ven igual:
 * la fila más nueva tiene la misma fecha en ambas.
 */
export async function sellarMaestro(tenantId: string, maestro: string, huboCambios: boolean): Promise<void> {
  const ahora = new Date();
  await prisma.selloMaestro.upsert({
    where: { tenantId_maestro: { tenantId, maestro } },
    create: { tenantId, maestro, revision: huboCambios ? 1 : 0, actualizadoEn: ahora },
    update: {
      actualizadoEn: ahora,
      ...(huboCambios ? { revision: { increment: 1 } } : {}),
    },
  });
}

/** Envuelve una corrida con apertura, cierre y clasificación del error. */
export async function ejecutarCorrida(
  tenantId: string,
  fuente: Fuente,
  manual: boolean,
  trabajo: () => Promise<Conteos>,
): Promise<{ corridaId: string; conteos: Conteos }> {
  const corridaId = await abrirCorrida(tenantId, fuente, manual);
  try {
    const conteos = await trabajo();
    await cerrarCorridaOk(corridaId, conteos);
    return { corridaId, conteos };
  } catch (error) {
    await cerrarCorridaConError(corridaId, error, error instanceof CorridaAbortada);
    throw error;
  }
}
