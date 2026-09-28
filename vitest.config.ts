import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Caché dentro del repo y no en el temp del sistema: en Windows, un nombre de
  // usuario con tilde hace que Vite escriba en una ruta corta 8.3 y falle al
  // abrirla. El síntoma es un error suelto que devuelve exit code 1 con todos
  // los tests en verde, que en CI se ve como una falla inexistente.
  cacheDir: "node_modules/.vitest",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Los pools de child process (`forks`, el default) pasan cada módulo
    // transformado al worker escribiendo un archivo en el temp del sistema. En
    // Windows esa escritura falla de forma intermitente con "UNKNOWN: unknown
    // error", y el archivo de test afectado queda sin recolectar: la corrida
    // reporta todo en verde pero con menos tests y exit code 1, que en CI se ve
    // como una falla inexistente. `threads` pasa el código por memoria y no
    // toca el disco. Los tests son puros, así que no necesitan el aislamiento
    // de proceso.
    pool: "threads",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
