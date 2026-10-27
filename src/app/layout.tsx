import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";

export const metadata: Metadata = {
  title: "Software Factory — Autonomous SDLC",
  description:
    "Local-first AI agent factory for requirements, architecture, implementation, testing and deployment.",
};

export const viewport: Viewport = {
  themeColor: "#080a09",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('factory-theme');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();",
          }}
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
        <Toaster
          theme="system"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "#0e1210",
              border: "1px solid #202823",
              color: "#eef2ea",
            },
          }}
        />
      </body>
    </html>
  );
}
