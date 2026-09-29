/**
 * El enchufe de entrada: cómo este módulo verifica que quien llama es CENTRIA.
 *
 * Hay dos caminos y no hay que confundirlos:
 *
 * - **Token de entrada** (`x-internal-token`): lo usa CENTRIA para llamar al
 *   módulo — manifiesto, salud y publicación de maestros. Es el secreto que
 *   CENTRIA guarda cifrado en `RegisteredModule.entryTokenCiphertext`.
 * - **Credencial** (`x-service-token` + `x-module-code`): la usa el módulo para
 *   llamar a CENTRIA. Va en la otra dirección y vive en `centria-cliente.ts`.
 *
 * Además, cuando un usuario entra por el proxy `/m/<codigo>`, CENTRIA reconstruye
 * la identidad en headers. Esos headers **solo valen si el token de entrada
 * validó**: sin eso, cualquiera desde internet diría ser ADMIN de cualquier
 * tenant escribiendo un header.
 */

import { validarSecreto, registrarUsoDelPrevio } from "@/lib/tokens";

const ENV_TOKEN_ENTRADA = "CENTRIA_ENTRY_TOKEN";

export type RolModulo = "ADMIN" | "USER";

export type Identidad = {
  tenantId: string;
  usuarioId: string;
  email: string | null;
  nombre: string | null;
  rol: RolModulo;
  zonaHoraria: string;
};

export type Autenticado<T> = { ok: true; datos: T } | { ok: false; status: number; mensaje: string };

/**
 * Valida solo el token de entrada, sin exigir identidad de usuario.
 *
 * Es lo que necesitan el manifiesto, el ping de salud y la publicación de
 * maestros: CENTRIA los llama de servidor a servidor, sin usuario detrás.
 */
export function autenticarCentria(req: Request): Autenticado<{ tenantId: string | null }> {
  const resultado = validarSecreto(ENV_TOKEN_ENTRADA, req.headers.get("x-internal-token"));
  if (!resultado.ok) {
    return { ok: false, status: resultado.status, mensaje: resultado.mensaje };
  }
  registrarUsoDelPrevio(ENV_TOKEN_ENTRADA, resultado.usóPrevio);

  const tenantId = req.headers.get("x-tenant-id")?.trim() || null;
  return { ok: true, datos: { tenantId } };
}

/** Igual que `autenticarCentria`, pero el tenant es obligatorio. */
export function autenticarCentriaConTenant(req: Request): Autenticado<{ tenantId: string }> {
  const base = autenticarCentria(req);
  if (!base.ok) return base;
  if (!base.datos.tenantId) {
    return { ok: false, status: 400, mensaje: "Falta x-tenant-id" };
  }
  return { ok: true, datos: { tenantId: base.datos.tenantId } };
}

/**
 * Valida el token de entrada y además reconstruye la identidad del usuario que
 * viene por el proxy.
 *
 * `x-module-role` es el rol **dentro de este módulo**, que CENTRIA asigna. No es
 * lo mismo que `x-user-role`, que es global y está deprecado; usarlo como si
 * fuera el rol del módulo convierte a cualquier admin de CENTRIA en admin de
 * acá, que no es lo acordado.
 */
export function autenticarUsuario(req: Request): Autenticado<Identidad> {
  const base = autenticarCentria(req);
  if (!base.ok) return base;

  const tenantId = base.datos.tenantId;
  const usuarioId = req.headers.get("x-user-id")?.trim() ?? "";
  if (!tenantId || !usuarioId) {
    return { ok: false, status: 400, mensaje: "Falta x-tenant-id o x-user-id" };
  }

  const rolCrudo = req.headers.get("x-module-role")?.trim().toUpperCase();
  const rol: RolModulo = rolCrudo === "ADMIN" ? "ADMIN" : "USER";

  return {
    ok: true,
    datos: {
      tenantId,
      usuarioId,
      email: req.headers.get("x-user-email")?.trim() || null,
      nombre: req.headers.get("x-user-name")?.trim() || null,
      rol,
      // Tu Recibo devuelve fechas sin zona; la del tenant es la única referencia
      // para decidir qué día es "hoy" al recortar la ventana de publicación.
      zonaHoraria: req.headers.get("x-tenant-timezone")?.trim() || "America/Argentina/Buenos_Aires",
    },
  };
}

/** Exige rol ADMIN dentro del módulo. */
export function exigirAdmin(identidad: Identidad): Autenticado<Identidad> {
  if (identidad.rol !== "ADMIN") {
    return { ok: false, status: 403, mensaje: "Requiere rol ADMIN en el módulo" };
  }
  return { ok: true, datos: identidad };
}

/** Token de entrada + identidad + rol ADMIN, en un paso. */
export function autenticarAdmin(req: Request): Autenticado<Identidad> {
  const auth = autenticarUsuario(req);
  if (!auth.ok) return auth;
  return exigirAdmin(auth.datos);
}
