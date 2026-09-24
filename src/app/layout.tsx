import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Devanagari } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${devanagari.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
