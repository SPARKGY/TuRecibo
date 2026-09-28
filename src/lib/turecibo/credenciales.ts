/**
 * Resolución de credenciales de Tu Recibo por tenant.
 *
 * La base guarda **nombres de variable**, no valores. El valor se resuelve acá,
 * contra el entorno, que a su vez lo toma de Key Vault. Así la base del módulo
 * puede volcarse a un entorno de staging sin arrastrar credenciales de
 * producción, que es el accidente que este rodeo evita.
 */

import { prisma } from "@/lib/prisma";
import { ConfiguracionInvalida, leerObligatoria } from "@/lib/env";

export type Credenciales = {
  tenantId: string;
  baseUrl: string;
  adminUrl: string;
  usuario: string;
  password: string;
};

export async function resolverCredenciales(tenantId: string): Promise<Credenciales> {
  const fila = await prisma.credencialTuRecibo.findUnique({ where: { tenantId } });
  if (!fila) {
    throw new ConfiguracionInvalida(
      `El tenant ${tenantId} no tiene credenciales de Tu Recibo cargadas. Ver docs/RUNBOOK.md.`,
    );
  }
  if (!fila.activa) {
    throw new ConfiguracionInvalida(`Las credenciales de Tu Recibo del tenant ${tenantId} están desactivadas.`);
  }

  return {
    tenantId,
    baseUrl: fila.baseUrl.replace(/\/+$/, ""),
    adminUrl: fila.adminUrl.replace(/\/+$/, ""),
    usuario: leerObligatoria(fila.usuarioEnv),
    password: leerObligatoria(fila.passwordEnv),
  };
}

/** Tenants con extracción habilitada. Es lo que recorre la corrida programada. */
export async function tenantsActivos(): Promise<string[]> {
  const filas = await prisma.credencialTuRecibo.findMany({
    where: { activa: true },
    select: { tenantId: true },
  });
  return filas.map((f) => f.tenantId);
}
