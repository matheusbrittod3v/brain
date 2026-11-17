import type { ReactNode } from "react";

export const metadata = {
  title: "Noema — Project Brain OS 2.0 Command Center",
  description: "Governança, Grafo de Conhecimento, Handoffs e Visões Corporativas."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#0b1020", color: "#e5e7eb" }}>
        {children}
      </body>
    </html>
  );
}

