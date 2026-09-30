export const metadata = {
  title: "Tu Recibo — módulo CENTRIA",
  description: "Extracción, custodia y publicación de licencias, ausencias y feriados.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ margin: 0, background: "#e4e4e4" }}>
        {children}
      </body>
    </html>
  );
}
