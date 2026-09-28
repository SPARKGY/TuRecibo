/**
 * Armado del manifiesto.
 *
 * **v1** declaraba solo `maestros`: lo que este módulo necesita **leer** de
 * CENTRIA. **v2** agrega `publica`: lo que este módulo **ofrece**, para que
 * CENTRIA arme su catálogo de conexiones sin que nadie lo cargue a mano.
 *
 * `publica` es **aditivo**. `maestros` no cambió de forma ni de significado, así
 * que un CENTRIA que solo entienda v1 sigue leyendo este documento sin
 * romperse: ve un campo de más y lo ignora.
 *
 * La forma de `publica` sigue el contrato cerrado por CENTRIA
 * (`docs/centria/contrato-maestros.md`): `campos[]` con `tipo` y
 * `sensibilidad`, y `parametros[]` solo para lo que varía entre maestros.
 * `?campos=` y `?desde=` no se declaran porque el contrato los define para todo
 * maestro publicado.
 *
 * La **sensibilidad** que se declara acá es una propuesta. Quien la aprueba
 * campo por campo es el SUPERADMIN en CENTRIA; declararla sirve para que la
 * pantalla de conexiones muestre el semáforo correcto antes de que alguien
 * conecte nada.
 */

import { MAESTROS, type CampoMaestro, type Maestro } from "@/lib/maestros";
import { MAESTROS_QUE_NECESITAMOS } from "@/lib/centria-cliente";
import { CODIGO_MODULO, NOMBRE_MODULO, VERSION_MODULO } from "@/lib/env";

/** Versión del **documento**, no del módulo ni de los maestros. */
export const MANIFIESTO_VERSION = 2;

export type CampoPublicado = CampoMaestro;

export type ParametroPublicado = {
  id: string;
  tipo: "numero";
  min: number;
  max: number;
  default: number;
};

export type MaestroPublicado = {
  id: string;
  nombre: string;
  /** Campo que identifica la fila. Siempre viaja, aunque no se pida. */
  clave: string;
  /** Versión del esquema de la fila. Cambia solo si cambian los campos. */
  version: number;
  descripcion?: string;
  campos: CampoPublicado[];
  /**
   * Parámetros de query configurables por conexión.
   *
   * Se omite entero cuando el maestro no tiene ninguno, en vez de mandar una
   * lista vacía: el contrato lo declara opcional, y un arreglo vacío invitaría
   * a CENTRIA a dibujar una sección de parámetros que no contiene nada.
   */
  parametros?: ParametroPublicado[];
};

function publicar(maestro: Maestro): MaestroPublicado {
  const publicado: MaestroPublicado = {
    id: maestro.id,
    nombre: maestro.nombre,
    clave: maestro.clave,
    version: maestro.version,
    descripcion: maestro.descripcion,
    campos: maestro.campos.map((c) => ({ ...c })),
  };

  if (maestro.parametros?.length) {
    publicado.parametros = maestro.parametros.map((p) => ({ ...p }));
  }

  return publicado;
}

export type Manifiesto = {
  codigo: string;
  nombre: string;
  version: string;
  manifiestoVersion: number;
  /** Ping autenticado. Path confirmado por CENTRIA. */
  salud: string;
  /** Maestros que este módulo necesita LEER de CENTRIA. Presente desde v1. */
  maestros: typeof MAESTROS_QUE_NECESITAMOS;
  /** Maestros que este módulo PUBLICA. Agregado en v2. */
  publica: MaestroPublicado[];
};

export function armarManifiesto(): Manifiesto {
  return {
    codigo: CODIGO_MODULO,
    nombre: NOMBRE_MODULO,
    version: VERSION_MODULO,
    manifiestoVersion: MANIFIESTO_VERSION,
    // Se declara la ruta aunque el contrato ya la fije: quien lee el manifiesto
    // no tiene que cruzarlo contra un documento aparte para saber dónde pingear.
    salud: "/centria/salud",
    maestros: MAESTROS_QUE_NECESITAMOS,
    publica: MAESTROS.map(publicar),
  };
}
