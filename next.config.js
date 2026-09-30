/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // El SDK de Azure se carga desde node_modules en runtime en vez de
    // empaquetarse: tiene dependencias opcionales nativas que webpack no
    // resuelve. `standalone` igual las copia al trazar los imports.
    serverComponentsExternalPackages: ["@azure/identity", "@azure/keyvault-secrets"],
  },
};

module.exports = nextConfig;
