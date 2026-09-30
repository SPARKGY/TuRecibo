import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    conexionTuRecibo: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    credencialTuRecibo: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { establecerAlmacenSecretos, escribirSecreto, leerSecreto, nombreSecreto, type AlmacenSecretos } from "@/lib/keyvault";
import {
  aplicarCambio,
  CambioConexionSchema,
  describirConexiones,
  enmascarar,
  probarConexion,
  registrarValidacion,
  resolverConexion,
  tenantsConLicenciasActivas,
  validarConfiguracion,
  ErrorConexion,
} from "@/lib/turecibo/conexiones";
import { resolverCredenciales } from "@/lib/turecibo/credenciales";
import { login } from "@/lib/turecibo/cliente";
import { ConfiguracionInvalida } from "@/lib/env";
import { GET as getConexiones, PUT as putConexiones } from "@/app/api/conexiones/route";
import { GET as getRobot, POST as postRobot } from "@/app/api/robot/conexion/route";

function almacenFalso(inicial: Record<string, string> = {}) {
  const datos = new Map(Object.entries(inicial));
  const almacen = {
    leer: vi.fn(async (n: string) => datos.get(n) ?? null),
    escribir: vi.fn(async (n: string, v: string) => {
      datos.set(n, v);
      return { version: "v2" };
    }),
  } satisfies AlmacenSecretos;
  establecerAlmacenSecretos(almacen);
  return { almacen, datos };
}

const creada = new Date("2026-01-01T00:00:00Z");

function fila(extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    tenantId: "acme",
    fuente: "LICENCIAS_API",
    modo: "USUARIO_PASSWORD",
    parametros: { baseUrl: "https://api.turecibo.com" },
    secretos: { usuario: "turecibo-acme-licencias-api-usuario", password: "turecibo-acme-licencias-api-password" },
    secretosEnv: null,
    activa: true,
    rotadaEn: null,
    rotadaPorId: null,
    rotadaPorEmail: null,
    validadaEn: null,
    ultimoResultadoValidacion: null,
    ultimoDetalleValidacion: null,
    creadaEn: creada,
    actualizadaEn: creada,
    ...extra,
  };
}

const legado = {
  id: "l1",
  tenantId: "acme",
  usuarioEnv: "TURECIBO_USER",
  passwordEnv: "TURECIBO_PASSWORD",
  baseUrl: "https://api.legado.test",
  adminUrl: "https://admin.legado.test",
  activa: true,
  creadaEn: creada,
  actualizadaEn: creada,
};

beforeEach(() => {
  process.env.TURECIBO_USER = "usuario-env";
  process.env.TURECIBO_PASSWORD = "clave-env";
  process.env.CENTRIA_ENTRY_TOKEN = "entrada-secreta";
  process.env.FERIADOS_TOKEN = "robot-secreto";
  process.env.TURECIBO_API_ORIGINS = "https://x.test,https://otra.test,https://api.test";
  process.env.TURECIBO_ADMIN_ORIGINS = "https://admin.test";
  prismaMock.conexionTuRecibo.updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
  establecerAlmacenSecretos(null);
  vi.unstubAllGlobals();
  for (const k of ["TURECIBO_USER", "TURECIBO_PASSWORD", "CENTRIA_ENTRY_TOKEN", "FERIADOS_TOKEN", "KEY_VAULT_PREFIJO", "TURECIBO_API_ORIGINS", "TURECIBO_ADMIN_ORIGINS"]) {
    delete process.env[k];
  }
});

describe("resolución con fallback", () => {
  it("usa Key Vault cuando la conexión tiene referencias", async () => {
    almacenFalso({
      "turecibo-acme-licencias-api-usuario": "u-kv",
      "turecibo-acme-licencias-api-password": "p-kv",
    });
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila());
    const c = await resolverConexion("acme", "LICENCIAS_API");
    expect(c).toMatchObject({ origen: "conexion", secretos: { usuario: "u-kv", password: "p-kv" } });
    expect(prismaMock.credencialTuRecibo.findUnique).not.toHaveBeenCalled();
  });

  it("una fila migrada resuelve por las variables de entorno heredadas", async () => {
    const { almacen } = almacenFalso();
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(
      fila({ secretos: {}, secretosEnv: { usuario: "TURECIBO_USER", password: "TURECIBO_PASSWORD" } }),
    );
    const c = await resolverConexion("acme", "LICENCIAS_API");
    expect(c?.secretos).toEqual({ usuario: "usuario-env", password: "clave-env" });
    expect(almacen.leer).not.toHaveBeenCalled();
  });

  it("sin fila nueva cae a CredencialTuRecibo + env", async () => {
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(null);
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(legado);
    const cred = await resolverCredenciales("acme");
    expect(cred).toMatchObject({
      baseUrl: "https://api.legado.test",
      usuario: "usuario-env",
      password: "clave-env",
      modo: "USUARIO_PASSWORD",
    });
    const panel = await resolverConexion("acme", "FERIADOS_PANEL");
    expect(panel).toMatchObject({ origen: "legado", parametros: { adminUrl: "https://admin.legado.test" } });
  });

  it("sin nada configurado devuelve null y resolverCredenciales falla con mensaje claro", async () => {
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(null);
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(null);
    await expect(resolverConexion("acme", "FERIADOS_PANEL")).resolves.toBeNull();
    await expect(resolverCredenciales("acme")).rejects.toThrow(/no tiene credenciales/);
  });

  it("un secreto ausente en el vault falla cerrado", async () => {
    almacenFalso({ "turecibo-acme-licencias-api-usuario": "u" });
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila());
    await expect(resolverConexion("acme", "LICENCIAS_API")).rejects.toThrow(ConfiguracionInvalida);
  });

  it("una conexión desactivada no cae al legado", async () => {
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila({ activa: false }));
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(legado);
    await expect(resolverConexion("acme", "LICENCIAS_API")).rejects.toThrow(/desactivada/);
  });

  it("modo TOKEN: login devuelve el token sin llamar a Tu Recibo", async () => {
    almacenFalso({ "turecibo-acme-licencias-api-token": "jwt-fijo" });
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(
      fila({ modo: "TOKEN", secretos: { token: "turecibo-acme-licencias-api-token" } }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cred = await resolverCredenciales("acme");
    await expect(login(cred)).resolves.toBe("jwt-fijo");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tenants activos: filas nuevas mandan sobre el legado", async () => {
    prismaMock.conexionTuRecibo.findMany.mockResolvedValue([
      { tenantId: "a", activa: true },
      { tenantId: "b", activa: false },
    ]);
    prismaMock.credencialTuRecibo.findMany.mockResolvedValue([{ tenantId: "b" }, { tenantId: "c" }]);
    await expect(tenantsConLicenciasActivas()).resolves.toEqual(["a", "c"]);
  });
});

describe("validación zod", () => {
  it("aplica defaults y normaliza la URL", () => {
    expect(validarConfiguracion("LICENCIAS_API", "USUARIO_PASSWORD", { baseUrl: "https://x.test///" })).toEqual({
      baseUrl: "https://x.test",
    });
    expect(validarConfiguracion("FERIADOS_PANEL", "SESION", {})).toEqual({
      adminUrl: "https://admin.turecibo.com",
      nombreCookieSesion: "PHPSESSID",
    });
  });

  it.each([
    ["modo que no aplica a la fuente", "LICENCIAS_API", "SESION", {}],
    ["token en el panel", "FERIADOS_PANEL", "TOKEN", {}],
    ["http en vez de https", "LICENCIAS_API", "USUARIO_PASSWORD", { baseUrl: "http://x.test" }],
    ["host no autorizado", "LICENCIAS_API", "USUARIO_PASSWORD", { baseUrl: "https://otro.test" }],
    ["IP privada", "LICENCIAS_API", "USUARIO_PASSWORD", { baseUrl: "https://127.0.0.1" }],
    ["credenciales en URL", "LICENCIAS_API", "USUARIO_PASSWORD", { baseUrl: "https://u:p@api.turecibo.com" }],
    ["ruta en URL", "LICENCIAS_API", "USUARIO_PASSWORD", { baseUrl: "https://api.turecibo.com/otra" }],
    ["clave desconocida", "LICENCIAS_API", "USUARIO_PASSWORD", { otra: 1 }],
    ["año fuera de rango", "FERIADOS_PANEL", "SESION", { anios: [1990] }],
    ["cookie con caracteres raros", "FERIADOS_PANEL", "SESION", { nombreCookieSesion: "a;b" }],
  ] as const)("rechaza %s", (_c, fuente, modo, parametros) => {
    expect(() => validarConfiguracion(fuente, modo, parametros)).toThrow(ErrorConexion);
  });

  it("el cuerpo del cambio rechaza secretos vacíos y claves extra", () => {
    expect(CambioConexionSchema.safeParse({ fuente: "LICENCIAS_API", modo: "TOKEN", secretos: { token: " " } }).success).toBe(
      false,
    );
    expect(CambioConexionSchema.safeParse({ fuente: "LICENCIAS_API", modo: "TOKEN", valor: "x" }).success).toBe(false);
  });
});

describe("enmascarado", () => {
  it("no revela nada del valor", () => {
    expect(enmascarar("supersecreto")).toBe("••••••••");
    expect(enmascarar("x")).toBe("••••••••");
    expect(enmascarar("")).toBeNull();
    expect(enmascarar(undefined)).toBeNull();
  });

  it("describirConexiones no incluye valores ni lee el vault", async () => {
    const { almacen } = almacenFalso({ "turecibo-acme-licencias-api-usuario": "u-kv" });
    prismaMock.conexionTuRecibo.findMany.mockResolvedValue([fila()]);
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(legado);
    const vistas = await describirConexiones("acme");
    const json = JSON.stringify(vistas);
    expect(json).not.toContain("u-kv");
    expect(json).not.toContain("usuario-env");
    expect(json).not.toContain("clave-env");
    expect(almacen.leer).not.toHaveBeenCalled();
    expect(vistas.find((v) => v.fuente === "FERIADOS_PANEL")).toMatchObject({ origen: "legado" });
    expect(vistas.find((v) => v.fuente === "LICENCIAS_API")?.campos[0]).toMatchObject({
      origen: "keyvault",
      referencia: "turecibo-acme-licencias-api-usuario",
      valor: "••••••••",
    });
  });
});

describe("cambio de credenciales", () => {
  const autor = { usuarioId: "u1", email: "admin@acme.test" };
  const cambio = CambioConexionSchema.parse({
    fuente: "LICENCIAS_API",
    modo: "USUARIO_PASSWORD",
    parametros: {},
    secretos: { usuario: "nuevo", password: "nueva-clave" },
  });

  it("una prueba fallida no escribe ni el vault ni la base", async () => {
    const { almacen } = almacenFalso();
    const probar = vi.fn().mockResolvedValue({ resultado: "FALLIDA", detalle: "401" });
    const r = await aplicarCambio("acme", cambio, autor, probar);
    expect(r.guardado).toBe(false);
    expect(almacen.escribir).not.toHaveBeenCalled();
    expect(prismaMock.conexionTuRecibo.upsert).not.toHaveBeenCalled();
  });

  it("con prueba OK escribe versiones nuevas en KV y solo nombres en la base", async () => {
    const { almacen } = almacenFalso();
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(null);
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(legado);
    const probar = vi.fn().mockResolvedValue({ resultado: "OK", detalle: "ok" });
    const r = await aplicarCambio("acme", cambio, autor, probar);

    expect(r).toMatchObject({ guardado: true, rotados: ["usuario", "password"] });
    expect(almacen.escribir).toHaveBeenCalledWith(expect.stringMatching(/^turecibo-acme-[a-f0-9]{20}-licencias-api-usuario-[a-f0-9]{32}$/), "nuevo");
    expect(almacen.escribir).toHaveBeenCalledWith(expect.stringMatching(/^turecibo-acme-[a-f0-9]{20}-licencias-api-password-[a-f0-9]{32}$/), "nueva-clave");
    const args = prismaMock.conexionTuRecibo.upsert.mock.calls[0]![0];
    expect(JSON.stringify(args)).not.toContain("nueva-clave");
    expect(args.create).toMatchObject({
      modo: "USUARIO_PASSWORD",
      secretos: {
        usuario: expect.stringMatching(/^turecibo-acme-[a-f0-9]{20}-licencias-api-usuario-[a-f0-9]{32}$/),
        password: expect.stringMatching(/^turecibo-acme-[a-f0-9]{20}-licencias-api-password-[a-f0-9]{32}$/),
      },
      rotadaPorId: "u1",
      rotadaPorEmail: "admin@acme.test",
      ultimoResultadoValidacion: "OK",
    });
  });

  it("un fallo del segundo secreto no cambia las referencias activas", async () => {
    const { almacen } = almacenFalso();
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila());
    almacen.escribir.mockImplementationOnce(async () => ({ version: "v1" })).mockRejectedValueOnce(new Error("KV no disponible"));
    await expect(aplicarCambio("acme", cambio, autor, vi.fn().mockResolvedValue({ resultado: "OK", detalle: "ok" })))
      .rejects.toThrow("KV no disponible");
    expect(prismaMock.conexionTuRecibo.upsert).not.toHaveBeenCalled();
    expect(almacen.escribir.mock.calls[0]![0]).not.toBe(fila().secretos.usuario);
  });

  it("forzar guarda y deja constancia de la falla", async () => {
    almacenFalso();
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(null);
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(null);
    const probar = vi.fn().mockResolvedValue({ resultado: "FALLIDA", detalle: "401" });
    const r = await aplicarCambio("acme", { ...cambio, forzar: true }, autor, probar);
    expect(r.guardado).toBe(true);
    expect(prismaMock.conexionTuRecibo.upsert.mock.calls[0]![0].create).toMatchObject({
      ultimoResultadoValidacion: "FALLIDA",
      ultimoDetalleValidacion: expect.stringContaining("forzado"),
    });
  });

  it("cambiar de modo exige todos los campos", async () => {
    almacenFalso();
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila());
    const aToken = CambioConexionSchema.parse({ fuente: "LICENCIAS_API", modo: "TOKEN" });
    await expect(aplicarCambio("acme", aToken, autor, vi.fn())).rejects.toThrow(/Faltan valores/);
  });

  it("sin modo nuevo, conserva los secretos vigentes para probar y no los reescribe", async () => {
    const { almacen } = almacenFalso({
      "turecibo-acme-licencias-api-usuario": "u-kv",
      "turecibo-acme-licencias-api-password": "p-kv",
    });
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila());
    const probar = vi.fn().mockResolvedValue({ resultado: "OK", detalle: "ok" });
    const soloUrl = CambioConexionSchema.parse({
      fuente: "LICENCIAS_API",
      modo: "USUARIO_PASSWORD",
      parametros: { baseUrl: "https://otra.test" },
    });
    const r = await aplicarCambio("acme", soloUrl, autor, probar);
    expect(probar).toHaveBeenCalledWith(
      "LICENCIAS_API",
      "USUARIO_PASSWORD",
      { baseUrl: "https://otra.test" },
      { usuario: "u-kv", password: "p-kv" },
    );
    expect(r.rotados).toEqual([]);
    expect(almacen.escribir).not.toHaveBeenCalled();
  });

  it("un reporte con revisión vieja no pisa la validación", async () => {
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila({ rotadaEn: new Date("2026-05-01T00:00:00Z") }));
    await expect(
      registrarValidacion("acme", "LICENCIAS_API", { resultado: "FALLIDA", detalle: "x" }, creada.toISOString()),
    ).resolves.toBe("revision-vieja");
    expect(prismaMock.conexionTuRecibo.updateMany).not.toHaveBeenCalled();
  });

  it("un reporte concurrente a una rotación no pisa la nueva validación", async () => {
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila({
      fuente: "FERIADOS_PANEL", parametros: { adminUrl: "https://admin.turecibo.com" },
      secretos: {}, secretosEnv: { usuario: "TURECIBO_USER", password: "TURECIBO_PASSWORD" },
    }));
    const revision = (await resolverConexion("acme", "FERIADOS_PANEL"))!.revision;
    prismaMock.conexionTuRecibo.updateMany.mockResolvedValue({ count: 0 });
    await expect(registrarValidacion("acme", "FERIADOS_PANEL", { resultado: "FALLIDA", detalle: "antigua" }, revision))
      .resolves.toBe("revision-vieja");
  });

  it("un cambio de parámetros invalida la revisión anterior aun sin rotar secretos", async () => {
    almacenFalso({
      "turecibo-acme-licencias-api-usuario": "u-kv",
      "turecibo-acme-licencias-api-password": "p-kv",
    });
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValueOnce(fila())
      .mockResolvedValueOnce(fila({ parametros: { baseUrl: "https://api.nueva.test" } }));
    const revision = (await resolverConexion("acme", "LICENCIAS_API"))!.revision;
    await expect(registrarValidacion("acme", "LICENCIAS_API", { resultado: "FALLIDA", detalle: "antigua" }, revision))
      .resolves.toBe("revision-vieja");
    expect(prismaMock.conexionTuRecibo.updateMany).not.toHaveBeenCalled();
  });
});

describe("prueba de conexión", () => {
  const panel = { adminUrl: "https://admin.test", nombreCookieSesion: "PHPSESSID" };

  it("el login del panel queda pendiente del robot, sin llamar afuera", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      probarConexion("FERIADOS_PANEL", "USUARIO_PASSWORD", panel, { usuario: "u", password: "p" }),
    ).resolves.toMatchObject({ resultado: "PENDIENTE_ROBOT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sesión que redirige al login: FALLIDA", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302 })));
    await expect(probarConexion("FERIADOS_PANEL", "SESION", panel, { sesion: "s" })).resolves.toMatchObject({
      resultado: "FALLIDA",
    });
  });

  it("sesión válida manda la cookie y lee feriados: OK", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ start: "2026-01-01" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(probarConexion("FERIADOS_PANEL", "SESION", panel, { sesion: "abc" })).resolves.toMatchObject({
      resultado: "OK",
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).cookie).toBe("PHPSESSID=abc");
  });

  it("API con credenciales rechazadas: FALLIDA sin exponer el cuerpo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("user=u&password=p", { status: 401 })));
    const r = await probarConexion("LICENCIAS_API", "USUARIO_PASSWORD", { baseUrl: "https://api.test" }, {
      usuario: "u",
      password: "p",
    });
    expect(r.resultado).toBe("FALLIDA");
    expect(r.detalle).not.toContain("password=p");
  });
});

describe("Key Vault", () => {
  it("cachea lecturas e invalida al escribir", async () => {
    const { almacen } = almacenFalso({ s: "v1" });
    await expect(leerSecreto("s")).resolves.toBe("v1");
    await expect(leerSecreto("s")).resolves.toBe("v1");
    expect(almacen.leer).toHaveBeenCalledTimes(1);
    await escribirSecreto("s", "v2");
    await expect(leerSecreto("s")).resolves.toBe("v2");
    expect(almacen.leer).toHaveBeenCalledTimes(2);
  });

  it("la caché vence", async () => {
    const { almacen } = almacenFalso({ s: "v1" });
    await leerSecreto("s", 0);
    await leerSecreto("s", 120_000);
    expect(almacen.leer).toHaveBeenCalledTimes(2);
  });

  it("nombres determinísticos y válidos para Key Vault", () => {
    expect(nombreSecreto("acme", "LICENCIAS_API", "password")).toMatch(/^turecibo-acme-[a-f0-9]{20}-licencias-api-password$/);
    expect(nombreSecreto("Acme S.A.", "FERIADOS_PANEL", "sesion")).not.toBe(nombreSecreto("acme-s-a", "FERIADOS_PANEL", "sesion"));
    process.env.KEY_VAULT_PREFIJO = "turecibo-staging";
    expect(nombreSecreto("acme", "FERIADOS_PANEL", "usuario")).toMatch(/^turecibo-staging-acme-[a-f0-9]{20}-feriados-panel-usuario$/);
  });
});

function pedido(url: string, headers: Record<string, string>, init: RequestInit = {}) {
  return new Request(url, { ...init, headers: { "content-type": "application/json", ...headers } });
}

const identidad = (rol: string) => ({
  "x-internal-token": "entrada-secreta",
  "x-tenant-id": "acme",
  "x-user-id": "u1",
  "x-user-email": "admin@acme.test",
  "x-module-role": rol,
});

describe("autorización admin", () => {
  it("sin token de entrada: 401", async () => {
    const res = await getConexiones(pedido("http://m/api/conexiones", { "x-tenant-id": "acme", "x-user-id": "u1" }));
    expect(res.status).toBe(401);
  });

  it("token equivocado: 403", async () => {
    const res = await getConexiones(pedido("http://m/api/conexiones", { ...identidad("ADMIN"), "x-internal-token": "otro" }));
    expect(res.status).toBe(403);
  });

  it("rol USER: 403 en GET y PUT, sin tocar la base", async () => {
    expect((await getConexiones(pedido("http://m/api/conexiones", identidad("USER")))).status).toBe(403);
    const put = await putConexiones(
      pedido("http://m/api/conexiones", identidad("USER"), {
        method: "PUT",
        body: JSON.stringify({ fuente: "LICENCIAS_API", modo: "TOKEN", secretos: { token: "x" } }),
      }),
    );
    expect(put.status).toBe(403);
    expect(prismaMock.conexionTuRecibo.findMany).not.toHaveBeenCalled();
    expect(prismaMock.conexionTuRecibo.findUnique).not.toHaveBeenCalled();
  });

  it("ADMIN: 200 con vista enmascarada", async () => {
    prismaMock.conexionTuRecibo.findMany.mockResolvedValue([]);
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(legado);
    const res = await getConexiones(pedido("http://m/api/conexiones", identidad("admin")));
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(texto).not.toContain("clave-env");
    expect(JSON.parse(texto).conexiones).toHaveLength(2);
  });

  it("ADMIN: un PUT con cuerpo inválido no repite los valores recibidos", async () => {
    const res = await putConexiones(
      pedido("http://m/api/conexiones", identidad("ADMIN"), {
        method: "PUT",
        body: JSON.stringify({ fuente: "LICENCIAS_API", modo: "NINGUNO", secretos: { token: "valor-secreto" } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("valor-secreto");
  });
});

describe("endpoint del robot", () => {
  const url = "http://m/api/robot/conexion?tenantId=acme";

  it("exige FERIADOS_TOKEN", async () => {
    expect((await getRobot(pedido(url, {}))).status).toBe(401);
    expect((await getRobot(pedido(url, { "x-feriados-token": "otro" }))).status).toBe(403);
    expect(prismaMock.conexionTuRecibo.findUnique).not.toHaveBeenCalled();
  });

  it("no acepta el token de entrada de CENTRIA", async () => {
    expect((await getRobot(pedido(url, { "x-feriados-token": "entrada-secreta" }))).status).toBe(403);
  });

  it("404 sin conexión ni legado, para que el robot caiga a sus env vars", async () => {
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(null);
    prismaMock.credencialTuRecibo.findUnique.mockResolvedValue(null);
    expect((await getRobot(pedido(url, { "x-feriados-token": "robot-secreto" }))).status).toBe(404);
  });

  it("devuelve modo SESION con la cookie desde Key Vault", async () => {
    almacenFalso({ "turecibo-acme-feriados-panel-sesion": "abc123" });
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(
      fila({
        fuente: "FERIADOS_PANEL",
        modo: "SESION",
        parametros: { adminUrl: "https://admin.turecibo.com", anios: [2026] },
        secretos: { sesion: "turecibo-acme-feriados-panel-sesion" },
      }),
    );
    const res = await getRobot(pedido(url, { "x-feriados-token": "robot-secreto" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      modo: "SESION",
      origen: "conexion",
      credenciales: { sesion: "abc123" },
      parametros: { adminUrl: "https://admin.turecibo.com", anios: [2026], nombreCookieSesion: "PHPSESSID" },
      revision: expect.stringMatching(/^2026-01-01T00:00:00.000Z:[a-f0-9]{20}$/),
    });
  });

  it("registra el resultado que reporta el robot", async () => {
    prismaMock.conexionTuRecibo.findUnique.mockResolvedValue(fila({
      fuente: "FERIADOS_PANEL", parametros: { adminUrl: "https://admin.turecibo.com" },
      secretos: {}, secretosEnv: { usuario: "TURECIBO_USER", password: "TURECIBO_PASSWORD" },
    }));
    const revision = (await resolverConexion("acme", "FERIADOS_PANEL"))!.revision;
    const res = await postRobot(
      pedido("http://m/api/robot/conexion", { "x-feriados-token": "robot-secreto" }, {
        method: "POST",
        body: JSON.stringify({ tenantId: "acme", ok: false, detalle: "volvió al login", revision }),
      }),
    );
    expect(res.status).toBe(200);
    expect(prismaMock.conexionTuRecibo.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ rotadaEn: null, actualizadaEn: creada }),
        data: expect.objectContaining({ ultimoResultadoValidacion: "FALLIDA", ultimoDetalleValidacion: "volvió al login" }),
      }),
    );
  });
});
