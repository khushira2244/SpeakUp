import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Inter, Noto_Sans_Devanagari } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { DEFAULT_LANG, LANG_COOKIE, isSupportedLang } from "@/i18n/messages";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const devanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-devanagari",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SpeakUp by AdaptiveSkills",
  description: "Learn and speak what matters most.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#07090b",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Read the saved language on the server so the very first paint is already
  // in it: a Hindi user never sees English flash before hydration.
  const saved = (await cookies()).get(LANG_COOKIE)?.value;
  const lang = isSupportedLang(saved) ? saved : DEFAULT_LANG;

  return (
    <html lang={lang} className={`${inter.variable} ${devanagari.variable}`}>
      <body>
        <Providers initialLang={lang}>{children}</Providers>
      </body>
    </html>
  );
}
