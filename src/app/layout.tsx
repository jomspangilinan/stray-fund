import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import "./globals.css";
import { APP_NAME } from "@/lib/config";
import { Brand, DemoBar, HeaderSession, SiteNav } from "@/components/SiteChrome";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Community funding for neighbourhood stray cat care",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

// The "sign" yellow from globals.css.
export const viewport: Viewport = { themeColor: "#ffc21a" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${bricolage.variable} ${figtree.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Suspense fallback={null}>
          <DemoBar />
        </Suspense>
        <header className="mx-auto flex w-full max-w-xl items-center justify-between gap-4 px-4 py-4">
          <Brand />
          <Suspense fallback={null}>
            <HeaderSession />
          </Suspense>
        </header>
        <SiteNav />
        <div className="mx-auto w-full max-w-xl flex-1 px-4 pb-16">{children}</div>
      </body>
    </html>
  );
}
