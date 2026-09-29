// Staging only. Reuses existing shared resources; does not create a server,
// plan, registry, vault, firewall rule, database or database login.
// Provision database/login and seed the three vault secrets separately before
// deploying the application image. Never apply infra/main.bicep for staging.
targetScope = 'resourceGroup'

@description('Name of the existing shared Linux App Service plan.')
param planName string = 'asp-ignix-staging'

@description('Name of the new staging web app.')
param appName string = 'turecibo-modulo-staging'

@description('Name of the existing shared Key Vault.')
param vaultName string = 'kv-ignix-prod'

@description('Name of the existing container registry.')
param registryName string = 'ignixacrprod'

@description('Versioned container image tag to serve. Empty during initial provisioning.')
param imageTag string = ''

@description('HTTPS base URL of CENTRIA staging, without a trailing slash.')
param centriaBaseUrl string

@description('Name of the entry-token secret created before deploying the image.')
param entryTokenSecretName string = 'turecibo-staging-modulo-entry-token'

@description('Name of the credential placeholder secret created before deploying the image.')
param credentialSecretName string = 'turecibo-staging-modulo-credential'

@description('Name of the database URL secret for the isolated staging database.')
param databaseUrlSecretName string = 'turecibo-staging-database-url'

@description('Name of the independent scheduled-sync token secret.')
param syncTokenSecretName string = 'turecibo-staging-sync-token'

@description('Name of the independent holiday-ingestion token secret.')
param feriadosTokenSecretName string = 'turecibo-staging-feriados-token'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' existing = {
  name: planName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: resourceGroup().location
  tags: {
    modulo: 'turecibo'
    entorno: 'staging'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: empty(imageTag) ? 'NODE|20-lts' : 'DOCKER|${registry.properties.loginServer}/turecibo-staging:${imageTag}'
      acrUseManagedIdentityCreds: !empty(imageTag)
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      // /centria/salud requires an internal token; Azure health checks cannot
      // send it. Probe the public home until authenticated monitoring is wired.
      healthCheckPath: '/'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '8080' }
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'NEXT_TELEMETRY_DISABLED', value: '1' }
        { name: 'CENTRIA_MODULE_CODE', value: 'turecibo' }
        { name: 'CENTRIA_MODULE_NAME', value: 'TuRecibo' }
        { name: 'CENTRIA_BASE_URL', value: centriaBaseUrl }
        { name: 'CENTRIA_URL', value: centriaBaseUrl }
        { name: 'CENTRIA_ENTRY_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${entryTokenSecretName})' }
        { name: 'CENTRIA_SERVICE_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${credentialSecretName})' }
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${databaseUrlSecretName})' }
        { name: 'SYNC_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${syncTokenSecretName})' }
        { name: 'FERIADOS_TOKEN', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${feriadosTokenSecretName})' }
        { name: 'TURECIBO_USER', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=turecibo-username)' }
        { name: 'TURECIBO_PASSWORD', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=turecibo-password)' }
      ]
    }
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, app.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource scmAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'scm'
  properties: {
    allow: false
  }
}

resource ftpAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: app
  name: 'ftp'
  properties: {
    allow: false
  }
}

output appId string = app.id
output appHostname string = app.properties.defaultHostName
output principalId string = app.identity.principalId
