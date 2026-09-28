export const metadata = {
  title: "Tu Recibo — módulo CENTRIA",
  description: "Extracción, custodia y publicación de licencias, ausencias y feriados.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          margin: 0,
          padding: "2rem",
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
