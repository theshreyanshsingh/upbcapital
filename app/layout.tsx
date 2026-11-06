import type { Metadata } from "next";
import { Inter, Newsreader } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Inter for everything people read, with its optical-size axis so titles get the tighter display cut.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", axes: ["opsz"], display: "swap" });
// Newsreader for page titles and display headlines only.
const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", axes: ["opsz"], display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "UPB Capital",
    template: "%s · UPB Capital",
  },
  description:
    "A private market for mortgage notes and distressed real estate debt, priced against unpaid principal balance.",
};

// Runs before first paint, so the page never flashes the wrong theme. The system setting decides unless
// the person picked Light or Dark (stored under upb-theme by components/theme-toggle.tsx). It keeps
// following the system, and other tabs, for the life of the page.
const themeScript = `(function(){var k="upb-theme",d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");function pick(){try{return localStorage.getItem(k)}catch(e){return null}}function apply(){var c=pick(),dark=c==="dark"||(c!=="light"&&m.matches);d.classList.toggle("dark",dark);d.style.colorScheme=dark?"dark":"light"}apply();if(m.addEventListener)m.addEventListener("change",apply);window.addEventListener("storage",function(e){if(e.key===k)apply()})})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">
        <a href="#desk" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">
          Skip to content
        </a>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
