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
const ANIOS = (opcion("anios", String(new Date().getUTCFullYear())) ?? "")
  .split(",")
  .map((a) => Number(a.trim()))
  .filter((a) => Number.isInteger(a) && a >= 2000 && a <= 2100);

const ADMIN_URL = (process.env.TURECIBO_ADMIN_URL ?? "https://admin.turecibo.com").replace(/\/+$/, "");
const USUARIO = process.env.TURECIBO_USER;
const CLAVE = process.env.TURECIBO_PASSWORD;

const MODULO_URL = (process.env.MODULO_BASE_URL ?? "").replace(/\/+$/, "");
const FERIADOS_TOKEN = process.env.FERIADOS_TOKEN;

function abortar(mensaje) {
  console.error(`[feriados-robot] ${mensaje}`);
  process.exit(1);
}

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
if (ANIOS.length === 0) abortar("Falta --anios (ej: --anios 2025,2026).");
if (!USUARIO || !CLAVE) abortar("Faltan TURECIBO_USER y/o TURECIBO_PASSWORD.");
if (ENVIAR && (!MODULO_URL || !FERIADOS_TOKEN)) abortar("Con --enviar hacen falta MODULO_BASE_URL y FERIADOS_TOKEN.");

async function raspar() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${ADMIN_URL}/s/login`, { waitUntil: "domcontentloaded" });
    const form = await formularioLogin(page);
    await form.usuario.fill(USUARIO);
    await form.clave.fill(CLAVE);
    await form.submit.click();
    await page.waitForURL((url) => url.pathname !== "/s/login", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Este `goto` no es decorativo: es el que dispara el SSO que establece la
    // sesión PHP. Sin pasar por acá, el POST de abajo responde como anónimo y
    // devuelve una lista vacía, que es indistinguible de "no hay feriados".
    const gestion = await page.goto(`${ADMIN_URL}/gestion.licencias`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!gestion?.ok()) {
      throw new Error(`El panel de licencias devolvió HTTP ${gestion?.status() ?? "sin respuesta"}.`);
    }
    if (new URL(page.url()).pathname === "/s/login") {
      throw new Error("El panel volvió al login; no se estableció la sesión.");
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
      if (filas.length === 0) throw new Error(`El panel no devolvió feriados para ${anio}. Se aborta sin enviar nada.`);

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

const feriados = await raspar();
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
