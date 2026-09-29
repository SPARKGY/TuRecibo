/**
 * Estilos de la página de inicio. Copian la paleta, la tipografía y las piezas
 * (hoja, banda de título, filetes, badges) de la pantalla de carga de horas del
 * módulo Timesheet, para que los módulos de SparkGY se vean como una familia.
 *
 * Todo cuelga de `.ch` para no pisar nada fuera de la página.
 */
export const ESTILOS = `
.ch {
  --bg: #e4e4e4;
  --panel: #f1f1f1;
  --border-t: #b1b1b1;
  --text-t: #1a1a1a;
  --accent: #1a5a8a;
  --inp: #ffffff;
  --inp-t: #16509a;
  --accent-bg: #ddeaf5;
  --banda: #1F4F7F;
  --banda-t: #ffffff;
  --ok: #25702f;
  --wn: #7a5000;
  --bd: #a01818;
  --border: #d5d5d5;
  --border-stronger: #8a8a8a;
  --text-sugerencia: #767676;
  --radius: 3px;

  min-height: 100vh;
  margin: 0;
  padding: 16px 12px 40px;
  background: var(--bg);
  color: var(--text-t);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 18px;
  font-weight: 400;
  -webkit-text-size-adjust: 100%;
  box-sizing: border-box;
}
.ch *, .ch *::before, .ch *::after { box-sizing: border-box; }
.ch code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }

.ch .hoja {
  min-width: 320px;
  max-width: 1180px;
  margin: 0 auto 14px;
  background: var(--inp);
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
  padding: 0 10px 12px;
}

.ch .titulo-caja {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin: 0 -10px 12px;
  padding: 9px 10px;
  min-height: 43px;
  background: var(--banda);
  border-bottom: 1px solid var(--accent);
  color: var(--banda-t);
}
.ch .titulo-nom { color: var(--banda-t); letter-spacing: .4px; font-weight: 600; text-transform: uppercase; }
.ch .titulo-sub { color: #c9d8e8; }
.ch .quien { margin-left: auto; color: var(--banda-t); display: inline-flex; gap: 8px; align-items: center; }

.ch .intro { margin: 0 0 10px; max-width: 72ch; }
.ch .suave { color: var(--text-sugerencia); }

.ch .aviso {
  margin: 0 0 12px;
  padding: 7px 10px;
  border: 1px solid #d8c08a;
  border-radius: var(--radius);
  background: #fbf5e6;
  color: var(--wn);
}
.ch .aviso strong { font-weight: 600; }

.ch .tarjetas {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 10px;
}
.ch .tarjeta {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-t);
  border-radius: var(--radius);
  background: var(--inp);
  overflow: hidden;
}
.ch .tarjeta-cab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border-t);
}
.ch .tarjeta-nom { font-weight: 600; letter-spacing: .2px; }
.ch .tarjeta-cab .badge { margin-left: auto; }
.ch .tarjeta-cuerpo { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
.ch .tarjeta-pie {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.ch .cuando { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.ch .cuando .fecha { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ch .rel { color: var(--inp-t); }

.ch .datos { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.ch .rot { color: var(--text-sugerencia); margin-right: 4px; }

.ch table.conteos {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  font-variant-numeric: tabular-nums;
}
.ch table.conteos th {
  font-weight: 400;
  color: var(--text-sugerencia);
  text-align: right;
  padding: 2px 2px;
  border-bottom: 2px solid var(--border-stronger);
  white-space: nowrap;
  font-size: 11px;
}
.ch table.conteos td { text-align: right; padding: 4px 2px 2px; color: var(--inp-t); }
.ch table.conteos td.cero { color: var(--text-sugerencia); }
.ch table.conteos td.alerta { color: var(--wn); }

.ch .error {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid #e0b4b4;
  border-radius: var(--radius);
  background: #fbeeee;
  color: var(--bd);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  line-height: 16px;
}
.ch .ultima-ok {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
}
.ch .ultima-ok.nunca { color: var(--bd); }
.ch .vacia { color: var(--text-sugerencia); padding: 6px 0; }

.ch .badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border: 1px solid;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .3px;
  line-height: 16px;
  white-space: nowrap;
  text-transform: uppercase;
}
.ch .badge.ok { color: var(--ok); background: #e5f2e7; border-color: #9fcaa6; }
.ch .badge.mal { color: var(--bd); background: #f8e3e3; border-color: #dba5a5; }
.ch .badge.medio { color: var(--wn); background: #f7eed8; border-color: #d8c08a; }
.ch .badge.curso { color: var(--accent); background: var(--accent-bg); border-color: #9dbdd8; }
.ch .badge.neutro { color: #4a4a4a; background: var(--panel); border-color: var(--border-t); }
.ch .badge.banda { color: var(--banda-t); background: transparent; border-color: #7f9fbf; }

.ch .seccion {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px -10px 10px;
  padding: 7px 10px;
  border-top: 1px solid var(--border);
  border-bottom: 2px solid var(--border-stronger);
  font-weight: 600;
  letter-spacing: .4px;
  text-transform: uppercase;
}
.ch .seccion:first-of-type { margin-top: 4px; }
.ch .seccion .suave { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: auto; }

.ch .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.ch table.maestros {
  width: 100%;
  min-width: 560px;
  border-collapse: separate;
  border-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.ch table.maestros th {
  font-weight: 400;
  color: var(--text-sugerencia);
  text-align: left;
  padding: 4px 8px;
  border-bottom: 2px solid var(--border-stronger);
  white-space: nowrap;
}
.ch table.maestros td { padding: 7px 8px; border-top: 1px solid var(--border); vertical-align: top; }
.ch table.maestros tr:nth-child(even) td { background: var(--panel); }
.ch table.maestros td.num { text-align: right; color: var(--inp-t); }
.ch table.maestros th.num { text-align: right; }

.ch .pie { margin: 12px 0 0; color: var(--text-sugerencia); }
`;
