import { describe, it, expect, afterEach } from "vitest";
import { validarSecreto } from "@/lib/tokens";

const VAR = "TOKEN_DE_PRUEBA";

afterEach(() => {
  delete process.env[VAR];
  delete process.env[`${VAR}_PREVIO`];
});

describe("validarSecreto", () => {
  it("acepta el secreto actual", () => {
    process.env[VAR] = "abc123";
    expect(validarSecreto(VAR, "abc123")).toEqual({ ok: true, usóPrevio: false });
  });

  it("rechaza un secreto que no coincide", () => {
    process.env[VAR] = "abc123";
    expect(validarSecreto(VAR, "otro")).toMatchObject({ ok: false, status: 403 });
  });

  it("distingue 'no mandó token' de 'mandó el equivocado'", () => {
    process.env[VAR] = "abc123";
    expect(validarSecreto(VAR, null)).toMatchObject({ ok: false, status: 401 });
  });

  it("falla cerrado si la variable no está configurada", () => {
    expect(validarSecreto(VAR, "loquesea")).toMatchObject({ ok: false, status: 500 });
  });

  it("no deja pasar un header vacío contra una variable vacía", () => {
    // El caso que hace que fallar cerrado importe: un App Setting en "" con un
    // `===` ingenuo autorizaría exactamente a quien no tiene el secreto.
    process.env[VAR] = "";
    expect(validarSecreto(VAR, "")).toMatchObject({ ok: false, status: 500 });
  });

  it("trata una referencia de Key Vault sin resolver como no configurada", () => {
    // Llega como texto literal, no vacía. Sin la guarda, el síntoma visible
    // sería un 403 inexplicable en vez de 'falta configurar el secreto'.
    process.env[VAR] = "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/x/1)";
    expect(validarSecreto(VAR, "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/x/1)")).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  it("durante la rotación acepta los dos y avisa cuál se usó", () => {
    process.env[VAR] = "nuevo";
    process.env[`${VAR}_PREVIO`] = "viejo";
    expect(validarSecreto(VAR, "nuevo")).toEqual({ ok: true, usóPrevio: false });
    expect(validarSecreto(VAR, "viejo")).toEqual({ ok: true, usóPrevio: true });
    expect(validarSecreto(VAR, "tercero")).toMatchObject({ ok: false, status: 403 });
  });

  it("acepta el previo aunque el actual todavía no esté puesto", () => {
    process.env[`${VAR}_PREVIO`] = "viejo";
    expect(validarSecreto(VAR, "viejo")).toEqual({ ok: true, usóPrevio: true });
  });
});
