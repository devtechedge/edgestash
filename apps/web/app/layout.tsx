import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

const boot = `try{var t=localStorage.getItem("edgestash-theme")||"dark";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch(e){}`;

export const metadata: Metadata = {
  title: "edgestash: self-hosted Vercel Blob and Upstash Redis API",
  description: "One small TypeScript server that speaks the Vercel Blob and Upstash Redis REST APIs. Point the official SDKs at it by changing a URL.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: boot }} /></head>
      <body>
        <header className="top">
          <div className="wrap">
            <Link href="/" className="brand"><img src="/favicon.svg" width={26} height={26} alt="" /> edgestash</Link>
            <nav>
              <Link href="/demo">Live demo</Link>
              <Link href="/dashboard">Dashboard</Link>
              <a href="https://github.com/devtechedge/edgestash">GitHub</a>
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer><div className="wrap">MIT licensed. Not affiliated with Vercel or Upstash. Compatibility derived from the open source SDKs.</div></footer>
      </body>
    </html>
  );
}
