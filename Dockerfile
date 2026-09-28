# Build de Next.js en modo standalone: el runtime final solo lleva el server ya
# armado, no `node_modules` entero.
#
# Deliberadamente sin Playwright. El robot de feriados necesita un navegador,
# pero corre en GitHub Actions: meter Chromium acá agregaría ~300 MB a una
# imagen que lo usaría una vez por semana.

FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .
# El cliente de Prisma se genera contra el esquema, antes del build: los tipos
# que usa el código TypeScript salen de acá.
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Sin `COPY /app/public`: el repo no tiene esa carpeta —el módulo no sirve
# assets estáticos propios— y copiar una ruta inexistente aborta el build. Si
# algún día se agregan, hay que sumar la línea junto con la carpeta.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# El esquema y el cliente generado viajan aparte: `prisma migrate deploy` corre
# en el arranque del release, no en el build de la imagen.
#
# **Todo sale de `build`, no de `deps`.** `deps` corre con `--omit=dev
# --ignore-scripts`, y ahí `prisma` es devDependency y `.prisma` solo existe
# después de `prisma generate`: copiar de esa etapa fallaba el build con
# `/app/node_modules/.prisma: not found`. `build` es la única etapa que tiene
# las tres cosas.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
