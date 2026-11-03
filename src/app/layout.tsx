import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Gabarito } from "next/font/google";
import "./globals.css";
import { APP_NAME } from "@/lib/config";
import { Brand, DemoBar, HeaderSession } from "@/components/SiteChrome";
import { TabBar } from "@/components/TabBar";

const gabarito = Gabarito({
  variable: "--font-gabarito",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Community funding for neighbourhood stray cat care",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

// The ground colour from globals.css.
export const viewport: Viewport = { themeColor: "#edf4ec" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${gabarito.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Suspense
          fallback={<div aria-hidden="true" className="fixed inset-x-0 bottom-0 z-30 h-20 bg-surface md:inset-y-0 md:right-auto md:h-auto md:w-52" />}
        >
          <TabBar />
        </Suspense>
        <div className="flex min-h-dvh flex-col md:pl-52">
          <Suspense fallback={null}>
            <DemoBar />
          </Suspense>
          <header className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-4 pb-2 pt-4">
            <Brand />
            <Suspense fallback={<div className="skeleton h-11 w-11" aria-hidden="true" />}>
              <HeaderSession />
            </Suspense>
          </header>
          <div className="mx-auto w-full max-w-2xl flex-1 px-4 pb-32 md:pb-16">{children}</div>
        </div>
      </body>
    </html>
  );
}
