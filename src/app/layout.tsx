import type { Metadata } from "next";
import { IBM_Plex_Mono, Schibsted_Grotesk, Spectral } from "next/font/google";
import "./globals.css";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import Footer from "@/components/Footer";
import SiteHeader from "@/components/site/SiteHeader";

// Typefaces of the Claude-Design prototype, self-hosted by next/font.
const sans = Schibsted_Grotesk({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600", "700"], variable: "--font-sans", display: "swap" });
const serif = Spectral({ subsets: ["latin", "latin-ext"], weight: ["400", "500"], style: ["normal", "italic"], variable: "--font-serif", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin", "latin-ext"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Castletter",
  description: "Daily newsletters for your favorite podcasts",
  icons: { icon: "/logo.svg" },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body className="antialiased flex flex-col min-h-screen">
        <NextIntlClientProvider messages={messages}>
          <SiteHeader />
          <main className="flex-1 flex flex-col">
            {children}
          </main>
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
