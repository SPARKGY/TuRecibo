/**
 * Cruce de ausencias contra la nómina de CENTRIA.
 *
 * Tu Recibo no devuelve el DNI ni ningún identificador que sirva fuera de Tu
 * Recibo: devuelve CUIL. El DNI se deriva del CUIL y recién ahí se puede tocar
 * el maestro `personas`.
 *
 * Ese cruce lo hace hoy KAiROS en memoria, dentro de su propio sync. Mudarlo acá
 * es una de las razones del módulo: si cada consumidor derivara el DNI por su
 * cuenta, cada uno se equivocaría distinto con los CUIL raros (extranjeros sin
 * DNI, CUIT de monotributistas, legajos viejos), y las diferencias aparecerían
 * como discrepancias de horas meses después.
 *
 * Lo que no se resuelve queda en null y se cuenta. Una ausencia sin persona no
 * es un error fatal —la fila igual vale— pero tiene que ser visible: si el
 * número crece, algo cambió en la nómina o en el origen.
 */

import { prisma } from "@/lib/prisma";
import { leerMaestroDeCentria } from "@/lib/centria-cliente";
import { normalizarDni } from "@/lib/turecibo/normalizar";

export type ResultadoCruce = {
  resueltas: number;
  sinPersona: number;
  sinDni: number;
};

/** Construye el índice DNI → externalId a partir del maestro `personas`. */
export function indexarPersonas(filas: Record<string, unknown>[]): Map<string, string> {
  const indice = new Map<string, string>();
  const ambiguos = new Set<string>();

  for (const fila of filas) {
    const externalId = String(fila.externalId ?? "").trim();
    const dni = normalizarDni(fila.dni == null ? null : String(fila.dni));
    if (!externalId || !dni) continue;

    // Dos personas con el mismo DNI es un problema de la nómina, no de acá. Se
    // descarta el DNI entero en vez de quedarse con una de las dos: asignarle
    // las licencias a la persona equivocada es peor que no asignárselas a nadie.
    if (indice.has(dni) && indice.get(dni) !== externalId) {
      ambiguos.add(dni);
      continue;
    }
    indice.set(dni, externalId);
  }

  for (const dni of ambiguos) indice.delete(dni);
  if (ambiguos.size > 0) {
    console.warn(`[identidades] ${ambiguos.size} DNI repetidos en la nómina: sus ausencias quedan sin cruzar.`);
  }

  return indice;
}

export async function cruzarIdentidades(tenantId: string): Promise<ResultadoCruce> {
  const personas = await leerMaestroDeCentria("personas", { campos: ["externalId", "dni"] });
  const indice = indexarPersonas(personas.filas);

  const pendientes = await prisma.ausencia.findMany({
    where: { tenantId, activa: true },
    select: { id: true, dni: true, personaExternalId: true },
  });

  const resultado: ResultadoCruce = { resueltas: 0, sinPersona: 0, sinDni: 0 };

  for (const ausencia of pendientes) {
    if (!ausencia.dni) {
      resultado.sinDni++;
      continue;
    }
    const externalId = indice.get(ausencia.dni) ?? null;
    if (!externalId) {
      resultado.sinPersona++;
      // Si antes estaba resuelta y ahora no, hay que limpiarla: la persona pudo
      // salir de la nómina, y dejar el vínculo viejo publicaría una ausencia
      // atribuida a alguien que ya no existe en el maestro.
      if (ausencia.personaExternalId !== null) {
        await prisma.ausencia.update({ where: { id: ausencia.id }, data: { personaExternalId: null } });
      }
      continue;
    }
    if (ausencia.personaExternalId !== externalId) {
      await prisma.ausencia.update({ where: { id: ausencia.id }, data: { personaExternalId: externalId } });
    }
    resultado.resueltas++;
  }

  if (resultado.sinPersona > 0 || resultado.sinDni > 0) {
    console.warn(
      `[identidades] ${resultado.sinPersona} ausencias sin persona en la nómina y ${resultado.sinDni} sin DNI derivable (tenant ${tenantId}).`,
    );
  }

  return resultado;
}
