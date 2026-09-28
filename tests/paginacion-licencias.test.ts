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
  return {
    ok: true,
    status: 200,
    json: async () => ({ pagination: total === undefined ? {} : { total }, results: { data: filas } }),
  } as unknown as Response;
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
    await expect(traerLicencias(CRED, "jwt")).rejects.toThrow(/incompleta/i);
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
