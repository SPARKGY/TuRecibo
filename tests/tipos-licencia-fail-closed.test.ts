import { afterEach, describe, expect, it, vi } from "vitest";
import { traerTiposLicencia, TuReciboError } from "@/lib/turecibo/cliente";
import { planificarTipos, sincronizarTipos } from "@/lib/sync/tipos";

const { prismaMock, resolverCredencialesMock, loginMock } = vi.hoisted(() => ({
  prismaMock: {
    corridaSync: { create: vi.fn(), update: vi.fn() },
    tipoLicencia: { findMany: vi.fn() },
    $transaction: vi.fn(),
    selloMaestro: { upsert: vi.fn() },
  },
  resolverCredencialesMock: vi.fn(),
  loginMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/turecibo/credenciales", () => ({ resolverCredenciales: resolverCredencialesMock }));
vi.mock("@/lib/turecibo/cliente", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/turecibo/cliente")>();
  return { ...original, login: loginMock };
});

const cred = {
  tenantId: "t1",
  baseUrl: "https://ejemplo.invalid",
  adminUrl: "https://ejemplo.invalid",
  usuario: "u",
  password: "p",
};
const existente = { externalId: "2", nombre: "Licencia", visible: true, esVacaciones: false, activo: true };
const valido = { id: "1", nombre: "Vacaciones", visible: "t", isVacation: true };

function respuesta(data: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data }) })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("catálogo de tipos: filas inválidas no autorizan bajas", () => {
  it.each([
    ["id ausente", { nombre: "Licencia" }],
    ["id vacío", { id: "  ", nombre: "Licencia" }],
    ["nombre ausente", { id: "2" }],
    ["nombre vacío", { id: "2", nombre: "  " }],
    ["fila nula", null],
  ])("lector rechaza %s aunque haya otras filas válidas", async (_caso, fila) => {
    respuesta([valido, fila]);
    await expect(traerTiposLicencia(cred, "jwt")).rejects.toThrow(TuReciboError);
  });

  it("el planificador no convierte una fila inválida en baja si recibe datos sin validar", () => {
    expect(() => planificarTipos([valido, { id: "2", nombre: "", visible: "t" }], [existente])).toThrow(TuReciboError);
  });

  it("una lectura corrupta deja la corrida FALLIDA sin consultar ni escribir tipos", async () => {
    respuesta([valido, { id: "2", nombre: "" }]);
    prismaMock.corridaSync.create.mockResolvedValue({ id: "corrida-1" });
    prismaMock.corridaSync.update.mockResolvedValue({});
    resolverCredencialesMock.mockResolvedValue(cred);
    loginMock.mockResolvedValue("jwt");

    await expect(sincronizarTipos("t1", false)).rejects.toThrow(TuReciboError);
    expect(prismaMock.corridaSync.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: "FALLIDA" }) }),
    );
    expect(prismaMock.tipoLicencia.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.selloMaestro.upsert).not.toHaveBeenCalled();
  });

  it("catálogo válido conserva la reconciliación de bajas reales", async () => {
    respuesta([valido]);
    await expect(traerTiposLicencia(cred, "jwt")).resolves.toEqual([valido]);
    expect(planificarTipos([valido], [existente]).bajas).toEqual(["2"]);
  });
});
