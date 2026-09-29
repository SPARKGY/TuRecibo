/**
 * Conexiones paramétricas a Tu Recibo.
 *
 * Una conexión es una fila de `ConexionTuRecibo` por (tenant, fuente) que dice
 * **cómo** autenticarse (modo), **contra qué** (parámetros validados con zod) y
 * **dónde** están los secretos (nombres en Key Vault, nunca valores).
 *
 * Compatibilidad hacia atrás: si un tenant no tiene fila para una fuente, se
 * resuelve con `CredencialTuRecibo` + variables de entorno, exactamente como
 * antes. Las filas migradas desde ahí guardan `secretosEnv` hasta la primera
 * rotación desde el panel, que mueve los valores al vault.
 */

import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { ConexionTuRecibo, FuenteConexion, ModoConexion, ResultadoValidacion } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ConfiguracionInvalida, leerObligatoria } from "@/lib/env";
import { escribirSecreto, leerSecreto, nombreSecreto } from "@/lib/keyvault";

export const FUENTES = ["LICENCIAS_API", "FERIADOS_PANEL"] as const satisfies readonly FuenteConexion[];
export const MODOS = ["USUARIO_PASSWORD", "SESION", "TOKEN"] as const satisfies readonly ModoConexion[];

/** Qué modos tienen sentido por fuente. La API no tiene sesión; el panel no acepta bearer. */
export const MODOS_POR_FUENTE: Record<FuenteConexion, readonly ModoConexion[]> = {
  LICENCIAS_API: ["USUARIO_PASSWORD", "TOKEN"],
  FERIADOS_PANEL: ["USUARIO_PASSWORD", "SESION"],
};

/** Campos secretos que exige cada modo. */
export const CAMPOS_POR_MODO: Record<ModoConexion, readonly string[]> = {
  USUARIO_PASSWORD: ["usuario", "password"],
  SESION: ["sesion"],
  TOKEN: ["token"],
};

const urlHttps = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https:\/\//i.test(u), "Tiene que ser https")
  .transform((u) => u.replace(/\/+$/, ""));

export const ParametrosLicenciasSchema = z
  .object({
    baseUrl: urlHttps.default("https://api.turecibo.com"),
  })
  .strict();

export const ParametrosFeriadosSchema = z
  .object({
    adminUrl: urlHttps.default("https://admin.turecibo.com"),
    /** Años a cubrir cuando el robot no recibe `--anios`. Vacío = actual y siguiente. */
    anios: z.array(z.number().int().min(2000).max(2100)).max(5).optional(),
    /** Nombre de la cookie de sesión PHP del panel, para el modo SESION. */
    nombreCookieSesion: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_\-]{1,64}$/)
      .default("PHPSESSID"),
  })
  .strict();

export type ParametrosLicencias = z.infer<typeof ParametrosLicenciasSchema>;
export type ParametrosFeriados = z.infer<typeof ParametrosFeriadosSchema>;

export function esquemaParametros(fuente: FuenteConexion) {
  return fuente === "LICENCIAS_API" ? ParametrosLicenciasSchema : ParametrosFeriadosSchema;
}

const ReferenciasSchema = z.record(z.string().trim().min(1));

const ValorSecretoSchema = z.string().trim().min(1, "No puede estar vacío").max(4096);

/** Lo que manda el panel para cambiar o probar una conexión. */
export const CambioConexionSchema = z
  .object({
    fuente: z.enum(FUENTES),
    modo: z.enum(MODOS),
    parametros: z.record(z.unknown()).default({}),
    /** Valores nuevos. Los campos omitidos conservan el valor vigente si el modo no cambia. */
    secretos: z.record(ValorSecretoSchema).default({}),
    /** Guardar aunque la prueba falle. Queda registrado como FALLIDA. */
    forzar: z.boolean().default(false),
  })
  .strict();

export type CambioConexion = z.infer<typeof CambioConexionSchema>;

export class ErrorConexion extends Error {
  constructor(
    mensaje: string,
    readonly status: number,
  ) {
    super(mensaje);
  }
}

/**
 * Traduce un error a respuesta. Los mensajes propios son seguros de mostrar;
 * los del SDK del vault u otros no se exponen tal cual.
 */
export function errorARespuesta(error: unknown): { status: number; mensaje: string } {
  if (error instanceof ErrorConexion) return { status: error.status, mensaje: error.message };
  if (error instanceof ConfiguracionInvalida) return { status: 409, mensaje: error.message };
  console.error("[conexiones] error inesperado", (error as Error)?.name, (error as Error)?.message);
  return { status: 502, mensaje: "No se pudo completar la operación con Key Vault o Tu Recibo. Ver logs." };
}

export type ConexionResuelta = {
  tenantId: string;
  fuente: FuenteConexion;
  modo: ModoConexion;
  parametros: ParametrosLicencias | ParametrosFeriados;
  secretos: Record<string, string>;
  /** `conexion` = fila nueva; `legado` = `CredencialTuRecibo` + env. */
  origen: "conexion" | "legado";
  /** Marca de la última rotación. El robot la devuelve al reportar. */
  revision: string;
};

function revisionDe(fila: Pick<ConexionTuRecibo, "rotadaEn" | "creadaEn">): string {
  return (fila.rotadaEn ?? fila.creadaEn).toISOString();
}

/** Valida la combinación fuente/modo/parámetros. Tira `ErrorConexion` 400. */
export function validarConfiguracion(fuente: FuenteConexion, modo: ModoConexion, parametros: unknown) {
  if (!MODOS_POR_FUENTE[fuente].includes(modo)) {
    throw new ErrorConexion(`El modo ${modo} no aplica a ${fuente}`, 400);
  }
  const parsed = esquemaParametros(fuente).safeParse(parametros ?? {});
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "parametros"}: ${i.message}`).join("; ");
    throw new ErrorConexion(`Parámetros inválidos: ${detalle}`, 400);
  }
  return parsed.data;
}

async function resolverCampo(
  campo: string,
  secretos: Record<string, string>,
  secretosEnv: Record<string, string>,
): Promise<string> {
  const enVault = secretos[campo];
  if (enVault) {
    const valor = (await leerSecreto(enVault))?.trim();
    if (!valor) throw new ConfiguracionInvalida(`El secreto ${enVault} no existe o está vacío en Key Vault.`);
    return valor;
  }
  const enEnv = secretosEnv[campo];
  if (enEnv) return leerObligatoria(enEnv);
  throw new ConfiguracionInvalida(`La conexión no tiene referencia para el campo '${campo}'.`);
}

function referencias(fila: ConexionTuRecibo) {
  return {
    secretos: ReferenciasSchema.catch({}).parse(fila.secretos),
    secretosEnv: ReferenciasSchema.catch({}).parse(fila.secretosEnv ?? {}),
  };
}

/**
 * Resuelve una conexión con sus secretos en claro. Devuelve `null` si el
 * tenant no tiene nada configurado para esa fuente (ni fila nueva ni legado).
 */
export async function resolverConexion(tenantId: string, fuente: FuenteConexion): Promise<ConexionResuelta | null> {
  const fila = await prisma.conexionTuRecibo.findUnique({ where: { tenantId_fuente: { tenantId, fuente } } });

  if (fila) {
    if (!fila.activa) {
      throw new ConfiguracionInvalida(`La conexión ${fuente} de Tu Recibo del tenant ${tenantId} está desactivada.`);
    }
    const parametros = esquemaParametros(fuente).safeParse(fila.parametros ?? {});
    if (!parametros.success) {
      throw new ConfiguracionInvalida(`La conexión ${fuente} del tenant ${tenantId} tiene parámetros inválidos.`);
    }
    const { secretos, secretosEnv } = referencias(fila);
    const valores: Record<string, string> = {};
    for (const campo of CAMPOS_POR_MODO[fila.modo]) {
      valores[campo] = await resolverCampo(campo, secretos, secretosEnv);
    }
    return {
      tenantId,
      fuente,
      modo: fila.modo,
      parametros: parametros.data,
      secretos: valores,
      origen: "conexion",
      revision: revisionDe(fila),
    };
  }

  const legado = await prisma.credencialTuRecibo.findUnique({ where: { tenantId } });
  if (!legado) return null;
  if (!legado.activa) {
    throw new ConfiguracionInvalida(`Las credenciales de Tu Recibo del tenant ${tenantId} están desactivadas.`);
  }
  return {
    tenantId,
    fuente,
    modo: "USUARIO_PASSWORD",
    parametros:
      fuente === "LICENCIAS_API"
        ? ParametrosLicenciasSchema.parse({ baseUrl: legado.baseUrl })
        : ParametrosFeriadosSchema.parse({ adminUrl: legado.adminUrl }),
    secretos: { usuario: leerObligatoria(legado.usuarioEnv), password: leerObligatoria(legado.passwordEnv) },
    origen: "legado",
    revision: legado.actualizadaEn.toISOString(),
  };
}

// --- Vista enmascarada ---------------------------------------------------------

/** Nunca devuelve nada del valor, ni largo ni prefijo: solo si está. */
export function enmascarar(valor: string | null | undefined): string | null {
  return valor && valor.trim() ? "••••••••" : null;
}

export type CampoEnmascarado = {
  campo: string;
  origen: "keyvault" | "env" | "ausente";
  /** Nombre del secreto o de la variable. No es el valor. */
  referencia: string | null;
  valor: string | null;
};

export type VistaConexion = {
  fuente: FuenteConexion;
  configurada: boolean;
  origen: "conexion" | "legado" | "ninguno";
  modo: ModoConexion | null;
  modosDisponibles: readonly ModoConexion[];
  parametros: Record<string, unknown>;
  campos: CampoEnmascarado[];
  activa: boolean;
  rotadaEn: string | null;
  rotadaPor: string | null;
  validadaEn: string | null;
  ultimoResultadoValidacion: ResultadoValidacion | null;
  ultimoDetalleValidacion: string | null;
};

function campoEnv(campo: string, variable: string | undefined): CampoEnmascarado {
  if (!variable) return { campo, origen: "ausente", referencia: null, valor: null };
  const crudo = process.env[variable];
  return { campo, origen: "env", referencia: variable, valor: enmascarar(crudo) };
}

/**
 * Estado de las conexiones del tenant para el panel. No lee el vault: que
 * exista la referencia alcanza para mostrar "configurado", y abrir el vault en
 * cada carga de página sería gastar permisos para no mostrar nada.
 */
export async function describirConexiones(tenantId: string): Promise<VistaConexion[]> {
  const [filas, legado] = await Promise.all([
    prisma.conexionTuRecibo.findMany({ where: { tenantId } }),
    prisma.credencialTuRecibo.findUnique({ where: { tenantId } }),
  ]);

  return FUENTES.map((fuente): VistaConexion => {
    const fila = filas.find((f) => f.fuente === fuente);
    const base = {
      fuente,
      modosDisponibles: MODOS_POR_FUENTE[fuente],
      rotadaEn: null,
      rotadaPor: null,
      validadaEn: null,
      ultimoResultadoValidacion: null,
      ultimoDetalleValidacion: null,
    };

    if (fila) {
      const { secretos, secretosEnv } = referencias(fila);
      return {
        ...base,
        configurada: true,
        origen: "conexion",
        modo: fila.modo,
        parametros: (fila.parametros ?? {}) as Record<string, unknown>,
        campos: CAMPOS_POR_MODO[fila.modo].map((campo) =>
          secretos[campo]
            ? { campo, origen: "keyvault" as const, referencia: secretos[campo] ?? null, valor: enmascarar("x") }
            : campoEnv(campo, secretosEnv[campo]),
        ),
        activa: fila.activa,
        rotadaEn: fila.rotadaEn?.toISOString() ?? null,
        rotadaPor: fila.rotadaPorEmail ?? fila.rotadaPorId,
        validadaEn: fila.validadaEn?.toISOString() ?? null,
        ultimoResultadoValidacion: fila.ultimoResultadoValidacion,
        ultimoDetalleValidacion: fila.ultimoDetalleValidacion,
      };
    }

    if (legado) {
      return {
        ...base,
        configurada: true,
        origen: "legado",
        modo: "USUARIO_PASSWORD",
        parametros: fuente === "LICENCIAS_API" ? { baseUrl: legado.baseUrl } : { adminUrl: legado.adminUrl },
        campos: [campoEnv("usuario", legado.usuarioEnv), campoEnv("password", legado.passwordEnv)],
        activa: legado.activa,
      };
    }

    return { ...base, configurada: false, origen: "ninguno", modo: null, parametros: {}, campos: [], activa: false };
  });
}

// --- Prueba -------------------------------------------------------------------

export type ResultadoPrueba = { resultado: ResultadoValidacion; detalle: string };

type Probador = (
  fuente: FuenteConexion,
  modo: ModoConexion,
  parametros: ParametrosLicencias | ParametrosFeriados,
  secretos: Record<string, string>,
) => Promise<ResultadoPrueba>;

const TIMEOUT_PRUEBA_MS = 20_000;

async function probarLicencias(p: ParametrosLicencias, modo: ModoConexion, s: Record<string, string>) {
  // Import diferido para no crear un ciclo credenciales → conexiones → cliente.
  const { login, verificarAcceso, TuReciboError } = await import("@/lib/turecibo/cliente");
  const cred = {
    tenantId: "",
    baseUrl: p.baseUrl,
    adminUrl: "",
    modo: modo as "USUARIO_PASSWORD" | "TOKEN",
    usuario: s.usuario ?? "",
    password: s.password ?? "",
    token: s.token,
  };
  try {
    const jwt = await login(cred);
    await verificarAcceso(cred, jwt);
    return { resultado: "OK" as const, detalle: "Login y catálogo de tipos respondieron OK." };
  } catch (error) {
    if (error instanceof TuReciboError) return { resultado: "FALLIDA" as const, detalle: error.message };
    throw error;
  }
}

/**
 * Usa la cookie contra el mismo endpoint que raspa el robot. Una sesión caída
 * redirige al login o responde vacío; los dos cuentan como falla.
 */
async function probarSesionPanel(p: ParametrosFeriados, sesion: string): Promise<ResultadoPrueba> {
  const anio = new Date().getUTCFullYear();
  let res: Response;
  try {
    res = await fetch(`${p.adminUrl}/ajax/licencias/feriados.php`, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_PRUEBA_MS),
      headers: {
        cookie: `${p.nombreCookieSesion}=${sesion}`,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: new URLSearchParams({
        action: "search",
        type: "feriadosPorAño",
        filter: String(anio),
        page: "1",
        perPage: "1",
      }).toString(),
    });
  } catch (error) {
    return { resultado: "FALLIDA", detalle: `No se pudo contactar al panel: ${(error as Error).message}` };
  }
  if (res.status >= 300 && res.status < 400) {
    return { resultado: "FALLIDA", detalle: "El panel redirigió al login: la sesión no es válida." };
  }
  if (!res.ok) return { resultado: "FALLIDA", detalle: `El panel respondió HTTP ${res.status}.` };
  const cuerpo = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(cuerpo?.data) || cuerpo.data.length === 0) {
    return { resultado: "FALLIDA", detalle: `El panel no devolvió feriados de ${anio}: la sesión parece anónima.` };
  }
  return { resultado: "OK", detalle: `La sesión leyó feriados de ${anio}.` };
}

export const probarConexion: Probador = async (fuente, modo, parametros, secretos) => {
  if (fuente === "LICENCIAS_API") return probarLicencias(parametros as ParametrosLicencias, modo, secretos);
  if (modo === "SESION") return probarSesionPanel(parametros as ParametrosFeriados, secretos.sesion ?? "");
  // El login del panel pasa por un formulario en iframe y un SSO que solo se
  // completa con un navegador real; no hay forma honesta de probarlo desde acá.
  return {
    resultado: "PENDIENTE_ROBOT",
    detalle: "El login del panel solo se puede validar con navegador: lo confirma el robot en su próxima corrida.",
  };
};

// --- Cambio -------------------------------------------------------------------

export type Autor = { usuarioId: string; email: string | null };

export type ResultadoCambio = {
  guardado: boolean;
  prueba: ResultadoPrueba;
  /** Campos escritos en Key Vault (nombres de campo, no valores). */
  rotados: string[];
};

/**
 * Arma la configuración candidata: valores nuevos + los vigentes que no se
 * cambian. Si el modo cambia, todos los campos son obligatorios.
 */
async function candidata(tenantId: string, cambio: CambioConexion) {
  const parametros = validarConfiguracion(cambio.fuente, cambio.modo, cambio.parametros);
  const campos = CAMPOS_POR_MODO[cambio.modo];

  const extra = Object.keys(cambio.secretos).filter((c) => !campos.includes(c));
  if (extra.length) throw new ErrorConexion(`Campos que el modo ${cambio.modo} no usa: ${extra.join(", ")}`, 400);

  const faltan = campos.filter((c) => !cambio.secretos[c]);
  let vigente: ConexionResuelta | null = null;
  if (faltan.length) {
    try {
      vigente = await resolverConexion(tenantId, cambio.fuente);
    } catch (error) {
      if (!(error instanceof ConfiguracionInvalida)) throw error;
    }
    if (!vigente || vigente.modo !== cambio.modo) {
      throw new ErrorConexion(`Faltan valores para: ${faltan.join(", ")}`, 400);
    }
  }

  const secretos: Record<string, string> = {};
  for (const c of campos) secretos[c] = cambio.secretos[c] ?? vigente?.secretos[c] ?? "";
  return { parametros, secretos, campos };
}

/** Prueba una configuración candidata sin guardar nada. */
export async function probarCambio(
  tenantId: string,
  cambio: CambioConexion,
  probar: Probador = probarConexion,
): Promise<ResultadoPrueba> {
  const { parametros, secretos } = await candidata(tenantId, cambio);
  return probar(cambio.fuente, cambio.modo, parametros, secretos);
}

/**
 * Prueba y, si pasa (o se fuerza), escribe los secretos nuevos en Key Vault y
 * actualiza la fila. Una prueba fallida sin `forzar` no toca ni el vault ni la
 * base.
 */
export async function aplicarCambio(
  tenantId: string,
  cambio: CambioConexion,
  autor: Autor,
  probar: Probador = probarConexion,
): Promise<ResultadoCambio> {
  const { parametros, secretos, campos } = await candidata(tenantId, cambio);
  const prueba = await probar(cambio.fuente, cambio.modo, parametros, secretos);
  if (prueba.resultado === "FALLIDA" && !cambio.forzar) return { guardado: false, prueba, rotados: [] };

  const actual = await prisma.conexionTuRecibo.findUnique({
    where: { tenantId_fuente: { tenantId, fuente: cambio.fuente } },
  });
  const legado = actual ? null : await prisma.credencialTuRecibo.findUnique({ where: { tenantId } });
  const previas = actual
    ? referencias(actual)
    : {
        secretos: {} as Record<string, string>,
        secretosEnv: legado ? { usuario: legado.usuarioEnv, password: legado.passwordEnv } : ({} as Record<string, string>),
      };

  const refsVault: Record<string, string> = {};
  const refsEnv: Record<string, string> = {};
  const rotados: string[] = [];

  for (const campo of campos) {
    const nuevo = cambio.secretos[campo];
    if (nuevo) {
      const nombre = nombreSecreto(tenantId, cambio.fuente, campo);
      await escribirSecreto(nombre, nuevo);
      refsVault[campo] = nombre;
      rotados.push(campo);
    } else if (previas.secretos[campo]) {
      refsVault[campo] = previas.secretos[campo]!;
    } else if (previas.secretosEnv[campo]) {
      refsEnv[campo] = previas.secretosEnv[campo]!;
    }
  }

  const ahora = new Date();
  const rotacion = rotados.length
    ? { rotadaEn: ahora, rotadaPorId: autor.usuarioId, rotadaPorEmail: autor.email }
    : {};
  const datos = {
    modo: cambio.modo,
    parametros,
    secretos: refsVault,
    // `DbNull` explícito: si quedara la referencia vieja a env, un campo rotado
    // al vault seguiría pareciendo "migrado" en el panel.
    secretosEnv: Object.keys(refsEnv).length ? refsEnv : Prisma.DbNull,
    activa: true,
    validadaEn: ahora,
    ultimoResultadoValidacion: prueba.resultado,
    ultimoDetalleValidacion:
      prueba.resultado === "FALLIDA" ? `Guardado forzado con prueba fallida: ${prueba.detalle}` : prueba.detalle,
    ...rotacion,
  };

  await prisma.conexionTuRecibo.upsert({
    where: { tenantId_fuente: { tenantId, fuente: cambio.fuente } },
    create: { tenantId, fuente: cambio.fuente, ...datos },
    update: datos,
  });

  return { guardado: true, prueba, rotados };
}

/** Persiste el resultado de probar la configuración vigente. */
export async function registrarValidacion(
  tenantId: string,
  fuente: FuenteConexion,
  prueba: ResultadoPrueba,
  revision?: string,
): Promise<"registrado" | "sin-conexion" | "revision-vieja"> {
  const fila = await prisma.conexionTuRecibo.findUnique({ where: { tenantId_fuente: { tenantId, fuente } } });
  if (!fila) return "sin-conexion";
  // Un robot que arrancó antes de una rotación no puede pisar la validación de
  // la credencial nueva con el resultado de la vieja.
  if (revision && revision !== revisionDe(fila)) return "revision-vieja";
  await prisma.conexionTuRecibo.update({
    where: { id: fila.id },
    data: {
      validadaEn: new Date(),
      ultimoResultadoValidacion: prueba.resultado,
      ultimoDetalleValidacion: prueba.detalle.slice(0, 1000),
    },
  });
  return "registrado";
}

/**
 * Tenants con extracción por API habilitada: los que tienen conexión
 * `LICENCIAS_API` activa, más los de legado que todavía no tienen fila.
 */
export async function tenantsConLicenciasActivas(): Promise<string[]> {
  const [conexiones, legado] = await Promise.all([
    prisma.conexionTuRecibo.findMany({ where: { fuente: "LICENCIAS_API" }, select: { tenantId: true, activa: true } }),
    prisma.credencialTuRecibo.findMany({ where: { activa: true }, select: { tenantId: true } }),
  ]);
  const conFila = new Set(conexiones.map((c) => c.tenantId));
  const activos = new Set(conexiones.filter((c) => c.activa).map((c) => c.tenantId));
  for (const l of legado) if (!conFila.has(l.tenantId)) activos.add(l.tenantId);
  return [...activos].sort();
}
