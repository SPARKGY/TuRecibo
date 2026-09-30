/**
 * Cliente HTTP de Tu Recibo. Es el **único** lugar del ecosistema que habla con
 * el proveedor: ese es el punto entero de este módulo.
 *
 * Dos endpoints de la API oficial:
 *   POST /v2/auth-mod/login          → { jwt }, vive ~1h
 *   GET  /v2/licensesUser/types      → catálogo de tipos
 *   POST /v2/licensesUser/licenses   → padrón COMPLETO de licencias, paginado
 *
 * No existe una consulta por persona. El camino `/licensesUser/history/{dni}`
 * fue probado por KAiROS y responde "Usuario inexistente" (ADR-007). Por eso el
 * diseño es bajar todo y reconciliar acá, no consultar a demanda.
 */

import type { Credenciales } from "@/lib/turecibo/credenciales";

export class TuReciboError extends Error {}

/** Tipo de licencia crudo, solo los campos que se consumen. */
export type TipoLicenciaCrudo = {
  id: string;
  nombre: string;
  visible: string;
  isVacation?: boolean;
};

/** Licencia cruda, solo los campos que se consumen. */
export type LicenciaCruda = {
  id_licencia: string;
  /** DD/MM/YYYY */
  fecha_desde: string | null;
  fecha_fin: string | null;
  /** Primer día de regreso, exclusivo. */
  fecha_regreso: string | null;
  tipo: string | null;
  /**
   * Id del tipo. Es la clave de cruce con el catálogo. Estuvo siempre en el
   * payload y durante meses KAiROS comparó `tipo` en texto; el id está al lado
   * de `id_estado` con la misma simetría. No confundir con `type_id_vp`, que
   * viene vacío en todas.
   */
  id_tipo: string | null;
  estado: string | null;
  id_estado: string | null;
  cuil: string | null;
  numero_legajo: string | null;
  id_usuario: string | null;
  motivo?: unknown;
  medio_dia?: unknown;
  medio_dia_horas?: unknown;
};

const TIMEOUT_MS = 30_000;

async function pedir(url: string, init: RequestInit): Promise<Response> {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: control.signal, cache: "no-store", redirect: "manual" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TuReciboError(`Tu Recibo no respondió en ${TIMEOUT_MS / 1000}s`);
    }
    throw new TuReciboError(`No se pudo contactar a Tu Recibo: ${(error as Error).message}`);
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * El JWT no se cachea entre corridas.
 *
 * KAiROS lo cachea 45 min en memoria del proceso porque consulta seguido. Acá
 * las corridas son diarias: un token cacheado estaría siempre vencido cuando
 * hiciera falta, así que el cache solo agregaría una forma más de fallar. Dentro
 * de una misma corrida sí se reusa, porque el objeto vive en el stack.
 */
export async function login(cred: Credenciales): Promise<string> {
  // Modo TOKEN: el bearer ya viene emitido y no hay login que hacer.
  if (cred.modo === "TOKEN") {
    if (!cred.token) throw new TuReciboError("La conexión está en modo TOKEN pero no tiene token");
    return cred.token;
  }
  const res = await pedir(`${cred.baseUrl}/v2/auth-mod/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user: cred.usuario, password: cred.password }),
  });
  // Sin cuerpo en el mensaje: un 401 de login puede devolver el intento completo,
  // credenciales incluidas, y eso terminaría en el log.
  if (!res.ok) throw new TuReciboError(`El login de Tu Recibo falló con HTTP ${res.status}`);

  const data = (await res.json().catch(() => null)) as { jwt?: string } | null;
  if (!data?.jwt) throw new TuReciboError("El login de Tu Recibo no devolvió jwt");
  return data.jwt;
}

/**
 * Llamada liviana para probar una conexión: el catálogo de tipos es chico y de
 * solo lectura. No parsea filas; solo confirma que el bearer sirve.
 */
export async function verificarAcceso(cred: Credenciales, jwt: string): Promise<void> {
  const res = await pedir(`${cred.baseUrl}/v2/licensesUser/types`, {
    method: "GET",
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new TuReciboError(`El catálogo de tipos devolvió HTTP ${res.status}`);
}

/** Catálogo completo de tipos, no los tipos que aparecieron en alguna licencia. */
export async function traerTiposLicencia(cred: Credenciales, jwt: string): Promise<TipoLicenciaCrudo[]> {
  const res = await pedir(`${cred.baseUrl}/v2/licensesUser/types`, {
    method: "GET",
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new TuReciboError(`El catálogo de tipos devolvió HTTP ${res.status}`);

  const cuerpo = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(cuerpo?.data)) {
    throw new TuReciboError("El catálogo de tipos no devolvió un arreglo en 'data'");
  }

  const tipos: TipoLicenciaCrudo[] = [];
  for (const crudo of cuerpo.data as (Record<string, unknown> | null)[]) {
    const id = crudo?.id == null ? "" : String(crudo.id).trim();
    const nombre = crudo?.nombre == null ? "" : String(crudo.nombre).trim();
    if (!id || !nombre) {
      throw new TuReciboError(
        "El catálogo de tipos trae una fila sin id o nombre. Se aborta antes de reconciliar para no dar de baja tipos vigentes.",
      );
    }
    tipos.push({
      id,
      nombre,
      visible: crudo?.visible == null ? "t" : String(crudo.visible).trim(),
      isVacation: crudo?.isVacation === true,
    });
  }
  return tipos;
}

const LIMITE_POR_PAGINA = 5000;
const PAGINAS_MAXIMAS = 20;

/**
 * Trae el padrón completo de licencias de la empresa, paginado.
 *
 * **Falla si no puede probar que la lectura está completa.** No es celo: quien
 * consume esto lo trata como padrón autoritativo y da de baja toda ausencia
 * activa que no aparezca. Una lectura truncada devuelta como buena no produce
 * un error, produce una baja masiva de licencias que siguen vigentes — y la
 * corrida termina informando éxito.
 *
 * Completitud probada, en orden de preferencia:
 *   1. una página con menos filas que el tope **y sin filas repetidas**: es la
 *      última;
 *   2. `total` alcanzado, cuando el origen lo informa.
 *
 * Todo lo demás es incompleto y tira: agotar el tope de páginas con páginas
 * llenas, que el origen repita filas ya vistas, o que `total` quede por encima
 * de lo acumulado. El tope sigue siendo la guarda contra un bucle infinito,
 * pero agotarlo ahora es un error y no un final silencioso.
 *
 * El orden de las comprobaciones es parte del contrato de esta función: la
 * inconsistencia se evalúa **antes** que el fin por página corta. Al revés, una
 * última página de diez filas ya vistas se leía como final legítimo.
 *
 * **Un arreglo vacío es la señal de fin, así que nada que no sea un arreglo
 * puede terminar valiendo `[]`.** Esa es la razón de que el parseo valide en
 * vez de tolerar: un 200 con cuerpo ilegible, sin `results.data`, o con filas
 * sin id, se volvía silenciosamente "no hay más licencias" y la reconciliación
 * daba de baja todo lo que no se alcanzó a leer. Una respuesta rota tiene que
 * doler acá, que es donde se distingue de un padrón que terminó.
 */
export async function traerLicencias(cred: Credenciales, jwt: string): Promise<LicenciaCruda[]> {
  const todas: LicenciaCruda[] = [];
  const vistas = new Set<string>();
  let completo = false;
  let total: number | null = null;

  for (let pagina = 1; pagina <= PAGINAS_MAXIMAS; pagina++) {
    const offset = (pagina - 1) * LIMITE_POR_PAGINA;
    const res = await pedir(
      `${cred.baseUrl}/v2/licensesUser/licenses?pagination=${LIMITE_POR_PAGINA},${pagina},${offset}`,
      { method: "POST", headers: { authorization: `Bearer ${jwt}` } },
    );
    if (!res.ok) throw new TuReciboError(`El padrón de licencias devolvió HTTP ${res.status} en la página ${pagina}`);

    const crudo = await res.text();
    let data: { pagination?: { total?: number }; results?: { data?: unknown } } | null;
    try {
      data = JSON.parse(crudo) as typeof data;
    } catch {
      // Un 200 con cuerpo ilegible **no es una página vacía**. Antes esto caía
      // a `null` y de ahí a `[]`, y un arreglo vacío es justamente la señal de
      // "última página": un error de transporte se disfrazaba de fin de padrón.
      throw new TuReciboError(
        `La página ${pagina} del padrón de licencias devolvió HTTP 200 con un cuerpo que no es JSON ` +
          `(${crudo.length} bytes). Se aborta antes de reconciliar: tomarlo por página vacía daría de baja ` +
          "todas las licencias que no se alcanzaron a leer.",
      );
    }

    if (data === null || typeof data !== "object") {
      throw new TuReciboError(
        `La página ${pagina} del padrón de licencias devolvió un JSON que no es un objeto. ` +
          "Se aborta antes de reconciliar.",
      );
    }

    if (typeof data.pagination?.total === "number") total = data.pagination.total;

    // `results.data` tiene que existir y ser arreglo. Que falte es un cambio de
    // contrato del origen o una respuesta de error con forma de éxito; en
    // ninguno de los dos casos significa "no hay más licencias".
    const contenido = data.results?.data;
    if (!Array.isArray(contenido)) {
      throw new TuReciboError(
        `La página ${pagina} del padrón de licencias no trae 'results.data' como arreglo ` +
          `(llegó ${contenido === undefined ? "ausente" : typeof contenido}). ` +
          "Se aborta antes de reconciliar: la ausencia del campo no es un padrón vacío.",
      );
    }
    const filas = contenido as LicenciaCruda[];

    // Si el origen repite la página, cortamos. Detectarlo por id evita confiar
    // en que `total` y `pagination` sean coherentes entre sí.
    let repetidas = 0;
    for (const fila of filas) {
      const id = String(fila?.id_licencia ?? "").trim();
      // Una fila sin id no se puede reconciliar ni deduplicar: no hay con qué
      // cruzarla. Descartarla en silencio hacía que el conteo de la página
      // siguiera pareciendo completo mientras el padrón perdía filas.
      if (!id) {
        throw new TuReciboError(
          `La página ${pagina} del padrón de licencias trae una fila sin 'id_licencia'. ` +
            "Se aborta antes de reconciliar: una fila que no se puede identificar tampoco se puede " +
            "distinguir de una licencia dada de baja.",
        );
      }
      if (vistas.has(id)) {
        repetidas++;
        continue;
      }
      vistas.add(id);
      todas.push(fila);
    }

    // Una fila ya vista significa que el origen no está dando un snapshot
    // estable: las páginas se movieron entre pedidos. No se puede saber qué
    // quedó afuera, así que no se puede afirmar completitud.
    //
    // **El orden importa y es el arreglo.** Con la comprobación de página corta
    // primero, una última página de 10 filas ya vistas se leía como "llegamos
    // al final" y un padrón truncado salía informado como completo. Una página
    // corta no prueba el fin si trae filas repetidas.
    if (repetidas > 0) break;

    // Ya no hace falta un chequeo de "página llena sin nada nuevo": una fila
    // sin id tira, y una fila repetida entra por `repetidas`. No quedan
    // caminos por los que una página con filas no aporte ninguna.

    // Una página incompleta —incluida la vacía— solo puede ser la última.
    if (filas.length < LIMITE_POR_PAGINA) {
      completo = true;
      break;
    }
    if (total !== null && todas.length >= total) {
      completo = true;
      break;
    }
  }

  if (!completo) {
    throw new TuReciboError(
      `La lectura del padrón de licencias quedó incompleta: ${todas.length} filas en ${PAGINAS_MAXIMAS} páginas ` +
        `sin señal de fin${total !== null ? ` (el origen informa ${total})` : ""}. ` +
        "Se aborta antes de reconciliar para no dar de baja licencias vigentes que no se alcanzaron a leer.",
    );
  }

  if (total !== null && todas.length < total) {
    throw new TuReciboError(
      `El padrón de licencias devolvió ${todas.length} filas pero el origen informa ${total}. ` +
        "Se aborta antes de reconciliar: las que falten se darían de baja estando vigentes.",
    );
  }

  return todas;
}
