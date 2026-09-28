/**
 * Lectura de configuración. Todo lo que sea secreto se lee por nombre de
 * variable, nunca se escribe en el repo ni se registra en un log.
 */

/**
 * Una referencia a Key Vault que no resolvió **no llega vacía**: llega como el
 * texto literal `@Microsoft.KeyVault(...)`. Sin esta guarda, el módulo
 * intentaría loguearse en Tu Recibo usando esa cadena como usuario, y el error
 * visible sería "login respondió 401", que manda a buscar el problema en Tu
 * Recibo cuando en realidad está en el vault.
 *
 * Es la misma guarda que ya existe en KAiROS (`src/lib/turecibo.ts`), y está
 * acá porque el modo de falla se repite en cada módulo que usa Key Vault.
 */
export function esReferenciaSinResolver(valor: string | null | undefined): boolean {
  return /^@Microsoft\.KeyVault\(/i.test((valor ?? "").trim());
}

export class ConfiguracionInvalida extends Error {}

/** Lee una variable obligatoria y falla con un mensaje que dice qué falta. */
export function leerObligatoria(nombre: string): string {
  const valor = process.env[nombre]?.trim() ?? "";
  if (!valor) {
    throw new ConfiguracionInvalida(`${nombre} no está configurada`);
  }
  if (esReferenciaSinResolver(valor)) {
    throw new ConfiguracionInvalida(
      `${nombre} no resolvió su referencia a Key Vault (llegó el texto literal). Revisar el secreto en el vault y el permiso de la identidad administrada.`,
    );
  }
  return valor;
}

/** Lee una variable opcional. Una referencia sin resolver cuenta como ausente. */
export function leerOpcional(nombre: string, porDefecto = ""): string {
  const valor = process.env[nombre]?.trim() ?? "";
  if (!valor || esReferenciaSinResolver(valor)) return porDefecto;
  return valor;
}

/** Entero de configuración con piso, techo y valor por defecto. */
export function leerEntero(nombre: string, porDefecto: number, min: number, max: number): number {
  const crudo = leerOpcional(nombre);
  if (!crudo) return porDefecto;
  const n = Number.parseInt(crudo, 10);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, n));
}

/** Código con el que este módulo está registrado en `/admin/modules`. */
export const CODIGO_MODULO = leerOpcional("CENTRIA_MODULE_CODE", "turecibo");

/** Nombre y versión que viajan en el manifiesto. */
export const NOMBRE_MODULO = leerOpcional("CENTRIA_MODULE_NAME", "Tu Recibo");
export const VERSION_MODULO = leerOpcional("CENTRIA_MODULE_VERSION", "0.1.0");
