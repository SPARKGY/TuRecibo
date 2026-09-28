import { describe, it, expect } from "vitest";
import { armarRespuesta, buscarMaestro, MAESTROS, type Fila } from "@/lib/maestros";

const maestro = buscarMaestro("ausencias")!;

const fila = (clave: string, over: Partial<Fila> = {}): Fila => ({
  clave,
  activa: true,
  actualizada: new Date("2025-03-10T12:00:00.000Z"),
  datos: { externalId: clave, estado: "APROBADA", dni: "12345678", desde: "2025-03-05" },
  ...over,
});

describe("catálogo", () => {
  it("marca DNI, CUIL y motivo como restringidos", () => {
    // Son los campos que convierten la tabla en un legajo médico: si dejaran de
    // ser restringidos, se conectarían sin que nadie justifique por escrito.
    const por = new Map(maestro.campos.map((c) => [c.id, c.sensibilidad]));
    expect(por.get("dni")).toBe("restringido");
    expect(por.get("cuil")).toBe("restringido");
    expect(por.get("motivo")).toBe("restringido");
    expect(por.get("estado")).toBe("comun");
  });

  it("la clave de cada maestro está entre sus campos", () => {
    for (const m of MAESTROS) {
      expect(m.campos.map((c) => c.id)).toContain(m.clave);
    }
  });

  it("no responde a un maestro que no publica", () => {
    expect(buscarMaestro("personas")).toBeUndefined();
  });
});

describe("armarRespuesta", () => {
  const sello = new Date("2025-03-11T03:00:00.000Z");

  it("recorta a los campos pedidos y siempre incluye la clave", () => {
    const r = armarRespuesta({
      maestro,
      filas: [fila("100")],
      campos: ["estado"],
      desde: null,
      selloActualizado: sello,
    });
    expect(Object.keys(r.filas[0]!)).toEqual(["externalId", "estado"]);
  });

  it("completa con null el campo que la fila no trae", () => {
    const r = armarRespuesta({
      maestro,
      filas: [fila("100")],
      campos: ["horas"],
      desde: null,
      selloActualizado: sello,
    });
    expect(r.filas[0]).toEqual({ externalId: "100", horas: null });
  });

  it("en lectura completa omite las bajas en vez de listarlas", () => {
    // La ausencia de la fila ya es la baja. Listar el historial completo le
    // daría al consumidor datos que no pidió.
    const r = armarRespuesta({
      maestro,
      filas: [fila("100"), fila("101", { activa: false })],
      campos: ["estado"],
      desde: null,
      selloActualizado: sello,
    });
    expect(r.filas).toHaveLength(1);
    expect(r.bajas).toEqual([]);
  });

  it("con ?desde= devuelve solo lo que cambió, y las bajas por su clave", () => {
    const desde = new Date("2025-03-09T00:00:00.000Z");
    const vieja = fila("099", { actualizada: new Date("2025-01-01T00:00:00.000Z") });
    const r = armarRespuesta({
      maestro,
      filas: [vieja, fila("100"), fila("101", { activa: false })],
      campos: ["estado"],
      desde,
      selloActualizado: sello,
    });
    expect(r.filas.map((f) => f.externalId)).toEqual(["100"]);
    expect(r.bajas).toEqual(["101"]);
  });

  it("`version` es del esquema y no se mueve con los datos", () => {
    const a = armarRespuesta({ maestro, filas: [fila("100")], campos: [], desde: null, selloActualizado: sello });
    const b = armarRespuesta({ maestro, filas: [], campos: [], desde: null, selloActualizado: new Date() });
    expect(a.version).toBe(b.version);
  });

  it("el sello gana sobre la fila más nueva", () => {
    // Una corrida que no cambió nada igual actualiza el sello: el dato es
    // fresco aunque ninguna fila se haya movido.
    const r = armarRespuesta({
      maestro,
      filas: [fila("100")],
      campos: ["estado"],
      desde: null,
      selloActualizado: sello,
    });
    expect(r.actualizado).toBe(sello.toISOString());
  });

  it("sin sello cae al máximo de las filas", () => {
    const r = armarRespuesta({
      maestro,
      filas: [fila("100")],
      campos: ["estado"],
      desde: null,
      selloActualizado: null,
    });
    expect(r.actualizado).toBe("2025-03-10T12:00:00.000Z");
  });
});
