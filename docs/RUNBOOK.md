# Runbook

## Staging compartido

El sitio de staging `turecibo-modulo-staging.azurewebsites.net` usa
`asp-ignix-staging`, una imagen versionada en `ignixacrprod` y la base aislada
`turecibo_staging` en `psql-ignix-prod`. Su configuración de App Service está
en `infra/staging.bicep`: **no** ejecutar `infra/main.bicep` para staging,
porque crea otra infraestructura. `CENTRIA_BASE_URL` (leída por el módulo) y
`CENTRIA_URL` apuntan ambas a CENTRIA staging. `/` sirve de health público;
`/centria/salud` requiere el token de entrada. Los cron apuntan al environment
GitHub `staging` y sus jobs programados solo corren si
`ENABLE_TURECIBO_SCHEDULE=true` como variable de **repositorio** (el `if` de
un job se evalúa antes de que estén disponibles las variables del environment);
`workflow_dispatch` sigue disponible con el gate apagado. Encenderlo solo
después de comprobar por separado sync manual, robot dry-run y robot con
ingesta en staging. Los tokens y credenciales usados por los jobs están en
los secrets del environment `staging`.

**Riesgos aceptados para staging:**

- `kv-ignix-prod` usa *access policies*. La identidad del sitio tiene solo
  permiso `get` (sin `list`), pero ese permiso alcanza **todos** los secretos
  del vault, incluidos los de producción; no se puede limitar a los tres
  secretos de este módulo en ese modo. Pendiente: vault de staging separado o
  RBAC a nivel de secreto. Las credenciales CENTRIA de staging se obtuvieron
  tras el alta del módulo y sustituyeron los placeholders iniciales.
- En el PostgreSQL compartido, `ignix` y `postgres` conservan `PUBLIC CONNECT`,
  al igual que en el despliegue de Timesheet staging. El rol
  `turecibo_staging_app` puede establecer conexión con esas dos bases, pero
  no puede crear objetos en `public` ni leer una tabla de usuario de `ignix`;
  `postgres` no tenía tablas de usuario al verificar. No conecta a
  `centria_staging`, `timesheet_staging`, `timesheet_next_staging` ni
  `kairos_staging`. No se tocaron permisos de otras bases. Para aislamiento
  estricto de conexión haría falta un servidor propio o revisar las ACL
  existentes con sus responsables.

La regla temporal de firewall `turecibo-staging-setup-20260929-tmp` queda
neutralizada en `0.0.0.1–0.0.0.1`: el RG tiene bloqueo `DoNotDelete` y no se
intenta eliminarla.

## Estado inicial antes del despliegue de staging

Antes del despliegue de staging, el módulo estaba **implementado y verificado
localmente** y nada más. Este inventario corresponde a aquel momento, no al
estado actual de staging:

- No se creó ningún recurso en Azure.
- No se desplegó nada.
- No se registró el módulo en CENTRIA.
- No se ejecutó ninguna llamada real a Tu Recibo.
- La base no existe todavía; la migración está versionada pero sin aplicar.

## Gates

En orden. Cada uno es una decisión operativa, no un paso automático.

### G1 — CENTRIA implementa el relay

**Bloqueante para todo lo demás.** El contrato está **cerrado**
(`docs/centria/contrato-maestros.md`, PR #129) y este módulo ya publica contra
él, pero el relay `GET /centria/maestros/<id>` del lado de CENTRIA
(`docs/centria/PLAN.md:90`, etapa 6) todavía no está desplegado. Hasta que
exista, nadie consume esto.

Lo que queda por verificar al cerrarse ya no es contractual sino de campo: que
el relay llegue con `x-internal-token` y `x-tenant-id`, que reenvíe
`?ventanaDias=` ya resuelto, y que el manifiesto v2 se lea entero en
`/admin/modules`.

### G2 — Infraestructura

`infra/main.bicep` describe lo que hay que crear. Antes de aplicarlo:

- Confirmar suscripción, grupo de recursos y región.
- Confirmar el SKU. `B1` + `Standard_B2s` alcanzan para una corrida diaria sobre
  un padrón de miles de filas; no para varios tenants grandes en paralelo.
- Cargar los secretos en el vault **antes** del primer arranque. Si falta uno,
  el módulo devuelve 500 en vez de arrancar a medias — que es lo correcto, pero
  conviene no descubrirlo en ese momento.

#### Verificar la imagen antes de publicarla

`docker build` en verde **no prueba que la imagen sirva**. El engine de Prisma
es un binario nativo que enlaza contra libssl al cargarse, así que una imagen
con el engine equivocado construye perfecto, arranca, sirve la home, y recién
muere en el primer request que toca la base.

Pasó: el engine salía como `linux-musl` (libssl 1.1) sobre una Alpine con
libssl 3, y el síntoma era `Error loading shared library libssl.so.1.1` dentro
de un `PrismaClientInitializationError`. Está cerrado por dos lados —
`binaryTargets` explícito en el esquema y `openssl` instalado en las dos etapas
— pero el chequeo queda porque el modo de falla se repite con cada bump de la
imagen base.

```bash
docker build -t turecibo:verif .

# 1. El engine tiene que ser el de OpenSSL 3, no el default.
docker run --rm --entrypoint sh turecibo:verif \
  -c 'ls node_modules/.prisma/client/*.node'
# Esperado: libquery_engine-linux-musl-openssl-3.0.x.so.node

# 2. Y tiene que cargar de verdad. Contra una base descartable:
docker run --rm --network <red> -e DATABASE_URL=<url> \
  --entrypoint node turecibo:verif \
  -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.$connect().then(()=>{console.log("OK");process.exit(0)}).catch(e=>{console.log(e.message);process.exit(1)})'
```

El paso 2 es el que vale: el 1 puede estar bien y el binario fallar igual por
otra dependencia. Un `Can't reach database server` es **éxito** para este
chequeo — significa que el engine cargó y llegó a intentar la conexión.

### G3 — Base y migración

```bash
npx prisma migrate deploy
```

Después, cargar una fila en `CredencialTuRecibo` por tenant. Guarda **nombres**
de variable, no valores:

| Columna | Ejemplo |
|---|---|
| `tenantId` | `acme` |
| `baseUrl` | `https://api.turecibo.com` |
| `adminUrl` | `https://admin.turecibo.com` |
| `usuarioEnv` | `TURECIBO_USER` |
| `passwordEnv` | `TURECIBO_PASSWORD` |
| `activa` | `true` |

Para un segundo tenant se agregan variables nuevas al vault
(`TURECIBO_USER_ACME`, etc.) y se las nombra en su fila.

### G4 — Registro en CENTRIA

Desde `/admin/modules`, con la URL del App Service. CENTRIA genera el token de
entrada y la credencial; van al vault como `centria-entry-token` y
`centria-service-token`.

Después, aprobar el manifiesto campo por campo. Sin eso, el cruce de identidades
falla con 403 y las ausencias quedan sin `personaExternalId`.

### G5 — Primera corrida, manual y observada

**No** habilitar el cron todavía. Correr a mano:

```bash
curl -X POST "$MODULO/api/sync/programado" \
  -H "x-sync-token: $SYNC_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tenantId":"acme"}'
```

Verificar contra lo que hoy tiene KAiROS antes de que nadie consuma
([`MIGRACION.md`](MIGRACION.md)).

### G6 — Cron y consumidores

En staging, después de infraestructura, secretos y corridas manuales
verificadas, se cambia la variable de repositorio
`ENABLE_TURECIBO_SCHEDULE` de `false` a `true`. Antes de eso, el evento `schedule` queda
sin job y `workflow_dispatch` permite ensayos controlados. No usar secretos
ni environment de producción.

## Operación diaria

| Qué | Cuándo | Dónde |
|---|---|---|
| Sync de tipos y ausencias (desde G6) | 06:15 UTC | `.github/workflows/sync-programado.yml` |
| Robot de feriados (desde G6) | lunes 07:00 UTC | `.github/workflows/feriados-robot.yml` |

Ambos tienen `workflow_dispatch` para correr a mano. El robot es dry-run salvo
que se tilde `enviar` (una vez habilitado el cron, siempre ingesta).

## Cuando algo falla

### La corrida quedó `ABORTADA`

Es una protección, no un error de programa. Significa que el origen devolvió
vacío y el módulo prefirió no escribir.

| Fuente | Qué habría pasado sin la protección |
|---|---|
| `TIPOS_LICENCIA` | catálogo entero dado de baja |
| `AUSENCIAS` | historial completo dado de baja |
| `FERIADOS` | calendario del año borrado |

**Qué hacer:** no reintentar a ciegas. Un 200 con cuerpo inesperado es
indistinguible de "no hay nada", así que primero hay que saber cuál de las dos
es. Revisar si Tu Recibo cambió el contrato, si las credenciales siguen válidas
y si el usuario conserva permisos. Cuando se entienda, correr manual.

**Los datos anteriores siguen intactos.** No hay urgencia: los consumidores leen
lo último bueno. Lo que envejece es `actualizado`, que es justamente la señal.

### La corrida quedó `FALLIDA`

Error real: red, credenciales, base o una fila corrupta en el catálogo de tipos
(sin id o nombre). En este último caso la corrida se corta antes de reconciliar:
no se desactivan tipos por haber descartado filas del origen. El mensaje está
en `CorridaSync.error`. El workflow programado devuelve rojo, pero no existe
una notificación operativa dedicada; hay que vigilar los fallos de GitHub
Actions. Se reintenta a mano una vez entendida la causa.

### HTTP 207 en el sync programado

Algún tenant o alguna fuente falló y el resto siguió. El cuerpo dice cuál. Se
trata como falla: si se dejara pasar como éxito, un tenant podría quedar sin
sincronizar durante semanas sin que nadie lo note.

### El robot no trae feriados

Casi siempre es la sesión PHP. El robot navega a `/gestion.licencias` después
del login porque **ese `goto` es el que dispara el SSO**; sin él, el POST
responde como anónimo con una lista vacía.

El formulario puede cambiar sus nombres de campo: el robot selecciona dentro
del formulario visible por tipo de input, incluso si está en un iframe. Si
falla antes de raspar, el workflow adjunta una captura saneada en
`feriados-fallido` (sin campos, texto ni iframes); no se reintenta el login
automáticamente. El panel puede mantener conexiones de red abiertas: se espera
el cambio de URL tras el login y el DOM de `/gestion.licencias`, no
`networkidle`; la lectura del endpoint de feriados tiene su propio timeout.

El robot aborta ante un año vacío y no envía nada. Si el panel cambió, hay que
ajustar el selector; mientras tanto, los feriados se pueden cargar con overrides
`ALTA`, que es exactamente para lo que sirven.

### Muchas ausencias sin persona

```
[identidades] N ausencias sin persona en la nómina y M sin DNI derivable
```

Un número estable y bajo es normal. Un salto significa que cambió la nómina, que
el manifiesto perdió el campo `dni`, o que el cruce se rompió. Revisar en ese
orden.

### 403 inesperado en el enchufe

Confirmar cuál de los dos secretos está en juego —son distintos y van en
direcciones opuestas ([`CONTRATO.md`](CONTRATO.md#los-dos-secretos)). Si la
variable está puesta y aun así da 500, probablemente sea una referencia de Key
Vault sin resolver: llega como texto literal y el módulo la trata como no
configurada, a propósito.

## Rotar un secreto

1. Poner el valor **viejo** en `<VAR>_PREVIO`.
2. Poner el nuevo en `<VAR>`.
3. Actualizar a los llamadores.
4. Esperar a que los logs dejen de mostrar `[rotacion] Se aceptó <VAR>_PREVIO`.
5. Borrar `<VAR>_PREVIO`.

Saltear el paso 4 corta a quien no rotó todavía.

## Qué NO hacer

- **No darle a Timesheet las credenciales de Tu Recibo.** Todo el punto del
  módulo es que exista un solo dueño.
- **No borrar filas para "limpiar".** Las bajas son lógicas porque el historial
  no se puede reconstruir desde el origen.
- **No agregar un timer dentro del App Service.** Se dispara una vez por
  instancia; en un scale-out silencioso serían corridas simultáneas contra Tu
  Recibo con las mismas credenciales.
- **No exponer `/centria/maestros/<id>` a otros módulos.** Quien filtra por
  campo y fila es CENTRIA; saltearlo vacía el modelo de permisos.
