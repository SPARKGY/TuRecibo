// Infraestructura del módulo Tu Recibo.
//
// IMPORTANTE: este archivo describe lo que hay que crear; NO se desplegó nada.
// Desplegarlo es un gate operativo aparte, con aprobación explícita.
//
// Dos decisiones que se ven raras y son a propósito:
//
//  1. Los secretos NO viven en App Settings sino en Key Vault, referenciados.
//     Un App Setting con el valor en claro lo ve cualquiera con lectura sobre
//     el recurso, y queda en los exports del portal.
//
//  2. La base es privada y solo accesible desde la VNet del App Service. El
//     módulo es el único que la lee: no hay ningún caso de uso legítimo en el
//     que un consumidor se conecte directo, y dejar la puerta abierta hace que
//     tarde o temprano alguien lo haga.

targetScope = 'resourceGroup'

@description('Sufijo corto que distingue el entorno. Ej: prod, stg.')
@minLength(2)
@maxLength(8)
param entorno string = 'prod'

@description('Región de todos los recursos.')
param ubicacion string = resourceGroup().location

@description('Usuario administrador de PostgreSQL.')
param adminUsuario string = 'turecibo_admin'

@description('Clave del administrador de PostgreSQL. Se pasa por parámetro seguro, no se versiona.')
@secure()
param adminClave string

@description('ObjectId del grupo de operadores que puede leer secretos del vault.')
param operadoresObjectId string = ''

var nombreBase = 'turecibo-${entorno}'
var etiquetas = {
  modulo: 'turecibo'
  entorno: entorno
  contrato: 'centria'
}

// --- Red -------------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${nombreBase}-vnet'
  location: ubicacion
  tags: etiquetas
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'app'
        properties: {
          addressPrefix: '10.40.1.0/24'
          delegations: [
            {
              name: 'appservice'
              properties: { serviceName: 'Microsoft.Web/serverFarms' }
            }
          ]
        }
      }
      {
        name: 'datos'
        properties: {
          addressPrefix: '10.40.2.0/24'
          delegations: [
            {
              name: 'postgres'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
    ]
  }
}

resource zonaPrivada 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${nombreBase}.private.postgres.database.azure.com'
  location: 'global'
  tags: etiquetas
}

resource enlaceZona 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zonaPrivada
  name: 'enlace-vnet'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

// --- Base de datos ----------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: '${nombreBase}-pg'
  location: ubicacion
  tags: etiquetas
  sku: {
    name: 'Standard_B2s'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: adminUsuario
    administratorLoginPassword: adminClave
    storage: { storageSizeGB: 32 }
    // 35 días de retención: la decisión fue guardar el historial completo, y
    // ese historial no se puede reconstruir desde Tu Recibo, que solo devuelve
    // el estado presente. El backup es la única red.
    backup: {
      backupRetentionDays: 35
      geoRedundantBackup: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: vnet.properties.subnets[1].id
      privateDnsZoneArmResourceId: zonaPrivada.id
    }
    highAvailability: { mode: 'Disabled' }
  }
  dependsOn: [enlaceZona]
}

resource baseDatos 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: postgres
  name: 'turecibo'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// --- Secretos ---------------------------------------------------------------

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${nombreBase}-kv'
  location: ubicacion
  tags: etiquetas
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    // Sin purge protection, un borrado accidental del vault se lleva puestos
    // los secretos y deja el módulo sin forma de autenticarse hasta que alguien
    // los regenere de los dos lados del enchufe.
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// --- Aplicación -------------------------------------------------------------

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${nombreBase}-plan'
  location: ubicacion
  tags: etiquetas
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: { reserved: true }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${nombreBase}-logs'
  location: ubicacion
  tags: etiquetas
  properties: {
    retentionInDays: 30
    sku: { name: 'PerGB2018' }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${nombreBase}-ai'
  location: ubicacion
  tags: etiquetas
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: nombreBase
  location: ubicacion
  tags: etiquetas
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: vnet.properties.subnets[0].id
    vnetRouteAllEnabled: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      healthCheckPath: '/centria/salud'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '8080' }
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'NEXT_TELEMETRY_DISABLED', value: '1' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'CENTRIA_MODULE_CODE', value: 'turecibo' }
        { name: 'CENTRIA_MODULE_NAME', value: 'Tu Recibo' }
        { name: 'PUBLICACION_AUSENCIAS_DIAS', value: '180' }
        { name: 'PUBLICACION_AUSENCIAS_DIAS_MAX', value: '730' }
        // Los secretos se cargan a mano en el vault y se referencian por nombre.
        // Bicep no los ve nunca; si una referencia no resuelve, el módulo falla
        // cerrado en vez de arrancar sin autenticación.
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=database-url)' }
        { name: 'CENTRIA_ENTRY_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=centria-entry-token)' }
        { name: 'CENTRIA_SERVICE_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=centria-service-token)' }
        { name: 'CENTRIA_BASE_URL', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=centria-base-url)' }
        { name: 'SYNC_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=sync-token)' }
        { name: 'FERIADOS_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=feriados-token)' }
        { name: 'TURECIBO_USER', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=turecibo-user)' }
        { name: 'TURECIBO_PASSWORD', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=turecibo-password)' }
      ]
    }
  }
  dependsOn: [baseDatos]
}

// --- Permisos ---------------------------------------------------------------

var rolLectorSecretos = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User

resource appLeeSecretos 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, app.id, rolLectorSecretos)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rolLectorSecretos)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource operadoresLeenSecretos 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operadoresObjectId)) {
  scope: vault
  name: guid(vault.id, operadoresObjectId, rolLectorSecretos)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rolLectorSecretos)
    principalId: operadoresObjectId
    principalType: 'Group'
  }
}

output urlModulo string = 'https://${app.properties.defaultHostName}'
output nombreVault string = vault.name
output servidorPostgres string = postgres.properties.fullyQualifiedDomainName
