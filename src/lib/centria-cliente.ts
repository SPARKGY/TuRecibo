/**
 * Cliente hacia CENTRIA: la dirección opuesta al enchufe de entrada.
 *
 * Acá el módulo es el que llama, así que usa la **credencial**
 * (`x-service-token` + `x-module-code`), no el token de entrada. Confundir los
 * dos secretos es el error clásico de esta integración: el token de entrada es
 * el que CENTRIA usa para entrar acá, y no sirve para salir.
 *
 * Lo único que este módulo necesita leer es `personas`, para resolver el DNI que
 * deriva del CUIL de cada licencia contra la identidad canónica. Hacerlo acá y
 * no en cada consumidor es justamente el punto: si el cruce quedara en Timesheet,
 * el próximo consumidor tendría que reimplementarlo y equivocarse distinto.
 */

import { leerObligatoria, leerOpcional, CODIGO_MODULO } from "@/lib/env";

export class CentriaError extends Error {}

/** Lo que este módulo declara necesitar en su manifiesto. */
export const MAESTROS_QUE_NECESITAMOS = [
  {
    id: "personas",
    campos: ["externalId", "dni", "email", "fullName"],
    motivo:
      "Resolver la identidad de cada ausencia. Tu Recibo solo devuelve CUIL, y el DNI que se deriva de él es el único puente con la nómina.",
  },
  {
    id: "tenant",
    campos: ["tenantId", "timezone"],
    motivo: "Interpretar las fechas sin zona que devuelve Tu Recibo en la zona del tenant.",
  },
] as const;

type RespuestaMaestro = {
  maestro: string;
  version: number;
  actualizado: string;
  filas: Record<string, unknown>[];
  bajas: string[];
};

function baseUrl(): string {
  return leerObligatoria("CENTRIA_BASE_URL").replace(/\/+$/, "");
}

/** Lee un maestro nativo de CENTRIA con la credencial del módulo. */
export async function leerMaestroDeCentria(
  maestro: string,
  opciones: { campos?: string[]; desde?: Date } = {},
): Promise<RespuestaMaestro> {
  const url = new URL(`${baseUrl()}/api/internal/maestros/${maestro}`);
  if (opciones.campos?.length) url.searchParams.set("campos", opciones.campos.join(","));
  if (opciones.desde) url.searchParams.set("desde", opciones.desde.toISOString());

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-service-token": leerObligatoria("CENTRIA_SERVICE_TOKEN"),
      "x-module-code": leerOpcional("CENTRIA_MODULE_CODE", CODIGO_MODULO),
    },
    cache: "no-store",
  });

  if (res.status === 403) {
    // CENTRIA devuelve `falta.maestro` o `falta.campos` cuando la conexión no
    // está habilitada. Repetirlo tal cual ahorra la vuelta de ir a mirar la
    // pantalla de conexiones para entender qué falta aprobar.
    const cuerpo = (await res.json().catch(() => null)) as { error?: string; falta?: unknown } | null;
    throw new CentriaError(
      `CENTRIA negó el maestro ${maestro}: ${cuerpo?.error ?? "sin conexión habilitada"}. ` +
        `Falta: ${JSON.stringify(cuerpo?.falta ?? {})}`,
    );
  }
  if (!res.ok) throw new CentriaError(`CENTRIA devolvió HTTP ${res.status} al leer ${maestro}`);

  return (await res.json()) as RespuestaMaestro;
}
