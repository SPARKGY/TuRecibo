import { describe, it, expect } from "vitest";
import { alcanzaLaVentana, filtroDeVentana, iso, type FechasAusencia } from "@/lib/maestros-lectura";
import { parseFechaTuRecibo, parseFechaISO } from "@/lib/turecibo/normalizar";

const dia = (texto: string | null): Date | null => (texto ? new Date(`${texto}T00:00:00.000Z`) : null);

const CORTE = new Date("2025-03-01T00:00:00.000Z");

const caso = (desde: string | null, hasta: string | null, regreso: string | null): FechasAusencia => ({
  desde: dia(desde),
  hasta: dia(hasta),
  regreso: dia(regreso),
});

/**
 * Evaluador del `OR` que se le manda a Prisma.
 *
 * Existe para que la prueba no verifique la *forma* del filtro —que no dice
 * nada— sino lo que ese filtro **decide**. Si alguien toca el `where` y deja de
 * coincidir con `alcanzaLaVentana`, la comparación de abajo lo marca.
 */
function evaluarFiltro(fechas: FechasAusencia, corte: Date): boolean {
  const cumple = (rama: Record<string, unknown>): boolean =>
    Object.entries(rama).every(([campo, condicion]) => {
      const valor = fechas[campo as keyof FechasAusencia];
      if (condicion === null) return valor === null;
      const minimo = (condicion as { gte: Date }).gte;
      return valor !== null && valor >= minimo;
    });

  return filtroDeVentana(corte).some((rama) => cumple(rama as Record<string, unknown>));
}

describe("ventana de publicación de ausencias", () => {
  it("mira el fin, no el inicio: una licencia larga y vigente no se cae del feed", () => {
    // El caso que la ventana existe para no romper: empezó mucho antes del
    // corte y todavía no terminó.
    expect(alcanzaLaVentana(caso("2024-12-01", "2025-04-10", null), CORTE)).toBe(true);
  });

  it("deja fuera lo que terminó antes del corte", () => {
    expect(alcanzaLaVentana(caso("2024-11-01", "2024-11-05", null), CORTE)).toBe(false);
  });

  it("sin `hasta`, usa `regreso` como fin en vez de caer a `desde`", () => {
    // Acá estaba el agujero: filtrar por `desde` descartaba una ausencia que
    // empezó antes del corte aunque su fin conocido cae dentro de la ventana.
    expect(alcanzaLaVentana(caso("2024-12-01", null, "2025-03-20"), CORTE)).toBe(true);
  });

  it("sin `hasta`, un `regreso` viejo sí queda fuera", () => {
    expect(alcanzaLaVentana(caso("2024-10-01", null, "2024-10-05"), CORTE)).toBe(false);
  });

  it("sin `hasta` ni `regreso`, publica siempre aunque haya empezado hace mucho", () => {
    // El origen no afirmó ningún fin, así que la ausencia no se puede dar por
    // terminada. Excluirla haría que el consumidor deje de bloquear a alguien
    // que quizá sigue de licencia, y esa falla no avisa.
    expect(alcanzaLaVentana(caso("2023-01-01", null, null), CORTE)).toBe(true);
  });

  it("una fila sin ninguna fecha se publica en vez de desaparecer", () => {
    expect(alcanzaLaVentana(caso(null, null, null), CORTE)).toBe(true);
  });

  it("el borde del corte entra", () => {
    expect(alcanzaLaVentana(caso("2025-02-20", "2025-03-01", null), CORTE)).toBe(true);
  });

  it("una ausencia que empezó dentro de la ventana se publica aunque su fin declarado sea incoherente", () => {
    // `regreso` anterior a `desde` es un dato roto que el origen puede mandar:
    // cada fecha se parsea por separado y nadie valida la relación. Sin la red
    // de seguridad por `desde`, esta fila se caía del feed y el consumidor
    // dejaba de bloquear a alguien recién ausentado.
    expect(alcanzaLaVentana(caso("2025-03-10", null, "2020-01-01"), CORTE)).toBe(true);
  });

  it("la red por `desde` no rescata a una ausencia vieja y ya terminada", () => {
    // La red es aditiva, no un comodín: si empezó y terminó antes del corte,
    // sigue afuera.
    expect(alcanzaLaVentana(caso("2024-01-01", "2024-01-10", null), CORTE)).toBe(false);
  });

  it("el filtro que se le manda a Prisma decide igual que la especificación", () => {
    // La regla vive en dos lados por necesidad: uno es legible y el otro es
    // ejecutable por la base. Esta prueba es lo que impide que se separen.
    const fechas = [null, "2023-01-01", "2024-12-01", "2025-02-25", "2025-03-01", "2025-06-01"];

    let comparados = 0;
    for (const desde of fechas) {
      for (const hasta of fechas) {
        for (const regreso of fechas) {
          const fila = caso(desde, hasta, regreso);
          expect(evaluarFiltro(fila, CORTE), `desde=${desde} hasta=${hasta} regreso=${regreso}`).toBe(
            alcanzaLaVentana(fila, CORTE),
          );
          comparados += 1;
        }
      }
    }

    expect(comparados).toBe(fechas.length ** 3);
  });
});

describe("el día publicado sobrevive el ida y vuelta", () => {
  // CENTRIA marcó que `iso()` corta en UTC y que eso solo es correcto si lo
  // guardado es medianoche UTC. Lo es, porque los dos parsers construyen con
  // `Date.UTC` explícito. Esta prueba ata las dos puntas para que siga siendo
  // cierto: si alguien cambia un parser a hora local, el día se corre y acá se
  // ve, en vez de aparecer como un feriado desfasado en la pantalla de alguien.
  it("una fecha DD/MM/YYYY vuelve como el mismo día", () => {
    expect(iso(parseFechaTuRecibo("05/03/2025"))).toBe("2025-03-05");
    expect(iso(parseFechaTuRecibo("01/01/2025"))).toBe("2025-01-01");
    expect(iso(parseFechaTuRecibo("31/12/2025"))).toBe("2025-12-31");
  });

  it("una fecha YYYY-MM-DD del panel de feriados vuelve como el mismo día", () => {
    expect(iso(parseFechaISO("2025-12-25"))).toBe("2025-12-25");
    expect(iso(parseFechaISO("2025-01-01"))).toBe("2025-01-01");
  });

  it("un nulo sigue siendo nulo en vez de convertirse en una fecha inventada", () => {
    expect(iso(null)).toBeNull();
  });
});
