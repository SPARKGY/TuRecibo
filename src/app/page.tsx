import { MAESTROS } from "@/lib/maestros";
import { CODIGO_MODULO, NOMBRE_MODULO, VERSION_MODULO } from "@/lib/env";

/**
 * Página de cortesía. El módulo es casi todo backend: su trabajo real es
 * extraer de Tu Recibo y publicar maestros. Esta pantalla existe para que quien
 * entre por `/m/<codigo>` vea qué publica y no una pantalla en blanco.
 *
 * No muestra datos: cualquier cifra acá tendría que resolver tenant e identidad,
 * y eso ya lo hacen las rutas con la identidad del proxy.
 */
export default function Home() {
  return (
    <main style={{ maxWidth: "46rem" }}>
      <h1 style={{ marginBottom: "0.25rem" }}>{NOMBRE_MODULO}</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        <code>{CODIGO_MODULO}</code> · v{VERSION_MODULO}
      </p>

      <p>
        Este módulo es el único que habla con Tu Recibo. Guarda el historial completo en su propia base y publica los
        maestros de abajo por el enchufe de CENTRIA. Los consumidores los leen desde ahí, nunca desde el proveedor.
      </p>

      <h2>Maestros publicados</h2>
      <ul>
        {MAESTROS.map((m) => (
          <li key={m.id}>
            <strong>{m.id}</strong> — {m.campos.length} campos, clave <code>{m.clave}</code>
          </li>
        ))}
      </ul>

      <p style={{ color: "#555" }}>
        Para conectarlos, se habilita la conexión por campo y fila desde CENTRIA. Este módulo no otorga acceso por su
        cuenta.
      </p>
    </main>
  );
}
