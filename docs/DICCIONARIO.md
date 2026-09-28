# Diccionario de datos

Qué significa cada campo, de dónde sale y qué **no** significa. Lo segundo suele
importar más.

## `tipos-licencia`

| Campo | Sensibilidad | Origen | Notas |
|---|---|---|---|
| `externalId` | común | `data[].id` | Clave. La asigna Tu Recibo |
| `nombre` | común | `data[].nombre` | Texto libre del cliente, cambia sin aviso |
| `visible` | común | `data[].visible` | `"t"`/`"f"` del origen, se guarda crudo |
| `esVacaciones` | común | `data[].isVacation` | Solo `true` estricto cuenta |

Un tipo que deja de venir en el catálogo se marca de baja, **no se borra**: las
ausencias históricas siguen apuntando a él.

## `ausencias`

| Campo | Sensibilidad | Origen | Notas |
|---|---|---|---|
| `externalId` | común | `id_licencia` | Clave. Sin él la fila se descarta |
| `personaExternalId` | común | derivado | Cruce contra `personas` de CENTRIA vía DNI |
| `tipoExternalId` | común | `id_tipo` | Apunta a `tipos-licencia` |
| `tipoNombre` | común | `tipo` | Copia del nombre al momento de la corrida |
| `estado` | común | derivado | `SOLICITADA` \| `APROBADA` \| `RECHAZADA` |
| `desde` | común | `fecha_desde` | `DD/MM/YYYY` parseado a medianoche UTC |
| `hasta` | común | `fecha_fin` | Último día de la ausencia |
| `regreso` | común | `fecha_regreso` | Primer día trabajado. **No** es `hasta + 1` siempre |
| `medioDia` | común | `medio_dia` | Booleano flojo del origen (`t`/`f`) |
| `horas` | común | `medio_dia_horas` | `""` es `null`, no `0` |
| `legajo` | sensible | `numero_legajo` | Identifica a la persona dentro de la empresa |
| `dni` | **restringido** | derivado del CUIL | |
| `cuil` | **restringido** | `cuil` | |
| `motivo` | **restringido** | `motivo` | Texto libre. Puede contener diagnóstico médico |

### `estado`: por id, no por texto

Catálogo relevado por KAiROS sobre 2451 licencias de producción:

| id | Texto en el origen | Se mapea a |
|---|---|---|
| 2 | En manos de aprobador nivel 1 | `SOLICITADA` |
| 4 | En manos de RRHH | `SOLICITADA` |
| 5 | Aprobado | `APROBADA` |
| 7 | Asignacion | `SOLICITADA` |
| 8 | Rechazado | `RECHAZADA` |
| 10 | Cancelada | `RECHAZADA` |

Se mapea por `id_estado` para que un renombre en el origen no cambie el
comportamiento en silencio. El respaldo por texto solo corre para ids que no
están en la tabla, y excluye explícitamente `"aprobador"`: es un paso del
circuito, no un resultado. Sin esa exclusión, "En manos de aprobador nivel 1"
contaría como aprobada y una licencia en trámite se publicaría como firme.

Ante la duda, `SOLICITADA`. Publicar de menos se corrige en la corrida
siguiente; publicar de más ya afectó un cálculo de horas.

### `personaExternalId` puede ser `null`

Tu Recibo no expone DNI: se deriva del CUIL (11 dígitos = 2 + 8 + 1). Si el CUIL
es raro —extranjero sin DNI, CUIT de monotributista, legajo viejo— o la persona
no está en la nómina, queda en `null` y se cuenta en el log.

Una ausencia sin persona **no es un error fatal**: la fila vale igual. Pero si
el número crece, algo cambió en la nómina o en el origen.

Si dos personas comparten DNI en la nómina, el DNI se descarta entero: asignarle
las licencias a la persona equivocada es peor que no asignárselas a nadie.

### La baja no borra

Lo que deja de venir en el padrón se marca `activa = false` con `bajaEn`. La
fila queda para el historial y sale en `bajas[]` cuando se lee con `?desde=`.

KAiROS borraba su cache entera y la recreaba. Acá no se puede: este módulo es el
dueño y Tu Recibo solo devuelve el presente. Lo que se borre se pierde.

## `feriados`

| Campo | Sensibilidad | Origen | Notas |
|---|---|---|---|
| `fecha` | común | `start` | Clave, `YYYY-MM-DD` |
| `tipo` | común | `tipo` | `FERIADO_NACIONAL` \| `NO_LABORABLE` |
| `descripcion` | común | `title` | |
| `desdeOverride` | común | módulo | `true` si el valor vigente es una corrección manual |

`desdeOverride` se publica a propósito: un consumidor que ve una diferencia con
Tu Recibo tiene que poder saber que fue deliberada y no un error de sync.

### El espejo crudo

En la base, cada feriado guarda además:

| Columna | Para qué |
|---|---|
| `enOrigen` | si Tu Recibo lo trajo alguna vez |
| `tipoOrigen` | qué tipo dijo el origen antes de la corrección |
| `descripcionOrigen` | qué descripción dijo |

No se publican. Existen para que **quitar un override sea reversible**: sin
ellos, sacar un `CAMBIO` no tendría a qué volver y el feriado se daría de baja
como si el origen nunca lo hubiera traído.

### Overrides

| Acción | Qué hace | Requiere |
|---|---|---|
| `ALTA` | agrega un feriado que el origen no trae | `tipo` + `descripcion` |
| `BAJA` | quita uno que el origen trae y acá no corresponde | — |
| `CAMBIO` | corrige tipo y/o descripción de uno que sí vino | `tipo` + `descripcion` |

Un `CAMBIO` sobre una fecha que el origen **no** trajo no inventa el feriado. Si
lo hiciera, un override viejo mantendría vivo para siempre algo que Tu Recibo ya
retiró. Para eso está `ALTA`.

Todo override exige `motivo` de 10 caracteres o más. Dentro de seis meses, la
única forma de saber si una diferencia fue deliberada es que alguien lo haya
escrito cuando la hizo.

### Acotado por año

El robot consulta `type=feriadosPorAño`: una corrida trae 2026 y 2027 y no sabe
nada de 2025. Por eso la reconciliación recibe `anios` explícito y solo da de
baja dentro de esos años. Comparar contra toda la tabla borraría el calendario
de los años que nadie pidió.

## Tablas que no se publican

| Tabla | Para qué |
|---|---|
| `CredencialTuRecibo` | Por tenant: URLs y **nombres** de las variables con usuario y clave. Nunca los valores |
| `CorridaSync` | Una fila por corrida: fuente, estado, conteos, error |
| `FeriadoOverride` | Las correcciones manuales, con motivo y autor |
| `SelloMaestro` | Cuándo se verificó por última vez cada maestro |

`CredencialTuRecibo` guarda nombres de variable y no valores a propósito: así un
volcado de la base a staging no arrastra credenciales de producción.
