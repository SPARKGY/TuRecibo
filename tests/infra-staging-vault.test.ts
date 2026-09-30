import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Staging must never get write access to the shared production vault.
const bicep = readFileSync(join(__dirname, "..", "infra", "staging.bicep"), "utf8");

describe("infra/staging.bicep: separación de vaults", () => {
  it("no modifica access policies del vault compartido", () => {
    expect(bicep).not.toMatch(/Microsoft\.KeyVault\/vaults\/accessPolicies/);
    expect(bicep).not.toMatch(/'set'/);
  });

  it("apunta KEY_VAULT_URL al vault dedicado de staging", () => {
    expect(bicep).toMatch(/name: 'KEY_VAULT_URL', value: connectionsVault\.properties\.vaultUri/);
    expect(bicep).toMatch(/param connectionsVaultName string = 'kv-turecibo-stg'/);
  });

  it("concede Secrets Officer solo con alcance al vault dedicado", () => {
    const asignaciones = bicep.split("resource ").filter((b) => b.includes("secretsOfficerRoleId)"));
    expect(asignaciones.length).toBeGreaterThan(0);
    for (const bloque of asignaciones) {
      expect(bloque).toMatch(/scope: connectionsVault\r?\n/);
    }
  });

  it("el vault dedicado usa RBAC y purge protection", () => {
    expect(bicep).toMatch(/enableRbacAuthorization: true/);
    expect(bicep).toMatch(/enablePurgeProtection: true/);
  });
});
