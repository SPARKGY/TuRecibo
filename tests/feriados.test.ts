import { describe, it, expect } from "vitest";
import { aplicarOverrides, planificarFeriados, type FeriadoDeseado } from "@/lib/sync/feriados";

const f = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const origen = (iso: string, descripcion: string, tipo: "FERIADO_NACIONAL" | "NO_LABORABLE" = "FERIADO_NACIONAL") => ({
  fecha: f(iso),
  tipo,
  descripcion,
});

const existente = (d: FeriadoDeseado, activo = true) => ({ ...d, activo });

describe("aplicarOverrides", () => {
  it("espeja tal cual lo que vino cuando no hay correcciones", () => {
    const { resultado, aplicados } = aplicarOverrides([origen("2025-05-01", "Día del Trabajador")], []);
    expect(aplicados).toBe(0);
    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toMatchObject({
      descripcion: "Día del Trabajador",
      desdeOverride: false,
      enOrigen: true,
      descripcionOrigen: "Día del Trabajador",
    });
  });

  it("un CAMBIO corrige el valor vigente pero conserva el crudo del origen", () => {
    const { resultado } = aplicarOverrides(
      [origen("2025-05-01", "Feriad del Trabajador")],
      [{ fecha: f("2025-05-01"), accion: "CAMBIO", tipo: null, descripcion: "Día del Trabajador" }],
    );

    expect(resultado[0]).toMatchObject({
      descripcion: "Día del Trabajador",
      descripcionOrigen: "Feriad del Trabajador",
      desdeOverride: true,
      enOrigen: true,
    });
  });

  it("un ALTA agrega un feriado que el origen no trae", () => {
    const { resultado } = aplicarOverrides(
      [],
      [{ fecha: f("2025-12-24"), accion: "ALTA", tipo: "NO_LABORABLE", descripcion: "Nochebuena" }],
    );

    expect(resultado[0]).toMatchObject({
      descripcion: "Nochebuena",
      desdeOverride: true,
      enOrigen: false,
      tipoOrigen: null,
    });
  });

  it("un BAJA saca de la carga lo que el origen sí trajo", () => {
    const { resultado, aplicados } = aplicarOverrides(
      [origen("2025-03-24", "Memoria")],
      [{ fecha: f("2025-03-24"), accion: "BAJA", tipo: null, descripcion: null }],
    );
    expect(aplicados).toBe(1);
    expect(resultado).toHaveLength(0);
  });

  it("un CAMBIO sobre una fecha que el origen retiró no la resucita", () => {
    // Si CAMBIO creara la fila, un override viejo mantendría vivo para siempre
    // un feriado que Tu Recibo ya sacó. Para eso está ALTA.
    const { resultado } = aplicarOverrides(
      [],
      [{ fecha: f("2025-06-17", ), accion: "CAMBIO", tipo: "NO_LABORABLE", descripcion: "Güemes" }],
    );
    expect(resultado).toHaveLength(0);
  });
});

describe("planificarFeriados", () => {
  const anios = new Set([2025]);

  it("da de alta lo que no existía", () => {
    const { resultado } = aplicarOverrides([origen("2025-05-01", "Trabajador")], []);
    const plan = planificarFeriados(resultado, [], anios);
    expect(plan.altas).toHaveLength(1);
    expect(plan.cambios).toHaveLength(0);
    expect(plan.bajas).toHaveLength(0);
  });

  it("no toca nada cuando la carga es idéntica a lo guardado", () => {
    const { resultado } = aplicarOverrides([origen("2025-05-01", "Trabajador")], []);
    const plan = planificarFeriados(resultado, resultado.map((d) => existente(d)), anios);
    expect(plan).toEqual({ altas: [], cambios: [], bajas: [] });
  });

  it("reactiva una fila dada de baja que el origen volvió a traer", () => {
    const { resultado } = aplicarOverrides([origen("2025-05-01", "Trabajador")], []);
    const plan = planificarFeriados(resultado, resultado.map((d) => existente(d, false)), anios);
    expect(plan.cambios).toHaveLength(1);
  });

  it("da de baja lo que dejó de venir, dentro de los años cubiertos", () => {
    const { resultado } = aplicarOverrides([origen("2025-05-01", "Trabajador")], []);
    const guardados = [
      ...resultado.map((d) => existente(d)),
      existente(aplicarOverrides([origen("2025-03-24", "Memoria")], []).resultado[0]!),
    ];
    const plan = planificarFeriados(resultado, guardados, anios);
    expect(plan.bajas.map((b) => b.toISOString().slice(0, 10))).toEqual(["2025-03-24"]);
  });

  it("no toca los años que la carga no cubre", () => {
    // El robot trae años sueltos: reconciliar contra toda la tabla borraría el
    // calendario de los años que nadie pidió.
    const { resultado } = aplicarOverrides([origen("2025-05-01", "Trabajador")], []);
    const guardados = [
      ...resultado.map((d) => existente(d)),
      existente(aplicarOverrides([origen("2026-05-01", "Trabajador")], []).resultado[0]!),
    ];
    const plan = planificarFeriados(resultado, guardados, anios);
    expect(plan.bajas).toHaveLength(0);
  });

  it("quitar un CAMBIO devuelve la fila al valor del origen en vez de darla de baja", () => {
    // Este es el caso que justifica guardar `tipoOrigen`/`descripcionOrigen`:
    // sin ellos, el origen reconstruido vendría vacío y el feriado se perdería.
    const conOverride = aplicarOverrides(
      [origen("2025-05-01", "Feriad del Trabajador")],
      [{ fecha: f("2025-05-01"), accion: "CAMBIO", tipo: null, descripcion: "Día del Trabajador" }],
    ).resultado;

    const guardado = existente(conOverride[0]!);

    // Se borra el override y se reconstruye la carga desde el espejo crudo,
    // que es exactamente lo que hace `reaplicarOverrides`.
    const reconstruido = aplicarOverrides(
      [{ fecha: guardado.fecha, tipo: guardado.tipoOrigen!, descripcion: guardado.descripcionOrigen! }],
      [],
    ).resultado;

    const plan = planificarFeriados(reconstruido, [guardado], anios);
    expect(plan.bajas).toHaveLength(0);
    expect(plan.cambios).toHaveLength(1);
    expect(plan.cambios[0]).toMatchObject({ descripcion: "Feriad del Trabajador", desdeOverride: false });
  });
});
