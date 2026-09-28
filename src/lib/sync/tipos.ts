/**
 * Reconciliación del catálogo de tipos de licencia.
 *
 * Reemplaza lo que hoy hace CENTRIA en `syncLicenseTypes`. La diferencia con
 * KAiROS es que acá **nada se borra**: un tipo que deja de venir se marca
 * inactivo con fecha, y así el maestro puede publicarlo en `bajas[]` de forma
 * incremental.
 */

import { prisma } from "@/lib/prisma";
import { traerTiposLicencia, login, TuReciboError, type TipoLicenciaCrudo } from "@/lib/turecibo/cliente";
import { resolverCredenciales } from "@/lib/turecibo/credenciales";
import { esVerdadero } from "@/lib/turecibo/normalizar";
import { CorridaAbortada, conteosVacios, ejecutarCorrida, sellarMaestro, type Conteos } from "@/lib/sync/corrida";

/** Reconciliación pura, sin red: recibe lo crudo y devuelve qué hay que hacer. */
export function planificarTipos(
  crudos: TipoLicenciaCrudo[],
  existentes: { externalId: string; nombre: string; visible: boolean; esVacaciones: boolean; activo: boolean }[],
) {
  const porId = new Map(existentes.map((e) => [e.externalId, e]));
  const vistos = new Set<string>();

  const altas: { externalId: string; nombre: string; visible: boolean; esVacaciones: boolean }[] = [];
  const cambios: { externalId: string; nombre: string; visible: boolean; esVacaciones: boolean }[] = [];
  for (const crudo of crudos) {
    const externalId = crudo?.id?.trim();
    const nombre = crudo?.nombre?.trim();
    if (!externalId || !nombre) {
      throw new TuReciboError(
        "El catálogo de tipos trae una fila sin id o nombre. Se aborta antes de reconciliar para no dar de baja tipos vigentes.",
      );
    }
    vistos.add(externalId);

    const deseado = {
      externalId,
      nombre,
      visible: esVerdadero(crudo.visible),
      esVacaciones: crudo.isVacation === true,
    };

    const actual = porId.get(externalId);
    if (!actual) {
      altas.push(deseado);
      continue;
    }
    const igual =
      actual.nombre === deseado.nombre &&
      actual.visible === deseado.visible &&
      actual.esVacaciones === deseado.esVacaciones &&
      actual.activo;
    if (!igual) cambios.push(deseado);
  }

  const bajas = existentes.filter((e) => e.activo && !vistos.has(e.externalId)).map((e) => e.externalId);
  return { altas, cambios, bajas, descartadas: 0 };
}

export async function sincronizarTipos(tenantId: string, manual: boolean) {
  return ejecutarCorrida(tenantId, "TIPOS_LICENCIA", manual, async (): Promise<Conteos> => {
    const cred = await resolverCredenciales(tenantId);
    const jwt = await login(cred);
    const crudos = await traerTiposLicencia(cred, jwt);

    // Tu Recibo siempre tuvo tipos. Un catálogo vacío es indistinguible de un
    // 200 con cuerpo inesperado, y reconciliarlo daría de baja el catálogo
    // entero. Se corta antes de escribir.
    if (crudos.length === 0) {
      throw new CorridaAbortada("El catálogo de tipos vino vacío: se aborta sin escribir");
    }

    const existentes = await prisma.tipoLicencia.findMany({
      where: { tenantId },
      select: { externalId: true, nombre: true, visible: true, esVacaciones: true, activo: true },
    });

    const plan = planificarTipos(crudos, existentes);
    const conteos = conteosVacios();
    conteos.leidas = crudos.length;

    await prisma.$transaction(async (tx) => {
      for (const alta of plan.altas) {
        await tx.tipoLicencia.create({ data: { tenantId, ...alta, activo: true, bajaEn: null } });
      }
      for (const cambio of plan.cambios) {
        await tx.tipoLicencia.update({
          where: { tenantId_externalId: { tenantId, externalId: cambio.externalId } },
          data: { ...cambio, activo: true, bajaEn: null },
        });
      }
      if (plan.bajas.length) {
        await tx.tipoLicencia.updateMany({
          where: { tenantId, externalId: { in: plan.bajas } },
          data: { activo: false, bajaEn: new Date() },
        });
      }
    });

    conteos.altas = plan.altas.length;
    conteos.cambios = plan.cambios.length;
    conteos.bajas = plan.bajas.length;
    conteos.descartadas = plan.descartadas;

    await sellarMaestro(tenantId, "tipos-licencia", conteos.altas + conteos.cambios + conteos.bajas > 0);
    return conteos;
  });
}
