import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import "./globals.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: "AI Visibility Checker",
  description: "How often do AI models recommend your brand when buyers ask vendor-neutral questions?",
};

const themeScript = `try{var t=localStorage.getItem("avc-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen flex flex-col">
        <header className="mx-auto w-full max-w-6xl px-5 sm:px-8 pt-6 pb-4 flex items-center justify-between gap-4">
          <Link href="/" className="display text-[22px] leading-none">
            AI <span className="hl">Visibility</span> Checker
          </Link>
          <nav className="flex items-center gap-5 text-sm text-ink-2">
            <Link href="/" className="hover:text-ink">
              New check
            </Link>
            <Link href="/history" className="hover:text-ink">
              History
            </Link>
            <ThemeToggle />
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl px-5 sm:px-8 flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-5 sm:px-8 py-10 text-xs text-ink-3">
          Answers are sampled via OpenRouter with no system prompt. Questions never name the brand. See the README for methodology.
        </footer>
      </body>
    </html>
  );
}
