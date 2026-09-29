/**
 * Resolución de credenciales de la API de Tu Recibo por tenant.
 *
 * La fuente de verdad es `ConexionTuRecibo` (fuente `LICENCIAS_API`), con los
 * secretos en Key Vault. Si el tenant todavía no tiene fila, se cae a
 * `CredencialTuRecibo`, que guarda **nombres de variable** resueltos contra el
 * entorno: así se puede desplegar esta versión antes de migrar a nadie.
 */

import { ConfiguracionInvalida } from "@/lib/env";
import { resolverConexion, tenantsConLicenciasActivas, type ParametrosLicencias } from "@/lib/turecibo/conexiones";

export type Credenciales = {
  tenantId: string;
  baseUrl: string;
  adminUrl: string;
  /** Por defecto USUARIO_PASSWORD. Con TOKEN, `login` devuelve `token` sin llamar. */
  modo?: "USUARIO_PASSWORD" | "TOKEN";
  usuario: string;
  password: string;
  token?: string;
};

export async function resolverCredenciales(tenantId: string): Promise<Credenciales> {
  const conexion = await resolverConexion(tenantId, "LICENCIAS_API");
  if (!conexion) {
    throw new ConfiguracionInvalida(
      `El tenant ${tenantId} no tiene credenciales de Tu Recibo cargadas. Ver docs/RUNBOOK.md.`,
    );
  }
  const parametros = conexion.parametros as ParametrosLicencias;
  return {
    tenantId,
    baseUrl: parametros.baseUrl.replace(/\/+$/, ""),
    adminUrl: "",
    modo: conexion.modo === "TOKEN" ? "TOKEN" : "USUARIO_PASSWORD",
    usuario: conexion.secretos.usuario ?? "",
    password: conexion.secretos.password ?? "",
    token: conexion.secretos.token,
  };
}

/** Tenants con extracción habilitada. Es lo que recorre la corrida programada. */
export async function tenantsActivos(): Promise<string[]> {
  return tenantsConLicenciasActivas();
}
