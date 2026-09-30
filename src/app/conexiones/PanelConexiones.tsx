"use client";

/**
 * Tarjetas de conexión a Tu Recibo (API de licencias y panel de feriados).
 *
 * Solo para ADMIN del módulo: las rutas `/api/conexiones*` devuelven 403 a
 * cualquier otro rol y la tarjeta lo dice en vez de romper. Nunca muestra
 * valores de secreto: lo que viene del servidor ya está enmascarado, y lo que
 * se tipea en el formulario se descarta al guardar.
 *
 * Usa las clases de la estética del módulo (`seccion`, `tarjetas`, `badge`…)
 * con estilos inline mínimos de respaldo, para verse bien con o sin ellas.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

type Fuente = "LICENCIAS_API" | "FERIADOS_PANEL";
type Modo = "USUARIO_PASSWORD" | "SESION" | "TOKEN";
type Resultado = "OK" | "FALLIDA" | "PENDIENTE_ROBOT";

type Campo = { campo: string; origen: "keyvault" | "env" | "ausente"; referencia: string | null; valor: string | null };

type Vista = {
  fuente: Fuente;
  configurada: boolean;
  origen: "conexion" | "legado" | "ninguno";
  modo: Modo | null;
  modosDisponibles: Modo[];
  parametros: Record<string, unknown>;
  campos: Campo[];
  activa: boolean;
  rotadaEn: string | null;
  rotadaPor: string | null;
  validadaEn: string | null;
  ultimoResultadoValidacion: Resultado | null;
  ultimoDetalleValidacion: string | null;
};

type Prueba = { resultado: Resultado; detalle: string };

const TITULOS: Record<Fuente, string> = {
  LICENCIAS_API: "API de licencias",
  FERIADOS_PANEL: "Panel de feriados (robot)",
};

const MODOS: Record<Modo, string> = {
  USUARIO_PASSWORD: "Usuario y contraseña",
  SESION: "Sesión del panel (cookie)",
  TOKEN: "Token (bearer)",
};

const CAMPOS: Record<Modo, { id: string; etiqueta: string; tipo: "text" | "password" }[]> = {
  USUARIO_PASSWORD: [
    { id: "usuario", etiqueta: "Usuario", tipo: "text" },
    { id: "password", etiqueta: "Contraseña", tipo: "password" },
  ],
  SESION: [{ id: "sesion", etiqueta: "Valor de la cookie de sesión", tipo: "password" }],
  TOKEN: [{ id: "token", etiqueta: "Token", tipo: "password" }],
};

const ESTADO: Record<Resultado, { clase: string; texto: string; color: string }> = {
  OK: { clase: "ok", texto: "Validada", color: "#1b7f3b" },
  FALLIDA: { clase: "mal", texto: "Falló", color: "#b3261e" },
  PENDIENTE_ROBOT: { clase: "medio", texto: "Pendiente de validar por robot", color: "#9a6700" },
};

const estiloTarjeta: React.CSSProperties = {
  border: "1px solid #d0d0d0",
  borderRadius: 6,
  background: "#fff",
  padding: "0.75rem 1rem",
  marginBottom: "0.75rem",
};
const estiloEntrada: React.CSSProperties = { display: "block", width: "100%", maxWidth: "24rem", marginTop: 2 };

function fecha(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("es-AR") : "—";
}

function Badge({ resultado }: { resultado: Resultado | null }) {
  if (!resultado) return <span className="badge neutro">Sin validar</span>;
  const e = ESTADO[resultado];
  return (
    <span className={`badge ${e.clase}`} style={{ color: e.color, fontWeight: 600 }}>
      {e.texto}
    </span>
  );
}

function useBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    // La página vive en la raíz del módulo, así que su ruta es el prefijo del
    // proxy de CENTRIA (`/m/<codigo>`), o vacío si se entra directo.
    setBase(window.location.pathname.replace(/\/+$/, ""));
  }, []);
  return base;
}

export default function PanelConexiones() {
  const base = useBase();
  const [vistas, setVistas] = useState<Vista[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (base === null) return;
    setError(null);
    try {
      const res = await fetch(`${base}/api/conexiones`, { cache: "no-store" });
      const cuerpo = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 403 ? "Solo los administradores del módulo ven las conexiones." : cuerpo.error ?? `HTTP ${res.status}`);
        return;
      }
      setVistas(cuerpo.conexiones as Vista[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div className="seccion" style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: "0.5rem" }}>
        Conexiones
      </div>
      {error && (
        <p className="aviso suave" style={{ color: "#555" }}>
          {error}
        </p>
      )}
      {!error && !vistas && <p className="suave">Cargando…</p>}
      {vistas && (
        <div className="tarjetas">
          {vistas.map((v) => (
            <TarjetaConexion key={v.fuente} vista={v} base={base ?? ""} alCambiar={cargar} />
          ))}
        </div>
      )}
    </section>
  );
}

function TarjetaConexion({ vista, base, alCambiar }: { vista: Vista; base: string; alCambiar: () => Promise<void> }) {
  const [editando, setEditando] = useState(false);
  const [probando, setProbando] = useState(false);
  const [prueba, setPrueba] = useState<Prueba | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function probarVigente() {
    setProbando(true);
    setError(null);
    setPrueba(null);
    try {
      const res = await fetch(`${base}/api/conexiones/probar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fuente: vista.fuente }),
      });
      const cuerpo = await res.json().catch(() => ({}));
      if (!res.ok) setError(cuerpo.error ?? `HTTP ${res.status}`);
      else setPrueba(cuerpo.prueba);
      await alCambiar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo probar la conexión.");
    } finally {
      setProbando(false);
    }
  }

  return (
    <div className="tarjeta" style={estiloTarjeta}>
      <div className="tarjeta-cab" style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <strong>{TITULOS[vista.fuente]}</strong>
        <Badge resultado={vista.ultimoResultadoValidacion} />
      </div>
      <div className="tarjeta-cuerpo">
        {!vista.configurada ? (
          <p className="suave">Sin configurar.</p>
        ) : (
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.15rem 0.75rem", margin: "0.5rem 0" }}>
            <dt className="suave">Modo</dt>
            <dd style={{ margin: 0 }}>
              {vista.modo ? MODOS[vista.modo] : "—"}
              {vista.origen === "legado" && <span className="suave"> · configuración heredada (variables de entorno)</span>}
              {!vista.activa && <span className="badge mal"> · desactivada</span>}
            </dd>
            {Object.entries(vista.parametros).map(([k, v]) => (
              <FilaParametro key={k} nombre={k} valor={v} />
            ))}
            {vista.campos.map((c) => (
              <FilaCampo key={c.campo} campo={c} />
            ))}
            <dt className="suave">Última rotación</dt>
            <dd style={{ margin: 0 }}>
              {fecha(vista.rotadaEn)}
              {vista.rotadaPor && <span className="suave"> · {vista.rotadaPor}</span>}
            </dd>
            <dt className="suave">Última validación</dt>
            <dd style={{ margin: 0 }}>
              {fecha(vista.validadaEn)}
              {vista.ultimoDetalleValidacion && <div className="suave">{vista.ultimoDetalleValidacion}</div>}
            </dd>
          </dl>
        )}

        {prueba && (
          <p style={{ color: ESTADO[prueba.resultado].color }}>
            Prueba: {ESTADO[prueba.resultado].texto}. {prueba.detalle}
          </p>
        )}
        {error && <p style={{ color: "#b3261e" }}>{error}</p>}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button type="button" onClick={() => setEditando((e) => !e)}>
            {editando ? "Cancelar" : "Cambiar credenciales"}
          </button>
          <button type="button" onClick={probarVigente} disabled={!vista.configurada || probando}>
            {probando ? "Probando…" : "Probar conexión"}
          </button>
        </div>

        {editando && (
          <FormularioConexion
            vista={vista}
            base={base}
            alGuardar={async () => {
              setEditando(false);
              await alCambiar();
            }}
          />
        )}
      </div>
    </div>
  );
}

function FilaParametro({ nombre, valor }: { nombre: string; valor: unknown }) {
  return (
    <>
      <dt className="suave">{nombre}</dt>
      <dd style={{ margin: 0 }}>
        <code>{Array.isArray(valor) ? valor.join(", ") : String(valor)}</code>
      </dd>
    </>
  );
}

function FilaCampo({ campo }: { campo: Campo }) {
  const origen =
    campo.origen === "keyvault" ? "Key Vault" : campo.origen === "env" ? "variable de entorno" : "sin referencia";
  return (
    <>
      <dt className="suave">{campo.campo}</dt>
      <dd style={{ margin: 0 }}>
        {campo.valor ?? <span style={{ color: "#b3261e" }}>no configurado</span>}{" "}
        <span className="suave">
          ({origen}
          {campo.referencia ? `: ${campo.referencia}` : ""})
        </span>
      </dd>
    </>
  );
}

function FormularioConexion({ vista, base, alGuardar }: { vista: Vista; base: string; alGuardar: () => Promise<void> }) {
  const [modo, setModo] = useState<Modo>(vista.modo ?? vista.modosDisponibles[0]!);
  const [parametros, setParametros] = useState<Record<string, string>>(() => {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(vista.parametros)) p[k] = Array.isArray(v) ? v.join(",") : String(v ?? "");
    return p;
  });
  const [secretos, setSecretos] = useState<Record<string, string>>({});
  const [forzar, setForzar] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [prueba, setPrueba] = useState<Prueba | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nombresParametros = vista.fuente === "LICENCIAS_API" ? ["baseUrl"] : ["adminUrl", "anios", "nombreCookieSesion"];
  const cambiaModo = modo !== vista.modo;

  const cuerpo = useMemo(() => {
    const p: Record<string, unknown> = {};
    for (const n of nombresParametros) {
      const v = (parametros[n] ?? "").trim();
      if (!v) continue;
      p[n] = n === "anios" ? v.split(",").map((a) => Number(a.trim())).filter((a) => Number.isInteger(a)) : v;
    }
    const s: Record<string, string> = {};
    for (const c of CAMPOS[modo]) if (secretos[c.id]?.trim()) s[c.id] = secretos[c.id]!;
    return { fuente: vista.fuente, modo, parametros: p, secretos: s, forzar };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista.fuente, modo, parametros, secretos, forzar]);

  async function enviar(accion: "probar" | "guardar") {
    setOcupado(true);
    setError(null);
    setPrueba(null);
    try {
      const res = await fetch(accion === "probar" ? `${base}/api/conexiones/probar` : `${base}/api/conexiones`, {
        method: accion === "probar" ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      const r = await res.json().catch(() => ({}));
      if (r.prueba) setPrueba(r.prueba);
      if (!res.ok) {
        setError(r.campos ? `${r.error}: ${r.campos.join(", ")}` : r.error ?? `HTTP ${res.status}`);
        return;
      }
      if (accion === "guardar") {
        setSecretos({});
        await alGuardar();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void enviar("guardar");
      }}
      style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid #e0e0e0" }}
      autoComplete="off"
    >
      <label>
        Modo
        <select value={modo} onChange={(e) => setModo(e.target.value as Modo)} style={estiloEntrada}>
          {vista.modosDisponibles.map((m) => (
            <option key={m} value={m}>
              {MODOS[m]}
            </option>
          ))}
        </select>
      </label>

      {nombresParametros.map((n) => (
        <label key={n} style={{ display: "block", marginTop: "0.5rem" }}>
          {n}
          {n === "anios" && <span className="suave"> (separados por coma; vacío = actual y siguiente)</span>}
          <input
            value={parametros[n] ?? ""}
            onChange={(e) => setParametros({ ...parametros, [n]: e.target.value })}
            style={estiloEntrada}
          />
        </label>
      ))}

      {CAMPOS[modo].map((c) => (
        <label key={c.id} style={{ display: "block", marginTop: "0.5rem" }}>
          {c.etiqueta}
          {!cambiaModo && <span className="suave"> (vacío = conservar el actual)</span>}
          <input
            type={c.tipo}
            value={secretos[c.id] ?? ""}
            onChange={(e) => setSecretos({ ...secretos, [c.id]: e.target.value })}
            autoComplete={c.tipo === "password" ? "new-password" : "off"}
            style={estiloEntrada}
          />
        </label>
      ))}

      {modo === "USUARIO_PASSWORD" && vista.fuente === "FERIADOS_PANEL" && (
        <p className="aviso suave">
          El login del panel solo se puede validar con navegador: quedará pendiente hasta la próxima corrida del robot.
        </p>
      )}

      {prueba && (
        <p style={{ color: ESTADO[prueba.resultado].color }}>
          Prueba: {ESTADO[prueba.resultado].texto}. {prueba.detalle}
        </p>
      )}
      {error && <p style={{ color: "#b3261e" }}>{error}</p>}

      {prueba?.resultado === "FALLIDA" && (
        <label style={{ display: "block", marginTop: "0.5rem" }}>
          <input type="checkbox" checked={forzar} onChange={(e) => setForzar(e.target.checked)} /> Guardar aunque la
          prueba falle
        </label>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
        <button type="button" onClick={() => void enviar("probar")} disabled={ocupado}>
          Probar
        </button>
        <button type="submit" disabled={ocupado}>
          {ocupado ? "Procesando…" : "Probar y guardar"}
        </button>
      </div>
    </form>
  );
}
