/**
 * Validación de secretos compartidos, con rotación.
 *
 * El enchufe de CENTRIA no usa JWT ni HMAC: son secretos opacos. Eso hace que
 * dos cosas sean críticas y fáciles de arruinar:
 *
 * 1. **Comparar en tiempo constante.** Un `===` sobre strings corta en el primer
 *    byte distinto y filtra el prefijo del secreto a quien mida.
 * 2. **Fallar cerrado.** Una variable vacía o con una referencia a Key Vault sin
 *    resolver cuenta como NO configurada. Sin esto, un App Setting en `""`
 *    dejaría pasar un header vacío, que es exactamente lo que manda quien no
 *    tiene el secreto.
 *
 * La rotación se hace con `<VAR>_PREVIO`: durante la ventana de cambio valen los
 * dos, y el uso del anterior se registra para saber cuándo se puede retirar.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { esReferenciaSinResolver } from "@/lib/env";

export type ResultadoAuth =
  | { ok: true; usóPrevio: boolean }
  | { ok: false; status: 401 | 403 | 500; mensaje: string };

type Aceptado = { valor: string; origen: "actual" | "previo" };

function aceptados(nombre: string): Aceptado[] {
  const lista: Aceptado[] = [];
  const actual = process.env[nombre]?.trim() ?? "";
  const previo = process.env[`${nombre}_PREVIO`]?.trim() ?? "";
  if (actual && !esReferenciaSinResolver(actual)) lista.push({ valor: actual, origen: "actual" });
  if (previo && !esReferenciaSinResolver(previo)) lista.push({ valor: previo, origen: "previo" });
  return lista;
}

function iguales(recibido: string, esperado: string): boolean {
  // El hash iguala las longitudes antes de comparar. Sin esto, `timingSafeEqual`
  // tira si los largos difieren, y ese throw sería en sí mismo un oráculo de
  // longitud del secreto.
  const a = createHash("sha256").update(recibido, "utf8").digest();
  const b = createHash("sha256").update(esperado, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Compara el valor recibido contra el actual y el previo.
 *
 * Recorre la lista **entera** aunque ya haya acertado: cortar en el primer
 * acierto haría que validar contra el previo tarde distinto que validar contra
 * el actual.
 */
export function validarSecreto(nombre: string, recibido: string | null): ResultadoAuth {
  const lista = aceptados(nombre);
  if (lista.length === 0) {
    return { ok: false, status: 500, mensaje: `${nombre} no está configurada` };
  }
  if (!recibido) {
    return { ok: false, status: 401, mensaje: "Falta el token" };
  }

  let acierto: Aceptado | null = null;
  for (const candidato of lista) {
    if (iguales(recibido, candidato.valor)) acierto = candidato;
  }
  if (!acierto) return { ok: false, status: 403, mensaje: "Forbidden" };

  return { ok: true, usóPrevio: acierto.origen === "previo" };
}

/**
 * Deja constancia de que alguien todavía usa el secreto anterior. Es el único
 * dato que dice si la rotación se puede terminar de cerrar.
 */
export function registrarUsoDelPrevio(nombre: string, usóPrevio: boolean): void {
  if (!usóPrevio) return;
  console.warn(`[rotacion] Se aceptó ${nombre}_PREVIO. Todavía hay un llamador con el secreto viejo.`);
}
