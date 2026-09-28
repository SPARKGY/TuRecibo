# Migración

Cómo pasar de la integración partida de hoy a este módulo, sin que nadie se
quede sin datos en el medio.

## De dónde se viene

| Qué | Quién lo hace hoy | Qué queda después |
|---|---|---|
| Catálogo de tipos de licencia | CENTRIA, contra `/v2/licensesUser/types` | lo hace el módulo |
| Padrón de licencias | KAiROS, contra `/v2/licensesUser/licenses` → `LicenciaCache` | lo hace el módulo |
| Feriados | KAiROS, robot Playwright → `Calendario` | lo hace el módulo |

Dos sistemas con las mismas credenciales, dos normalizaciones del mismo dato y
ningún dueño. Eso es lo que termina.

## Principio: nadie apaga nada hasta que el reemplazo demuestre paridad

Los sistemas actuales siguen corriendo mientras el módulo sincroniza en paralelo.
Recién cuando los datos coinciden se mueve a los consumidores. El corte es el
último paso, no el primero.

## Fase 1 — Sincronización en sombra

El módulo desplegado y sincronizando, sin ningún consumidor conectado. CENTRIA y
KAiROS siguen haciendo lo suyo.

Duración: al menos varios ciclos completos, incluyendo un fin de semana. Los
errores de calendario aparecen en los bordes.

## Fase 2 — Verificación de paridad

Comparación de solo lectura contra lo que ya existe. No hay script automático:
las bases son de sistemas distintos y la comparación se hace una vez.

### Tipos de licencia

Contra lo que CENTRIA tiene hoy:

- Misma cantidad de tipos activos.
- Mismos `externalId`.
- `esVacaciones` coincide. Es el que más impacta: clasifica horas.

### Ausencias contra `LicenciaCache` de KAiROS

Esta es la que importa. Verificar, para una ventana acotada (por ejemplo los
últimos 90 días):

1. **Cantidad de licencias por estado.** Una diferencia en `APROBADA` es grave:
   afecta el cálculo de horas.
2. **Las fechas no están corridas un día.** El error clásico: `DD/MM/YYYY`
   parseado en zona local corre cada licencia un día al oeste de Greenwich.
   Comparar `desde`/`hasta` de una muestra, no solo los totales.
3. **El cruce de identidad da la misma persona.** KAiROS deriva el DNI del CUIL
   en memoria; el módulo hace lo mismo pero contra el maestro `personas`. Si
   difieren, gana investigar antes de cortar.
4. **Las licencias sin persona son las mismas.** Si el módulo tiene muchas más,
   el manifiesto probablemente no tiene aprobado el campo `dni`.

Diferencias esperables y **aceptables**:

- El módulo tiene **más** filas históricas: no borra, KAiROS sí.
- El módulo tiene licencias que KAiROS descartó por no cruzar con una persona.
- Los estados `SOLICITADA` pueden diferir si las corridas no fueron simultáneas.

Diferencia **no** aceptable: una licencia `APROBADA` en KAiROS que en el módulo
no está o figura con otras fechas.

### Feriados contra `Calendario` de KAiROS

- Mismo conjunto de fechas para el año en curso y el siguiente.
- Las diferencias deliberadas —si KAiROS tenía correcciones a mano— se cargan
  como overrides **antes** del corte, con su motivo escrito. Si no, la primera
  corrida del robot las borra.

## Fase 3 — Corte por consumidor

De a uno, empezando por Timesheet.

1. Crear la conexión en CENTRIA con los campos mínimos. `dni`, `cuil` y `motivo`
   son restringidos: si Timesheet no los necesita, no se piden. Casi seguro no
   los necesita —le alcanza `personaExternalId`.
2. Timesheet lee del maestro y **compara** contra lo que venía usando, sin
   cambiar de fuente todavía.
3. Cuando coincide, Timesheet cambia de fuente.
4. Recién entonces se retira el camino viejo.

## Fase 4 — Retiro

Con todos los consumidores migrados y un período de observación cumplido:

1. **Desactivar** la extracción de Tu Recibo en CENTRIA y KAiROS. Desactivar, no
   borrar: revertir tiene que ser volver a prender algo.
2. Quitar las credenciales de Tu Recibo de esos entornos. Este es el paso que
   cumple el objetivo: **un solo sistema con esas credenciales**.
3. Dejar sus tablas de cache un tiempo en solo lectura. Son el punto de
   comparación si aparece una discrepancia tarde.
4. Recién al final, borrar código muerto.

## Cómo volver atrás

Hasta la fase 4, volver atrás es cambiar la fuente del consumidor. Los sistemas
viejos siguen sincronizando.

Después de la fase 4, volver atrás implica reactivar la extracción en KAiROS y
esperar una corrida. Por eso la fase 4 va después del período de observación y
no antes.

## Lo que no se migra

**El historial previo no se puede reconstruir.** Tu Recibo devuelve el estado
presente: no hay forma de pedirle las licencias como estaban en 2023. Lo que el
módulo tenga empieza el día de su primera corrida.

Si hace falta el historial anterior, la única fuente es `LicenciaCache` de
KAiROS, y habría que importarlo explícitamente. **No está implementado** y no se
decidió hacerlo. Si se decide, tiene que pasar antes de la fase 4, mientras esa
tabla siga existiendo.
