# Azure Deployment Plan

> **Status:** Validated

## Scope

Update only the existing `turecibo-modulo-staging` App Service in
`rg-ignixcommsuite-prod` (Brazil South, subscription
`dc7a59f3-0f26-449c-adb4-e822fd893336`). This is an approved replacement of
the old `8cc06c4` container with the already merged `28eb513` code; no
production resources, database schema, secrets, or sync schedule are changed.

## Procedure

1. Use the exact `main` commit `28eb51360c2911485230cb3a836f6b271b89dbac`.
2. Validate `infra/staging.bicep` via `az bicep build` and group `what-if` with
   `imageTag=28eb513` and the existing CENTRIA staging URL. The user accepted
   the comparison artifacts itemized below, provided **Bicep is not applied**.
3. Build `ignixacrprod.azurecr.io/turecibo-staging:28eb513` from that exact
   commit with `az acr build`, without applying `infra/main.bicep`.
4. Point only `turecibo-modulo-staging` at that image with
   `az webapp config container set`, then restart the site.
5. Check public `/` and authenticated `/centria/salud` for HTTP 200. Keep
   `ENABLE_SYNC_SCHEDULE=false`; issue one manual workflow dispatch only after
   health passes. Never write to the Tu Recibo provider.

## Validation Proof

On 2026-09-29, `az bicep build --file infra/staging.bicep --stdout` passed.
`az deployment group validate` (staging template, versioned tag and CENTRIA
staging URL) passed without errors. The latest `main` CI for
`28eb51360c2911485230cb3a836f6b271b89dbac` passed. The site managed
identity currently has `AcrPull` on `ignixacrprod`; no RBAC change is needed.
The group `what-if` with `imageTag=28eb513` did **not** meet the required
image-only threshold. Besides `linuxFxVersion`, it reported:

- `AcrPull` role assignment `properties.principalId: Modify`, from the live
  principal to an unresolved ARM `reference(...)` expression.
- Site `siteConfig` `ftpsState`, `healthCheckPath`, `localMySqlEnabled`,
  `minTlsVersion`, and `netFrameworkVersion` as `Create`.

The same deltas appeared when previewing the **current** `imageTag=8cc06c4`,
including `linuxFxVersion`. On **2026-09-29**, the user explicitly accepted
the above extra deltas as ARM comparison artifacts, on the condition that the
update is **only** `az webapp config container set` to the new versioned image
plus restart. Do **not** apply `infra/staging.bicep` or `infra/main.bicep`.
This acceptance does not authorize modifying the ACR role assignment or
other `siteConfig` fields.

Validation checklist:

- [x] `az bicep build --file infra/staging.bicep --stdout` (pass)
- [x] `az deployment group validate` on staging Bicep with target image (pass)
- [x] `az deployment group what-if` for both target and current tag (same
      unrelated deltas; explicitly accepted as preview artifacts by user)
- [x] Latest CI build/tests for target main SHA (success)
- [x] Existing managed identity has `AcrPull` on shared registry (read-only
      verification)
- [x] Only `az webapp config container set` plus restart may be executed;
      neither Bicep template may be applied.

## Deployment attempt (2026-09-29)

The source was archived from exact `main` commit
`28eb51360c2911485230cb3a836f6b271b89dbac`; the archive was verified
to include `Authorization: Bearer` before building. `az acr build` succeeded
(run `cqh1`) and produced `turecibo-staging:28eb513`. Only
`az webapp config container set` and `az webapp restart` targeted
`turecibo-modulo-staging`. Twelve health attempts failed due to request
timeouts, so the site was restored to image `turecibo-staging:8cc06c4`
and restarted, as required. The previous image subsequently returned HTTP
200 on `/`, but with a ~27-second response time; the short 20-second health
timeout may have masked slow startup. **No sync was dispatched** and
`ENABLE_SYNC_SCHEDULE` remained `false`. Do not retry the swap without a
separate operational decision after diagnosing startup and health timing.

## Second swap (2026-09-29)

With explicit authorization, swapped only the staging container to `28eb513`
and restarted at 15:22:31 UTC. A scripting error in the health probe used
PowerShell's read-only `$HOME` variable for the HTTP response, causing
`SessionStateUnauthorizedAccessException` on every attempt. **The health
requests did not run; this is not evidence that the new image was unhealthy.**
At the end of the authorized five-minute window, captured the App Service
startup logs in an ignored local archive and rolled back to `8cc06c4`, then
restarted. Those logs show `28eb513` pulled, its process ready and the App
Service warm-up probe succeeded at 15:23:52 UTC. After rollback, `/` and
authenticated `/centria/salud` both responded HTTP 200. The site currently
runs `8cc06c4`, sync was not dispatched, and its schedule remains disabled.
Another swap requires separate authorization; correct the probe variable
name before running it.

## Third swap (2026-09-29)

The user separately authorized a third attempt. Before changing the image,
the corrected PowerShell probe (using `$resp`, not `$HOME`) returned HTTP 200
from both `/` and authenticated `/centria/salud` on `8cc06c4`. The sync
schedule was confirmed disabled. Only the staging site's container image was
changed to `turecibo-staging:28eb513` and the site restarted at 15:41:50 UTC.
Both external health requests returned HTTP 200 on the first attempt at
15:42:10–15:42:11 UTC, within the authorized five-minute window. The
confirmed `linuxFxVersion` is
`DOCKER|ignixacrprod.azurecr.io/turecibo-staging:28eb513`; no rollback was
needed.

One manual sync was dispatched from `main` at
`28eb51360c2911485230cb3a836f6b271b89dbac` for the staging tenant
(Actions run `36592250272`). It completed with HTTP 200: tipos read 12,
inserted 12, deleted 0; ausencias read 2567, inserted 2567, deleted 0;
identities resolved 2074, without person 493, without DNI 0. CENTRIA's
Timesheet credential received HTTP 200 with 12 `tipos-licencia` rows and
1247 `ausencias` rows using `?campos=externalId`; the latter is the default
publication window, not the entire stored padrón. The provider calls
succeeded, but their exact successful HTTP status codes were not recorded by
the sync, so only 2xx can be asserted for those requests. No extra provider
request was made to infer the codes. `ENABLE_SYNC_SCHEDULE` remains `false`.
Neither Bicep template was applied.

## Scheduled sync gate (2026-09-29)

After the successful manual sync, the user separately authorized enabling
the **staging** GitHub Actions schedule. `ENABLE_SYNC_SCHEDULE` was set to
`true` and read back as `true`; the workflow's schedule remains `15 6 * * *`
(06:15 UTC daily). At the time of enabling it on September 29, the next
scheduled run was September 30, 2026, at 06:15 UTC. No additional manual
dispatch was made. Earlier `false` references above describe the state
**during the image swap**, not the current gate.
