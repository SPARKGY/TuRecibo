import { describe, it, expect } from "vitest";
import { armarManifiesto, MANIFIESTO_VERSION } from "@/lib/manifiesto";
import { MAESTROS, MAESTROS_VERSION } from "@/lib/maestros";
import { VENTANA_MAXIMA, VENTANA_POR_DEFECTO } from "@/lib/ventana";

const manifiesto = armarManifiesto();
const porId = new Map(manifiesto.publica.map((m) => [m.id, m]));

describe("compatibilidad con v1", () => {
  // `publica` es aditivo: un CENTRIA que solo entienda v1 tiene que poder leer
  // este documento sin romperse. Si `maestros` cambiara de forma o dejara de
  // estar, el módulo quedaría sin poder leer `personas` hasta que el otro lado
  // se actualice — justo lo que la compatibilidad busca evitar.
  it("`maestros` sigue estando y conserva su forma", () => {
    expect(Array.isArray(manifiesto.maestros)).toBe(true);
    expect(manifiesto.maestros.length).toBeGreaterThan(0);
    for (const m of manifiesto.maestros) {
      expect(typeof m.id).toBe("string");
      expect(Array.isArray(m.campos)).toBe(true);
      expect(typeof m.motivo).toBe("string");
    }
  });

  it("sigue declarando `personas`, que es de lo que depende el cruce", () => {
    const personas = manifiesto.maestros.find((m) => m.id === "personas");
    expect(personas).toBeDefined();
    expect(personas!.campos).toContain("dni");
  });

  it("la identidad del módulo no cambió de lugar", () => {
    expect(manifiesto.codigo).toBeTruthy();
    expect(manifiesto.nombre).toBeTruthy();
    expect(manifiesto.version).toBeTruthy();
  });
});

describe("sección publica", () => {
  it("declara exactamente los maestros que el módulo sabe servir", () => {
    // Si el manifiesto ofreciera uno que `buscarMaestro` no conoce, CENTRIA
    // mostraría una conexión posible que después da 404.
    expect(manifiesto.publica.map((m) => m.id).sort()).toEqual(["ausencias", "feriados", "tipos-licencia"]);
    expect(manifiesto.publica).toHaveLength(MAESTROS.length);
  });

  it("publica la sensibilidad de cada campo", () => {
    const ausencias = porId.get("ausencias")!;
    const sens = new Map(ausencias.campos.map((c) => [c.id, c.sensibilidad]));
    expect(sens.get("dni")).toBe("restringido");
    expect(sens.get("cuil")).toBe("restringido");
    expect(sens.get("motivo")).toBe("restringido");
    expect(sens.get("legajo")).toBe("sensible");
    expect(sens.get("estado")).toBe("comun");
  });

  it("la clave de cada maestro está entre sus campos declarados", () => {
    for (const m of manifiesto.publica) {
      expect(m.campos.map((c) => c.id)).toContain(m.clave);
    }
  });

  it("los campos declarados coinciden con los que se publican de verdad", () => {
    // El manifiesto y el catálogo no pueden divergir: un campo ofrecido y no
    // servido se conectaría y llegaría siempre en null.
    for (const real of MAESTROS) {
      const declarado = porId.get(real.id)!;
      expect(declarado.campos.map((c) => c.id).sort()).toEqual(real.campos.map((c) => c.id).sort());
    }
  });

  it("expone la versión del esquema de fila, no la del documento", () => {
    for (const m of manifiesto.publica) {
      expect(m.version).toBe(MAESTROS_VERSION);
    }
    expect(manifiesto.manifiestoVersion).toBe(MANIFIESTO_VERSION);
  });
});

describe("parámetros declarados", () => {
  // `?campos=` y `?desde=` son universales por contrato, así que no se declaran.
  // Lo único que varía entre maestros es `ventanaDias`.
  it("solo ausencias declara ventanaDias, con los límites del contrato", () => {
    const parametros = porId.get("ausencias")!.parametros!;
    expect(parametros).toHaveLength(1);
    const ventana = parametros[0]!;
    expect(ventana.id).toBe("ventanaDias");
    expect(ventana.tipo).toBe("numero");
    expect(ventana.min).toBe(1);
    expect(ventana.max).toBe(VENTANA_MAXIMA);
    expect(ventana.default).toBe(VENTANA_POR_DEFECTO);
    expect(ventana.default).toBeLessThanOrEqual(ventana.max);
  });

  it("los valores por defecto son los que CENTRIA fijó", () => {
    expect(VENTANA_POR_DEFECTO).toBe(31);
    expect(VENTANA_MAXIMA).toBe(400);
  });

  it("el que no tiene parámetros omite la lista en vez de mandarla vacía", () => {
    expect(porId.get("feriados")!.parametros).toBeUndefined();
    expect(porId.get("tipos-licencia")!.parametros).toBeUndefined();
  });
});

describe("ids y claves fijados por el contrato", () => {
  it("cada maestro usa la clave acordada", () => {
    expect(porId.get("tipos-licencia")!.clave).toBe("externalId");
    expect(porId.get("ausencias")!.clave).toBe("externalId");
    // `feriados` se identifica por fecha, no por un id sintético: el calendario
    // no tiene otro identificador estable del lado de Tu Recibo.
    expect(porId.get("feriados")!.clave).toBe("fecha");
  });

  it("todo campo declara un tipo del contrato", () => {
    const validos = ["texto", "numero", "booleano", "fecha", "fechaHora", "lista"];
    for (const m of manifiesto.publica) {
      for (const c of m.campos) {
        expect(validos).toContain(c.tipo);
      }
    }
  });

  it("ausencias expone con nombre exacto los campos que Timesheet pide", () => {
    const campos = porId.get("ausencias")!.campos.map((c) => c.id);
    for (const pedido of ["personaExternalId", "tipoExternalId", "estado", "desde", "hasta", "medioDia", "horas"]) {
      expect(campos).toContain(pedido);
    }
  });

  it("los campos de fecha y los booleanos se declaran como tales", () => {
    const tipos = new Map(porId.get("ausencias")!.campos.map((c) => [c.id, c.tipo]));
    expect(tipos.get("desde")).toBe("fecha");
    expect(tipos.get("hasta")).toBe("fecha");
    expect(tipos.get("regreso")).toBe("fecha");
    expect(tipos.get("medioDia")).toBe("booleano");
    expect(tipos.get("horas")).toBe("numero");
  });

  it("los enum escalares se declaran `texto`, no `lista`", () => {
    // `lista` le dice al relay que espere un arreglo. `estado` y `tipo` viajan
    // como un string suelto, así que declararlos `lista` hacía fallar la
    // validación de forma y descartaba el sobre entero con un 502. El conjunto
    // acotado se documenta en `descripcion`, que no participa de la validación.
    const ausencias = new Map(porId.get("ausencias")!.campos.map((c) => [c.id, c]));
    const feriados = new Map(porId.get("feriados")!.campos.map((c) => [c.id, c]));

    expect(ausencias.get("estado")!.tipo).toBe("texto");
    expect(feriados.get("tipo")!.tipo).toBe("texto");
    expect(ausencias.get("estado")!.descripcion).toContain("APROBADA");
  });

  it("ningún campo publicado se declara `lista` mientras se emitan escalares", () => {
    for (const m of manifiesto.publica) {
      for (const c of m.campos) {
        expect(c.tipo, `${m.id}.${c.id}`).not.toBe("lista");
      }
    }
  });

  it("ausencias publica exactamente los 14 campos del catálogo", () => {
    // El conteo está fijado porque CENTRIA lo verifica contra el manifiesto
    // real: si alguien agrega o saca un campo, hay que incrementar
    // `MAESTROS_VERSION` y avisar, no descubrirlo cuando falle una conexión.
    expect(porId.get("ausencias")!.campos).toHaveLength(14);
    expect(porId.get("tipos-licencia")!.campos).toHaveLength(4);
    expect(porId.get("feriados")!.campos).toHaveLength(4);
  });
});

describe("ping de salud", () => {
  it("declara el path acordado", () => {
    expect(manifiesto.salud).toBe("/centria/salud");
  });
});
