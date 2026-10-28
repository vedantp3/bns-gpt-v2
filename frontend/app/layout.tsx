import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import type { ReactNode } from "react";

const displayFont = Fraunces({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const sansFont = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "BNS Legal Intelligence Desk",
  description: "Indian police and legal intelligence workspace for BNS, BNSS, and BSA research.",
  icons: { icon: "/images/scales.svg" }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f2440"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${displayFont.variable} ${sansFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}
