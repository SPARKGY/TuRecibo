# Runbook

## Staging compartido

El sitio de staging `turecibo-modulo-staging.azurewebsites.net` usa
`asp-ignix-staging`, una imagen versionada en `ignixacrprod` y la base aislada
`turecibo_staging` en `psql-ignix-prod`. Su configuración de App Service está
en `infra/staging.bicep`: **no** ejecutar `infra/main.bicep` para staging,
porque crea otra infraestructura. `CENTRIA_BASE_URL` (leída por el módulo) y
`CENTRIA_URL` apuntan ambas a CENTRIA staging. `/` sirve de health público;
`/centria/salud` requiere el token de entrada. Los cron apuntan al environment
GitHub `staging` y tienen gates separados como variables de **repositorio**:
`ENABLE_SYNC_SCHEDULE` para tipos y ausencias y `ENABLE_FERIADOS_SCHEDULE`
para el robot (el `if` de un job se evalúa antes de que estén disponibles
las variables del environment). Si falta una variable o vale `false`, el
respectivo job programado se omite; `workflow_dispatch` sigue disponible
para pruebas controladas. El robot puede habilitarse tras su ingesta manual
verificada, pero el sync debe permanecer apagado mientras Tu Recibo devuelva
403 para tipos y ausencias. Los tokens y credenciales usados por los jobs
están en los secrets del environment `staging`.

**Riesgos aceptados para staging:**

- `kv-ignix-prod` usa *access policies*. La identidad del sitio tiene solo
  permiso `get` (sin `list`), pero ese permiso alcanza **todos** los secretos
  del vault, incluidos los de producción; no se puede limitar a los tres
  secretos de este módulo en ese modo. Pendiente: mover también estos
  secretos de arranque al vault dedicado `kv-turecibo-stg`, que ya aloja los
  secretos de conexión (ver "Permisos sobre el vault"). La escritura nunca se
  concede sobre `kv-ignix-prod`. Las credenciales CENTRIA de staging se obtuvieron
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

Después, configurar las conexiones de cada tenant desde el panel del módulo
(ver [Conexiones a Tu Recibo](#conexiones-a-tu-recibo)). La migración
`1_conexiones_parametricas` ya copia cada fila existente de
`CredencialTuRecibo` a dos conexiones (`LICENCIAS_API` y `FERIADOS_PANEL`) en
modo `USUARIO_PASSWORD`, que siguen leyendo las mismas variables de entorno
hasta la primera rotación.

**Fallback heredado.** Un tenant sin fila en `ConexionTuRecibo` se resuelve
como antes: una fila en `CredencialTuRecibo` con **nombres** de variable, no
valores:

| Columna | Ejemplo |
|---|---|
| `tenantId` | `acme` |
| `baseUrl` | `https://api.turecibo.com` |
| `adminUrl` | `https://admin.turecibo.com` |
| `usuarioEnv` | `TURECIBO_USER` |
| `passwordEnv` | `TURECIBO_PASSWORD` |
| `activa` | `true` |

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

En staging, después de infraestructura, secretos y una ingesta manual de
feriados verificada por el módulo y CENTRIA, cambiar la variable de
repositorio `ENABLE_FERIADOS_SCHEDULE` a `true`. Mantener
`ENABLE_SYNC_SCHEDULE=false` hasta resolver el 403 de tipos y ausencias
con el proveedor y verificar una corrida manual de sync; **no** habilitar
ambos mediante un gate compartido. Si un gate queda apagado, el evento
`schedule` de ese workflow no ejecuta el job. `workflow_dispatch` permite
ensayos controlados. No usar secretos ni environment de producción.

## Operación diaria

| Qué | Cuándo | Dónde |
|---|---|---|
| Sync de tipos y ausencias (pendiente resolver 403 y habilitar su gate) | 06:15 UTC | `.github/workflows/sync-programado.yml` |
| Robot de feriados (tras habilitar su gate) | lunes 07:00 UTC | `.github/workflows/feriados-robot.yml` |

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

## Conexiones a Tu Recibo

Cada tenant tiene hasta dos conexiones en `ConexionTuRecibo`, una por fuente:

| Fuente | Quién la usa | Modos |
|---|---|---|
| `LICENCIAS_API` | sync de tipos y ausencias (App Service) | `USUARIO_PASSWORD` (login → JWT), `TOKEN` (bearer ya emitido) |
| `FERIADOS_PANEL` | robot de feriados (GitHub Actions) | `USUARIO_PASSWORD` (login con navegador), `SESION` (cookie PHP inyectada, sin login) |

Parámetros (validados con zod): `baseUrl` para la API; `adminUrl`, `anios`
(opcional; vacío = actual y siguiente) y `nombreCookieSesion` (default
`PHPSESSID`) para el panel.

**Secretos.** La base guarda solo nombres. Los valores viven en Key Vault con
nombre determinístico `{KEY_VAULT_PREFIJO}-{tenant}-{fuente}-{campo}` (ej.
`turecibo-acme-feriados-panel-sesion`). El módulo los lee y escribe en runtime
con su identidad administrada (`KEY_VAULT_URL`), con caché en memoria de 60 s
que se invalida al rotar. Las filas migradas guardan `secretosEnv` (nombres de
variable) hasta la primera rotación desde el panel.

### Rotar desde el panel

En la página del módulo (solo rol ADMIN del módulo según `x-module-role`),
tarjeta de la fuente → **Cambiar credenciales**:

1. Elegir modo y parámetros; cargar los valores nuevos. Los campos vacíos
   conservan el valor vigente si el modo no cambia.
2. **Probar** valida sin guardar. **Probar y guardar** vuelve a probar y solo
   guarda si pasa: escribe una versión nueva de cada secreto en Key Vault y
   registra `rotadaEn`, `rotadaPor*`, `validadaEn` y el resultado.
3. Si la prueba falla, no se guarda nada. Se puede tildar "Guardar aunque la
   prueba falle" (`forzar: true`): queda registrado como `FALLIDA`.

Qué se puede validar desde el servidor:

| Fuente / modo | Prueba |
|---|---|
| API / `USUARIO_PASSWORD` o `TOKEN` | login (si aplica) + `GET /v2/licensesUser/types` |
| Panel / `SESION` | `POST /ajax/licencias/feriados.php` con la cookie; redirect o lista vacía = falla |
| Panel / `USUARIO_PASSWORD` | no factible (formulario en iframe + SSO): queda `PENDIENTE_ROBOT` hasta la próxima corrida del robot |

**Probar conexión** en la tarjeta prueba la configuración vigente y registra
el resultado. Las rutas son `GET|PUT /api/conexiones` y
`POST /api/conexiones/probar`; ninguna devuelve valores de secreto.

### Robot y conexión

El robot pide su configuración a `GET /api/robot/conexion?tenantId=` con
`x-feriados-token` (el mismo `FERIADOS_TOKEN` de la ingesta). Recibe modo,
parámetros y el secreto que corresponda, y al terminar informa con
`POST /api/robot/conexion` si la credencial/sesión sirvió (actualiza
`ultimoResultadoValidacion`). Solo las fallas de acceso (login rechazado,
vuelta a `/s/login`, año vacío) marcan la conexión como `FALLIDA`; un error de
red no. Un reporte con una `revision` anterior a la última rotación se ignora.

**Fallback.** Si el módulo responde 404 (tenant sin conexión ni legado, o un
módulo sin esta ruta), no responde, o devuelve 5xx, el robot usa
`TURECIBO_USER`/`TURECIBO_PASSWORD`/`TURECIBO_ADMIN_URL` del entorno como
antes. Un 401/403 aborta: el token está mal. En el workflow, los secrets
`TURECIBO_USER`/`TURECIBO_PASSWORD` del environment `staging` pasan a ser
**opcionales** y solo sirven para ese fallback; se pueden borrar una vez que
la conexión `FERIADOS_PANEL` esté validada por el robot.

### Modo SESION: cómo obtener la cookie

Entrar al panel con un navegador, abrir `/gestion.licencias` (dispara el SSO),
y copiar el valor de la cookie `PHPSESSID` del dominio del panel desde las
herramientas de desarrollo. Cargarlo en la tarjeta del panel con modo
**Sesión**. La sesión PHP vence: cuando el robot reporte `FALLIDA`, hay que
renovarla.

### Permisos sobre el vault

- **Producción** (`infra/main.bicep`, vault propio con RBAC): la identidad del
  App Service tiene **Key Vault Secrets Officer** (lee y escribe secretos;
  no gestiona claves ni certificados ni el vault).
- **Staging** (`infra/staging.bicep`): los secretos de conexión viven en un
  **vault dedicado** `kv-turecibo-stg` (parámetro `connectionsVaultName`), con
  RBAC, soft delete de 90 días y purge protection, que crea la misma
  plantilla. La identidad del sitio tiene **Key Vault Secrets Officer solo
  sobre ese vault**, y `KEY_VAULT_URL` apunta a él. Sobre el vault compartido
  `kv-ignix-prod` (*access policies*) la plantilla **no concede nada**: la
  identidad conserva únicamente el `get` preexistente para las referencias de
  App Settings de arranque (`DATABASE_URL`, tokens, `TURECIBO_USER/PASSWORD`).
  Staging no puede escribir secretos de producción.

  Por qué no una access policy `set` en `kv-ignix-prod`: no se puede limitar
  por secreto, así que daría a staging escritura sobre todos los secretos de
  producción. Un prefijo de nombre no alcanza como separación.

#### Alta y migración del vault de staging

1. Desplegar `infra/staging.bicep` (crea `kv-turecibo-stg` y la asignación de
   rol). Para cargar secretos a mano, pasar
   `connectionsVaultAdminObjectIds=["<objectId de usuario o grupo>"]`; si no,
   solo la app puede escribir. Verificar antes con `az deployment group
   what-if`: `kv-ignix-prod` debe figurar como `Ignore` (sin cambios).
2. Esperar la propagación de RBAC (hasta ~5 min) antes de rotar desde el panel;
   mientras tanto la escritura devuelve 502 y no se guarda nada.
3. No hay nada que copiar: las filas migradas desde `CredencialTuRecibo`
   usan `secretosEnv`, que se resuelve con las App Settings que ya leen
   `kv-ignix-prod`. Licencias y robot siguen funcionando igual. La primera
   rotación desde el panel escribe en `kv-turecibo-stg`
   (`turecibo-staging-{tenant}-{fuente}-{campo}`) y la fila pasa a apuntar
   ahí.
4. Si hubiera secretos `turecibo-staging-*` de conexión escritos a mano en
   `kv-ignix-prod`, volver a cargarlos desde el panel (o con
   `az keyvault secret set --vault-name kv-turecibo-stg`) y borrarlos del
   vault compartido con su responsable.
5. Comprobar que la identidad no tiene escritura en el vault compartido:
   `az keyvault show -n kv-ignix-prod --query "properties.accessPolicies[?objectId=='<principalId>'].permissions.secrets"`
   debe devolver solo `["get"]`. Si alguna vez se aplicó una versión
   anterior de esta rama con `set`, dejarla en `get` con
   `az keyvault set-policy -n kv-ignix-prod --object-id <principalId> --secret-permissions get`.

Rollback: volver `KEY_VAULT_URL` al valor anterior no es necesario ni
recomendable. Si el vault dedicado no está disponible, la rotación desde el
panel falla sin guardar y las filas con `secretosEnv` siguen resolviendo por
App Settings. Purge protection impide borrar el vault de forma definitiva
durante la retención: es intencional.

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
