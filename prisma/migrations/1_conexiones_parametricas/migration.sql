-- Conexiones paramétricas a Tu Recibo. Ver `ConexionTuRecibo` en schema.prisma.

-- CreateEnum
CREATE TYPE "FuenteConexion" AS ENUM ('LICENCIAS_API', 'FERIADOS_PANEL');

-- CreateEnum
CREATE TYPE "ModoConexion" AS ENUM ('USUARIO_PASSWORD', 'SESION', 'TOKEN');

-- CreateEnum
CREATE TYPE "ResultadoValidacion" AS ENUM ('OK', 'FALLIDA', 'PENDIENTE_ROBOT');

-- CreateTable
CREATE TABLE "ConexionTuRecibo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fuente" "FuenteConexion" NOT NULL,
    "modo" "ModoConexion" NOT NULL,
    "parametros" JSONB NOT NULL DEFAULT '{}',
    "secretos" JSONB NOT NULL DEFAULT '{}',
    "secretosEnv" JSONB,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "rotadaEn" TIMESTAMP(3),
    "rotadaPorId" TEXT,
    "rotadaPorEmail" TEXT,
    "validadaEn" TIMESTAMP(3),
    "ultimoResultadoValidacion" "ResultadoValidacion",
    "ultimoDetalleValidacion" TEXT,
    "creadaEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadaEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConexionTuRecibo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConexionTuRecibo_activa_idx" ON "ConexionTuRecibo"("activa");

-- CreateIndex
CREATE UNIQUE INDEX "ConexionTuRecibo_tenantId_fuente_key" ON "ConexionTuRecibo"("tenantId", "fuente");

-- Migración de datos: cada `CredencialTuRecibo` se vuelve dos conexiones
-- (API y panel) en modo USUARIO_PASSWORD. Los secretos siguen resolviéndose
-- por las mismas variables de entorno (`secretosEnv`) hasta que alguien los
-- rote desde el panel, que los mueve a Key Vault. `CredencialTuRecibo` no se
-- toca: sigue siendo el fallback de lectura.
INSERT INTO "ConexionTuRecibo" ("id", "tenantId", "fuente", "modo", "parametros", "secretos", "secretosEnv", "activa", "actualizadaEn")
SELECT
    'mig_' || md5(c."tenantId" || ':LICENCIAS_API'),
    c."tenantId",
    'LICENCIAS_API'::"FuenteConexion",
    'USUARIO_PASSWORD'::"ModoConexion",
    jsonb_build_object('baseUrl', c."baseUrl"),
    '{}'::jsonb,
    jsonb_build_object('usuario', c."usuarioEnv", 'password', c."passwordEnv"),
    c."activa",
    CURRENT_TIMESTAMP
FROM "CredencialTuRecibo" c
UNION ALL
SELECT
    'mig_' || md5(c."tenantId" || ':FERIADOS_PANEL'),
    c."tenantId",
    'FERIADOS_PANEL'::"FuenteConexion",
    'USUARIO_PASSWORD'::"ModoConexion",
    jsonb_build_object('adminUrl', c."adminUrl"),
    '{}'::jsonb,
    jsonb_build_object('usuario', c."usuarioEnv", 'password', c."passwordEnv"),
    c."activa",
    CURRENT_TIMESTAMP
FROM "CredencialTuRecibo" c
ON CONFLICT ("tenantId", "fuente") DO NOTHING;
