/**
 * Catálogo de maestros que **este módulo publica** hacia CENTRIA
 * (`GET /centria/maestros/<id>`).
 *
 * La forma de la respuesta es deliberadamente idéntica a la que CENTRIA usa
 * para sus maestros nativos (`src/lib/maestros.ts` en CENTRIA):
 * `{ maestro, version, actualizado, filas, bajas }`. Copiarla no es pereza: el
 * relay de CENTRIA filtra por campo y fila sobre esa forma, y un consumidor no
 * debería notar si un maestro es nativo o viene de un módulo.
 *
 * La **sensibilidad** que se declara acá es una propuesta del módulo. Quien la
 * aprueba campo por campo es el SUPERADMIN en CENTRIA. Declararla igual sirve
 * para que la pantalla de conexiones muestre el mismo semáforo que en los
 * maestros nativos, y para que el módulo no publique por accidente un campo que
 * él mismo considera restringido sin que nadie lo haya mirado.
 */

import { VENTANA_MAXIMA, VENTANA_POR_DEFECTO } from "@/lib/ventana";

export type Sensibilidad = "restringido" | "sensible" | "comun";

/** Tipos de campo del contrato de maestros de CENTRIA. */
export type TipoCampo = "texto" | "numero" | "booleano" | "fecha" | "fechaHora" | "lista";

export type CampoMaestro = {
  id: string;
  tipo: TipoCampo;
  sensibilidad: Sensibilidad;
  descripcion?: string;
};

/**
 * Parámetro de query que este maestro acepta y que CENTRIA ofrece configurar
 * por conexión.
 *
 * `?campos=` y `?desde=` no se declaran acá: el contrato los define para todo
 * maestro publicado, y el filtro vive en `armarRespuesta`, que no mira de qué
 * maestro se trata. Lo que se declara es lo que **varía** entre maestros.
 */
export type ParametroMaestro = {
  id: string;
  tipo: "numero";
  min: number;
  max: number;
  default: number;
};

export type MaestroId = "tipos-licencia" | "ausencias" | "feriados";

export type Maestro = {
  id: MaestroId;
  nombre: string;
  clave: string;
  /**
   * Versión del **esquema** de este maestro. Ver la nota de `VERSIONES` sobre
   * por qué es por maestro y no compartida.
   */
  version: number;
  /** De dónde sale el dato, para qué sirve y qué significa que desaparezca. */
  descripcion: string;
  campos: readonly CampoMaestro[];
  /** Ausente si el maestro no acepta parámetros más allá de los universales. */
  parametros?: readonly ParametroMaestro[];
};

/**
 * Versión del **esquema** de cada maestro, no de sus datos.
 *
 * Es la distinción que hay que dejar clavada: un consumidor que cachea usa
 * `actualizado` para saber si hay datos nuevos, y `version` para saber si la
 * forma cambió y su parser dejó de servir. Si `version` fuera un contador de
 * corrida, cada sync invalidaría el parser de todos los consumidores.
 *
 * Se incrementa ante cualquier cambio de forma: agregar, sacar o renombrar un
 * campo, cambiar el `tipo` de uno, o cambiar la `clave` del maestro. CENTRIA
 * rechaza aprobar una publicación que quite un campo o cambie tipo o clave sin
 * incremento, y el número **nunca decrece**.
 *
 * **Es una por maestro, y eso importa.** Con una constante compartida, tocar un
 * campo de `feriados` subía la versión de los tres, y CENTRIA responde 502 en
 * todo maestro cuya versión no coincide con la aprobada hasta que el SUPERADMIN
 * apruebe la propuesta nueva. Es decir: un cambio en el calendario cortaba la
 * lectura de `ausencias`, que no había cambiado, con la copia de 24 h como
 * único colchón contra el reloj de una aprobación humana.
 *
 * Arrancan las tres en 1 porque todavía no hay ninguna aprobación viva. Hacerlo
 * después habría obligado a re-aprobar los tres maestros.
 */
export const VERSIONES: Readonly<Record<MaestroId, number>> = {
  "tipos-licencia": 1,
  ausencias: 1,
  feriados: 1,
};

/**
 * Topes de respuesta fijados por el contrato de CENTRIA.
 *
 * Se chequean acá en vez de confiar en que el relay corte: una respuesta
 * truncada es indistinguible de una completa, y un consumidor concluiría que
 * las personas faltantes no tuvieron ausencias. Preferimos fallar fuerte con un
 * mensaje accionable antes que publicar un silencio que parece un dato.
 */
export const LIMITE_FILAS = 50_000;
export const LIMITE_BYTES = 10 * 1024 * 1024;

const campo = (
  id: string,
  tipo: TipoCampo,
  sensibilidad: Sensibilidad = "comun",
  descripcion?: string,
): CampoMaestro => ({
  id,
  tipo,
  sensibilidad,
  ...(descripcion ? { descripcion } : {}),
});

export const MAESTROS: readonly Maestro[] = [
  {
    id: "tipos-licencia",
    nombre: "Tipos de licencia",
    clave: "externalId",
    version: VERSIONES["tipos-licencia"],
    descripcion:
      "Catálogo de ausencias para clasificar horas y licencias. Origen: Tu Recibo, GET /v2/licensesUser/types. " +
      "Una baja significa que el tipo dejó de venir en el catálogo.",
    campos: [
      campo("externalId", "texto"),
      campo("nombre", "texto"),
      campo("visible", "booleano"),
      campo("esVacaciones", "booleano"),
    ],
  },
  {
    id: "ausencias",
    nombre: "Ausencias",
    clave: "externalId",
    version: VERSIONES.ausencias,
    descripcion:
      "Quién no estuvo, cuándo y bajo qué tipo. Origen: Tu Recibo, POST /v2/licensesUser/licenses. " +
      "Una baja significa que la licencia dejó de venir en el padrón.",
    // La ventana acota cuánto historial se publica. Solo aplica acá: los otros
    // dos son catálogos chicos y completos, y recortar el calendario de feriados
    // o la lista de tipos por antigüedad dejaría al consumidor sin poder
    // interpretar una ausencia vieja que sí le llegó.
    parametros: [
      { id: "ventanaDias", tipo: "numero", min: 1, max: VENTANA_MAXIMA, default: VENTANA_POR_DEFECTO },
    ],
    campos: [
      campo("externalId", "texto"),
      campo("personaExternalId", "texto"),
      campo("tipoExternalId", "texto"),
      campo("tipoNombre", "texto"),
      // `texto`, no `lista`: el valor que viaja es un escalar, y `lista` haría
      // que el relay esperara un arreglo y descartara el sobre entero con un
      // 502. El conjunto acotado se declara en la descripción, que es
      // informativa y no cambia la validación de forma.
      campo("estado", "texto", "comun", "Valores: SOLICITADA | APROBADA | RECHAZADA."),
      campo("desde", "fecha"),
      campo("hasta", "fecha"),
      campo("regreso", "fecha"),
      campo("medioDia", "booleano"),
      campo("horas", "numero"),
      campo("legajo", "texto", "sensible"),
      // El DNI, el CUIL y el motivo son las tres cosas que convierten esta
      // tabla en un legajo médico. Se publican solo bajo conexión con
      // justificación escrita.
      campo("dni", "texto", "restringido"),
      campo("cuil", "texto", "restringido"),
      campo("motivo", "texto", "restringido"),
    ],
  },
  {
    id: "feriados",
    nombre: "Feriados",
    clave: "fecha",
    version: VERSIONES.feriados,
    descripcion:
      "Calendario laboral para calcular días hábiles. Origen: Tu Recibo (panel legacy) más las " +
      "correcciones manuales del módulo.",
    campos: [
      campo("fecha", "fecha"),
      // Escalar, no arreglo: ver la nota en `ausencias.estado`.
      campo("tipo", "texto", "comun", "Tipo de feriado, escalar acotado por el origen."),
      campo("descripcion", "texto"),
      campo("desdeOverride", "booleano"),
    ],
  },
];

export function buscarMaestro(id: string): Maestro | undefined {
  return MAESTROS.find((maestro) => maestro.id === id);
}

export type Dato = string | number | boolean | null;

/**
 * Una fila tal como sale de la base, antes de recortarla a los campos pedidos.
 * `activa` en false es una baja: la fila sigue existiendo (historial completo),
 * pero ya no se publica como vigente.
 */
export type Fila = {
  clave: string;
  activa: boolean;
  actualizada: Date;
  datos: Record<string, Dato>;
  /**
   * La fila existe y sigue activa, pero **ya no entra en la ventana de
   * publicación**. Solo la produce una lectura incremental, y solo para
   * `ausencias`.
   *
   * Es una baja desde el punto de vista del consumidor: dejó de estar en el
   * conjunto publicado. Sin esto, una ausencia que se cae de la ventana por el
   * mero paso del tiempo no aparecía ni en `filas` ni en `bajas`, y quien
   * cachea con `?desde=` la retenía para siempre —bloqueando un día que ya no
   * corresponde, sin forma de enterarse—.
   */
  salioDeVentana?: boolean;
};

export type RespuestaMaestro = {
  maestro: MaestroId;
  version: number;
  actualizado: string;
  filas: Record<string, Dato>[];
  bajas: string[];
};

/**
 * Arma la respuesta publicada.
 *
 * Sin `desde`: todas las filas vigentes. Con `desde`: solo lo que cambió desde
 * entonces, y lo que dejó de estar vigente sale en `bajas` con su clave sola.
 *
 * Que las bajas salgan **solo** con `desde` es intencional: en una lectura
 * completa, la ausencia de la fila ya es la baja, y mandar además la lista de
 * todo lo que alguna vez existió filtraría el historial entero a un consumidor
 * que solo pidió el estado actual.
 */
export function armarRespuesta(args: {
  maestro: Maestro;
  filas: Fila[];
  campos: string[];
  desde: Date | null;
  selloActualizado: Date | null;
  ahora?: Date;
}): RespuestaMaestro {
  const { maestro, campos, desde } = args;
  const salida = [maestro.clave, ...campos.filter((c) => c !== maestro.clave)];

  const filas: Record<string, Dato>[] = [];
  const bajas: string[] = [];
  let ultimoCambio = 0;

  for (const fila of args.filas) {
    ultimoCambio = Math.max(ultimoCambio, fila.actualizada.getTime());

    // La salida de la ventana no se mide por `actualizada`: la fila se cae por
    // el paso del tiempo, sin que nadie la toque. Por eso se evalúa antes del
    // corte incremental, que si no la descartaría por vieja justo cuando hay
    // que avisar que se fue.
    if (fila.salioDeVentana) {
      if (desde) bajas.push(fila.clave);
      continue;
    }

    if (desde && fila.actualizada < desde) continue;
    if (fila.activa) {
      filas.push(Object.fromEntries(salida.map((c) => [c, fila.datos[c] ?? null])));
    } else if (desde) {
      bajas.push(fila.clave);
    }
  }

  // El sello gana sobre el máximo de las filas porque contempla el caso en que
  // la última corrida no cambió nada: el dato es fresco aunque ninguna fila se
  // haya movido, y un consumidor que cachea necesita poder distinguir "no
  // cambió" de "hace días que no sincronizamos".
  const actualizado = args.selloActualizado?.getTime() ?? ultimoCambio;

  return {
    maestro: maestro.id,
    version: maestro.version,
    actualizado: new Date(actualizado || (args.ahora ?? new Date()).getTime()).toISOString(),
    filas,
    bajas,
  };
}
