import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "../components/Providers";

export const metadata = {
  title: "Noema — Project Brain OS 2.0",
  description: "Governança, Grafo de Conhecimento, Handoffs e Visões Corporativas."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
