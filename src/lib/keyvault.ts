/**
 * Lectura y escritura de secretos en Key Vault en runtime.
 *
 * Hasta ahora los secretos entraban solo por App Settings con referencias
 * `@Microsoft.KeyVault(...)`, que App Service resuelve al arrancar. Eso obliga a
 * reiniciar para rotar. Las conexiones paramétricas leen y escriben el vault
 * directo con la identidad administrada (`DefaultAzureCredential`), así que
 * rotar una credencial desde el panel no requiere tocar la infraestructura.
 *
 * La caché es corta a propósito: evita golpear el vault en cada request de una
 * misma corrida, pero un valor rotado desde otra instancia se ve en segundos.
 * La instancia que rota invalida su entrada al escribir.
 */

import { ConfiguracionInvalida, leerOpcional } from "@/lib/env";

/** Lo mínimo que se usa del vault. Existe para poder reemplazarlo en tests. */
export interface AlmacenSecretos {
  leer(nombre: string): Promise<string | null>;
  escribir(nombre: string, valor: string): Promise<{ version: string | null }>;
}

const TTL_MS = 60_000;

const cache = new Map<string, { valor: string | null; vence: number }>();
let almacen: AlmacenSecretos | null = null;

async function almacenPorDefecto(): Promise<AlmacenSecretos> {
  const url = leerOpcional("KEY_VAULT_URL");
  if (!url) {
    throw new ConfiguracionInvalida("KEY_VAULT_URL no está configurada: no se pueden leer ni escribir credenciales.");
  }
  // Import diferido: el SDK de Azure no se carga en entornos que no lo usan
  // (tests, build) y un error de carga no tumba rutas que no tocan el vault.
  const [{ SecretClient }, { DefaultAzureCredential }] = await Promise.all([
    import("@azure/keyvault-secrets"),
    import("@azure/identity"),
  ]);
  const cliente = new SecretClient(url, new DefaultAzureCredential());
  return {
    async leer(nombre) {
      try {
        const s = await cliente.getSecret(nombre);
        return s.value ?? null;
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return null;
        throw error;
      }
    },
    async escribir(nombre, valor) {
      const s = await cliente.setSecret(nombre, valor, { contentType: "text/plain", tags: { modulo: "turecibo" } });
      return { version: s.properties.version ?? null };
    },
  };
}

async function obtenerAlmacen(): Promise<AlmacenSecretos> {
  if (!almacen) almacen = await almacenPorDefecto();
  return almacen;
}

/** Reemplaza el almacén (tests) y vacía la caché. `null` vuelve al real. */
export function establecerAlmacenSecretos(nuevo: AlmacenSecretos | null): void {
  almacen = nuevo;
  cache.clear();
}

export async function leerSecreto(nombre: string, ahora = Date.now()): Promise<string | null> {
  const enCache = cache.get(nombre);
  if (enCache && enCache.vence > ahora) return enCache.valor;
  const valor = await (await obtenerAlmacen()).leer(nombre);
  cache.set(nombre, { valor, vence: ahora + TTL_MS });
  return valor;
}

/** Escribe una versión nueva e invalida la caché de ese nombre. */
export async function escribirSecreto(nombre: string, valor: string): Promise<{ version: string | null }> {
  invalidarSecreto(nombre);
  const res = await (await obtenerAlmacen()).escribir(nombre, valor);
  invalidarSecreto(nombre);
  return res;
}

export function invalidarSecreto(nombre: string): void {
  cache.delete(nombre);
}

/**
 * Nombre determinístico de un secreto de conexión.
 *
 * Key Vault solo admite `[0-9a-zA-Z-]`, hasta 127 caracteres. El prefijo es
 * configurable porque staging comparte vault con producción: sin él, un tenant
 * de prueba con el mismo id pisaría el secreto productivo.
 */
export function nombreSecreto(tenantId: string, fuente: string, campo: string): string {
  const prefijo = leerOpcional("KEY_VAULT_PREFIJO", "turecibo");
  const limpio = (s: string) =>
    s
      .toLowerCase()
      .replace(/_/g, "-")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const nombre = [limpio(prefijo), limpio(tenantId), limpio(fuente), limpio(campo)].filter(Boolean).join("-");
  if (nombre.length > 127) throw new ConfiguracionInvalida(`Nombre de secreto demasiado largo: ${nombre.slice(0, 40)}…`);
  return nombre;
}
