import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

import { AuthProvider } from "@/components/auth/AuthContext";
import AppShell from "@/components/auth/AppShell";
import { ThemeProvider } from "@/components/theme/ThemeContext";

// Runs before React hydrates to set the saved theme class on <html>, avoiding
// a flash of the wrong theme on first paint. Defaults to dark when nothing is
// stored, matching the ThemeProvider default.
const themeInitScript = `
(function(){try{var t=localStorage.getItem('pd-theme');if(t!=='light'){document.documentElement.classList.add('dark');}}catch(e){document.documentElement.classList.add('dark');}})();
`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Premier Data Platform",
  description: "Premier Data Operations Platform",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Premier Data",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B1220",
  width: "device-width",
  initialScale: 1,
  // Allow the installed app to use the full screen (no accidental zoom), but
  // still let users pinch-zoom content.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="h-screen overflow-hidden bg-white text-slate-900 dark:bg-slate-950 dark:text-white">

        <ThemeProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ThemeProvider>

      </body>
    </html>
  );
}