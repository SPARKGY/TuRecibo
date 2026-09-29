import { headers } from "next/headers";
import { MAESTROS } from "@/lib/maestros";
import { CODIGO_MODULO, NOMBRE_MODULO, VERSION_MODULO } from "@/lib/env";
import { autenticarUsuario, type Identidad } from "@/lib/centria-auth";
import {
  ESTADOS,
  FUENTES_REFRESCO,
  formatearDuracion,
  formatearFechaHora,
  formatearRelativo,
  leerEstadoRefresco,
  recortarError,
  type CorridaResumen,
  type EstadoFuente,
} from "@/lib/refresco";
import { ESTILOS } from "./estilos";

/**
 * Página de inicio del módulo, servida por el proxy de CENTRIA en `/m/<codigo>`.
 *
 * El módulo es casi todo backend: extrae de Tu Recibo y publica maestros. Esta
 * pantalla muestra qué publica y, sobre todo, **cuándo fue el último refresco
 * de la base por fuente** (feriados, ausencias, tipos de licencia): la última
 * corrida con su estado y conteos, y la última OK si la última no lo fue.
 *
 * El tenant sale de la identidad que reconstruye el proxy, validada con el
 * token de entrada igual que en las rutas (`autenticarUsuario`). Sin identidad
 * válida la página se muestra igual, sin datos y con un aviso. Si la base no
 * responde, cada fuente dice "sin datos" en vez de tirar un 500: esta es la
 * pantalla adonde se entra justamente cuando algo está roto.
 *
 * El texto del error de una corrida solo lo ve un ADMIN del módulo: puede traer
 * detalle del proveedor que no tiene por qué leer cualquier usuario.
 */
export const dynamic = "force-dynamic";

type Contexto =
  | { tipo: "sin-identidad" }
  | { tipo: "ok"; identidad: Identidad; fuentes: EstadoFuente[] }
  | { tipo: "sin-base"; identidad: Identidad };

async function resolverContexto(): Promise<Contexto> {
  const req = new Request("http://modulo.local/", { headers: new Headers(Array.from(headers().entries())) });
  const auth = autenticarUsuario(req);
  if (!auth.ok) return { tipo: "sin-identidad" };

  try {
    return { tipo: "ok", identidad: auth.datos, fuentes: await leerEstadoRefresco(auth.datos.tenantId) };
  } catch (error) {
    console.error("inicio: no se pudo leer el estado de refresco", error instanceof Error ? error.message : error);
    return { tipo: "sin-base", identidad: auth.datos };
  }
}

function Badge({ corrida }: { corrida: CorridaResumen }) {
  const e = ESTADOS[corrida.estado];
  return <span className={`badge ${e.tono}`}>{e.texto}</span>;
}

function Cuando({ fecha, ahora }: { fecha: Date; ahora: Date }) {
  return (
    <span className="cuando">
      <span className="fecha">{formatearFechaHora(fecha)}</span>
      <span className="rel">{formatearRelativo(fecha, ahora)}</span>
    </span>
  );
}

const CONTEOS = [
  ["leidas", "Leídas"],
  ["altas", "Altas"],
  ["cambios", "Cambios"],
  ["bajas", "Bajas"],
  ["descartadas", "Descartadas"],
] as const;

const numero = (n: number) => n.toLocaleString("es-AR");

function Conteos({ corrida }: { corrida: CorridaResumen }) {
  return (
    <table className="conteos">
      <thead>
        <tr>
          {CONTEOS.map(([k, t]) => (
            <th key={k}>{t}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          {CONTEOS.map(([k]) => {
            const n = corrida[k];
            const clase = n === 0 ? "cero" : k === "descartadas" ? "alerta" : undefined;
            return (
              <td key={k} className={clase}>
                {numero(n)}
              </td>
            );
          })}
        </tr>
      </tbody>
    </table>
  );
}

function CabeceraTarjeta({ nombre, fuente, children }: { nombre: string; fuente: string; children: React.ReactNode }) {
  return (
    <div className="tarjeta-cab">
      <span className="tarjeta-nom">{nombre}</span>
      <code className="suave">{fuente}</code>
      {children}
    </div>
  );
}

function UltimaOk({ f, ahora }: { f: EstadoFuente; ahora: Date }) {
  if (f.ultimaOk) {
    return (
      <div className="ultima-ok">
        <span className="rot">Última OK</span>
        <Cuando fecha={f.ultimaOk.iniciadaEn} ahora={ahora} />
        <span className="suave">
          {numero(f.ultimaOk.leidas)} leídas{f.ultimaOk.manual ? " · manual" : ""}
        </span>
      </div>
    );
  }
  if (!f.consultaOk) return null;
  return <div className="ultima-ok nunca">No hay ninguna corrida OK registrada.</div>;
}

function TarjetaFuente({ f, ahora, esAdmin }: { f: EstadoFuente; ahora: Date; esAdmin: boolean }) {
  const u = f.ultima;
  const duracion = u ? formatearDuracion(u.iniciadaEn, u.terminadaEn) : null;

  return (
    <article className="tarjeta" aria-label={f.nombre}>
      <CabeceraTarjeta nombre={f.nombre} fuente={f.fuente}>
        {u ? <Badge corrida={u} /> : <span className="badge neutro">Sin datos</span>}
      </CabeceraTarjeta>

      <div className="tarjeta-cuerpo">
        {u ? (
          <>
            <Cuando fecha={u.iniciadaEn} ahora={ahora} />
            <div className="datos">
              <span>
                <span className="rot">Disparo</span>
                {u.manual ? "Manual" : "Programado"}
              </span>
              {duracion ? (
                <span>
                  <span className="rot">Duración</span>
                  {duracion}
                </span>
              ) : null}
            </div>
            <Conteos corrida={u} />
            {u.error ? (
              esAdmin ? (
                <pre className="error">{recortarError(u.error)}</pre>
              ) : (
                <p className="error">El detalle del error lo ve un administrador del módulo.</p>
              )
            ) : null}
            {u.estado !== "OK" ? <UltimaOk f={f} ahora={ahora} /> : null}
          </>
        ) : (
          <p className="vacia">
            {f.consultaOk ? "Todavía no hay corridas registradas para esta fuente." : "Sin datos: no se pudo consultar la base."}
          </p>
        )}
      </div>

      <div className="tarjeta-pie">
        <span>
          <span className="rot">Filas activas</span>
          {f.activas == null ? "—" : numero(f.activas)}
        </span>
        <span>
          <span className="rot">Sello</span>
          {f.sello ? `rev. ${f.sello.revision} · ${formatearFechaHora(f.sello.actualizadoEn)}` : "—"}
        </span>
        <span>
          <span className="rot">Maestro</span>
          <code>{f.maestro}</code>
        </span>
      </div>
    </article>
  );
}

export default async function Home() {
  const ctx = await resolverContexto();
  const ahora = new Date();
  const identidad = ctx.tipo === "sin-identidad" ? null : ctx.identidad;

  return (
    <div className="ch">
      <style dangerouslySetInnerHTML={{ __html: ESTILOS }} />

      <main className="hoja">
        <div className="titulo-caja">
          <span className="titulo-nom">{NOMBRE_MODULO}</span>
          <span className="titulo-sub">
            <code>{CODIGO_MODULO}</code> · v{VERSION_MODULO}
          </span>
          {identidad ? (
            <span className="quien">
              {identidad.nombre ?? identidad.email ?? identidad.usuarioId}
              <span className="badge banda">{identidad.rol}</span>
            </span>
          ) : null}
        </div>

        <p className="intro">
          Este módulo es el único que habla con Tu Recibo. Guarda el historial completo en su propia base y publica los
          maestros de abajo por el enchufe de CENTRIA. Los consumidores los leen desde ahí, nunca desde el proveedor.
        </p>

        {ctx.tipo === "sin-identidad" ? (
          <div className="aviso" role="status">
            <strong>Sin datos del tenant.</strong> No llegó una identidad válida desde el proxy de CENTRIA, así que no se
            puede mostrar el estado de la base. Entrá al módulo desde CENTRIA.
          </div>
        ) : null}
        {ctx.tipo === "sin-base" ? (
          <div className="aviso" role="status">
            <strong>Sin datos.</strong> No se pudo consultar la base del módulo.
          </div>
        ) : null}

        <div className="seccion">
          Último refresco
          <span className="suave">Hora de Buenos Aires · consultado {formatearFechaHora(ahora)}</span>
        </div>

        <div className="tarjetas">
          {ctx.tipo === "ok"
            ? ctx.fuentes.map((f) => (
                <TarjetaFuente key={f.fuente} f={f} ahora={ahora} esAdmin={ctx.identidad.rol === "ADMIN"} />
              ))
            : FUENTES_REFRESCO.map((f) => (
                <article key={f.fuente} className="tarjeta" aria-label={f.nombre}>
                  <CabeceraTarjeta nombre={f.nombre} fuente={f.fuente}>
                    <span className="badge neutro">Sin datos</span>
                  </CabeceraTarjeta>
                  <div className="tarjeta-cuerpo">
                    <p className="vacia">
                      {ctx.tipo === "sin-base" ? "No se pudo consultar la base." : "Requiere entrar desde CENTRIA."}
                    </p>
                  </div>
                </article>
              ))}
        </div>

        <div className="seccion">Maestros publicados</div>
        <div className="scroll">
          <table className="maestros">
            <thead>
              <tr>
                <th>Maestro</th>
                <th>Nombre</th>
                <th className="num">Campos</th>
                <th>Clave</th>
                <th className="num">Versión</th>
              </tr>
            </thead>
            <tbody>
              {MAESTROS.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.id}</strong>
                  </td>
                  <td>{m.nombre}</td>
                  <td className="num">{m.campos.length}</td>
                  <td>
                    <code>{m.clave}</code>
                  </td>
                  <td className="num">{m.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="pie">
          Para conectarlos, se habilita la conexión por campo y fila desde CENTRIA. Este módulo no otorga acceso por su
          cuenta.
        </p>
      </main>
    </div>
  );
}
