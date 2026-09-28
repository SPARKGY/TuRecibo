/**
 * Reconciliación de ausencias individuales.
 *
 * Tu Recibo devuelve el padrón completo de la empresa en cada corrida: no hay
 * consulta por persona ni por rango. KAiROS resuelve eso borrando su cache
 * entera y recreándola. Acá no se puede, porque este módulo es el dueño del
 * dato: lo que se borre se pierde para siempre.
 *
 * Entonces el padrón completo se compara contra lo guardado y se calcula la
 * diferencia. Lo que dejó de venir se marca de baja con fecha; sigue en la tabla
 * para el historial y sale en `bajas[]` cuando un consumidor lee con `?desde=`.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { login, traerLicencias, type LicenciaCruda } from "@/lib/turecibo/cliente";
import { resolverCredenciales } from "@/lib/turecibo/credenciales";
import {
  dniDesdeCuil,
  esVerdadero,
  mapEstado,
  numeroOpcional,
  parseFechaTuRecibo,
  textoOpcional,
} from "@/lib/turecibo/normalizar";
import { CorridaAbortada, conteosVacios, ejecutarCorrida, sellarMaestro, type Conteos } from "@/lib/sync/corrida";

/** Lo que se guarda de una licencia, ya normalizado. */
export type AusenciaNormalizada = {
  externalId: string;
  dni: string | null;
  cuil: string | null;
  legajo: string | null;
  tipoExternalId: string | null;
  tipoNombre: string | null;
  estado: "SOLICITADA" | "APROBADA" | "RECHAZADA";
  estadoOrigen: string | null;
  idEstadoOrigen: string | null;
  desde: Date | null;
  hasta: Date | null;
  regreso: Date | null;
  medioDia: boolean;
  horas: number | null;
  motivo: string | null;
};

export function normalizarLicencia(crudo: LicenciaCruda): AusenciaNormalizada | null {
  const externalId = String(crudo?.id_licencia ?? "").trim();
  // Sin id no hay clave: no se puede reconciliar ni publicar. Se descarta en vez
  // de inventarle una, que crearía un duplicado nuevo en cada corrida.
  if (!externalId) return null;

  const cuil = textoOpcional(crudo.cuil);
  return {
    externalId,
    dni: dniDesdeCuil(cuil),
    cuil,
    legajo: textoOpcional(crudo.numero_legajo),
    tipoExternalId: textoOpcional(crudo.id_tipo),
    tipoNombre: textoOpcional(crudo.tipo),
    estado: mapEstado(crudo.id_estado, crudo.estado),
    estadoOrigen: textoOpcional(crudo.estado),
    idEstadoOrigen: textoOpcional(crudo.id_estado),
    desde: parseFechaTuRecibo(crudo.fecha_desde),
    hasta: parseFechaTuRecibo(crudo.fecha_fin),
    regreso: parseFechaTuRecibo(crudo.fecha_regreso),
    medioDia: esVerdadero(crudo.medio_dia),
    horas: numeroOpcional(crudo.medio_dia_horas),
    motivo: textoOpcional(crudo.motivo),
  };
}

type Existente = {
  externalId: string;
  dni: string | null;
  cuil: string | null;
  legajo: string | null;
  tipoExternalId: string | null;
  tipoNombre: string | null;
  estado: string;
  estadoOrigen: string | null;
  idEstadoOrigen: string | null;
  desde: Date | null;
  hasta: Date | null;
  regreso: Date | null;
  medioDia: boolean;
  horas: number | null;
  motivo: string | null;
  activa: boolean;
};

const mismaFecha = (a: Date | null, b: Date | null): boolean =>
  a === null && b === null ? true : a !== null && b !== null && a.getTime() === b.getTime();

export function sinCambios(actual: Existente, deseado: AusenciaNormalizada): boolean {
  return (
    actual.activa &&
    actual.dni === deseado.dni &&
    actual.cuil === deseado.cuil &&
    actual.legajo === deseado.legajo &&
    actual.tipoExternalId === deseado.tipoExternalId &&
    actual.tipoNombre === deseado.tipoNombre &&
    actual.estado === deseado.estado &&
    actual.estadoOrigen === deseado.estadoOrigen &&
    actual.idEstadoOrigen === deseado.idEstadoOrigen &&
    mismaFecha(actual.desde, deseado.desde) &&
    mismaFecha(actual.hasta, deseado.hasta) &&
    mismaFecha(actual.regreso, deseado.regreso) &&
    actual.medioDia === deseado.medioDia &&
    actual.horas === deseado.horas &&
    actual.motivo === deseado.motivo
  );
}

/** Reconciliación pura, sin red ni base. Es lo que prueban los tests. */
export function planificarAusencias(crudas: LicenciaCruda[], existentes: Existente[]) {
  const porId = new Map(existentes.map((e) => [e.externalId, e]));
  const vistos = new Set<string>();

  const altas: AusenciaNormalizada[] = [];
  const cambios: AusenciaNormalizada[] = [];
  let descartadas = 0;

  for (const cruda of crudas) {
    const deseado = normalizarLicencia(cruda);
    if (!deseado) {
      descartadas++;
      continue;
    }
    // Un id repetido dentro de la misma corrida no es una alta y un cambio: es
    // la misma fila dos veces. Gana la primera y se descarta el resto, si no el
    // `create` de la segunda rompería la restricción única.
    if (vistos.has(deseado.externalId)) {
      descartadas++;
      continue;
    }
    vistos.add(deseado.externalId);

    const actual = porId.get(deseado.externalId);
    if (!actual) altas.push(deseado);
    else if (!sinCambios(actual, deseado)) cambios.push(deseado);
  }

  const bajas = existentes.filter((e) => e.activa && !vistos.has(e.externalId)).map((e) => e.externalId);
  return { altas, cambios, bajas, descartadas };
}

/**
 * Si el padrón viene vacío se aborta sin escribir, por el mismo motivo que el
 * catálogo: un 200 con cuerpo inesperado sería indistinguible de "la empresa no
 * tiene ninguna licencia", y la reconciliación daría de baja todo el historial.
 */
const LOTE = 500;

export async function sincronizarAusencias(tenantId: string, manual: boolean) {
  return ejecutarCorrida(tenantId, "AUSENCIAS", manual, async (): Promise<Conteos> => {
    const cred = await resolverCredenciales(tenantId);
    const jwt = await login(cred);
    const crudas = await traerLicencias(cred, jwt);

    if (crudas.length === 0) {
      throw new CorridaAbortada("El padrón de licencias vino vacío: se aborta sin escribir");
    }

    const existentes = (await prisma.ausencia.findMany({
      where: { tenantId },
      select: {
        externalId: true,
        dni: true,
        cuil: true,
        legajo: true,
        tipoExternalId: true,
        tipoNombre: true,
        estado: true,
        estadoOrigen: true,
        idEstadoOrigen: true,
        desde: true,
        hasta: true,
        regreso: true,
        medioDia: true,
        horas: true,
        motivo: true,
        activa: true,
      },
    })) as Existente[];

    const plan = planificarAusencias(crudas, existentes);
    const ahora = new Date();

    // Por lotes y fuera de una transacción única: el padrón ronda las miles de
    // filas y una transacción de ese tamaño bloquea la tabla el tiempo que dura
    // la corrida. Cada lote es idempotente, así que reintentar no duplica.
    for (let i = 0; i < plan.altas.length; i += LOTE) {
      const lote = plan.altas.slice(i, i + LOTE);
      await prisma.ausencia.createMany({
        data: lote.map((a) => ({ tenantId, ...a, activa: true }) satisfies Prisma.AusenciaCreateManyInput),
        skipDuplicates: true,
      });
    }

    for (const cambio of plan.cambios) {
      await prisma.ausencia.update({
        where: { tenantId_externalId: { tenantId, externalId: cambio.externalId } },
        data: { ...cambio, activa: true, bajaEn: null },
      });
    }

    for (let i = 0; i < plan.bajas.length; i += LOTE) {
      const lote = plan.bajas.slice(i, i + LOTE);
      await prisma.ausencia.updateMany({
        where: { tenantId, externalId: { in: lote } },
        data: { activa: false, bajaEn: ahora },
      });
    }

    const conteos = conteosVacios();
    conteos.leidas = crudas.length;
    conteos.altas = plan.altas.length;
    conteos.cambios = plan.cambios.length;
    conteos.bajas = plan.bajas.length;
    conteos.descartadas = plan.descartadas;

    await sellarMaestro(tenantId, "ausencias", conteos.altas + conteos.cambios + conteos.bajas > 0);
    return conteos;
  });
}
