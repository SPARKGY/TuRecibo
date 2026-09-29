/**
 * Robot de feriados.
 *
 * Tu Recibo no expone los feriados por API. El único lugar donde existen es el
 * panel legacy, que se navega con sesión PHP. Este script hace exactamente eso
 * y nada más: entra, raspa, y se lo manda al módulo por `/api/ingesta/feriados`.
 *
 * Corre fuera del App Service (GitHub Actions) porque necesita un browser real,
 * y meter Chromium dentro del contenedor del módulo sería cargar 300 MB para
 * usarlos una vez por semana.
 *
 * Deliberadamente tonto: no decide, no reconcilia, no borra. Solo reporta lo que
 * vio. Toda la lógica vive del lado de la base, donde se puede testear sin
 * levantar un navegador.
 *
 * Uso:
 *   node scripts/feriados-robot.mjs --tenant acme --anios 2025,2026
 *   node scripts/feriados-robot.mjs --tenant acme --anios 2025 --enviar
 *
 * Credenciales: se piden al módulo (`GET /api/robot/conexion`, con
 * `FERIADOS_TOKEN`), que soporta modo USUARIO_PASSWORD (login) y SESION (cookie
 * inyectada, sin login). Si el módulo no tiene conexión para el tenant, se usan
 * `TURECIBO_USER`/`TURECIBO_PASSWORD` como antes.
 *
 * Sin `--enviar` imprime y no manda nada. El default es dry-run a propósito: el
 * modo destructivo se escribe, no se olvida.
 */

import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const args = process.argv.slice(2);

function opcion(nombre, porDefecto = null) {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
}

const ENVIAR = args.includes("--enviar");
const TENANT = opcion("tenant");

function parsearAnios(crudo) {
  return String(crudo ?? "")
    .split(",")
    .map((a) => Number(String(a).trim()))
    .filter((a) => Number.isInteger(a) && a >= 2000 && a <= 2100);
}

const ANIOS_CLI = opcion("anios") ? parsearAnios(opcion("anios")) : null;

const MODULO_URL = (process.env.MODULO_BASE_URL ?? "").replace(/\/+$/, "");
const FERIADOS_TOKEN = process.env.FERIADOS_TOKEN;

function abortar(mensaje) {
  console.error(`[feriados-robot] ${mensaje}`);
  process.exit(1);
}

function log(mensaje) {
  console.error(`[feriados-robot] ${mensaje}`);
}

/**
 * Configuración de acceso al panel.
 *
 * Primero se le pide al módulo (`GET /api/robot/conexion`), que la resuelve
 * desde `ConexionTuRecibo` + Key Vault. Si el módulo no la tiene (404), no
 * responde, o no hay `MODULO_BASE_URL`/`FERIADOS_TOKEN`, se cae a las variables
 * de entorno de siempre (`TURECIBO_USER`/`TURECIBO_PASSWORD`). Un 401/403 no
 * cae: significa que el token está mal, y seguir con credenciales viejas solo
 * escondería eso hasta la ingesta.
 */
async function obtenerConexion() {
  const desdeEnv = () => {
    const usuario = process.env.TURECIBO_USER;
    const password = process.env.TURECIBO_PASSWORD;
    if (!usuario || !password) return null;
    return {
      origen: "env",
      modo: "USUARIO_PASSWORD",
      revision: null,
      parametros: {
        adminUrl: process.env.TURECIBO_ADMIN_URL ?? "https://admin.turecibo.com",
        nombreCookieSesion: "PHPSESSID",
      },
      credenciales: { usuario, password },
    };
  };

  if (!MODULO_URL || !FERIADOS_TOKEN) {
    log("Sin MODULO_BASE_URL/FERIADOS_TOKEN: se usan las variables de entorno.");
    return desdeEnv();
  }

  let res;
  try {
    res = await fetch(`${MODULO_URL}/api/robot/conexion?tenantId=${encodeURIComponent(TENANT)}`, {
      headers: { "x-feriados-token": FERIADOS_TOKEN },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    log(`El módulo no respondió (${error.message}); se intenta con las variables de entorno.`);
    return desdeEnv();
  }

  if (res.status === 401 || res.status === 403) {
    abortar(`El módulo rechazó FERIADOS_TOKEN (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    log(`El módulo devolvió HTTP ${res.status} para la conexión; se intenta con las variables de entorno.`);
    return desdeEnv();
  }

  const cuerpo = await res.json();
  log(`Conexión del módulo: modo ${cuerpo.modo}, origen ${cuerpo.origen}.`);
  return cuerpo;
}

/** Informa al módulo si la credencial/sesión sirvió. Nunca hace fallar la corrida. */
async function reportar(conexion, ok, detalle) {
  if (!conexion || conexion.origen === "env" || !MODULO_URL || !FERIADOS_TOKEN) return;
  try {
    const res = await fetch(`${MODULO_URL}/api/robot/conexion`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feriados-token": FERIADOS_TOKEN },
      body: JSON.stringify({
        tenantId: TENANT,
        ok,
        detalle: String(detalle).slice(0, 1000),
        ...(conexion.revision ? { revision: conexion.revision } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log(`No se pudo reportar la validación: HTTP ${res.status}.`);
  } catch (error) {
    log(`No se pudo reportar la validación: ${error.message}`);
  }
}

/** Error de acceso al panel: credencial o sesión que no sirvió. */
class ErrorAcceso extends Error {}

async function formularioLogin(page) {
  const limite = Date.now() + 30_000;
  while (Date.now() < limite) {
    for (const frame of page.frames()) {
      const form = frame.locator('form:has(input[type="password"])');
      if (await form.count() !== 1 || !(await form.isVisible())) continue;
      const usuario = form.locator('input:not([type]), input[type="text"], input[type="email"]');
      const clave = form.locator('input[type="password"]');
      const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])');
      if (await usuario.count() === 1 && await clave.count() === 1 && await submit.count() === 1) {
        return { usuario, clave, submit };
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error("No apareció un formulario de login con usuario, contraseña y submit únicos.");
}

async function capturarFallo(page) {
  await page.evaluate(() => {
    document.querySelectorAll("input, textarea, img, svg, canvas, video, iframe").forEach((element) => element.remove());
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.textContent.trim()) text.textContent = "[texto oculto]";
    }
    const style = document.createElement("style");
    style.textContent = "* { background-image: none !important } *::before, *::after { content: none !important }";
    document.head.append(style);
  });
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/feriados-fallo-saneado.png", fullPage: true });
}

if (!TENANT) abortar("Falta --tenant.");
if (ANIOS_CLI && ANIOS_CLI.length === 0) abortar("--anios inválido (ej: --anios 2025,2026).");
if (ENVIAR && (!MODULO_URL || !FERIADOS_TOKEN)) abortar("Con --enviar hacen falta MODULO_BASE_URL y FERIADOS_TOKEN.");

const CONEXION = await obtenerConexion();
if (!CONEXION) {
  abortar("No hay conexión en el módulo ni TURECIBO_USER/TURECIBO_PASSWORD en el entorno.");
}
if (CONEXION.modo !== "USUARIO_PASSWORD" && CONEXION.modo !== "SESION") {
  abortar(`Modo ${CONEXION.modo} no soportado por el robot.`);
}

const ADMIN_URL = String(CONEXION.parametros?.adminUrl ?? "https://admin.turecibo.com").replace(/\/+$/, "");

// Prioridad: `--anios` explícito, después lo configurado en la conexión, y si
// no hay nada, el año actual y el siguiente (en diciembre, un cálculo de días
// hábiles ya cruza el corte de año).
const anioActual = new Date().getUTCFullYear();
const ANIOS =
  ANIOS_CLI ??
  (Array.isArray(CONEXION.parametros?.anios) && CONEXION.parametros.anios.length
    ? parsearAnios(CONEXION.parametros.anios.join(","))
    : [anioActual, anioActual + 1]);

async function entrarConUsuario(page, { usuario, password }) {
  if (!usuario || !password) throw new ErrorAcceso("La conexión no trae usuario y contraseña.");
  await page.goto(`${ADMIN_URL}/s/login`, { waitUntil: "domcontentloaded" });
  const form = await formularioLogin(page);
  await form.usuario.fill(usuario);
  await form.clave.fill(password);
  await form.submit.click();
  try {
    await page.waitForURL((url) => url.pathname !== "/s/login", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch {
    throw new ErrorAcceso("El login no salió de /s/login: credenciales rechazadas o formulario cambiado.");
  }
}

/** Modo SESION: se inyecta la cookie PHP y se salta el login entero. */
async function entrarConSesion(context, { sesion }) {
  if (!sesion) throw new ErrorAcceso("La conexión está en modo SESION pero no trae la sesión.");
  const { hostname } = new URL(ADMIN_URL);
  await context.addCookies([
    {
      name: CONEXION.parametros?.nombreCookieSesion ?? "PHPSESSID",
      value: sesion,
      domain: hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function raspar() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    if (CONEXION.modo === "SESION") {
      await entrarConSesion(context, CONEXION.credenciales ?? {});
    } else {
      await entrarConUsuario(page, CONEXION.credenciales ?? {});
    }

    // Este `goto` no es decorativo: es el que dispara el SSO que establece la
    // sesión PHP. Sin pasar por acá, el POST de abajo responde como anónimo y
    // devuelve una lista vacía, que es indistinguible de "no hay feriados".
    const gestion = await page.goto(`${ADMIN_URL}/gestion.licencias`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (new URL(page.url()).pathname === "/s/login") {
      throw new ErrorAcceso(
        CONEXION.modo === "SESION"
          ? "La sesión inyectada no es válida: el panel volvió al login."
          : "El panel volvió al login; no se estableció la sesión.",
      );
    }
    if (!gestion?.ok()) {
      throw new Error(`El panel de licencias devolvió HTTP ${gestion?.status() ?? "sin respuesta"}.`);
    }

    const feriados = [];

    for (const anio of ANIOS) {
      const crudo = await page.evaluate(
        async ({ base, anio }) => {
          const res = await fetch(`${base}/ajax/licencias/feriados.php`, {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
            credentials: "include",
            headers: {
              "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
              "x-requested-with": "XMLHttpRequest",
            },
            body: new URLSearchParams({
              action: "search",
              type: "feriadosPorAño",
              filter: String(anio),
              page: "1",
              perPage: "100",
            }).toString(),
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          return res.json();
        },
        { base: ADMIN_URL, anio },
      );

      if (crudo?.error) throw new Error(`El panel devolvió ${crudo.error} para ${anio}.`);

      const filas = Array.isArray(crudo?.data) ? crudo.data : [];
      // Un año entero vacío casi siempre significa que la sesión se cayó, no que
      // no haya feriados. Cortar acá evita mandar una carga que daría de baja el
      // calendario completo de ese año.
      if (filas.length === 0) {
        throw new ErrorAcceso(`El panel no devolvió feriados para ${anio}. Se aborta sin enviar nada.`);
      }

      for (const f of filas) {
        feriados.push({
          fecha: String(f.start ?? "").slice(0, 10),
          tipo: f.tipo ?? null,
          descripcion: String(f.title ?? "").trim(),
        });
      }

      console.error(`[feriados-robot] ${anio}: ${filas.length} feriados.`);
    }

    return feriados;
  } catch (error) {
    try {
      await capturarFallo(page);
    } catch (capturaError) {
      console.error(`[feriados-robot] No se pudo guardar la captura saneada: ${capturaError.message}`);
    }
    throw error;
  } finally {
    await browser.close();
  }
}

let feriados;
try {
  feriados = await raspar();
} catch (error) {
  // Solo las fallas de acceso marcan la credencial como rota. Un timeout de
  // red o un HTTP 500 del panel no dicen nada de la credencial.
  if (error instanceof ErrorAcceso) await reportar(CONEXION, false, error.message);
  throw error;
}
await reportar(CONEXION, true, `Modo ${CONEXION.modo}: ${feriados.length} feriados leídos (${ANIOS.join(",")}).`);

const carga = { tenantId: TENANT, anios: ANIOS, feriados };

if (!ENVIAR) {
  console.error(`[feriados-robot] Dry-run: ${feriados.length} feriados. Agregá --enviar para ingestarlos.`);
  console.log(JSON.stringify(carga, null, 2));
  process.exit(0);
}

const res = await fetch(`${MODULO_URL}/api/ingesta/feriados`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-feriados-token": FERIADOS_TOKEN },
  body: JSON.stringify(carga),
});

const cuerpo = await res.text();
if (!res.ok) abortar(`La ingesta devolvió HTTP ${res.status}: ${cuerpo}`);

console.error(`[feriados-robot] Ingesta OK: ${cuerpo}`);
