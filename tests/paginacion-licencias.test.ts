import { describe, it, expect, afterEach, vi } from "vitest";
import { traerLicencias, TuReciboError } from "@/lib/turecibo/cliente";
import type { Credenciales } from "@/lib/turecibo/credenciales";

/**
 * El padrón de licencias se usa como autoridad: la reconciliación da de baja
 * toda ausencia activa que no aparezca en la lectura. Por eso una lectura
 * incompleta no es "menos datos", es una baja masiva de licencias vigentes
 * informada como corrida exitosa.
 *
 * Estas pruebas fijan que cualquier final que no pruebe completitud aborte
 * **antes** de devolver algo que alguien pueda reconciliar.
 */

const CRED: Credenciales = {
  tenantId: "t1",
  baseUrl: "https://ejemplo.invalid",
  adminUrl: "https://ejemplo.invalid",
  usuario: "u",
  password: "p",
};

const LIMITE = 5000;
const TOPE_PAGINAS = 20;

/** Página de `n` filas con ids únicos a partir de `base`. */
function pagina(n: number, base: number) {
  return Array.from({ length: n }, (_, i) => ({ id_licencia: String(base + i) }));
}

function responder(filas: unknown[], total?: number) {
  return cuerpo(JSON.stringify({ pagination: total === undefined ? {} : { total }, results: { data: filas } }));
}

/** Respuesta 200 con un cuerpo textual arbitrario. */
function cuerpo(texto: string) {
  return { ok: true, status: 200, text: async () => texto } as unknown as Response;
}

function mockearPaginas(paginas: { filas: unknown[]; total?: number }[]) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const p = paginas[Math.min(i, paginas.length - 1)]!;
    i++;
    return responder(p.filas, p.total);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Primera página llena y legítima, seguida de un cuerpo crudo cualquiera. */
function mockearSegundaCruda(texto: string) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const res = i === 0 ? responder(pagina(LIMITE, 0)) : cuerpo(texto);
    i++;
    return res;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("traerLicencias: completitud probada", () => {
  it("una página corta es fin de padrón", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: pagina(10, LIMITE) }]);
    const filas = await traerLicencias(CRED, "jwt");
    expect(filas).toHaveLength(LIMITE + 10);
  });

  it("una página vacía también es fin de padrón", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: [] }]);
    await expect(traerLicencias(CRED, "jwt")).resolves.toHaveLength(LIMITE);
  });

  it("acepta el corte por total alcanzado", async () => {
    mockearPaginas([
      { filas: pagina(LIMITE, 0), total: LIMITE },
      { filas: [], total: LIMITE },
    ]);
    await expect(traerLicencias(CRED, "jwt")).resolves.toHaveLength(LIMITE);
  });

  // Sin el arreglo, esto devolvía 100.000 filas como si fueran el padrón
  // entero y la reconciliación daba de baja todo lo que quedó sin leer.
  it("agotar el tope de páginas con páginas llenas es error, no final", async () => {
    const paginas = Array.from({ length: TOPE_PAGINAS + 2 }, (_, i) => ({ filas: pagina(LIMITE, i * LIMITE) }));
    mockearPaginas(paginas);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(TuReciboError);
  });

  it("una página repetida es error: no se sabe qué falta", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: pagina(LIMITE, 0) }]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/incompleta/i);
  });

  // El caso de la segunda revisión: la página final es corta **y** repetida.
  // Con el chequeo de página corta primero, esto devolvía 5000 filas como
  // padrón completo y la reconciliación daba de baja todo lo no leído.
  it("una página corta de filas ya vistas no prueba el fin", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: pagina(10, 0) }]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/incompleta/i);
  });

  // Variante mezclada: trae algo nuevo, pero también repite. Sigue siendo
  // prueba de que el origen movió las páginas entre pedidos.
  it("una página corta con algunas repetidas tampoco prueba el fin", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: [...pagina(5, 0), ...pagina(5, LIMITE)] }]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/incompleta/i);
  });

  it("una página corta con filas nuevas sí prueba el fin", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: pagina(10, LIMITE) }]);
    await expect(traerLicencias(CRED, "jwt")).resolves.toHaveLength(LIMITE + 10);
  });

  it("una página llena de filas sin id no se toma por final", async () => {
    mockearPaginas([
      { filas: pagina(LIMITE, 0) },
      { filas: Array.from({ length: LIMITE }, () => ({ id_licencia: "" })) },
    ]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/sin 'id_licencia'/i);
  });
});

/**
 * Un arreglo vacío es la señal de "última página". Por eso cualquier respuesta
 * que degrade a `[]` es peligrosa: un error de transporte o un cambio de
 * contrato se vuelven indistinguibles de un padrón que terminó, y la
 * reconciliación da de baja todo lo que no se alcanzó a leer.
 *
 * Todas estas pruebas montan una **primera página llena y legítima**, que es lo
 * que hace daño: sin ella no habría nada que dar de baja.
 */
describe("traerLicencias: respuestas rotas no son páginas vacías", () => {
  it("un 200 con cuerpo que no es JSON aborta", async () => {
    mockearSegundaCruda("<html><body>502 Bad Gateway</body></html>");
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/no es JSON/i);
  });

  it("un 200 con cuerpo vacío aborta", async () => {
    mockearSegundaCruda("");
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/no es JSON/i);
  });

  it("un JSON que no es objeto aborta", async () => {
    mockearSegundaCruda("null");
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/no es un objeto/i);
  });

  it("un JSON sin `results.data` aborta", async () => {
    mockearSegundaCruda(JSON.stringify({ pagination: { total: 99999 } }));
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/results\.data/i);
  });

  // Una respuesta de error con forma de éxito: 200, JSON válido, y un mensaje
  // donde iba el arreglo.
  it("`results.data` que no es arreglo aborta", async () => {
    mockearSegundaCruda(JSON.stringify({ results: { data: { error: "sesión vencida" } } }));
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/results\.data/i);
  });

  // El caso de la tercera revisión: página corta —o sea, señal de fin— con una
  // fila que no se puede identificar. Antes se descartaba en silencio y el
  // padrón quedaba corto pero declarado completo.
  it("una página corta con una fila sin id aborta en vez de cerrar el padrón", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: [...pagina(4, LIMITE), { id_licencia: null }] }]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/sin 'id_licencia'/i);
  });

  it("una fila con id en blanco cuenta como fila sin id", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: [...pagina(4, LIMITE), { id_licencia: "   " }] }]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/sin 'id_licencia'/i);
  });

  it("el mensaje explica que no se reconcilia", async () => {
    mockearSegundaCruda("no soy json");
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/antes de reconciliar/i);
  });

  // La contracara: una página vacía **bien formada** sí es fin legítimo y tiene
  // que seguir funcionando. Si el endurecimiento rompiera esto, el padrón cuyo
  // tamaño es múltiplo exacto del tope nunca terminaría.
  it("una página vacía bien formada sigue siendo fin de padrón", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: [] }]);
    await expect(traerLicencias(CRED, "jwt")).resolves.toHaveLength(LIMITE);
  });

  it("si el origen informa más filas de las leídas, aborta", async () => {
    mockearPaginas([{ filas: pagina(10, 0), total: 40 }]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/aborta antes de reconciliar/i);
  });

  it("el mensaje de error explica que no se reconcilia", async () => {
    mockearPaginas([{ filas: pagina(LIMITE, 0) }, { filas: pagina(LIMITE, 0) }]);
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/dar de baja licencias vigentes/i);
  });
});
