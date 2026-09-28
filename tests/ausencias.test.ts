import { describe, it, expect } from "vitest";
import { planificarAusencias, normalizarLicencia, sinCambios } from "@/lib/sync/ausencias";

const cruda = (over: Record<string, unknown> = {}) => ({
  id_licencia: "100",
  cuil: "20-12345678-9",
  numero_legajo: "A-1",
  id_tipo: "3",
  tipo: "Vacaciones",
  id_estado: "5",
  estado: "Aprobado",
  fecha_desde: "05/03/2025",
  fecha_fin: "07/03/2025",
  fecha_regreso: "10/03/2025",
  medio_dia: "f",
  medio_dia_horas: "",
  motivo: null,
  ...over,
});

const guardada = (over: Record<string, unknown> = {}) => ({
  ...normalizarLicencia(cruda() as never)!,
  activa: true,
  ...over,
});

describe("normalizarLicencia", () => {
  it("normaliza una licencia completa", () => {
    const n = normalizarLicencia(cruda() as never)!;
    expect(n).toMatchObject({
      externalId: "100",
      dni: "12345678",
      estado: "APROBADA",
      medioDia: false,
      horas: null,
    });
    expect(n.desde?.toISOString()).toBe("2025-03-05T00:00:00.000Z");
  });

  it("descarta la licencia sin id en vez de inventarle una clave", () => {
    // Inventarla crearía una fila nueva en cada corrida, para siempre.
    expect(normalizarLicencia(cruda({ id_licencia: "" }) as never)).toBeNull();
    expect(normalizarLicencia(cruda({ id_licencia: null }) as never)).toBeNull();
  });

  it("tolera un CUIL que no deriva a DNI", () => {
    const n = normalizarLicencia(cruda({ cuil: "sin datos" }) as never)!;
    expect(n.dni).toBeNull();
    expect(n.externalId).toBe("100");
  });
});

describe("sinCambios", () => {
  it("compara fechas por valor y no por identidad", () => {
    // Dos `Date` con el mismo instante son objetos distintos: con `===` cada
    // corrida reescribiría el padrón completo.
    expect(sinCambios(guardada() as never, normalizarLicencia(cruda() as never)!)).toBe(true);
  });

  it("detecta el cambio de estado", () => {
    const deseado = normalizarLicencia(cruda({ id_estado: "8", estado: "Rechazado" }) as never)!;
    expect(sinCambios(guardada() as never, deseado)).toBe(false);
  });

  it("una fila dada de baja nunca está 'sin cambios'", () => {
    expect(sinCambios(guardada({ activa: false }) as never, normalizarLicencia(cruda() as never)!)).toBe(false);
  });
});

describe("planificarAusencias", () => {
  it("da de alta lo que no existía", () => {
    const plan = planificarAusencias([cruda()] as never, []);
    expect(plan.altas).toHaveLength(1);
    expect(plan.cambios).toHaveLength(0);
    expect(plan.bajas).toHaveLength(0);
  });

  it("no escribe nada cuando el padrón es idéntico a lo guardado", () => {
    const plan = planificarAusencias([cruda()] as never, [guardada()] as never);
    expect(plan).toMatchObject({ altas: [], cambios: [], bajas: [], descartadas: 0 });
  });

  it("da de baja lo que dejó de venir en el padrón", () => {
    const plan = planificarAusencias([] as never, [guardada()] as never);
    expect(plan.bajas).toEqual(["100"]);
  });

  it("reactiva lo que volvió a aparecer", () => {
    const plan = planificarAusencias([cruda()] as never, [guardada({ activa: false })] as never);
    expect(plan.cambios).toHaveLength(1);
    expect(plan.bajas).toHaveLength(0);
  });

  it("colapsa el mismo id repetido dentro de una corrida", () => {
    // El paginado defensivo puede traer la misma fila dos veces; tratarla como
    // alta dos veces rompería la restricción única.
    const plan = planificarAusencias([cruda(), cruda({ estado: "Rechazado", id_estado: "8" })] as never, []);
    expect(plan.altas).toHaveLength(1);
    expect(plan.descartadas).toBe(1);
  });

  it("cuenta las descartadas sin darlas de baja por error", () => {
    const plan = planificarAusencias([cruda(), cruda({ id_licencia: "" })] as never, [guardada()] as never);
    expect(plan.descartadas).toBe(1);
    expect(plan.bajas).toHaveLength(0);
  });
});
