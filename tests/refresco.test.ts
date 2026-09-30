import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    corridaSync: { findFirst: vi.fn() },
    selloMaestro: { findUnique: vi.fn() },
    feriado: { count: vi.fn() },
    ausencia: { count: vi.fn() },
    tipoLicencia: { count: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  formatearDuracion,
  formatearFechaHora,
  formatearRelativo,
  leerEstadoRefresco,
  recortarError,
  type EstadoFuente,
} from "@/lib/refresco";

const corrida = (estado: string, extra: Record<string, unknown> = {}) => ({
  id: `c-${estado}`,
  estado,
  manual: false,
  iniciadaEn: new Date("2026-09-29T10:00:00Z"),
  terminadaEn: new Date("2026-09-29T10:01:05Z"),
  leidas: 10,
  altas: 1,
  cambios: 2,
  bajas: 0,
  descartadas: 0,
  error: null,
  ...extra,
});

describe("formatos", () => {
  it("formatea en hora de Buenos Aires", () => {
    expect(formatearFechaHora(new Date("2026-09-29T03:05:00Z"))).toBe("29/09/2026 00:05");
    expect(formatearFechaHora(new Date("2026-09-29T02:59:00Z"))).toBe("28/09/2026 23:59");
  });

  it("relativo", () => {
    const ahora = new Date("2026-09-29T12:00:00Z");
    const hace = (ms: number) => formatearRelativo(new Date(ahora.getTime() - ms), ahora);
    expect(hace(10_000)).toBe("recién");
    expect(hace(-60_000)).toBe("recién");
    expect(hace(5 * 60_000)).toBe("hace 5 min");
    expect(hace(3 * 3_600_000 + 59 * 60_000)).toBe("hace 3 h");
    expect(hace(2 * 86_400_000)).toBe("hace 2 d");
    expect(hace(90 * 86_400_000)).toBe("hace 3 meses");
  });

  it("duración y error", () => {
    const d = new Date("2026-09-29T10:00:00Z");
    expect(formatearDuracion(d, null)).toBeNull();
    expect(formatearDuracion(d, new Date(d.getTime() + 42_000))).toBe("42 s");
    expect(formatearDuracion(d, new Date(d.getTime() + 65_000))).toBe("1 min 5 s");
    expect(formatearDuracion(d, new Date(d.getTime() + 120_000))).toBe("2 min");
    expect(recortarError("  corto  ")).toBe("corto");
    expect(recortarError("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("leerEstadoRefresco", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.selloMaestro.findUnique.mockResolvedValue({ revision: 4, actualizadoEn: new Date() });
    prismaMock.feriado.count.mockResolvedValue(20);
    prismaMock.ausencia.count.mockResolvedValue(300);
    prismaMock.tipoLicencia.count.mockResolvedValue(12);
  });

  it("devuelve las tres fuentes en orden y no busca la última OK si la última ya lo fue", async () => {
    prismaMock.corridaSync.findFirst.mockResolvedValue(corrida("OK"));
    const r = await leerEstadoRefresco("t1");
    expect(r.map((f) => f.fuente)).toEqual(["FERIADOS", "AUSENCIAS", "TIPOS_LICENCIA"]);
    expect(r.map((f) => f.activas)).toEqual([20, 300, 12]);
    expect(r.every((f) => f.consultaOk && f.ultimaOk === null)).toBe(true);
    expect(prismaMock.corridaSync.findFirst).toHaveBeenCalledTimes(3);
    expect(prismaMock.corridaSync.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", fuente: "FERIADOS" }, orderBy: { iniciadaEn: "desc" } }),
    );
  });

  it("si la última falló, trae también la última OK", async () => {
    const ok = corrida("OK", { id: "vieja" });
    prismaMock.corridaSync.findFirst.mockImplementation(async (args: { where: { estado?: string } }) =>
      args.where.estado === "OK" ? ok : corrida("FALLIDA", { error: "boom" }),
    );
    const feriados = (await leerEstadoRefresco("t1"))[0]!;
    expect(feriados.ultima?.estado).toBe("FALLIDA");
    expect(feriados.ultimaOk?.id).toBe("vieja");
  });

  it("tolera fallas de la base: deja la parte en null y marca consultaOk en false", async () => {
    prismaMock.corridaSync.findFirst.mockRejectedValue(new Error("db caída"));
    prismaMock.feriado.count.mockRejectedValue(new Error("db caída"));
    const [feriados, ausencias] = (await leerEstadoRefresco("t1")) as [EstadoFuente, EstadoFuente];
    expect(feriados).toMatchObject({
      ultima: null,
      ultimaOk: null,
      consultaUltimaOk: true,
      activas: null,
      consultaOk: false,
    });
    expect(ausencias.activas).toBe(300);
    expect(ausencias.sello?.revision).toBe(4);
  });

  it("sin corridas: consultaOk sigue en true", async () => {
    prismaMock.corridaSync.findFirst.mockResolvedValue(null);
    prismaMock.selloMaestro.findUnique.mockResolvedValue(null);
    const feriados = (await leerEstadoRefresco("t1"))[0]!;
    expect(feriados).toMatchObject({ ultima: null, sello: null, consultaOk: true });
  });

  it("preserva el estado de la búsqueda de la última OK aunque fallen otras consultas", async () => {
    prismaMock.corridaSync.findFirst.mockImplementation(async (args: { where: { estado?: string } }) =>
      args.where.estado === "OK" ? null : corrida("FALLIDA"),
    );
    prismaMock.feriado.count.mockRejectedValue(new Error("db caída"));
    const feriados = (await leerEstadoRefresco("t1"))[0]!;
    expect(feriados).toMatchObject({
      ultima: { estado: "FALLIDA" },
      ultimaOk: null,
      consultaUltimaOk: true,
      activas: null,
      consultaOk: false,
    });
  });

  it("indica si falló específicamente la búsqueda de la última OK", async () => {
    prismaMock.corridaSync.findFirst.mockImplementation(async (args: { where: { estado?: string } }) =>
      args.where.estado === "OK" ? Promise.reject(new Error("db caída")) : corrida("FALLIDA"),
    );
    const feriados = (await leerEstadoRefresco("t1"))[0]!;
    expect(feriados).toMatchObject({ ultimaOk: null, consultaUltimaOk: false, consultaOk: false });
  });
});
