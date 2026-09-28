# Contrato con CENTRIA

## Los dos secretos

Es lo que más se confunde y lo que más rompe. Son **dos secretos opacos
distintos, en direcciones opuestas**.

| | Token de entrada | Credencial |
|---|---|---|
| Dirección | CENTRIA → módulo | módulo → CENTRIA |
| Header | `x-internal-token` | `x-service-token` |
| Acompaña | `x-tenant-id` | `x-module-code` |
| Variable | `CENTRIA_ENTRY_TOKEN` | `CENTRIA_SERVICE_TOKEN` |
| Lo genera | CENTRIA, al registrar | CENTRIA, al registrar |
| Protege | manifiesto, salud, publicación | lectura de maestros nativos |

No son JWT ni HMAC: son cadenas opacas. Por eso la validación
(`src/lib/tokens.ts`) compara con SHA-256 + `timingSafeEqual` y no con `===`.
Un `===` corta en el primer byte distinto y filtra el prefijo a quien mida.

### Rotación

Cada variable acepta un `<VAR>_PREVIO`. Durante la ventana valen las dos y el
uso del anterior queda en los logs:

```
[rotacion] Se aceptó CENTRIA_ENTRY_TOKEN_PREVIO. Todavía hay un llamador con el secreto viejo.
```

Cuando ese aviso deja de aparecer, se borra el `_PREVIO`. Si se borra antes, el
llamador que todavía no rotó empieza a recibir 403.

### Fallar cerrado

Una variable vacía, ausente o con una referencia de Key Vault **sin resolver**
cuenta como no configurada y devuelve 500, nunca 200.

Esto importa porque una referencia sin resolver llega como el texto literal
`@Microsoft.KeyVault(...)`, no vacía. Sin la guarda, el síntoma sería un 403
inexplicable y la búsqueda arrancaría en el lugar equivocado.

## Identidad de usuario

Cuando una persona entra por `/m/<codigo>`, CENTRIA agrega:

| Header | Contenido |
|---|---|
| `x-user-id` | identificador estable |
| `x-user-email` | correo |
| `x-user-name` | nombre visible |
| `x-module-role` | `ADMIN` o `USER`, **rol dentro de este módulo** |
| `x-tenant-timezone` | zona del tenant |

Estos headers **solo valen si el token de entrada validó**. Sin esa condición,
cualquiera se declararía ADMIN escribiendo un header.

`x-user-role` está deprecado y **no** equivale a `x-module-role`: es el rol en
CENTRIA, no en el módulo. Este código no lo lee.

## Manifiesto

`GET /centria/manifiesto` declara dos cosas distintas: lo que el módulo
necesita **leer** (`maestros`, desde v1) y lo que **publica** (`publica`,
agregado en v2).

```json
{
  "codigo": "turecibo",
  "nombre": "Tu Recibo",
  "version": "0.1.0",
  "manifiestoVersion": 2,
  "salud": "/centria/salud",
  "maestros": [
    { "id": "personas", "campos": ["externalId", "dni", "email", "fullName"], "motivo": "..." },
    { "id": "tenant", "campos": ["tenantId", "timezone"], "motivo": "..." }
  ],
  "publica": [
    {
      "id": "ausencias",
      "nombre": "Ausencias",
      "clave": "externalId",
      "version": 1,
      "descripcion": "...",
      "campos": [
        { "id": "estado", "tipo": "texto", "sensibilidad": "comun", "descripcion": "Valores: SOLICITADA | APROBADA | RECHAZADA." },
        { "id": "dni", "tipo": "texto", "sensibilidad": "restringido" }
      ],
      "parametros": [{ "id": "ventanaDias", "tipo": "numero", "min": 1, "max": 400, "default": 31 }]
    }
  ]
}
```

`publica` es **aditivo**: `maestros` no cambió de forma ni de significado, así
que un CENTRIA que solo entienda v1 sigue leyendo el documento y se limita a
ignorar el campo de más.

- `tipo` de campo: `texto` | `numero` | `booleano` | `fecha` (AAAA-MM-DD) |
  `fechaHora` (ISO) | `lista`. **Este módulo no usa `lista`**: todos sus campos
  emiten escalares, y declarar `lista` haría que el relay esperara un arreglo.

Cantidad de campos publicados, fijada por prueba porque CENTRIA la verifica
contra el manifiesto real: **`ausencias` 14**, `tipos-licencia` 4, `feriados` 4.
- `sensibilidad`: `comun` | `sensible` | `restringido`. `dni`, `cuil` y `motivo`
  van como **restringido**.
- `parametros` declara solo lo que **varía** entre maestros. `?campos=` y
  `?desde=` no se declaran porque el contrato los define para todo maestro
  publicado; `?ventanaDias=` sí, porque solo aplica a `ausencias`.
- `parametros` se **omite** cuando no hay ninguno, en vez de mandar una lista
  vacía que invitaría a dibujar una sección sin contenido.

Ids y claves fijados por el contrato:

| Maestro | Clave | Parámetros |
|---|---|---|
| `tipos-licencia` | `externalId` | — |
| `ausencias` | `externalId` | `ventanaDias` (1–400, default 31) |
| `feriados` | `fecha` | — |

El manifiesto **no otorga acceso**: es un pedido. El SUPERADMIN lo aprueba campo
por campo en `/admin/modules`. Hasta entonces, `leerMaestroDeCentria` recibe 403
con el detalle de lo que falta habilitar. La sensibilidad declarada en `publica`
es, del mismo modo, una propuesta que CENTRIA aprueba.

## Salud

`GET /centria/salud` con `x-internal-token` responde `200 { "ok": true }`. Path
**confirmado por CENTRIA**. Valida solo el token de entrada: no exige tenant,
porque un ping que dependiera de que el tenant exista reportaría caído al módulo
por un problema de datos.

## Publicación

`GET /centria/maestros/<id>`, con `x-internal-token` y `x-tenant-id`, devuelve:

```json
{
  "maestro": "ausencias",
  "version": 1,
  "actualizado": "2025-03-11T03:00:00.000Z",
  "filas": [{ "externalId": "100", "estado": "APROBADA" }],
  "bajas": []
}
```

Es la **misma forma** que usan los maestros nativos de CENTRIA. Copiarla es
deliberado: el relay filtra sobre esa forma y un consumidor no debería poder
notar si un maestro es nativo o viene de un módulo.

### Parámetros

| Query | Efecto |
|---|---|
| `?campos=a,b` | subconjunto; la clave siempre viaja. Un campo fuera del catálogo da 400 |
| `?desde=<ISO>` | solo lo que cambió desde entonces, más `bajas[]` |
| `?ventanaDias=N` | ventana de publicación, solo para `ausencias`. Se acota al techo |

CENTRIA **no manda la identidad del consumidor**, y el módulo no la espera ni la
exige: quién puede ver qué se decide del lado de CENTRIA, por conexión.

### Límites de respuesta

50.000 filas, 10 MB, 8 s, sin redirects. Las dos primeras las valida el módulo
antes de responder y, si se exceden, devuelve **413** con el conteo real y la
sugerencia de acotar.

Fallar es deliberado: una respuesta truncada es indistinguible de una completa,
así que un consumidor concluiría que las personas faltantes no tuvieron
ausencias. Un silencio que parece un dato es peor que un error visible.

### Dos cosas que no son obvias

**`version` es del esquema, no de los datos.** Si fuera un contador de corrida,
cada sync invalidaría el parser de todos los consumidores. Para saber si hay
datos nuevos está `actualizado`.

Se **debe** incrementar ante cualquier cambio de forma: agregar, sacar o
renombrar un campo, cambiar el `tipo` de uno, o cambiar la `clave` del maestro.
CENTRIA **rechaza aprobar** una publicación que quite un campo, cambie tipo o
clave, o baje el número, sin incremento. `version` **nunca decrece**.

**Cada maestro lleva su propia `version`.** No hay una constante compartida: son
tres números independientes en `VERSIONES` (`src/lib/maestros.ts`), y el
manifiesto publica el que corresponde a cada uno.

La versión compartida era la forma anterior, y el motivo del cambio no es
estético. CENTRIA aprueba y sirve **por maestro**: el relay compara la versión
del sobre contra la aprobada de ese maestro. Con una constante única, subir la
versión por un cambio en `feriados` movía también la de `ausencias` y
`tipos-licencia` —que no cambiaron—, y el relay empezaba a responder **502 en los
tres** hasta que el SUPERADMIN aprobara las tres propuestas nuevas. El único
colchón es la copia de 24 h. Es decir: un cambio en el maestro más chico podía
cortar el que más importa.

Partirlo antes de la primera aprobación evita tener que coordinar reaprobaciones
en cascada. CENTRIA lo soporta sin cambios de su lado.

**`bajas[]` sale solo con `?desde=`.** En una lectura completa, la ausencia de
la fila ya es la baja; mandar además la lista de todo lo que alguna vez existió
filtraría el historial entero a quien solo pidió el estado actual.

### `actualizado` y el sello

Sale de `SelloMaestro`, que se escribe en cada corrida exitosa **aunque no haya
cambiado nada**. Sin eso, "la última corrida no encontró novedades" y "hace tres
días que no sincronizamos" se verían idénticos desde afuera.

## Ventana de publicación

**Quién resuelve `ventanaDias`, resuelto:** lo aplica el módulo, pero CENTRIA
**siempre manda el valor ya resuelto** —lo pedido o el default, topado por el
`ventanaDiasMax` de la conexión—. El default del módulo
(`PUBLICACION_AUSENCIAS_DIAS`) solo entra en juego si no llega nada, y el techo
(`PUBLICACION_AUSENCIAS_DIAS_MAX`) queda como red de seguridad, no como el
límite de negocio.

Por eso el módulo no necesita conocer al consumidor: la política vive en la
conexión de CENTRIA y llega ya reducida a un número. El tope lo configura el
SUPERADMIN en la conexión como `{"ventanaDiasMax": n}`.

La ventana mira `hasta`, no `desde`: una licencia larga que empezó antes del
corte y sigue vigente tiene que publicarse. Con `desde >= corte` desaparecería
justo mientras la persona está ausente.

## Estado de las ausencias

`estado` viaja en **mayúsculas**: `SOLICITADA` | `APROBADA` | `RECHAZADA`. Se
declara como campo de tipo **`texto`**, no `lista`: el valor que viaja es un
escalar, y `lista` le diría al relay que espere un arreglo, con lo que la
validación de forma fallaría y el sobre entero se descartaría con un 502. El
conjunto acotado se declara en la `descripcion` del campo, que es informativa y
no participa de la validación. Lo mismo aplica a `feriados.tipo`.

## Semántica de `medioDia` y `horas`

Acordado con Timesheet. Es semántica de **negocio**, no descripción de cómo
viene el dato: un consumidor que la lea al revés descuenta mal las horas.

| Campo | Significado |
|---|---|
| `medioDia: false` | Ausencia de **jornada completa**. El día se bloquea entero |
| `medioDia: true` | Ausencia **parcial**. La otra fracción es trabajable y cargable |
| `horas` | Cantidad de **esa fracción**, no duración total de la ausencia |
| `horas: null` | La magnitud **no está afirmada** por el origen |

**`medioDia: true` no bloquea el día.** Tu Recibo no manda un flag suelto: manda
el par `medio_dia` + `medio_dia_horas`. Si el flag significara "día bloqueado",
la duración sobraría —un día entero no necesita que le digan cuántas horas
dura—. Lo confirma el comportamiento del par: con `medio_dia: "f"`, `horas`
viaja `null` y no `0`. Las horas solo existen cuando hay jornada partida.

**`horas` no es la duración de la licencia.** Sale de `medio_dia_horas`. Una
licencia de tres días con `horas: 4` son tres días de los cuales uno tiene una
fracción de 4 h; no son cuatro horas de licencia. Un consumidor que la use como
total descuenta de menos en toda licencia multi-día, y la diferencia aparece
meses después como una discrepancia de horas sin causa visible.

Cuando `horas` viene `null` y `medioDia` es `true`, el consumidor que necesite
una magnitud tiene que elegir una convención **y dejarla explícita**: el origen
no la está afirmando.

### Ambigüedad multi-día, sin resolver

Para una licencia con `desde != hasta` y `medioDia: true`, **no está definido a
qué fecha corresponde la fracción**: primer día, último, ambos extremos o cada
día del rango. El proveedor no lo documenta y los datos disponibles no cubren el
caso.

**El módulo no lo infiere ni lo va a inferir.** Publica el par tal como lo
afirma el origen; inventar una regla de reparto produciría números plausibles y
equivocados, que es el peor resultado posible acá.

Decisión de Timesheet (Andrés) para ese caso: **permite cargar y marca la fila
para revisión**, sin deducir la fecha de la fracción. Cualquier otro consumidor
que enfrente lo mismo debería resolverlo de forma igualmente explícita.

El punto puede cerrarse con evidencia —no con criterio— cuando el módulo esté
sincronizando: mirando la distribución real de `medioDia: true` con
`desde != hasta`.

## Correcciones manuales de feriados: `desdeOverride`

El maestro `feriados` publica `desdeOverride`, y su significado es más amplio
que el que sugiere el nombre:

> **El valor vigente de esta fila fue tocado por una corrección manual del
> módulo.**

Eso cubre dos casos que el campo **no distingue**:

- **ALTA** — fecha que el origen no trajo y se agregó a mano.
- **CAMBIO** — fecha que **sí vino** del origen, con `tipo` o `descripcion`
  corregidos.

De ahí la lectura que hay que evitar: `desdeOverride: true` **no** significa
"este día no vino de Tu Recibo". Mostrarlo en pantalla como "cargado a mano, no
viene del origen" sería falso en todos los CAMBIO. La redacción segura es "fue
ajustado manualmente".

El campo que sí separa ambos casos es `enOrigen` (con `tipoOrigen` y
`descripcionOrigen` como espejo crudo). **Hoy no se publica**: existe en la base
pero ningún consumidor lo necesita. Si alguno lo pide, agregarlo al catálogo es
un cambio chico —hay que incrementar la `version` de `feriados`, que ya no
arrastra a los otros dos— y habilita los tres
estados: sin tocar, corregido, agregado.

`desdeOverride` es **explicativo, no funcional**: no cambia si el día bloquea.

### El caso BAJA no viaja como fila

Existe una tercera corrección: eliminar un feriado que el origen sí trae. Esos
días **no aparecen en `filas[]`** —son indistinguibles de un día hábil
cualquiera, que es el resultado buscado—.

La consecuencia importa solo para consumidores con caché incremental: la baja
llega en **`bajas[]`**, y `bajas[]` sale **solo con `?desde=`**. Ignorar ese
arreglo deja bloqueado un día que dejó de ser feriado.

### Las capas de override se apilan

Un consumidor puede tener su propia capa de feriados propios y anulados sobre lo
que recibe por el enchufe (Timesheet la tiene). Se componen sin conflicto porque
la local se aplica después: un feriado corregido acá y anulado allá **queda
anulado**.

Se deja escrito para desarmar el supuesto inverso: publicar una corrección **no
garantiza** que se vea en todos los consumidores. La última palabra sobre su
propio calendario la tiene cada uno.

## Fin de una ausencia: `hasta`, `regreso` y qué significa que falten

`ausencias` publica tres fechas: `desde`, `hasta` y `regreso`. Las tres pueden
venir nulas, y **un nulo nunca se rellena**: significa que el origen no afirmó
ese dato, no que valga otra cosa.

- **`hasta` presente** — fin afirmado por el origen.
- **`hasta: null`** — el origen **no afirmó fecha de fin**. No significa "dura un
  día" ni "no tiene fin"; significa que el dato no está.
- **`regreso`** — primer día de vuelta al trabajo, **exclusivo**. Es
  independiente de `hasta` y suele venir cargado cuando `hasta` no está.

De ahí la regla para un consumidor, en tres ramas:

| `hasta` | `regreso` | Qué se puede afirmar |
|---|---|---|
| presente | — | Termina en `hasta`. |
| null | presente | Fin **derivable**: `regreso − 1 día`. |
| null | null | **Fin indeterminado.** No hay dato para derivarlo. |

Solo la tercera rama necesita una política, y esa política es **del consumidor**,
no del origen: el módulo no la elige por él. Lo que sí corresponde es que quede
explícita y visible en el código que la aplica, en vez de quedar implícita en un
comportamiento.

El módulo **no rellena `hasta` con `desde`** cuando viene vacío. Hacerlo
entregaría una fecha que nadie afirmó, indistinguible de una real, y borraría
para siempre la diferencia entre las tres ramas de arriba.

### Una baja no significa que la ausencia terminó

`activa: false` significa que la fila **dejó de venir en el padrón** del origen:
se anuló, se borró o se cayó del listado. **No** es la señal de que la persona
volvió a trabajar.

Una licencia que termina normalmente **sigue viniendo en el padrón y sigue
`activa: true`**; lo único que cambia es que su `hasta` ya pasó. Esperar una baja
como señal de fin de ausencia es esperar un evento que, en el caso feliz, no
llega nunca.

El camino real por el que una ausencia abierta se cierra es otro: cada corrida
relee el padrón y reconcilia por `externalId`, así que si el origen después
completa la fecha de fin, **la misma fila se actualiza en el lugar** —mismo
`externalId`, `hasta` ahora presente— y `actualizado` se mueve.

### La ventana de publicación mira el fin, no el inicio

Consecuencia directa de lo anterior, del lado del módulo: `leerAusencias` filtra
por el **fin efectivo** —`hasta`, y si no hay, `regreso`—, nunca por `desde`.
Filtrar por `desde` haría desaparecer del feed una licencia larga justo mientras
la persona está ausente.

Una ausencia **sin `hasta` ni `regreso` se publica siempre**, sin importar hace
cuánto empezó: el origen no afirmó ningún fin, así que no se la puede dar por
terminada. El costo es volumen, y el volumen falla ruidoso contra el tope de
filas con un 413; excluirla fallaría en silencio, dejando de bloquear a alguien
que quizá sigue de licencia.

**Un `regreso` que no es posterior a `desde` no cuenta como fin.** El origen
puede mandarlo —cada fecha se parsea por separado y nadie valida la relación
entre ellas— y tomarlo como fin sacaba de la ventana una ausencia potencialmente
abierta. Esas filas caen en el caso "sin fin afirmado" y se publican.

La comparación es **estricta**: `regreso == desde` describe una ausencia de cero
días, tan imposible como una de días negativos. El motivo de partirlo ahí no es
simetría sino **alineación con el consumidor**: Timesheet trata `regreso <=
desde` como incoherente y cubre el día de inicio, así que si acá contara como
fin válido, una fila así con `desde` fuera de la ventana no se publicaría y el
consumidor perdería un día que sí habría bloqueado. Las dos puntas tienen que
partir la coherencia en el mismo lugar.

Ese borde lo reportaron CENTRIA y Timesheet como inocuo, y lo era desde cada
lado por separado: una ausencia de cero días no bloquea nada. Deja de serlo al
mirar las dos reglas juntas, porque no coincidían sobre qué es coherente.

Ese borde lo levantó Timesheet, y el argumento que lo volvió un defecto y no una
limitación aceptable es del lado del consumidor: **una fila que falta en una
respuesta completa es indistinguible de "no hubo ausencia"**. No hay forma de
detectarla desde afuera. Es el mismo modo de falla silencioso que el resto de la
regla evita.

La regla vive como función pura (`alcanzaLaVentana`) y es la **autoridad**: se
aplica en memoria sobre lo que devuelve la base. El `where` de Prisma es una
pre-poda deliberadamente más amplia, porque la regla compara `regreso` contra
`desde` y eso no se expresa en un `where`. Una prueba verifica la relación
correcta —**superconjunto, no igualdad**—: la base puede traer de más, nunca
descartar una fila que la regla habría publicado.

## Dependencia abierta

Ninguna en el contrato. CENTRIA lo cerró en
`docs/centria/contrato-maestros.md` (PR #129): forma del manifiesto y de la
publicación, ids y claves, límites, resolución de `ventanaDias`, ausencia de
identidad del consumidor y path del ping.

Queda pendiente lo **operativo**, no lo contractual: el relay
(`GET /centria/maestros/<id>` del lado de CENTRIA, etapa 6) tiene que estar
desplegado y el módulo registrado en `/admin/modules` para que alguien consuma
esto. Ver el gate G1 en `RUNBOOK.md`.
