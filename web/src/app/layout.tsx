import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { ThemeProvider } from "@/lib/ThemeContext";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SIGAA Caiu? — Status do SIGAA UnB",
  description:
    "O SIGAA da UnB esta no ar? Monitor em tempo real com historico de uptime, tempo de resposta e incidentes. Verifica automaticamente a cada 3 minutos.",
  keywords: [
    "SIGAA", "UnB", "SIGAA caiu", "SIGAA fora do ar", "SIGAA status",
    "SIGAA UnB", "sistema academico UnB", "SIGAA lento", "SIGAA online",
    "status SIGAA", "monitor SIGAA",
  ],
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤔</text></svg>",
  },
  metadataBase: new URL("https://unb.sigaacaiu.com"),
  openGraph: {
    title: "SIGAA Caiu? — O SIGAA da UnB tá no ar?",
    description:
      "Monitor em tempo real do SIGAA da UnB. Veja se o sistema esta no ar, lento ou fora do ar.",
    url: "https://unb.sigaacaiu.com",
    siteName: "SIGAA Caiu?",
    locale: "pt_BR",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "SIGAA Caiu? — Status do SIGAA UnB",
    description:
      "O SIGAA da UnB esta no ar? Confira em tempo real.",
  },
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: "https://unb.sigaacaiu.com",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('theme');if(t==='sigaa')document.documentElement.setAttribute('data-theme','sigaa')}catch(e){}` }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white text-neutral-900 min-h-screen`}
      >
        <ThemeProvider>
          {children}
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
