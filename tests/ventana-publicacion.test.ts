import { describe, it, expect } from "vitest";
import { alcanzaLaVentana, corteDeVentana, cortesDeLectura, filtroDeVentana, iso, type FechasAusencia } from "@/lib/maestros-lectura";
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

  it("`regreso` igual a `desde` tampoco es un fin: sería una ausencia de cero días", () => {
    // El borde lo marcaron CENTRIA y Timesheet como inocuo. No lo es, y el
    // motivo está del lado del consumidor: Timesheet trata `regreso <= desde`
    // como incoherente y cubre el día de inicio. Si acá contara como fin
    // válido, esta fila no se publicaría y el consumidor perdería un día que
    // sí habría bloqueado. La coherencia tiene que partirse en el mismo lugar
    // en las dos puntas.
    expect(alcanzaLaVentana(caso("2024-01-15", null, "2024-01-15"), CORTE)).toBe(true);
  });

  it("un día de ausencia real sí es un fin válido", () => {
    // El límite del cambio anterior: `regreso` un día después de `desde` es la
    // ausencia más corta posible, y es coherente. Si esta prueba pasara a
    // `true`, la comparación estricta se habría vuelto un comodín que publica
    // toda ausencia terminada.
    expect(alcanzaLaVentana(caso("2024-01-15", null, "2024-01-16"), CORTE)).toBe(false);
  });

  it("un `regreso` anterior a `desde` no cuenta como fin, ni siquiera fuera de la ventana", () => {
    // El caso que reportó Timesheet: `desde` viejo (fuera de ventana) con un
    // `regreso` incoherente. Tratar ese valor roto como fin sacaba la fila del
    // feed, y una fila ausente en una respuesta completa es indistinguible de
    // "no hubo ausencia". Al descartarlo, cae en "sin fin afirmado" y se
    // publica.
    expect(alcanzaLaVentana(caso("2024-01-15", null, "2020-01-01"), CORTE)).toBe(true);
  });

  it("un `regreso` coherente sí acota, aunque `desde` sea viejo", () => {
    // El complemento del anterior: descartar la incoherencia no puede volverse
    // un comodín que publique todo lo que no tiene `hasta`.
    expect(alcanzaLaVentana(caso("2024-01-15", null, "2024-02-01"), CORTE)).toBe(false);
  });

  it("sin `desde`, un `regreso` viejo se toma como fin: no hay contra qué compararlo", () => {
    expect(alcanzaLaVentana(caso(null, null, "2024-01-01"), CORTE)).toBe(false);
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

  it("el filtro que se le manda a Prisma nunca descarta una fila que la regla publica", () => {
    // La relación correcta es **superconjunto**, no igualdad: el `where` es una
    // pre-poda y `alcanzaLaVentana` es la autoridad que se aplica después, en
    // memoria. Lo que no puede pasar nunca es que la base descarte una fila que
    // la regla habría publicado, porque esa fila ya no llega a evaluarse y
    // desaparece en silencio.
    const fechas = [null, "2020-01-01", "2024-01-15", "2024-12-01", "2025-02-25", "2025-03-01", "2025-06-01"];

    let publicadas = 0;
    let traidasDeMas = 0;
    for (const desde of fechas) {
      for (const hasta of fechas) {
        for (const regreso of fechas) {
          const fila = caso(desde, hasta, regreso);
          const publica = alcanzaLaVentana(fila, CORTE);
          const trae = evaluarFiltro(fila, CORTE);

          if (publica) {
            expect(trae, `descartada por la base: desde=${desde} hasta=${hasta} regreso=${regreso}`).toBe(true);
            publicadas += 1;
          } else if (trae) {
            traidasDeMas += 1;
          }
        }
      }
    }

    // Que efectivamente haya casos de las dos clases: si no, la prueba pasaría
    // por vacuidad y no estaría comparando nada.
    expect(publicadas).toBeGreaterThan(0);
    expect(traidasDeMas).toBeGreaterThan(0);
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

/**
 * La detección de salidas compara la ventana en dos momentos: dónde estaba el
 * corte cuando el consumidor sincronizó y dónde está ahora. Lo que estaba
 * adentro entonces y no ahora es exactamente lo que hay que informar de baja.
 */

/**
 * La detección de salidas compara la ventana en dos momentos: dónde estaba el
 * corte cuando el consumidor sincronizó y dónde está ahora. Lo que estaba
 * adentro entonces y no ahora es exactamente lo que hay que informar de baja.
 */
describe("cortes de una lectura incremental", () => {
  const AHORA = new Date("2025-03-31T00:00:00.000Z");
  const VENTANA = 30;

  it("el corte retrocede la ventana desde el instante dado", () => {
    expect(corteDeVentana(AHORA, VENTANA).toISOString()).toBe("2025-03-01T00:00:00.000Z");
  });

  it("sin desde los tres cortes coinciden: no hay 'antes'", () => {
    const c = cortesDeLectura(AHORA, null, VENTANA);
    expect(c.anterior.getTime()).toBe(c.corte.getTime());
    expect(c.lectura.getTime()).toBe(c.corte.getTime());
  });

  // El que mata el bug: si la base se consultara con el corte de ahora, las
  // filas que salieron de la ventana no se leerían y la baja sería imposible
  // de emitir.
  it("la lectura usa el corte viejo, no el de ahora", () => {
    const c = cortesDeLectura(AHORA, new Date("2025-03-10T00:00:00.000Z"), VENTANA);
    expect(c.lectura.toISOString()).toBe("2025-02-08T00:00:00.000Z");
    expect(c.lectura.getTime()).toBeLessThan(c.corte.getTime());

    // Terminó el 15 de febrero: la pre-poda tiene que traerla, y la autoridad
    // en memoria la deja fuera de la publicación actual.
    const f = caso("2025-02-10", "2025-02-15", null);
    expect(evaluarFiltro(f, c.lectura)).toBe(true);
    expect(evaluarFiltro(f, c.corte)).toBe(false);
    expect(alcanzaLaVentana(f, c.anterior)).toBe(true);
    expect(alcanzaLaVentana(f, c.corte)).toBe(false);
  });

  it("no marca como salida lo que sigue adentro", () => {
    const c = cortesDeLectura(AHORA, new Date("2025-03-10T00:00:00.000Z"), VENTANA);
    const f = caso("2025-03-20", "2025-03-25", null);
    expect(alcanzaLaVentana(f, c.anterior)).toBe(true);
    expect(alcanzaLaVentana(f, c.corte)).toBe(true);
  });

  // Un desde en el futuro dejaría el corte anterior por delante del actual.
  // El conjunto de salidas queda vacío solo, sin caso especial, porque la
  // lectura nunca se angosta respecto de la ventana de ahora.
  it("un desde futuro no angosta la lectura", () => {
    const c = cortesDeLectura(AHORA, new Date("2025-06-01T00:00:00.000Z"), VENTANA);
    expect(c.lectura.getTime()).toBe(c.corte.getTime());
    expect(c.anterior.getTime()).toBeGreaterThan(c.corte.getTime());
  });
});