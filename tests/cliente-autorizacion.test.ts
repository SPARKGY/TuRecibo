import { afterEach, describe, expect, it, vi } from "vitest";
import { traerLicencias, traerTiposLicencia } from "@/lib/turecibo/cliente";
import type { Credenciales } from "@/lib/turecibo/credenciales";

const CRED: Credenciales = {
  tenantId: "t1",
  baseUrl: "https://ejemplo.invalid",
  adminUrl: "https://ejemplo.invalid",
  usuario: "u",
  password: "p",
};

const JWT = "token-de-prueba";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cliente Tu Recibo: autorización", () => {
  it("envía Bearer en la lectura del catálogo de tipos", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(traerTiposLicencia(CRED, JWT)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ headers: { authorization: `Bearer ${JWT}` } }),
    );
  });

  it("envía Bearer en la lectura del padrón de licencias", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ results: { data: [] } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(traerLicencias(CRED, JWT)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ headers: { authorization: `Bearer ${JWT}` } }),
    );
  });
});
