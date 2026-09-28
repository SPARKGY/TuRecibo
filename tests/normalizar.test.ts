import { describe, it, expect } from "vitest";
import {
  normalizarDni,
  dniDesdeCuil,
  parseFechaTuRecibo,
  parseFechaISO,
  mapEstado,
  mapEstadoPorTexto,
  mapTipoFeriado,
  esVerdadero,
  numeroOpcional,
} from "@/lib/turecibo/normalizar";

describe("dniDesdeCuil", () => {
  it("extrae los 8 dígitos centrales del CUIL", () => {
    expect(dniDesdeCuil("20-12345678-9")).toBe("12345678");
    expect(dniDesdeCuil("27123456789")).toBe("12345678");
  });

  it("acepta un DNI que ya viene suelto", () => {
    expect(dniDesdeCuil("12345678")).toBe("12345678");
    expect(dniDesdeCuil("9123456")).toBe("9123456");
  });

  it("descarta lo que no es ni CUIL ni DNI en vez de inventar uno", () => {
    expect(dniDesdeCuil("123")).toBeNull();
    expect(dniDesdeCuil("201234567890000")).toBeNull();
    expect(dniDesdeCuil(null)).toBeNull();
  });

  it("saca ceros a la izquierda para que crucen con la nómina", () => {
    expect(normalizarDni("00123456")).toBe("123456");
  });
});

describe("fechas", () => {
  // El bug clásico: en Buenos Aires (UTC-3) `new Date("05/03/2025")` cae el día
  // anterior en UTC, y una licencia de un día desaparece del calendario.
  it("lee DD/MM/YYYY sin correr el día", () => {
    const f = parseFechaTuRecibo("05/03/2025");
    expect(f?.toISOString()).toBe("2025-03-05T00:00:00.000Z");
  });

  it("no confunde día con mes", () => {
    expect(parseFechaTuRecibo("13/01/2025")?.getUTCMonth()).toBe(0);
    expect(parseFechaTuRecibo("13/01/2025")?.getUTCDate()).toBe(13);
  });

  it("lee YYYY-MM-DD del panel de feriados", () => {
    expect(parseFechaISO("2025-12-25")?.toISOString()).toBe("2025-12-25T00:00:00.000Z");
  });

  it("devuelve null ante formato desconocido en vez de una fecha inválida", () => {
    expect(parseFechaTuRecibo("2025-03-05")).toBeNull();
    expect(parseFechaISO("05/03/2025")).toBeNull();
    expect(parseFechaTuRecibo("")).toBeNull();
  });

  // `Date.UTC(2025, 1, 31)` no falla: devuelve el 3 de marzo. Si eso pasa, una
  // ingesta de feriados con un día mal tipeado termina marcando el día
  // equivocado en vez de rechazar la fila.
  it("rechaza un día que no existe en vez de correrlo al mes siguiente", () => {
    expect(parseFechaISO("2025-02-31")).toBeNull();
    expect(parseFechaTuRecibo("31/02/2025")).toBeNull();
    expect(parseFechaISO("2025-04-31")).toBeNull();
    expect(parseFechaTuRecibo("00/01/2025")).toBeNull();
    expect(parseFechaISO("2025-13-01")).toBeNull();
  });

  it("acepta el 29 de febrero solo en año bisiesto", () => {
    expect(parseFechaISO("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(parseFechaISO("2025-02-29")).toBeNull();
  });

  // Sin `$` en la regex, "2025-12-25 y algo más" pasaba como el 25.
  it("no acepta basura pegada al final", () => {
    expect(parseFechaISO("2025-12-25X")).toBeNull();
    expect(parseFechaISO("2025-12-250")).toBeNull();
    expect(parseFechaTuRecibo("05/03/2025 10:00")).toBeNull();
    expect(parseFechaTuRecibo("05/03/20251")).toBeNull();
  });
});

describe("mapEstado", () => {
  it("mapea por id según el catálogo relevado", () => {
    expect(mapEstado("5", "Aprobado")).toBe("APROBADA");
    expect(mapEstado("7", "Asignacion")).toBe("SOLICITADA");
    expect(mapEstado("10", "Cancelada")).toBe("RECHAZADA");
    expect(mapEstado("8", "Rechazado")).toBe("RECHAZADA");
    expect(mapEstado("4", "En manos de RRHH")).toBe("SOLICITADA");
  });

  it("le gana el id al texto cuando se contradicen", () => {
    // Si el origen renombra el estado 7, el id sigue mandando.
    expect(mapEstado("7", "Aprobado")).toBe("SOLICITADA");
  });

  it("cae al texto solo para ids fuera del catálogo", () => {
    expect(mapEstado("99", "Rechazado")).toBe("RECHAZADA");
    expect(mapEstado(null, "Aprobada")).toBe("APROBADA");
  });

  it("no toma 'aprobador' por 'aprobada'", () => {
    expect(mapEstadoPorTexto("En manos de aprobador nivel 1")).toBe("SOLICITADA");
    expect(mapEstadoPorTexto("Pendiente de aprobador")).toBe("SOLICITADA");
  });

  it("ante la duda deja la licencia en trámite", () => {
    expect(mapEstadoPorTexto("estado nuevo que nadie vio")).toBe("SOLICITADA");
    expect(mapEstadoPorTexto("")).toBe("SOLICITADA");
  });
});

describe("mapTipoFeriado", () => {
  it("distingue el feriado de empresa del nacional", () => {
    expect(mapTipoFeriado("Feriado por empresa")).toBe("NO_LABORABLE");
    expect(mapTipoFeriado("Feriado nacional")).toBe("FERIADO_NACIONAL");
    expect(mapTipoFeriado(null)).toBe("FERIADO_NACIONAL");
  });
});

describe("coerciones flojas", () => {
  it("interpreta los booleanos que manda el origen", () => {
    expect(esVerdadero("t")).toBe(true);
    expect(esVerdadero("1")).toBe(true);
    expect(esVerdadero("f")).toBe(false);
    expect(esVerdadero(null)).toBe(false);
  });

  it("no convierte vacío en cero", () => {
    expect(numeroOpcional("")).toBeNull();
    expect(numeroOpcional("hola")).toBeNull();
    expect(numeroOpcional("0")).toBe(0);
    expect(numeroOpcional("3.5")).toBe(3.5);
  });
});
