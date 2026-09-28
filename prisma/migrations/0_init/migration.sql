-- CreateEnum
CREATE TYPE "Fuente" AS ENUM ('TIPOS_LICENCIA', 'AUSENCIAS', 'FERIADOS');

-- CreateEnum
CREATE TYPE "EstadoCorrida" AS ENUM ('EN_CURSO', 'OK', 'FALLIDA', 'ABORTADA');

-- CreateEnum
CREATE TYPE "EstadoAusencia" AS ENUM ('SOLICITADA', 'APROBADA', 'RECHAZADA');

-- CreateEnum
CREATE TYPE "TipoFeriado" AS ENUM ('FERIADO_NACIONAL', 'NO_LABORABLE');

-- CreateEnum
CREATE TYPE "AccionOverride" AS ENUM ('ALTA', 'BAJA', 'CAMBIO');

-- CreateTable
CREATE TABLE "CredencialTuRecibo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "usuarioEnv" TEXT NOT NULL,
    "passwordEnv" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT 'https://api.turecibo.com',
    "adminUrl" TEXT NOT NULL DEFAULT 'https://admin.turecibo.com',
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadaEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CredencialTuRecibo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorridaSync" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fuente" "Fuente" NOT NULL,
    "estado" "EstadoCorrida" NOT NULL DEFAULT 'EN_CURSO',
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "iniciadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminadaEn" TIMESTAMP(3),
    "leidas" INTEGER NOT NULL DEFAULT 0,
    "altas" INTEGER NOT NULL DEFAULT 0,
    "cambios" INTEGER NOT NULL DEFAULT 0,
    "bajas" INTEGER NOT NULL DEFAULT 0,
    "descartadas" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "CorridaSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TipoLicencia" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "esVacaciones" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "bajaEn" TIMESTAMP(3),
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TipoLicencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ausencia" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "dni" TEXT,
    "cuil" TEXT,
    "legajo" TEXT,
    "personaExternalId" TEXT,
    "tipoExternalId" TEXT,
    "tipoNombre" TEXT,
    "estado" "EstadoAusencia" NOT NULL,
    "estadoOrigen" TEXT,
    "idEstadoOrigen" TEXT,
    "desde" TIMESTAMP(3),
    "hasta" TIMESTAMP(3),
    "regreso" TIMESTAMP(3),
    "medioDia" BOOLEAN NOT NULL DEFAULT false,
    "horas" DOUBLE PRECISION,
    "motivo" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "bajaEn" TIMESTAMP(3),
    "creadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadaEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ausencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feriado" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "tipo" "TipoFeriado" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "desdeOverride" BOOLEAN NOT NULL DEFAULT false,
    "enOrigen" BOOLEAN NOT NULL DEFAULT true,
    "tipoOrigen" "TipoFeriado",
    "descripcionOrigen" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "bajaEn" TIMESTAMP(3),
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feriado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeriadoOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "accion" "AccionOverride" NOT NULL,
    "tipo" "TipoFeriado",
    "descripcion" TEXT,
    "motivo" TEXT NOT NULL,
    "autorId" TEXT NOT NULL,
    "autorEmail" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeriadoOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelloMaestro" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "maestro" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "actualizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelloMaestro_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CredencialTuRecibo_tenantId_key" ON "CredencialTuRecibo"("tenantId");

-- CreateIndex
CREATE INDEX "CredencialTuRecibo_activa_idx" ON "CredencialTuRecibo"("activa");

-- CreateIndex
CREATE INDEX "CorridaSync_tenantId_fuente_iniciadaEn_idx" ON "CorridaSync"("tenantId", "fuente", "iniciadaEn");

-- CreateIndex
CREATE INDEX "CorridaSync_tenantId_estado_idx" ON "CorridaSync"("tenantId", "estado");

-- CreateIndex
CREATE INDEX "TipoLicencia_tenantId_actualizadoEn_idx" ON "TipoLicencia"("tenantId", "actualizadoEn");

-- CreateIndex
CREATE UNIQUE INDEX "TipoLicencia_tenantId_externalId_key" ON "TipoLicencia"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "Ausencia_tenantId_actualizadaEn_idx" ON "Ausencia"("tenantId", "actualizadaEn");

-- CreateIndex
CREATE INDEX "Ausencia_tenantId_dni_idx" ON "Ausencia"("tenantId", "dni");

-- CreateIndex
CREATE INDEX "Ausencia_tenantId_desde_idx" ON "Ausencia"("tenantId", "desde");

-- CreateIndex
CREATE UNIQUE INDEX "Ausencia_tenantId_externalId_key" ON "Ausencia"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "Feriado_tenantId_actualizadoEn_idx" ON "Feriado"("tenantId", "actualizadoEn");

-- CreateIndex
CREATE UNIQUE INDEX "Feriado_tenantId_fecha_key" ON "Feriado"("tenantId", "fecha");

-- CreateIndex
CREATE INDEX "FeriadoOverride_tenantId_idx" ON "FeriadoOverride"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FeriadoOverride_tenantId_fecha_key" ON "FeriadoOverride"("tenantId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "SelloMaestro_tenantId_maestro_key" ON "SelloMaestro"("tenantId", "maestro");
